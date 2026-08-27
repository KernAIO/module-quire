/**
 * Publishing a page, and everything under it, to a URL a signed-out stranger can open.
 *
 * This file holds both halves: the authenticated CRUD an author uses, and the read path an
 * anonymous request takes. They are together because the second one is only safe if it agrees with
 * the first about what "public" means, and the definition lives here once:
 *
 *   **A page is public iff it is the publication's root or a descendant of it reached without
 *   passing through a page that is opted out, archived, trashed, unpublished or not a `page`; and
 *   it has a published version that has been rendered to HTML.**
 *
 * Note that the walk *prunes* rather than filters. A page whose parent is private is private, even
 * though it is inside the subtree — otherwise excluding a section would leave every page under it
 * reachable by anyone who guessed its address, and the nav would simply not mention them. The cost
 * is that forgetting to publish a middle page hides its children, which is the safe direction to be
 * wrong in and is worth saying in the interface.
 *
 * Three things about the anonymous path that the type system cannot hold:
 *
 *   - it runs in a **read-only transaction** (`read`, below). Once the workspace is set, row-level
 *     security has stopped being a fence around an anonymous request — the whole workspace is inside
 *     it, which is right for reading a publication and wrong for everything else. Postgres refuses
 *     the write with 25006 instead of a code review catching it;
 *   - **every query carries the publication in its own `WHERE`**. Workspace scope is not publication
 *     scope, and RLS will happily return a page in another space that nobody published;
 *   - **nothing it returns carries an id.** Pages are addressed by path, the cache validator is a
 *     hash rather than the version id, and the rendered HTML is scrubbed of `id` and `data-id`
 *     before it leaves. An id in a public response is a string somebody can try somewhere else.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Publication } from '../../contract/index.js'
import { escapeHtml } from '../render.js'
import { pages, pageVersions, publications } from '../schema.js'
import type { QuireAccess } from './access.js'
import type { QuireVersions } from './versions.js'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

type PublicationRow = typeof publications.$inferSelect

/** How deep a published site may nest before the walk stops descending. */
const MAX_DEPTH = 32
/** How many pages one `create`/`update` will render HTML for before giving up and logging. */
const MAX_BACKFILL = 200
/** How long an unlock token is good for. Short, because there is nothing to revoke it with. */
const TOKEN_TTL_MS = 12 * 60 * 60_000
/** How much of a page's prose a search hit shows around the match. */
const SNIPPET = 180

/**
 * A publication as a client sees it — with `hasPassword` in place of the hash.
 *
 * The hash never leaves this file. It is a hash, a salt and a cost, so shipping it to a browser
 * turns an online guess, which the server can rate-limit, into an offline one, which it cannot.
 * Row-level security is row-level: the column is inside every row the workspace can read, including
 * on the public path once the handler has set the workspace, so "do not select it" is not a
 * protection — mapping through this function is.
 */
export function toPublication(row: PublicationRow): Publication {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Publication['workspaceId'],
    rootPageId: row.rootPageId,
    includeDescendants: row.includeDescendants,
    slug: row.slug,
    hasPassword: row.passwordHash !== null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    ogImageUrl: row.ogImageUrl,
    indexable: row.indexable,
    theme: row.theme as Publication['theme'],
    createdBy: row.createdBy as Publication['createdBy'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * A title reduced to a URL segment, keeping Unicode letters and digits.
 *
 * `[^\p{L}\p{N}]` rather than `[^a-z0-9]`: a Persian or Arabic title would otherwise slugify to
 * nothing at all, and a handbook in Persian would be a tree of `untitled`, `untitled-2`,
 * `untitled-3`. Percent-encoding makes the result URL-safe; readability in the address bar is the
 * browser's job, and every browser shows it decoded.
 */
export function slugifyTitle(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return cleaned || 'untitled'
}

/**
 * What one page contributes to a published site, before its path is worked out.
 *
 * Snake case because these come back from a hand-written recursive query rather than through
 * drizzle's column mapping: `tx.execute` hands back Postgres's own column names.
 *
 * **`RawWalkRow` types what the driver actually returns, and it is not what the query looks like it
 * returns.** A `timestamptz` selected through `tx.execute` arrives as a string, and an `int` may
 * too, because the row never passes through the column mapping that would have parsed it — so
 * `published_at.getTime()` is a `TypeError` at runtime on a path that type-checks perfectly. It
 * cost a green suite: 117 assertions passed while every public read threw, because the sweep in
 * `authz.int.test.ts` compares *what two callers got*, and both of them got the same crash.
 * `walk` narrows once, here, so nothing downstream has to remember.
 */
interface RawWalkRow {
  [column: string]: unknown
  id: string
  parent_id: string | null
  title: string
  icon: string | null
  cover_url: string | null
  position: string
  version_id: string
  published_at: string | Date
  has_html: boolean
  depth: number | string
}

interface WalkRow {
  id: string
  parent_id: string | null
  title: string
  icon: string | null
  cover_url: string | null
  position: string
  version_id: string
  published_at: Date
  has_html: boolean
  depth: number
}

/** The same, addressed. */
export interface PublicNode extends WalkRow {
  path: string
  parentPath: string | null
}

/**
 * Give every page in the walk its path, and nothing else its path.
 *
 * Siblings that slugify the same get `-2`, `-3` in `position` order, which is deterministic from the
 * tree: two people looking at the same site get the same URLs, and nothing has to be stored. The
 * rows arrive ordered by depth and then position, so a parent's path is always known before its
 * children are reached.
 */
export function withPaths(rows: WalkRow[]): PublicNode[] {
  const pathOf = new Map<string, string>()
  const takenUnder = new Map<string | null, Set<string>>()
  const out: PublicNode[] = []
  for (const row of rows) {
    const parentPath = row.parent_id === null ? null : (pathOf.get(row.parent_id) ?? null)
    // A child whose parent did not survive the walk cannot be addressed, so it is not public
    // either. Unreachable while the walk prunes, and it stays correct if it ever stops.
    if (row.parent_id !== null && parentPath === null) continue
    if (row.depth === 0) {
      pathOf.set(row.id, '')
      out.push({ ...row, path: '', parentPath: null })
      continue
    }
    const taken = takenUnder.get(row.parent_id) ?? new Set<string>()
    takenUnder.set(row.parent_id, taken)
    const base = slugifyTitle(row.title)
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
    taken.add(slug)
    const path = parentPath === '' ? slug : `${parentPath}/${slug}`
    pathOf.set(row.id, path)
    out.push({ ...row, path, parentPath })
  }
  return out
}

/** Compare two public paths the way a URL bar does: trimmed of slashes, case-folded, NFC. */
const normalisePath = (path: string): string =>
  path
    .normalize('NFC')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()

/**
 * The public rendering of a stored version.
 *
 * Two passes, in this order because the first needs what the second removes:
 *
 *   1. **Re-point page mentions.** `versions.html` writes `/quire/<space-key>/<page-id>`, which is
 *      an address inside the application: a stranger following it gets a sign-in screen, and the id
 *      in it belongs to a page that may not be public at all. A mention of a page in this
 *      publication becomes a link to its public path; anything else loses its `href` and stays as
 *      readable text.
 *   2. **Strip every identifier.** `id` is the block anchor the editor wrote and `data-id` is the
 *      mentioned page's or person's id — a user id on a public page is a person's identifier handed
 *      to the internet for no reader's benefit.
 *
 * A regular expression over HTML is usually a mistake and is safe here for one specific reason: this
 * HTML was produced by `render.ts`, which escapes every attribute value, so a `"` never appears
 * inside one and `[^"]*` cannot run past the attribute it is in. Prose that happens to contain the
 * text `id="x"` arrives as `id=&quot;x&quot;` and is left alone. `publications.int.test.ts` holds
 * that with a code block written to look like markup.
 */
export function publicHtml(
  html: string,
  publicPathOf: (pageId: string) => string | null,
  basePath: string,
): string {
  const linked = html.replace(/href="\/quire\/[^"/]*\/([0-9a-fA-F-]{36})"/g, (_match, pageId: string) => {
    const path = publicPathOf(pageId)
    return path === null ? '' : `href="${escapeHtml(basePath + encodeURI(path))}"`
  })
  return linked.replace(/ (?:data-)?id="[^"]*"/g, '')
}

/** A plain-text window around the first match, for a search result. */
export function snippetAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return flat.slice(0, SNIPPET)
  const from = Math.max(0, at - Math.floor(SNIPPET / 3))
  const to = Math.min(flat.length, from + SNIPPET)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

/** `%`, `_` and `\` mean something to `ILIKE`, so a reader searching for `50%` gets `50%`. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

export function quirePublications(kernel: Kernel, access: QuireAccess, versions: QuireVersions) {
  /**
   * The associated data an unlock token is sealed with.
   *
   * AES-GCM authenticates it, so a token minted for one publication cannot be presented to another
   * — and a token from another instance cannot be presented at all, because the key is derived from
   * that instance's own secret. This is what makes the token a capability rather than a session:
   * there is nothing on the server to look up, nothing to expire on a schedule, and nothing that
   * says who is holding it.
   */
  const aad = (workspaceId: string, publicationId: string) =>
    `quire.publication.unlock:${workspaceId}:${publicationId}`

  async function hashPassword(plain: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await scrypt(plain.normalize('NFC'), salt, 32, { N: 16384, r: 8, p: 1 })
    return `$scrypt$N=16384,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`
  }

  /**
   * Constant-time in the comparison, and deliberately not in the parse: a malformed stored hash is
   * a bug in this file rather than something an attacker can produce, and answering `false` for one
   * is the safe direction.
   */
  async function verifyPassword(plain: string, phc: string): Promise<boolean> {
    const parts = phc.split('$')
    if (parts.length !== 5 || parts[1] !== 'scrypt') return false
    const params = Object.fromEntries(
      (parts[2] ?? '').split(',').map((pair) => {
        const [k, v] = pair.split('=')
        return [k ?? '', Number(v)]
      }),
    )
    const salt = Buffer.from(parts[3] ?? '', 'base64url')
    const expected = Buffer.from(parts[4] ?? '', 'base64url')
    if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p))
      return false
    if (salt.length === 0 || expected.length === 0) return false
    const actual = await scrypt(plain.normalize('NFC'), salt, expected.length, {
      N: params.N as number,
      r: params.r as number,
      p: params.p as number,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  /**
   * The walk, as one recursive query.
   *
   * `cycle` is not paranoia: a page that had somehow become its own ancestor would otherwise hang
   * the connection rather than fail, and this is the one endpoint where a hung connection is
   * something a stranger can ask for. `depth < MAX_DEPTH` bounds the other direction.
   */
  async function walk(
    tx: Tx,
    workspaceId: string,
    pub: PublicationRow,
    opts: { requireHtml: boolean },
  ): Promise<WalkRow[]> {
    const rendered = opts.requireHtml
    const res = await tx.execute<RawWalkRow>(sql`
      with recursive tree as (
        select p.id, p.parent_id, p.title, p.icon, p.cover_url, p.position,
               v.id as version_id, v.created_at as published_at,
               (v.html is not null) as has_html, 0 as depth
          from mod_quire.pages p
          join mod_quire.page_versions v
            on v.workspace_id = p.workspace_id and v.id = p.published_version_id
         where p.workspace_id = ${workspaceId}::uuid
           and p.id = ${pub.rootPageId}::uuid
           and p.kind = 'page'
           and p.database_id is null
           and p.deleted_at is null
           and p.archived_at is null
           and p.excluded_from_public = false
           and (${rendered}::boolean = false or v.html is not null)
        union all
        select c.id, c.parent_id, c.title, c.icon, c.cover_url, c.position,
               cv.id, cv.created_at, (cv.html is not null), tree.depth + 1
          from mod_quire.pages c
          join tree on c.parent_id = tree.id
          join mod_quire.page_versions cv
            on cv.workspace_id = ${workspaceId}::uuid and cv.id = c.published_version_id
         where c.workspace_id = ${workspaceId}::uuid
           and ${pub.includeDescendants}::boolean
           and c.kind = 'page'
           and c.database_id is null
           and c.deleted_at is null
           and c.archived_at is null
           and c.excluded_from_public = false
           and tree.depth < ${MAX_DEPTH}
           and (${rendered}::boolean = false or cv.html is not null)
      ) cycle id set looped using cyclepath
      select id, parent_id, title, icon, cover_url, position,
             version_id, published_at, has_html, depth
        from tree
       order by depth asc, position asc
    `)
    return res.rows.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      title: row.title,
      icon: row.icon,
      cover_url: row.cover_url,
      position: row.position,
      version_id: row.version_id,
      published_at: row.published_at instanceof Date ? row.published_at : new Date(row.published_at),
      has_html: row.has_html === true,
      depth: Number(row.depth),
    }))
  }

  return {
    /**
     * The anonymous path's transaction: the workspace set, and nothing writable.
     *
     * `set transaction read only` is issued after `withWorkspace`'s own `set_config`, which
     * Postgres allows — the access mode is fixed by the first *write*, not by the first statement —
     * and covers `pages` and `page_versions` as well as `publications`. It is the second fence, not
     * the first: the first is that every query below carries the publication.
     */
    read<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return kernel.database.withWorkspace(
        workspaceId,
        async (tx) => {
          await tx.execute(sql`set transaction read only`)
          return fn(tx)
        },
        { userId: null },
      )
    },

    /**
     * The publication behind a slug, or `notFound`.
     *
     * Expiry is checked here rather than by a sweep, so the URL stops working at the moment its
     * author said it would even if nothing has run since. Everything that cannot be served answers
     * the same 404: a slug nobody has taken, one that has expired, and one whose root page has
     * since been trashed are indistinguishable from outside, which is the point.
     */
    async bySlug(tx: Tx, workspaceId: string, slug: string): Promise<PublicationRow> {
      const [row] = await tx
        .select()
        .from(publications)
        .where(and(eq(publications.workspaceId, workspaceId), eq(publications.slug, slug)))
        .limit(1)
      if (!row) throw new KernError('NOT_FOUND', 'There is no published site at this address')
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
        throw new KernError('NOT_FOUND', 'There is no published site at this address')
      return row
    },

    /** Whether this request may see anything but the door. */
    async unlocked(pub: PublicationRow, token: string | null): Promise<boolean> {
      if (!pub.passwordHash) return true
      if (!token) return false
      try {
        const claims = JSON.parse(kernel.secrets.decrypt(token, aad(pub.workspaceId, pub.id))) as {
          exp?: unknown
        }
        return typeof claims.exp === 'number' && claims.exp > Date.now()
      } catch {
        // A forged, truncated, re-used-from-another-publication or simply stale token is not an
        // error worth reporting to whoever sent it — it is a locked door.
        return false
      }
    },

    async mintToken(pub: PublicationRow): Promise<{ token: string; expiresAt: string }> {
      const exp = Date.now() + TOKEN_TTL_MS
      return {
        token: kernel.secrets.encrypt(JSON.stringify({ exp }), aad(pub.workspaceId, pub.id)),
        expiresAt: new Date(exp).toISOString(),
      }
    },

    async checkPassword(pub: PublicationRow, password: string): Promise<boolean> {
      if (!pub.passwordHash) return false
      return verifyPassword(password, pub.passwordHash)
    },

    /** Every publicly reachable page of this publication, addressed, root first. */
    async tree(tx: Tx, workspaceId: string, pub: PublicationRow): Promise<PublicNode[]> {
      return withPaths(await walk(tx, workspaceId, pub, { requireHtml: true }))
    },

    /** The node at a public path, or `notFound`. Never an id — `path` names a place or nothing. */
    find(nodes: PublicNode[], path: string): PublicNode {
      const wanted = normalisePath(path)
      const node = nodes.find((n) => normalisePath(n.path) === wanted)
      if (!node) throw new KernError('NOT_FOUND', 'There is no published page at this address')
      return node
    },

    /** The pinned version's stored HTML, scrubbed for the internet. */
    async html(
      tx: Tx,
      workspaceId: string,
      node: PublicNode,
      nodes: PublicNode[],
      basePath: string,
    ): Promise<string> {
      const [row] = await tx
        .select({ html: pageVersions.html })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.id, node.version_id)))
        .limit(1)
      /*
       * `=== null`, not falsy. `''` and NULL mean different things in this column and the
       * difference is the whole reason it is nullable: NULL is "nobody has drawn this version",
       * which is not servable, and `''` is "this version draws to nothing", which is a page
       * somebody published while it was empty and is perfectly servable. Treating them the same
       * way 404s a real page — it did, on every page in the fixture whose prose the renderer could
       * not decode.
       */
      if (!row || row.html === null)
        throw new KernError('NOT_FOUND', 'There is no published page at this address')
      const pathById = new Map(nodes.map((n) => [n.id, n.path]))
      return publicHtml(row.html, (id) => pathById.get(id) ?? null, basePath)
    },

    /**
     * Search the published text of this publication's pages.
     *
     * The ids come from the walk, so the search cannot reach outside the publication however the
     * query is written — and it reads `page_versions.text`, which is the published copy, rather than
     * `pages.text`, which mirrors the live document.
     */
    async search(
      tx: Tx,
      workspaceId: string,
      nodes: PublicNode[],
      query: string,
      limit: number,
    ): Promise<Array<{ node: PublicNode; snippet: string }>> {
      const versionIds = nodes.map((n) => n.version_id)
      if (versionIds.length === 0) return []
      const pattern = `%${escapeLike(query.trim())}%`
      const rows = await tx
        .select({ id: pageVersions.id, text: pageVersions.text })
        .from(pageVersions)
        .where(
          and(
            eq(pageVersions.workspaceId, workspaceId),
            inArray(pageVersions.id, versionIds),
            sql`${pageVersions.text} ilike ${pattern}`,
          ),
        )
        .limit(limit)
      const byVersion = new Map(nodes.map((n) => [n.version_id, n]))
      const hits: Array<{ node: PublicNode; snippet: string }> = []
      for (const row of rows) {
        const node = byVersion.get(row.id)
        if (node) hits.push({ node, snippet: snippetAround(row.text, query) })
      }
      // Titles are worth matching too, and they are already in hand rather than in the database.
      for (const node of nodes) {
        if (hits.length >= limit) break
        if (hits.some((h) => h.node.id === node.id)) continue
        if (node.title.toLowerCase().includes(query.trim().toLowerCase())) hits.push({ node, snippet: '' })
      }
      return hits.slice(0, limit)
    },

    /**
     * A cache validator for a pinned version that is not the version's id.
     *
     * The id addresses `versions.get`, which asks a permission; a hash of it changes exactly when
     * the pinned version does and can be tried nowhere.
     */
    etagFor(versionId: string): string {
      return createHash('sha256').update(`quire.public.v1:${versionId}`).digest('base64url').slice(0, 32)
    },

    // ---------------------------------------------------------------- authenticated side

    /** Every publication rooted at a page of this space, newest first. */
    async list(tx: Tx, workspaceId: string, spaceId: string): Promise<PublicationRow[]> {
      return tx
        .select({ pub: publications })
        .from(publications)
        .innerJoin(
          pages,
          and(eq(pages.workspaceId, publications.workspaceId), eq(pages.id, publications.rootPageId)),
        )
        .where(and(eq(publications.workspaceId, workspaceId), eq(pages.spaceId, spaceId)))
        .orderBy(desc(publications.createdAt))
        .then((rows) => rows.map((r) => r.pub))
    },

    async row(tx: Tx, workspaceId: string, publicationId: string): Promise<PublicationRow> {
      const [row] = await tx
        .select()
        .from(publications)
        .where(and(eq(publications.workspaceId, workspaceId), eq(publications.id, publicationId)))
        .limit(1)
      if (!row) throw KernError.notFound('Publication')
      return row
    },

    async create(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: {
        rootPageId: string
        slug: string
        includeDescendants: boolean
        password: string | null
        expiresAt: string | null
        seoTitle: string
        seoDescription: string
        ogImageUrl: string | null
        indexable: boolean
        theme: Publication['theme']
      },
    ): Promise<PublicationRow> {
      const root = await access.pageRow(tx, workspaceId, input.rootPageId)
      if (root.kind !== 'page')
        throw KernError.badRequest('Only a page can be published; a live doc and a database cannot')
      const [row] = await tx
        .insert(publications)
        .values({
          workspaceId,
          rootPageId: input.rootPageId,
          includeDescendants: input.includeDescendants,
          slug: input.slug,
          passwordHash: input.password ? await hashPassword(input.password) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          seoTitle: input.seoTitle,
          seoDescription: input.seoDescription,
          ogImageUrl: input.ogImageUrl,
          indexable: input.indexable,
          theme: input.theme,
          createdBy: principal.userId,
        })
        .returning()
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === '23505')
            throw KernError.conflict('That address is already taken in this workspace', 'quire.slug.taken')
          throw err
        })
      return row!
    },

    async update(
      tx: Tx,
      workspaceId: string,
      publicationId: string,
      patch: {
        slug?: string
        includeDescendants?: boolean
        password?: string | null
        expiresAt?: string | null
        seoTitle?: string
        seoDescription?: string
        ogImageUrl?: string | null
        indexable?: boolean
        theme?: Publication['theme']
      },
    ): Promise<PublicationRow> {
      await this.row(tx, workspaceId, publicationId)
      const values: Partial<typeof publications.$inferInsert> = { updatedAt: new Date() }
      if (patch.slug !== undefined) values.slug = patch.slug
      if (patch.includeDescendants !== undefined) values.includeDescendants = patch.includeDescendants
      // Three-valued: a string sets, `null` removes, absent leaves alone. See the contract.
      if (patch.password !== undefined)
        values.passwordHash = patch.password === null ? null : await hashPassword(patch.password)
      if (patch.expiresAt !== undefined)
        values.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt)
      if (patch.seoTitle !== undefined) values.seoTitle = patch.seoTitle
      if (patch.seoDescription !== undefined) values.seoDescription = patch.seoDescription
      if (patch.ogImageUrl !== undefined) values.ogImageUrl = patch.ogImageUrl
      if (patch.indexable !== undefined) values.indexable = patch.indexable
      if (patch.theme !== undefined) values.theme = patch.theme
      const [row] = await tx
        .update(publications)
        .set(values)
        .where(and(eq(publications.workspaceId, workspaceId), eq(publications.id, publicationId)))
        .returning()
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === '23505')
            throw KernError.conflict('That address is already taken in this workspace', 'quire.slug.taken')
          throw err
        })
      return row!
    },

    async remove(tx: Tx, workspaceId: string, publicationId: string): Promise<void> {
      await this.row(tx, workspaceId, publicationId)
      await tx
        .delete(publications)
        .where(and(eq(publications.workspaceId, workspaceId), eq(publications.id, publicationId)))
    },

    /** "Never public", on the page rather than on any one publication. */
    async setExcluded(tx: Tx, workspaceId: string, pageId: string, excluded: boolean): Promise<boolean> {
      await access.pageRow(tx, workspaceId, pageId)
      const [row] = await tx
        .update(pages)
        .set({ excludedFromPublic: excluded, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .returning({ excluded: pages.excludedFromPublic })
      return row?.excluded ?? excluded
    },

    /**
     * Draw one version and keep the drawing.
     *
     * Called when a page is published, so the work happens once per publish rather than once per
     * anonymous read — the version is immutable, so every render of it would be identical. Already
     * rendered is a no-op, which is what makes it safe to call from both `publish` and the backfill.
     */
    async renderVersion(tx: Tx, workspaceId: string, versionId: string): Promise<void> {
      const [row] = await tx
        .select({ id: pageVersions.id, state: pageVersions.state, html: pageVersions.html })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.id, versionId)))
        .limit(1)
      if (!row || row.html !== null) return
      const html = await versions.html(tx, workspaceId, row.state)
      await tx
        .update(pageVersions)
        .set({ html })
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.id, versionId)))
    },

    /**
     * Render whatever in this publication's subtree has never been rendered.
     *
     * Only ever needed for a page published before this feature existed — a publish since then
     * writes the HTML as it goes. It runs on `create` and `update` because that is the moment an
     * author is asking for the site to work, and it is bounded: past `MAX_BACKFILL` the rest are
     * left to be rendered when they are next published, and the gap is a warning rather than a
     * failed request. A page whose HTML is missing is simply not part of the site yet, which is the
     * same rule as a page with no published version.
     */
    async backfill(tx: Tx, workspaceId: string, pub: PublicationRow): Promise<number> {
      const all = await walk(tx, workspaceId, pub, { requireHtml: false })
      const missing = all.filter((r) => !r.has_html)
      if (missing.length > MAX_BACKFILL)
        kernel.log.warn(
          { publicationId: pub.id, pending: missing.length, cap: MAX_BACKFILL },
          'too many unrendered versions to publish in one request',
        )
      for (const row of missing.slice(0, MAX_BACKFILL))
        await this.renderVersion(tx, workspaceId, row.version_id)
      return Math.min(missing.length, MAX_BACKFILL)
    },
  }
}
export type QuirePublications = ReturnType<typeof quirePublications>
