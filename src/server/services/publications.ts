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
import { PUBLIC_ASSET_SEGMENT } from '../../contract/index.js'
import { escapeHtml } from '../render.js'
import { pages, pageVersions, publications } from '../schema.js'
import type { QuireAccess } from './access.js'

/** A workspace segment is either its uuid or its slug; anything else is not an address. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * A public URL names its workspace by slug or by id; every query needs the id.
 *
 * Exported because two places need it and they are on opposite sides of the module: the anonymous
 * middleware in `_impl.ts`, which is the first thing to see the segment and must not hand a slug to
 * `isModuleEnabled` (whose schema is `z.uuid()`), and `publications.read`, which sets the workspace
 * for row-level security.
 *
 * Resolving it inside this module rather than in `core` is what stops it being an oracle. Core
 * could only answer "is there a workspace called this" — a fact about private workspaces too.
 * Here, a slug naming a workspace with no such publication reaches exactly the same `NOT_FOUND` as
 * a slug nobody has taken, so the answer gives away nothing a published site does not.
 *
 * Returns null rather than throwing; every caller turns that into the one 404.
 */
export async function resolveWorkspaceSegment(kernel: Kernel, segment: string): Promise<string | null> {
  if (UUID_RE.test(segment)) return segment.toLowerCase()
  if (!SLUG_RE.test(segment)) return null
  try {
    const found = (await kernel.call('core.workspaces.list', { q: segment, limit: 50 })) as
      | { items?: { id: string; slug: string }[] }
      | { id: string; slug: string }[]
    const items = Array.isArray(found) ? found : (found?.items ?? [])
    // `q` is a search over names; only an exact slug is an address.
    return items.find((w) => w.slug === segment)?.id?.toLowerCase() ?? null
  } catch {
    // Core unreachable is not "no such site", but the reader is owed one answer either way.
    return null
  }
}

import { ASSET_REFERENCE_PREFIX, type QuireVersions } from './versions.js'

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
 * The largest picture this surface will hand out, and how long a reader may keep one.
 *
 * The bytes come back through an anonymous procedure, so an object with no ceiling on it is a way
 * to spend the server's memory from outside. Over the cap is the same 404 as a picture that is not
 * there — an oversized image on a published page is a defect in the page rather than something to
 * fail a request over. A version is immutable and its reference is sealed to one file, so the cache
 * lifetime is as long as anything in Kern gets.
 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const ASSET_MAX_AGE = 31_536_000
/**
 * What a picture is allowed to be, because the route layer serves these from the app's own origin.
 *
 * A stored content type is whatever an uploader declared, and a reference resolves on the same
 * origin as the signed-in application — so anything the browser would treat as a document rather
 * than as an image is a way to run script beside somebody's session. The node these references come
 * from is an image node, so the list is the image types and nothing else, and an object claiming to
 * be anything else is the same 404 as one that is not there.
 *
 * `image/svg+xml` is on the list and is the one that needs saying: an SVG *is* a document, and it
 * can carry script. It is here because a diagram in a handbook is very often one, and it is safe
 * only because the route layer is required to serve every one of these with `nosniff`, an inline
 * disposition and a `default-src 'none'` policy — see the note on `PublicAsset` in the contract.
 */
const ASSET_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
])
/**
 * How many passwords one publication will weigh in a minute, and why the number is here.
 *
 * `public.unlock` is reachable by anyone on the internet with no account, and every attempt costs
 * the server an scrypt at N=16384 — 600 of them measured at roughly a minute of single-thread work,
 * bought with one unauthenticated burst. The platform's own limiter is a *shared* budget across the
 * whole API rather than a password fence, so a publication needs one of its own.
 *
 * It is per process and therefore multiplied by however many copies of the host service are
 * running, which is honest rather than ideal: a counter that has to be right across a cluster
 * belongs in the platform limiter, and until it is there this is the difference between 864,000
 * guesses a day from one address and 14,400.
 */
const UNLOCK_ATTEMPTS = 10
const UNLOCK_WINDOW_MS = 60_000
/** Above this many publications tracked at once the window is dropped wholesale rather than grown. */
const UNLOCK_TRACKED_MAX = 5000

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
const APP_LINK = /href="\/quire\/[^"]*"/g
const APP_PAGE_LINK =
  /^href="\/quire\/[^"/]*\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#][^"]*)?"$/

/**
 * Pictures, held to the same rule as links: a `src` this module cannot account for does not go out.
 *
 * `render.ts` escapes every attribute value, so `>` never appears inside one and `[^>]*` cannot run
 * past the tag it is in — the same property that makes the link pass above safe.
 *
 * Three shapes reach here and only one of them is servable. A **reference** is what the public
 * render writes and it resolves to an address on this site. An **absolute off-site URL** is an
 * author's own picture hosted somewhere else, and it is left alone. Everything else is dropped
 * together with its `<img>`, and that is deliberately wide: a root-relative `src` is a link into
 * the private application, and a *signed storage URL* — which is what versions published by 0.12.0
 * have stored in them — is the tenant's workspace uuid and a file uuid written into a page on the
 * public internet, with an hour before it stops working. `0009_public_asset_references.sql` rewrites
 * the ones already in the database; this is what covers a row the migration did not reach.
 */
const IMG_TAG = /<img\b[^>]*>/g
const ASSET_SRC = new RegExp(
  ` src="${ASSET_REFERENCE_PREFIX}([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"`,
)
const ANY_SRC = / src="([^"]*)"/
const SIGNED_URL = /[?&](?:amp;)?X-Amz-(?:Signature|Credential)=/i

export function publicHtml(
  html: string,
  basePath: string,
  resolve: {
    /** where a mentioned page is served on this site, or null if it is not public */
    pagePath: (pageId: string) => string | null
    /** where a referenced picture is served on this site, or null if it cannot be handed out */
    assetHref: (fileId: string) => string | null
  },
): string {
  /*
   * Every link into the application, in one pass, and the page id is not anchored on the closing
   * quote.
   *
   * A page mention is not the only thing that writes one of these. `safeHref` passes any
   * root-relative path through — it has to, that is what an internal link is — so an author who
   * pastes a page's address out of their own address bar gets `/quire/<space>/<id>#block-7` or
   * `…?comment=1` or `…/history`, and a pattern that required `"` straight after the id matched
   * none of them and left the whole href alone. That put a live deep link into the private
   * application, carrying the uuid of a page this same API answers 404 for, on the public internet.
   *
   * So: match the whole href, then ask whether it names a page — and if the answer is no for any
   * reason at all (no id in it, an id that is not public, an id with something glued to it), drop
   * the href rather than keep it. One pass rather than two, because `basePath` may legally be
   * `/quire/` and a second sweep would eat the links the first one had just written.
   */
  const linked = html.replace(APP_LINK, (match) => {
    const pageId = APP_PAGE_LINK.exec(match)?.[1] ?? null
    const path = pageId === null ? null : resolve.pagePath(pageId)
    return path === null ? '' : `href="${escapeHtml(basePath + encodeURI(path))}"`
  })
  const pictured = linked.replace(IMG_TAG, (tag) => {
    const fileId = ASSET_SRC.exec(tag)?.[1] ?? null
    if (fileId === null) {
      const src = ANY_SRC.exec(tag)?.[1] ?? ''
      return /^https?:\/\//i.test(src) && !SIGNED_URL.test(src) ? tag : ''
    }
    const href = resolve.assetHref(fileId)
    // A function replacement, because `$&` and friends mean something in a replacement string and
    // a base64url token is not somewhere to find that out.
    return href === null ? '' : tag.replace(ASSET_SRC, () => ` src="${escapeHtml(href)}"`)
  })
  return pictured.replace(/ (?:data-)?id="[^"]*"/g, '')
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

  /**
   * The same mechanism, one scope wider, for a picture reference.
   *
   * Sealed to the **workspace** rather than to one publication, because a version is shared: the
   * same page can be the root of two publications and its stored HTML is rendered once. Widening it
   * costs nothing that matters — a reference only ever exists inside a page somebody has already
   * been served, and resolving one still requires the file to be in the tree of the publication it
   * is presented against.
   */
  const assetAad = (workspaceId: string) => `quire.publication.asset:${workspaceId.toLowerCase()}`

  /** Recent password attempts per publication, for the fence described at `UNLOCK_ATTEMPTS`. */
  const unlockAttempts = new Map<string, number[]>()

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
    /**
     * A public URL names its workspace by slug; every query below needs its id.
     *
     * The address the share dialog copies is `/p/<workspace-slug>/<publication-slug>/`, because a
     * uuid in a link somebody is meant to send to a colleague is not an address, it is a receipt.
     * The `public.*` procedures take an id and have to: anonymous means no principal, so nothing
     * downstream can resolve a slug for itself.
     *
     * Resolving it here rather than in `core` is what stops it becoming an oracle. Core could only
     * answer "is there a workspace called this", which is true whether or not anybody publishes —
     * and that is a fact about a private workspace. Here, a slug that resolves to a workspace with
     * no publication of that name reaches exactly the same `NOT_FOUND` as a slug nobody has taken,
     * so the answer carries no information a published site does not already give away.
     *
     * Returns null rather than throwing: the caller turns every failure into the one 404.
     */
    resolveWorkspace: (segment: string) => resolveWorkspaceSegment(kernel, segment),

    async read<T>(segment: string, fn: (tx: Tx, workspaceId: string) => Promise<T>): Promise<T> {
      /*
       * The segment is resolved here, once, rather than in each of the eight handlers — and a
       * segment that resolves to nothing raises the same `NOT_FOUND` those handlers raise for a
       * page nobody published, so the two are indistinguishable from outside.
       */
      const workspaceId = await this.resolveWorkspace(segment)
      if (!workspaceId) throw KernError.notFound('There is no published site at this address')
      /*
       * Lower-cased before it is set, and that is not tidiness.
       *
       * `withWorkspace` writes the caller's string into `app.workspace_id` verbatim, and every RLS
       * policy compares it as **text** against `workspace_id::text`, which Postgres renders in
       * lower case. So an upper-case uuid in a public URL sets a GUC no policy can ever match: the
       * whole surface returns nothing on a correctly locked-down instance and serves the site
       * normally in development and CI, where the role is a superuser and bypasses the policies
       * altogether. That is the direction that hides a bug rather than the one that shows it, and
       * this is the only anonymous entry point, so it is normalised here.
       */
      return kernel.database.withWorkspace(
        workspaceId,
        async (tx) => {
          await tx.execute(sql`set transaction read only`)
          return fn(tx, workspaceId)
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

    /**
     * Weigh one password, and refuse to weigh too many.
     *
     * The counter is taken *before* the scrypt rather than after the answer, so a burst is stopped
     * at the cost of a map lookup instead of buying the sender a key derivation each time. Only a
     * publication that has a door is ever counted — a slug nobody has taken never reaches here, so
     * the fence cannot be turned into a way of finding out which slugs exist.
     */
    async checkPassword(pub: PublicationRow, password: string): Promise<boolean> {
      if (!pub.passwordHash) return false
      const key = `${pub.workspaceId}:${pub.id}`
      const now = Date.now()
      if (unlockAttempts.size > UNLOCK_TRACKED_MAX) unlockAttempts.clear()
      const recent = (unlockAttempts.get(key) ?? []).filter((at) => at > now - UNLOCK_WINDOW_MS)
      if (recent.length >= UNLOCK_ATTEMPTS) {
        unlockAttempts.set(key, recent)
        throw new KernError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again')
      }
      recent.push(now)
      unlockAttempts.set(key, recent)
      return verifyPassword(password, pub.passwordHash)
    },

    /** The reference a published page carries in place of a picture's address. */
    assetReferenceFor(workspaceId: string, fileId: string): string {
      return kernel.secrets.encrypt(fileId, assetAad(workspaceId))
    },

    /**
     * The bytes of one referenced picture, or `notFound` for every way of not having them.
     *
     * Two questions, and the second is the one that matters. The reference decrypts to a file id —
     * authenticated, so it cannot be forged or moved between instances or workspaces — and then the
     * file has to be *used by a page that is public in this publication right now*. Without that
     * second half a reference lifted from one site would resolve against another in the same
     * workspace, and a page opted out of publishing would keep serving its illustrations after its
     * prose had gone.
     *
     * The containment question is asked of the stored HTML rather than of the document, because the
     * stored HTML is what a reader is actually served: if the reference is not in it, no published
     * page ever asked for this file.
     */
    async asset(
      tx: Tx,
      workspaceId: string,
      nodes: PublicNode[],
      reference: string,
    ): Promise<{ contentType: string; bytes: string; maxAge: number }> {
      const gone = () => new KernError('NOT_FOUND', 'There is no such picture on this site')
      const versionIds = nodes.map((n) => n.version_id)
      if (versionIds.length === 0) throw gone()

      let fileId: string
      try {
        fileId = kernel.secrets.decrypt(reference, assetAad(workspaceId))
      } catch {
        throw gone()
      }
      if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) throw gone()

      const [used] = await tx
        .select({ id: pageVersions.id })
        .from(pageVersions)
        .where(
          and(
            eq(pageVersions.workspaceId, workspaceId),
            inArray(pageVersions.id, versionIds),
            sql`${pageVersions.html} like ${`%${ASSET_REFERENCE_PREFIX}${fileId}%`}`,
          ),
        )
        .limit(1)
      if (!used) throw gone()

      const file = await kernel
        .call<{ key: string; mimeType: string } | null>('core.files.get', { id: fileId })
        .catch(() => null)
      if (!file?.key) throw gone()
      const contentType = (file.mimeType || '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!ASSET_TYPES.has(contentType)) throw gone()

      const head = await kernel.storage.head(file.key).catch(() => null)
      if ((head?.contentLength ?? 0) > MAX_ASSET_BYTES) {
        kernel.log.warn(
          { fileId, bytes: head?.contentLength, cap: MAX_ASSET_BYTES },
          'a published picture is over the public cap and was not served',
        )
        throw gone()
      }

      const object = await kernel.storage.get(file.key).catch(() => null)
      if (!object) throw gone()
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of object.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        size += buf.length
        // `head` is the fast refusal; this is the one that holds when the store did not answer it.
        if (size > MAX_ASSET_BYTES) {
          object.body.destroy()
          throw gone()
        }
        chunks.push(buf)
      }
      return { contentType, bytes: Buffer.concat(chunks).toString('base64'), maxAge: ASSET_MAX_AGE }
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
      return publicHtml(row.html, basePath, {
        pagePath: (id) => pathById.get(id) ?? null,
        // Minted per read rather than stored, so the envelope can be re-keyed and so nothing
        // durable in the database is a capability. `basePath` already ends in a slash.
        assetHref: (fileId) =>
          `${basePath}${PUBLIC_ASSET_SEGMENT}/${encodeURIComponent(
            this.assetReferenceFor(workspaceId, fileId),
          )}`,
      })
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
      // `referenced`, never `signed`: this drawing is *stored*, and a signed URL is the object's
      // key with an hour on it. See the note on `html` in `versions.ts`.
      const html = await versions.html(tx, workspaceId, row.state, { pictures: 'referenced' })
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
