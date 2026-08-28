/**
 * What a macro is allowed to say, to the person actually reading.
 *
 * Five of the eight macros draw pages that are not in the document — `pageChildren`,
 * `excerptInclude`, `includePage`, `recentlyUpdated` and `contributors`. Everything about them that
 * matters is in this file, because this is the only place that decides *which* pages, and the
 * decision is the feature's whole risk: a children macro that forgets its filter still compiles,
 * still renders, and looks right to the author, because the author can read everything on it.
 *
 * The rule, in three parts, and `macros.int.test.ts` holds all three:
 *
 *   1. **The renderer never reads a database.** `renderPageDoc` draws a reading macro only from a
 *      `MacroResolver` it was handed. With none — which is what every caller written before this
 *      feature passes, the exporters and the publish-time render included — a reading macro draws
 *      its frame and nothing else. Fail-closed is the default rather than a branch to remember.
 *   2. **A signed-in reader sees exactly what they could open.** Every page named here is asked
 *      about with `quire.page.view` at *page* scope, so a DENY bound to one page removes it.
 *   3. **A published site has no reader, so the publication is the audience.** The set of publicly
 *      reachable pages — which `publications.walk` already computes, root first and pruned — is the
 *      whole of what exists. Anything outside it is not drawn as a title with a dead link; it is
 *      not drawn.
 *
 * Two structural choices follow from that and are worth stating rather than leaving to be inferred.
 *
 * **Resolution is a pass, not a per-node lookup.** `macrosIn` collects the reading macros in a
 * document and de-duplicates them by their attributes, this file answers them against one audience,
 * and `renderPageDoc` reads the answers out of a map. The alternative — resolving inside the
 * renderer — is a database round trip per macro in render order, on a request that is otherwise two
 * queries, and it would make the renderer async for every caller that has no macros at all.
 *
 * **A prune is not a filter.** Where a page is not visible, its descendants go with it. Removing a
 * page from a children list and then listing its children anyway would name every page under it to
 * whoever guessed there was something there, which is exactly the shape `publications.ts`'s walk
 * exists to avoid — and the reason that walk prunes is the reason this one does.
 */
import type { Principal } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import {
  PAGE_MACRO_MAX_DEPTH,
  PAGE_MACRO_MAX_ROWS,
  type PageDoc,
  type PageDocNode,
} from '@kernhq/ui/editor/page-doc'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { pageDocFromBase64, pageDocFromState } from '../document.js'
import {
  type MacroContent,
  type MacroPageRef,
  type MacroResolver,
  macroKey,
  macrosIn,
  renderPageDoc,
  textFromPageDoc,
} from '../render.js'
import { pages, pageVersions } from '../schema.js'
import type { QuireAccess } from './access.js'
import { documentNameOf } from './pages.js'

/**
 * Who is being drawn for.
 *
 * A discriminated union with exactly two members, and there is deliberately no third: a caller
 * cannot express "resolve this for nobody in particular", because that is the shape that leaks. A
 * caller with no audience passes no resolver at all, and the renderer draws empty frames.
 */
export type MacroAudience =
  | { kind: 'reader'; principal: Principal }
  /**
   * The publicly reachable pages, as `publications.walk` computed them for *this* publication.
   * A set rather than a publication id, so this file cannot disagree with the walk about what
   * "public" means — there is only one definition of it and it is not here.
   */
  | { kind: 'publication'; pageIds: ReadonlySet<string> }

export interface MacroContext {
  /** The page the document belongs to. `null` for a render with no page — a preview, an import. */
  pageId: string | null
  /** Where to send a reader for a page id, if this render has addresses at all. */
  pageHref?: (pageId: string) => string | null
  /** For the dates a list macro draws. `principal.locale` for a reader; the site's for a publication. */
  locale?: string | null
}

/**
 * How much one macro may ask for.
 *
 * The document decides how much work a request does, so these are enforced here as well as in the
 * editor: a `depth` of 900 in a page somebody pasted in is a recursive query somebody pasted in.
 * The editor's own clamps are the same constants, out of `page-doc.ts` — the one file in
 * `@kernhq/ui` that imports nothing and is safe to load in a backend process.
 */
const MAX_DEPTH = PAGE_MACRO_MAX_DEPTH
const MAX_ROWS = PAGE_MACRO_MAX_ROWS

/**
 * How many rows a "recently updated" macro reads before filtering.
 *
 * It has to over-fetch, because the filter runs after the sort: the newest twenty-five pages in a
 * space are not the newest twenty-five *this reader may see*. Four times the ceiling is the
 * compromise — a reader denied three quarters of a space still fills the list, and the query stays
 * one bounded index scan rather than a walk of the whole space. A reader denied more than that gets
 * a short list, which is honest: the alternative is paging until the list is full, which is a
 * query whose cost is set by how much somebody is not allowed to see.
 */
const RECENT_CANDIDATES = MAX_ROWS * 4

/** How long an excerpt drawn beside a title may be, before it stops being a hint and becomes prose. */
const EXCERPT_CHARS = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A page id out of a document, or null.
 *
 * The same narrowing `macroPageId` applies in the editor, restated for the same reason the status
 * tones are: this file must not load the extension. A value that is not a uuid reaches a
 * `= $1::uuid` and turns a macro nobody can see into a 500 on the page that holds it.
 */
const pageIdAttr = (value: unknown): string | null =>
  typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null

/** A whole number inside a range, or the fallback — never the string that was in the document. */
function countAttr(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

const flagAttr = (value: unknown): boolean => value === true || value === 'true'

const CHILDREN_SORTS = ['position', 'title', 'updated'] as const
type ChildrenSort = (typeof CHILDREN_SORTS)[number]
const sortAttr = (value: unknown): ChildrenSort =>
  (CHILDREN_SORTS as readonly string[]).includes(String(value)) ? (value as ChildrenSort) : 'position'

const RECENT_SCOPES = ['space', 'subtree'] as const
type RecentScope = (typeof RECENT_SCOPES)[number]
const scopeAttr = (value: unknown): RecentScope =>
  (RECENT_SCOPES as readonly string[]).includes(String(value)) ? (value as RecentScope) : 'space'

/** One row of the page table, as every macro here reads it. */
interface PageRow {
  id: string
  parentId: string | null
  spaceId: string
  title: string
  icon: string | null
  text: string
  updatedAt: Date
}

/** A page and the chain above it, which is what a page-scoped permission question needs. */
interface Scoped extends PageRow {
  ancestorIds: string[]
}

/** Trim flattened prose to something that sits under a title without becoming the page. */
function excerptOf(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  if (clean.length <= EXCERPT_CHARS) return clean
  // Cut at a space so the hint does not end mid-word; fall back to a hard cut for a long token.
  const cut = clean.slice(0, EXCERPT_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${(space > EXCERPT_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The first `excerpt` node in a document, flattened to text.
 *
 * One page, one excerpt: a second is ignored, because "the excerpt" would otherwise mean whichever
 * one the walk happened to reach first, and that is a page whose macro changes meaning when
 * somebody edits a paragraph far away from it. Depth-bounded for the reason `templates.ts` gives —
 * `doc` is whatever was written to a JSONB column, and an adversarially nested document walked
 * recursively is a stack overflow, which in Node is a process rather than an exception.
 */
function markedExcerpt(doc: PageDoc | null, depth = 0): string | null {
  if (!doc || depth > MAX_DEPTH * 4) return null
  for (const node of (doc.content ?? []) as PageDocNode[]) {
    if (node.type === 'excerpt') {
      const text = textFromPageDoc({ type: 'doc', content: node.content ?? [] } as PageDoc)
      const clean = text.replace(/\s+/g, ' ').trim()
      if (clean) return clean
    }
    const nested = markedExcerpt({ type: 'doc', content: node.content ?? [] } as PageDoc, depth + 1)
    if (nested) return nested
  }
  return null
}

export function quireMacros(kernel: Kernel, access: QuireAccess) {
  /**
   * A page's prose, as a document — the live one first.
   *
   * Same order as `templates.ts`'s: what the person looking at the page can see, then the newest
   * stored version for a page the collab service has forgotten or never held. An include that drew
   * last week's published copy while the source page says something else is the kind of wrong that
   * takes a day to notice.
   */
  async function docOfPage(tx: Tx, workspaceId: string, pageId: string): Promise<PageDoc | null> {
    const live = await kernel
      .call<{ state: string | null }>('collab.document.state', {
        name: documentNameOf({ workspaceId, id: pageId }),
      })
      .catch(() => null)
    const fromLive = pageDocFromBase64(live?.state ?? null)
    if (fromLive) return fromLive

    const [version] = await tx
      .select({ state: pageVersions.state })
      .from(pageVersions)
      .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.pageId, pageId)))
      .orderBy(desc(pageVersions.createdAt))
      .limit(1)
    return version ? pageDocFromState(version.state) : null
  }

  const selection = {
    id: pages.id,
    parentId: pages.parentId,
    spaceId: pages.spaceId,
    title: pages.title,
    icon: pages.icon,
    text: pages.text,
    updatedAt: pages.updatedAt,
  }

  /**
   * The pages a macro may consider at all, before anybody is asked about them.
   *
   * Trashed, archived, non-`page` and database rows are excluded here rather than in each macro,
   * because every one of them wants the same answer and the one that forgot would be the leak.
   * A database row is a page, which is exactly why it has to be named: a children macro on a page
   * that happens to hold a database would otherwise draw four thousand rows as a table of contents.
   */
  const drawable = (workspaceId: string) =>
    and(
      eq(pages.workspaceId, workspaceId),
      eq(pages.kind, 'page'),
      isNull(pages.databaseId),
      isNull(pages.deletedAt),
      isNull(pages.archivedAt),
    )

  /**
   * May this audience be shown this page?
   *
   * The one question this file exists to ask, and the only place either audience is interpreted.
   * A publication is a set membership — no principal exists to ask, and the walk that built the set
   * already applied every rule about what public means. A reader is a page-scoped permission check
   * whose parent chain carries every ancestor, so a restriction set on a section applies to
   * everything under it without having been copied down.
   */
  async function visible(workspaceId: string, audience: MacroAudience, page: Scoped): Promise<boolean> {
    if (audience.kind === 'publication') return audience.pageIds.has(page.id)
    return access.canPage(audience.principal, 'quire.page.view', workspaceId, {
      pageId: page.id,
      spaceId: page.spaceId,
      ancestorIds: page.ancestorIds,
    })
  }

  /** A visible page as the renderer wants it. Nothing here is reached for a page that failed the gate. */
  function refOf(
    page: PageRow,
    ctx: MacroContext,
    opts: { excerpt: boolean; updated: boolean },
  ): MacroPageRef {
    return {
      id: page.id,
      title: page.title,
      icon: page.icon,
      href: ctx.pageHref?.(page.id) ?? null,
      updated: opts.updated ? formatDate(page.updatedAt, ctx.locale) : null,
      excerpt: opts.excerpt ? excerptOf(page.text) : null,
    }
  }

  /**
   * A date the reader can read, formatted here because the renderer does no date arithmetic.
   *
   * Through `Intl`, so a Persian workspace gets Persian digits and an Arabic one an Arabic calendar
   * without this file knowing anything about either — the same bargain `templates.ts` makes for a
   * template's `{{date}}`.
   */
  function formatDate(value: Date, locale: string | null | undefined): string | null {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
    try {
      return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'medium' }).format(value)
    } catch {
      return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(value)
    }
  }

  /** The chain above one page, so its children can be asked about without a query per level. */
  async function scopeChain(tx: Tx, workspaceId: string, pageId: string): Promise<string[]> {
    const scope = await access.scopeOf(tx, workspaceId, pageId).catch(() => null)
    return scope ? scope.ancestorIds : []
  }

  /**
   * The visible pages under one page, level by level, pruning as it goes.
   *
   * Breadth-first and one query per level rather than one recursive query, because the permission
   * question is asked *between* levels: a page that fails the gate is never expanded, so its
   * children are not read from the database at all. That is what makes this a prune rather than a
   * filter, and it is also why the loop is bounded by `depth` — the number of queries is the depth
   * the macro asked for, which is at most `MAX_DEPTH`.
   */
  async function childrenTree(
    tx: Tx,
    workspaceId: string,
    audience: MacroAudience,
    ctx: MacroContext,
    root: { id: string; ancestorIds: string[] },
    depth: number,
    sort: ChildrenSort,
    showExcerpt: boolean,
  ): Promise<MacroPageRef[]> {
    const order =
      sort === 'title' ? asc(pages.title) : sort === 'updated' ? desc(pages.updatedAt) : asc(pages.position)

    const top: MacroPageRef[] = []
    // The frontier carries each surviving page's own ancestor chain, which its children inherit.
    let frontier: { ref: MacroPageRef; id: string; ancestorIds: string[] }[] = [
      {
        ref: { id: root.id, title: '', icon: null, href: null, updated: null, excerpt: null },
        id: root.id,
        ancestorIds: root.ancestorIds,
      },
    ]
    let drawn = 0

    for (let level = 0; level < depth && frontier.length > 0 && drawn < MAX_ROWS; level++) {
      const parentIds = frontier.map((entry) => entry.id)
      const rows = await tx
        .select(selection)
        .from(pages)
        .where(and(drawable(workspaceId), inArray(pages.parentId, parentIds)))
        .orderBy(order)
        .limit(MAX_ROWS * 4)

      const next: { ref: MacroPageRef; id: string; ancestorIds: string[] }[] = []
      for (const entry of frontier) {
        for (const row of rows) {
          if (row.parentId !== entry.id) continue
          if (drawn >= MAX_ROWS) break
          const scoped: Scoped = { ...row, ancestorIds: [entry.id, ...entry.ancestorIds] }
          if (!(await visible(workspaceId, audience, scoped))) continue
          const ref = refOf(row, ctx, { excerpt: showExcerpt, updated: false })
          drawn++
          if (level === 0) top.push(ref)
          else {
            entry.ref.children ??= []
            entry.ref.children.push(ref)
          }
          next.push({ ref, id: row.id, ancestorIds: scoped.ancestorIds })
        }
      }
      frontier = next
    }
    return top
  }

  /** The most recently changed pages an audience may see, in a space or under one page. */
  async function recentlyUpdated(
    tx: Tx,
    workspaceId: string,
    audience: MacroAudience,
    ctx: MacroContext,
    home: Scoped,
    scope: RecentScope,
    limit: number,
  ): Promise<MacroPageRef[]> {
    /*
     * A subtree is resolved with one recursive query rather than level by level, because unlike the
     * children macro this list is ordered by time across the whole subtree — there is no level to
     * stop at. The prune is then applied to the result: a page whose ancestor chain contains
     * something the audience cannot see is dropped along with anything under it, which the chain
     * carried on each row makes a check rather than a second walk.
     */
    let rows: PageRow[]
    let chains = new Map<string, string[]>()
    if (scope === 'subtree') {
      const res = await tx.execute<{
        id: string
        parent_id: string | null
        space_id: string
        title: string
        icon: string | null
        text: string
        updated_at: Date | string
        path: string[]
      }>(sql`
        with recursive tree as (
          select p.id, p.parent_id, p.space_id, p.title, p.icon, p.text, p.updated_at,
                 array[]::uuid[] as path, 0 as depth
            from mod_quire.pages p
           where p.workspace_id = ${workspaceId}::uuid
             and p.parent_id = ${home.id}::uuid
             and p.kind = 'page' and p.database_id is null
             and p.deleted_at is null and p.archived_at is null
          union all
          select c.id, c.parent_id, c.space_id, c.title, c.icon, c.text, c.updated_at,
                 tree.path || tree.id, tree.depth + 1
            from mod_quire.pages c
            join tree on c.parent_id = tree.id
           where c.workspace_id = ${workspaceId}::uuid
             and c.kind = 'page' and c.database_id is null
             and c.deleted_at is null and c.archived_at is null
             and tree.depth < ${MAX_DEPTH}
        ) cycle id set looped using cyclepath
        select id, parent_id, space_id, title, icon, text, updated_at, path
          from tree
         order by updated_at desc
         limit ${RECENT_CANDIDATES}
      `)
      rows = res.rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        spaceId: row.space_id,
        title: row.title,
        icon: row.icon,
        text: row.text,
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
      }))
      chains = new Map(
        res.rows.map((row) => [row.id, [...(row.path ?? [])].reverse().concat(home.id, home.ancestorIds)]),
      )
    } else {
      rows = await tx
        .select(selection)
        .from(pages)
        .where(and(drawable(workspaceId), eq(pages.spaceId, home.spaceId)))
        .orderBy(desc(pages.updatedAt))
        .limit(RECENT_CANDIDATES)
    }

    const out: MacroPageRef[] = []
    for (const row of rows) {
      if (out.length >= limit) break
      /*
       * A space-scoped list has no walk to carry a chain, so each surviving row is asked about with
       * its own ancestors. `scopeOf` is one recursive query per row, which is why the candidate set
       * is bounded — and why the subtree branch, which already knows every chain, does not pay it.
       */
      const ancestorIds = chains.get(row.id) ?? (await scopeChain(tx, workspaceId, row.id))
      if (!(await visible(workspaceId, audience, { ...row, ancestorIds }))) continue
      out.push(refOf(row, ctx, { excerpt: false, updated: true }))
    }
    return out
  }

  /**
   * Who has written on this page.
   *
   * **A reader only.** Every other public response in this module is scrubbed of anything
   * identifying a person — see the note at the top of `publications.ts` — and a page's authors are
   * the customer's staff rather than the page's content. Somebody who wants a byline on a published
   * page writes one. That decision is made by having no publication branch at all rather than by
   * returning an empty list from one, so a later edit cannot turn it back on by accident.
   */
  async function contributors(
    tx: Tx,
    workspaceId: string,
    audience: MacroAudience,
    home: Scoped,
    limit: number,
  ): Promise<MacroContent | null> {
    if (audience.kind !== 'reader') return null
    if (!(await visible(workspaceId, audience, home))) return null

    const [row] = await tx
      .select({ createdBy: pages.createdBy, updatedBy: pages.updatedBy })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, home.id)))
      .limit(1)

    // Newest first, so a long-lived page credits whoever has been working on it lately.
    const versions = await tx
      .select({ authorId: pageVersions.authorId })
      .from(pageVersions)
      .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.pageId, home.id)))
      .orderBy(desc(pageVersions.createdAt))
      .limit(RECENT_CANDIDATES)

    const ordered: string[] = []
    const seen = new Set<string>()
    for (const id of [row?.updatedBy, ...versions.map((v) => v.authorId), row?.createdBy]) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
      if (ordered.length >= limit) break
    }
    if (ordered.length === 0) return null

    /*
     * Names from core, which is the only thing that has them. A lookup that fails draws no
     * contributors rather than a list of ids: an id is not a name, and printing one on somebody's
     * page is both useless and a string a reader can try somewhere else.
     */
    const people = await kernel
      .call<{ id: string; name: string | null }[]>('core.users.list', { ids: ordered })
      .catch(() => null)
    if (!people) return null

    const byId = new Map(people.map((person) => [person.id, person.name]))
    const named = ordered
      .map((id) => byId.get(id))
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map((name) => ({ name }))
    return named.length > 0 ? { kind: 'people', people: named } : null
  }

  /** The page a macro points at, with its chain, or null when it is not drawable at all. */
  async function targetPage(tx: Tx, workspaceId: string, pageId: string): Promise<Scoped | null> {
    const [row] = await tx
      .select(selection)
      .from(pages)
      .where(and(drawable(workspaceId), eq(pages.id, pageId)))
      .limit(1)
    if (!row) return null
    return { ...row, ancestorIds: await scopeChain(tx, workspaceId, row.id) }
  }

  return {
    /**
     * Answer every reading macro in a document, for one audience, in one pass.
     *
     * Returns the synchronous lookup `renderPageDoc` takes. A macro this could not answer — a page
     * that was deleted, a page the audience may not see, a lookup that failed — is simply absent
     * from the map, and an absent answer is the empty frame. There is no path through this function
     * that returns a page the audience failed the gate on, and no way to express one: `visible` is
     * the only thing that builds a `MacroPageRef`'s input, and every caller of `refOf` has just
     * awaited it.
     */
    async resolve(
      tx: Tx,
      workspaceId: string,
      doc: PageDoc | null | undefined,
      audience: MacroAudience,
      ctx: MacroContext,
    ): Promise<MacroResolver> {
      const nodes = macrosIn(doc)
      if (nodes.length === 0) return () => null

      /*
       * The page the document is on, which four of the five macros need — as the default target,
       * as the space a recent list is drawn from, and as the page a byline is about. Without one
       * (a preview, an import) only a macro carrying an explicit page id can resolve, and the rest
       * draw empty frames.
       */
      const home = ctx.pageId ? await targetPage(tx, workspaceId, ctx.pageId) : null

      const answers = new Map<string, MacroContent>()
      for (const node of nodes) {
        const content = await resolveOne(tx, workspaceId, audience, ctx, home, node)
        if (content) answers.set(macroKey(node), content)
      }
      return (node: PageDocNode) => answers.get(macroKey(node)) ?? null
    },
  }

  async function resolveOne(
    tx: Tx,
    workspaceId: string,
    audience: MacroAudience,
    ctx: MacroContext,
    home: Scoped | null,
    node: PageDocNode,
  ): Promise<MacroContent | null> {
    const attrs = node.attrs ?? {}
    /*
     * `pageId` null means "the page this macro is on" — what almost every use of a children macro
     * wants, and what keeps it working after the page is copied into a template or duplicated.
     */
    const named = pageIdAttr(attrs.pageId)

    switch (node.type) {
      case 'pageChildren': {
        const root = named ? await targetPage(tx, workspaceId, named) : home
        if (!root) return null
        /*
         * The root of a children list is asked about too. Pointing a macro at a page the reader may
         * not see must not list that page's children — the parent is the permission boundary its
         * children inherit, so skipping this check would make the macro a way around it.
         */
        if (!(await visible(workspaceId, audience, root))) return null
        const pages_ = await childrenTree(
          tx,
          workspaceId,
          audience,
          ctx,
          root,
          countAttr(attrs.depth, 1, MAX_DEPTH, 1),
          sortAttr(attrs.sort),
          flagAttr(attrs.showExcerpt),
        )
        return { kind: 'pages', pages: pages_ }
      }

      case 'recentlyUpdated': {
        const anchor = named ? await targetPage(tx, workspaceId, named) : home
        if (!anchor) return null
        if (!(await visible(workspaceId, audience, anchor))) return null
        const rows = await recentlyUpdated(
          tx,
          workspaceId,
          audience,
          ctx,
          anchor,
          scopeAttr(attrs.scope),
          countAttr(attrs.limit, 1, MAX_ROWS, 10),
        )
        return { kind: 'pages', pages: rows }
      }

      case 'excerptInclude': {
        const target = named ? await targetPage(tx, workspaceId, named) : null
        if (!target) return null
        if (!(await visible(workspaceId, audience, target))) return null
        /*
         * The marked excerpt where the source page has one, its opening prose where it does not —
         * plain text either way. Lifting markup out of one document into another is how a half-open
         * tag becomes the reader's problem on a page they did not write.
         */
        const marked = markedExcerpt(await docOfPage(tx, workspaceId, target.id))
        const text = marked ?? excerptOf(target.text)
        if (!text) return null
        const ref = refOf(target, ctx, { excerpt: false, updated: false })
        return { kind: 'page', page: { ...ref, excerpt: text }, html: '' }
      }

      case 'includePage': {
        const target = named ? await targetPage(tx, workspaceId, named) : null
        if (!target) return null
        if (!(await visible(workspaceId, audience, target))) return null
        const doc = await docOfPage(tx, workspaceId, target.id)
        if (!doc) return null
        /*
         * **The included page is rendered with no resolver of its own**, so its macros draw empty
         * frames. Two reasons, and the first is sufficient: a page that includes a page that
         * includes the first is a cycle, and a cycle here is a request that never returns. The
         * second is that a macro one level down would be resolved against an audience that reached
         * it through two pages' permissions, which is a question nobody asked and this file would
         * have to invent an answer to. One level of transclusion, stated rather than discovered.
         *
         * The HTML this produces is the only string the renderer emits unescaped, and this is the
         * only place that produces it — by calling the same `renderPageDoc` that escapes everything
         * else. See the note on `MacroContent`.
         */
        const html = renderPageDoc(doc, { pageHref: ctx.pageHref })
        return { kind: 'page', page: refOf(target, ctx, { excerpt: false, updated: false }), html }
      }

      case 'contributors': {
        if (!home) return null
        return contributors(tx, workspaceId, audience, home, countAttr(attrs.limit, 1, MAX_ROWS, 10))
      }

      default:
        return null
    }
  }
}

export type QuireMacros = ReturnType<typeof quireMacros>
