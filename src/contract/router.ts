import { baseContract, Id, PageInput, page, Timestamp, UserId, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import {
  CommentAnchor,
  CommentThread,
  ExportFormat,
  ExportJob,
  ExportScope,
  Favorite,
  ImportJob,
  ImportSource,
  Label,
  LabelColour,
  Ok,
  Page,
  PageKind,
  PageNode,
  PageVersion,
  Publication,
  PublicationTheme,
  RecentView,
  RichDoc,
  Space,
  SpaceVisibility,
  Template,
  TemplateKind,
  TemplateStarterKey,
  TemplateVariable,
} from './models.js'
import {
  Database,
  DatabaseRef,
  Property,
  PropertyConfig,
  PropertyType,
  Row,
  RowRef,
  View,
  ViewConfig,
  ViewKind,
} from './properties.js'

const ws = z.object({ workspaceId: WorkspaceId })

/**
 * What names the workspace in a **public** URL: its id or its slug.
 *
 * The address the share dialog copies is `/p/<workspace-slug>/<publication-slug>/`, because a uuid
 * in a link somebody sends a colleague is a receipt rather than an address. Every `public.*`
 * procedure still needs an id before it touches `mod_quire` — anonymous means no principal, not no
 * tenant — so the slug is resolved at the one anonymous entry point and everything downstream is
 * unchanged. Widened here rather than parsed in the handler because a `z.uuid()` rejects the slug
 * before any handler runs, which is how this shipped answering 404 for its own published URLs.
 */
const WorkspaceSegment = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9a-zA-Z][0-9a-zA-Z-]*$/, 'not a workspace id or slug')
const t = (...tags: string[]) => ({ tags })

/** The page fields a shortcut row draws, so a sidebar is one request rather than one per entry. */
const pageBits = {
  spaceId: Id,
  title: z.string(),
  icon: z.string().nullable(),
  kind: PageKind,
}

/**
 * A favourite as a sidebar draws it: the shortcut, plus enough of its page to render the row.
 *
 * Composed here rather than stored, for the same reason `versions.get` composes its output here —
 * it is the shape of one answer, not a second copy of the page. A favourite whose page has been
 * trashed or purged is not in this list at all: the row survives (nothing cascades), and every read
 * joins to `pages`, so it is simply never drawn.
 */
export const FavoriteEntry = Favorite.extend(pageBits)
export type FavoriteEntry = z.infer<typeof FavoriteEntry>

/** The same, for a page somebody opened recently. */
export const RecentEntry = RecentView.extend(pageBits)
export type RecentEntry = z.infer<typeof RecentEntry>

/**
 * Whether you are watching a page, and who else is.
 *
 * Both in one answer because a watch button has to draw both — its own pressed state and the number
 * beside it — and asking twice within a keystroke of each other is two requests for one control.
 */
export const WatchState = z.object({
  watching: z.boolean(),
  watchers: z.array(UserId),
})
export type WatchState = z.infer<typeof WatchState>

/**
 * A published site addresses its pages by **path, never by id**, and that is a security decision
 * rather than a matter of taste.
 *
 * Every id in a public response is a string somebody can try somewhere else, and the only way to be
 * sure none of them opens a door is for there to be none. So the whole `public.*` surface below
 * carries no page id, no space id, no version id, no user id and no workspace id — a nav entry, a
 * breadcrumb, a search hit and a sitemap line are all `path`, and `path` is built from titles by the
 * server. `publications.int.test.ts` walks every public response and fails on any uuid belonging to
 * anything in the fixture, which is what keeps this true as the shapes grow.
 *
 * The root page's path is the empty string; a child's is its ancestors' slugs joined with `/`, each
 * slug being its title reduced to letters, digits and dashes (Unicode letters, so a Persian title
 * keeps a Persian slug) and suffixed `-2`, `-3` when two siblings would collide.
 */
export const PublicNavEntry = z.object({
  /** '' is the front page; everything else is `parent/child`, already URL-safe once encoded */
  path: z.string(),
  /** null only for the front page — the nav is flat, like `pages.tree`, and rebuilt into a tree */
  parentPath: z.string().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
})
export type PublicNavEntry = z.infer<typeof PublicNavEntry>

/** What is worth saying about a published site once a reader is allowed to see it. */
export const PublicSiteDetail = z.object({
  title: z.string(),
  description: z.string(),
  ogImageUrl: z.string().nullable(),
  /** false means the route layer sends `noindex`. Public and findable are different requests. */
  indexable: z.boolean(),
  /**
   * The newest published version in the whole site.
   *
   * Deliberately *not* the newest `pages.updated_at`: that column moves on every keystroke in a
   * draft, so publishing it would tell the internet when somebody was working on an unpublished
   * change. A published site's freshness is when something was last published.
   */
  updatedAt: Timestamp,
  nav: z.array(PublicNavEntry),
})
export type PublicSiteDetail = z.infer<typeof PublicSiteDetail>

/**
 * A published site, or the door to it.
 *
 * `locked` is the one thing a password-protected site admits before the password: that there is a
 * door. Everything else — the title, the description, the shape of the tree — is behind it, because
 * a nav tree is a table of contents and a table of contents is most of what a private handbook is.
 * `theme` comes out anyway so the challenge screen is not white on a site that is not.
 */
export const PublicSite = z.object({
  slug: z.string(),
  theme: PublicationTheme,
  locked: z.boolean(),
  /** null exactly when `locked` */
  site: PublicSiteDetail.nullable(),
})
export type PublicSite = z.infer<typeof PublicSite>

export const PublicBreadcrumb = z.object({ path: z.string(), title: z.string() })
export type PublicBreadcrumb = z.infer<typeof PublicBreadcrumb>

export const PublicPage = z.object({
  path: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  coverUrl: z.string().nullable(),
  /**
   * The pinned published version, drawn once and stored on the version — never the live document
   * and never the draft — then passed through the public scrub: every `id` and `data-id` attribute
   * removed, and every page mention either re-pointed at its public path or left as plain text.
   */
  html: z.string(),
  publishedAt: Timestamp,
  /**
   * A cache validator for the pinned version, and **not the version's id**.
   *
   * A published page is immutable, so the response is a static read that should be cached until the
   * page is published again — which is what an entity tag is for. It is a hash rather than the id
   * because the id addresses `versions.get`, a procedure that asks a permission: handing it to the
   * internet turns a cache key into something to try.
   */
  etag: z.string(),
  breadcrumbs: z.array(PublicBreadcrumb),
})
export type PublicPage = z.infer<typeof PublicPage>

export const PublicSearchHit = z.object({
  path: z.string(),
  title: z.string(),
  /** plain text from the published version, never from the draft */
  snippet: z.string(),
})
export type PublicSearchHit = z.infer<typeof PublicSearchHit>

export const PublicSitemapEntry = z.object({ path: z.string(), lastModified: Timestamp })

/**
 * An export job, plus the one thing that cannot be stored on it: a link to the artefact.
 *
 * `downloadUrl` is minted per request and is null in every state but `done`. It is composed here
 * rather than written into `export_jobs` because a signed storage URL is the object's key, so a
 * stored one is both an address that leaks the workspace and file uuids and an address that stops
 * working an hour later — and, worse, a fence applied once at the moment the job finished rather
 * than every time somebody asks. A subtree export flattens pages of different readerships into one
 * file, so the moment of the fetch is the moment that has to be checked.
 */
export const ExportJobDetail = ExportJob.extend({ downloadUrl: z.string().nullable() })
export type ExportJobDetail = z.infer<typeof ExportJobDetail>

/**
 * An import job **without its report**, which is the only shape a list can afford to carry.
 *
 * The report is one row per file, and a Notion export is thousands of files — so twenty jobs in a
 * list is a response of megabytes to draw a table of dates and states. `get` carries the whole thing
 * because that screen is somebody looking at one import and asking what happened to their files,
 * which is the question the report exists to answer.
 *
 * Omitted rather than truncated on purpose. A report cut off at fifty rows is one that has quietly
 * stopped being the complete account of the archive, and a person reading "23 skipped" beside a list
 * of twelve would have no way to know which. Absent is a state a client can render; incomplete is not.
 */
export const ImportJobSummary = ImportJob.omit({ report: true })
export type ImportJobSummary = z.infer<typeof ImportJobSummary>

/**
 * One picture from a published page, **as bytes rather than as an address**.
 *
 * A published page used to carry its pictures as presigned storage URLs, written into the stored
 * HTML at publish time. That was wrong twice over, and both halves were measured rather than
 * argued. The URL is the storage key — `ws/<workspaceId>/<module>/<yyyy>/<mm>/<fileId>/<name>` —
 * so every published page with a picture on it handed a stranger the tenant's workspace uuid and a
 * file uuid, on the one surface whose whole rule is that no response carries an id; and a presigned
 * GET expires in an hour while the HTML it was baked into is rendered once and stored for ever, so
 * every image on every published site broke sixty minutes after it was published.
 *
 * So the HTML carries an opaque, workspace-sealed reference and the bytes come through here. The
 * route layer fetches this from **its own server** and streams the body back under a URL of its
 * own; nothing in the answer may reach a browser as-is, which is why it is bytes and not a link —
 * there is no address in it to leak, and none to expire.
 *
 * Capped rather than streamed on purpose: a published handbook's illustration is tens of kilobytes,
 * this path is anonymous, and an unbounded body on an unauthenticated endpoint is a way to spend
 * somebody else's memory. Over the cap answers the same 404 as a picture that is not there.
 */
export const PublicAsset = z.object({
  /**
   * The stored content type, narrowed to an image type before it is answered.
   *
   * The route layer serves these from the application's own origin, so the two things it owes back
   * are `X-Content-Type-Options: nosniff` and, because `image/svg+xml` is a document that can carry
   * script, a `Content-Security-Policy: default-src 'none'` on the response. Anything the server
   * could not narrow to an image is refused here rather than sent for the route layer to be careful
   * with.
   */
  contentType: z.string(),
  /** base64 of the whole object */
  bytes: z.string(),
  /** how long the route layer may cache it; a version is immutable, so this is long */
  maxAge: z.number().int().min(0),
})
export type PublicAsset = z.infer<typeof PublicAsset>

/**
 * The URL prefix the route layer serves this site under, so a link between two published pages is a
 * link and not a dead mention.
 *
 * The module knows a page's path inside its publication and nothing about the address it is served
 * at — one instance mounts a site at `/p/<workspace>/<slug>/`, another at the root of its own
 * domain. Rather than guess, it takes the prefix and refuses anything that is not one: it has to
 * start and end with `/`, and its segments are unreserved characters only. That refusal is the
 * point. `//evil.example/` is a protocol-relative URL wearing the costume of a local path, and a
 * caller that could set it would have every link on somebody's published site point off-site.
 */
export const PublicBasePath = z
  .string()
  .max(200)
  .regex(/^\/(?:[A-Za-z0-9._~-]+\/)*$/, 'an absolute path ending in a slash')
  .default('/')

/**
 * The one thing the module does ask of whatever serves a published site: a place for its pictures.
 *
 * `public.page` writes every `<img src>` as `<basePath><segment>/<reference>`, so the route layer
 * has to answer that address by calling `public.asset` and streaming the bytes back. It is a
 * constant rather than a convention because two sides have to agree on it and only one of them can
 * be wrong quietly — a route layer that does not serve it renders a published page with no
 * pictures, which looks like a rendering bug and is a missing route.
 *
 * The leading `__` is what keeps it out of the way: a page's own path segment is `slugifyTitle`'s
 * output, which is Unicode letters and digits separated by hyphens, so no title can ever produce a
 * segment starting with an underscore and no published page can be shadowed by this one.
 */
export const PUBLIC_ASSET_SEGMENT = '__media'

/**
 * One row of the picker: a shipped starter, or a template somebody saved.
 *
 * The two are one list on purpose. A person choosing what to write does not care which of them came
 * with Kern, so a screen that draws "Templates" and "Your templates" as separate sections is asking
 * them to know something about our packaging — and it makes the override rule invisible, because a
 * starter a workspace has edited would appear in the second list while its shipped twin sat in the
 * first.
 *
 * **`id` is null for a shipped starter, and that is the whole shape of the compromise.** A starter is
 * a constant in the module rather than a row in the customer's database — `migrations/0011` argues
 * why at length — so there is no row for it to have an id, and `key` is what addresses it instead.
 * `instantiate` therefore takes one of the two and refuses both.
 *
 * `name` and `description` arrive **already in the reader's language**. A starter's strings are a
 * table in the module resolved against `principal.locale`, so a client renders whatever it is given
 * and never has to know which entries are ours.
 */
export const TemplateChoice = z.object({
  /** null for a shipped starter — a constant has no row, so it has no id */
  id: Id.nullable(),
  /**
   * The starter this entry is, or replaces; null for somebody's own template.
   *
   * A row carrying a key **stands in for** that starter rather than appearing beside it, so this
   * list never contains two entries with the same key.
   */
  key: z.string().nullable(),
  builtIn: z.boolean(),
  kind: TemplateKind,
  spaceId: Id.nullable(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  variables: z.array(TemplateVariable),
  /** null for a shipped starter nobody has edited — it has no row and therefore no history */
  updatedAt: Timestamp.nullable(),
})
export type TemplateChoice = z.infer<typeof TemplateChoice>

/**
 * What somebody typed into the form a template asked for.
 *
 * Strings whatever the variable's type, because substitution is textual: a `date` variable puts
 * characters into a paragraph exactly as a `text` one does, and the type only ever decided which
 * control the person was shown. Storing a number here would mean the server deciding how to format
 * it, in a locale it would have to guess.
 *
 * A key naming no declared variable is ignored rather than refused — a client one release ahead is
 * a normal thing during a rolling deploy, and refusing the whole page over a spare field is not.
 */
export const TemplateValues = z.record(z.string().max(40), z.string().max(2000))

/**
 * What making something from a template produced.
 *
 * One shape for both kinds, rather than `Page` for one and `Space` for the other. The caller's next
 * move is the same either way — open what was just made — and a union output would make every
 * client branch on `kind` to find out where to navigate. `pageCount` is what the screen reports:
 * a space template that made eleven pages should say so, because that is a lot of pages to have
 * appeared in a sidebar without warning.
 */
export const TemplateResult = z.object({
  /** the new space, for a space template; the space the new page landed in otherwise */
  spaceId: Id,
  /** what to open: the new page, or the first page of the new space's tree. Null for an empty tree. */
  pageId: Id.nullable(),
  pageCount: z.number().int().nonnegative(),
})
export type TemplateResult = z.infer<typeof TemplateResult>

export const quireContract = {
  spaces: {
    list: baseContract
      .route({ method: 'GET', path: '/spaces', ...t('spaces') })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(Space)),
    get: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}', ...t('spaces') })
      .input(ws.extend({ spaceId: Id }))
      .output(Space),
    create: baseContract
      .route({ method: 'POST', path: '/spaces', ...t('spaces') })
      .input(
        ws.extend({
          key: Space.shape.key,
          name: Space.shape.name,
          description: z.string().max(2000).default(''),
          icon: z.string().max(64).nullable().default(null),
          visibility: SpaceVisibility.default('open'),
        }),
      )
      .output(Space),
    update: baseContract
      .route({ method: 'PATCH', path: '/spaces/{spaceId}', ...t('spaces') })
      .input(
        ws.extend({
          spaceId: Id,
          name: Space.shape.name.optional(),
          description: z.string().max(2000).optional(),
          icon: z.string().max(64).nullable().optional(),
          visibility: SpaceVisibility.optional(),
          homepageId: Id.nullable().optional(),
        }),
      )
      .output(Space),
    archive: baseContract
      .route({ method: 'POST', path: '/spaces/{spaceId}/archive', ...t('spaces') })
      .input(ws.extend({ spaceId: Id, archived: z.boolean().default(true) }))
      .output(Space),
  },

  pages: {
    /**
     * The whole tree of one space in one call. A wiki sidebar shows every level at once, and asking
     * per level turns opening a space into a request per expanded node.
     */
    tree: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}/tree', ...t('pages') })
      .input(ws.extend({ spaceId: Id, includeArchived: z.boolean().default(false) }))
      .output(z.array(PageNode)),
    get: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}', ...t('pages') })
      .input(ws.extend({ pageId: Id }))
      .output(Page),
    /** Everything in the space's trash, newest first. */
    trash: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}/trash', ...t('pages') })
      .input(ws.extend({ spaceId: Id }).extend(PageInput.shape))
      .output(page(Page)),
    create: baseContract
      .route({ method: 'POST', path: '/pages', ...t('pages') })
      .input(
        ws.extend({
          spaceId: Id,
          parentId: Id.nullable().default(null),
          title: z.string().max(300).default(''),
          kind: PageKind.default('page'),
          icon: z.string().max(64).nullable().default(null),
          /** place it after this sibling; null means first */
          afterId: Id.nullable().default(null),
        }),
      )
      .output(Page),
    update: baseContract
      .route({ method: 'PATCH', path: '/pages/{pageId}', ...t('pages') })
      .input(
        ws.extend({
          pageId: Id,
          title: z.string().max(300).optional(),
          icon: z.string().max(64).nullable().optional(),
          coverUrl: z.string().max(2048).nullable().optional(),
          kind: PageKind.optional(),
        }),
      )
      .output(Page),
    /** Reparent, reorder, or both. `afterId` is the sibling to land behind; null means first. */
    move: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/move', ...t('pages') })
      .input(ws.extend({ pageId: Id, parentId: Id.nullable(), afterId: Id.nullable().default(null) }))
      .output(Page),
    /** Out of the tree but not gone: still searchable, still restorable, no longer in the sidebar. */
    archive: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/archive', ...t('pages') })
      .input(ws.extend({ pageId: Id, archived: z.boolean().default(true) }))
      .output(Page),
    /** Into the trash, with every descendant. Reversible until `purge`. */
    trashPage: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/trash', ...t('pages') })
      .input(ws.extend({ pageId: Id }))
      .output(z.object({ ok: z.literal(true), count: z.number().int().nonnegative() })),
    restore: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/restore', ...t('pages') })
      .input(ws.extend({ pageId: Id }))
      .output(Page),
    /** Gone, with its collaborative document and every descendant. */
    purge: baseContract
      .route({ method: 'DELETE', path: '/pages/{pageId}', ...t('pages') })
      .input(ws.extend({ pageId: Id }))
      .output(z.object({ ok: z.literal(true), count: z.number().int().nonnegative() })),
    /**
     * The labels on this page, replaced by exactly this set.
     *
     * `set`, not `add`: a picker with three labels ticked sends three, and a picker with one ticked
     * sends one and means the other two are gone. An additive procedure cannot express unticking
     * without a second one to pair with it, and the pair then has to agree about a page two people
     * are editing. Every label has to be one of the space's own — a label belongs to a space, so
     * putting another space's label on a page would leak its vocabulary across the boundary.
     */
    setLabels: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/labels', ...t('pages') })
      .input(ws.extend({ pageId: Id, labelIds: z.array(Id).max(50) }))
      .output(z.array(Label)),
  },

  versions: {
    list: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}/versions', ...t('versions') })
      .input(ws.extend({ pageId: Id }).extend(PageInput.shape))
      .output(page(PageVersion)),
    /**
     * One version's prose, both ways it is worth having.
     *
     * `text` is flat — what a diff and a search snippet want. `html` is the version *as it looked*:
     * headings, lists, tables, callouts, its pictures signed and its page mentions linked, escaped
     * and safe to hand to a renderer. The bytes for it have always been stored; nothing drew them,
     * so the only thing anybody could see of an old version was 160 characters of flattened text.
     */
    get: baseContract
      .route({ method: 'GET', path: '/versions/{versionId}', ...t('versions') })
      .input(ws.extend({ versionId: Id }))
      .output(PageVersion.extend({ text: z.string(), html: z.string() })),
    /** Take one now, and give it a name. */
    create: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/versions', ...t('versions') })
      .input(ws.extend({ pageId: Id, label: z.string().min(1).max(120).nullable().default(null) }))
      .output(PageVersion),
    /**
     * Put an older version back. It is applied to the live document rather than written behind the
     * people editing it, and the state it replaced is kept as a version of its own first.
     */
    restore: baseContract
      .route({ method: 'POST', path: '/versions/{versionId}/restore', ...t('versions') })
      .input(ws.extend({ versionId: Id }))
      .output(PageVersion),
  },

  comments: {
    /** Every open thread on a page, and optionally the resolved ones too. */
    list: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}/comments', ...t('comments') })
      .input(ws.extend({ pageId: Id, includeResolved: z.boolean().default(false) }))
      .output(z.array(CommentThread)),
    create: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/comments', ...t('comments') })
      .input(
        ws.extend({
          pageId: Id,
          body: RichDoc,
          /** omit for a comment about the page rather than a piece of it */
          anchor: CommentAnchor.nullable().default(null),
          quotedText: z.string().max(2000).default(''),
          /** reply to this comment; the thread is inferred from it */
          parentId: Id.nullable().default(null),
        }),
      )
      .output(CommentThread.shape.root),
    update: baseContract
      .route({ method: 'PATCH', path: '/comments/{commentId}', ...t('comments') })
      .input(ws.extend({ commentId: Id, body: RichDoc }))
      .output(CommentThread.shape.root),
    remove: baseContract
      .route({ method: 'DELETE', path: '/comments/{commentId}', ...t('comments') })
      .input(ws.extend({ commentId: Id }))
      .output(Ok),
    /** Settle a thread. Resolving the root resolves the thread; it is not a per-reply state. */
    resolve: baseContract
      .route({ method: 'POST', path: '/comments/{commentId}/resolve', ...t('comments') })
      .input(ws.extend({ commentId: Id, resolved: z.boolean().default(true) }))
      .output(CommentThread),
  },

  databases: {
    get: baseContract
      .route({ method: 'GET', path: '/databases/{databaseId}', ...t('databases') })
      .input(ws.extend({ databaseId: Id }))
      .output(Database),
    /**
     * The database a `database` page draws, or null.
     *
     * A page carries no field pointing at it: `pages.database_id` already means "this page is a
     * *row of* that database", and giving the same name a second, opposite meaning is what made the
     * database appear as the first row of itself. So the direction nobody can express in `Page` is
     * asked for here instead.
     */
    forPage: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}/database', ...t('databases') })
      .input(ws.extend({ pageId: Id }))
      .output(Database.nullable()),
    /** Every database in a space, named — what a relation or a rollup is allowed to point at. */
    list: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}/databases', ...t('databases') })
      .input(ws.extend({ spaceId: Id }))
      .output(z.array(DatabaseRef)),
    /**
     * Rows named rather than identified — what a relation cell draws, and what it searches.
     *
     * `ids` resolves what a cell already holds; `query` finds the next one. Both in one procedure
     * because a cell needs both within a keystroke of each other.
     */
    lookup: baseContract
      .route({ method: 'GET', path: '/databases/{databaseId}/lookup', ...t('databases') })
      .input(
        ws.extend({
          databaseId: Id,
          query: z.string().max(200).default(''),
          ids: z.array(Id).max(200).default([]),
          limit: z.number().int().min(1).max(100).default(25),
        }),
      )
      .output(z.array(RowRef)),
    /** Turn a page into a database. It arrives with one column and one view, never empty. */
    create: baseContract
      .route({ method: 'POST', path: '/databases', ...t('databases') })
      .input(
        ws.extend({
          spaceId: Id,
          pageId: Id,
          name: z.string().max(120).default(''),
          inline: z.boolean().default(false),
        }),
      )
      .output(Database),
    /** The rows a view selects, filtered and ordered in SQL so a page of rows is a full page. */
    rows: baseContract
      .route({ method: 'GET', path: '/databases/{databaseId}/rows', ...t('databases') })
      .input(ws.extend({ databaseId: Id, viewId: Id.nullable().default(null) }).extend(PageInput.shape))
      .output(page(Row)),
    addRow: baseContract
      .route({ method: 'POST', path: '/databases/{databaseId}/rows', ...t('databases') })
      .input(
        ws.extend({
          databaseId: Id,
          title: z.string().max(300).default(''),
          props: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .output(Row),
    updateRow: baseContract
      .route({ method: 'PATCH', path: '/rows/{rowId}', ...t('databases') })
      .input(
        ws.extend({
          rowId: Id,
          title: z.string().max(300).optional(),
          props: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .output(Row),

    addProperty: baseContract
      .route({ method: 'POST', path: '/databases/{databaseId}/properties', ...t('databases') })
      .input(
        ws.extend({
          databaseId: Id,
          name: z.string().min(1).max(120),
          type: PropertyType,
          config: PropertyConfig.default({}),
        }),
      )
      .output(Property),
    updateProperty: baseContract
      .route({ method: 'PATCH', path: '/properties/{propertyId}', ...t('databases') })
      .input(
        ws.extend({
          propertyId: Id,
          name: z.string().min(1).max(120).optional(),
          type: PropertyType.optional(),
          config: PropertyConfig.optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .output(Property),
    /**
     * Reorder a column. `afterId` is the column to land behind; null means first.
     *
     * The rank is minted by the server, exactly as `pages.move` does it — a client that sends a
     * raw fractional index is a client that can write one two other people are already using.
     */
    moveProperty: baseContract
      .route({ method: 'POST', path: '/properties/{propertyId}/move', ...t('databases') })
      .input(ws.extend({ propertyId: Id, afterId: Id.nullable().default(null) }))
      .output(Property),
    removeProperty: baseContract
      .route({ method: 'DELETE', path: '/properties/{propertyId}', ...t('databases') })
      .input(ws.extend({ propertyId: Id }))
      .output(Ok),

    addView: baseContract
      .route({ method: 'POST', path: '/databases/{databaseId}/views', ...t('databases') })
      .input(
        ws.extend({
          databaseId: Id,
          name: z.string().min(1).max(120),
          kind: ViewKind.default('table'),
          config: ViewConfig.partial().default({}),
        }),
      )
      .output(View),
    updateView: baseContract
      .route({ method: 'PATCH', path: '/views/{viewId}', ...t('databases') })
      .input(
        ws.extend({
          viewId: Id,
          name: z.string().min(1).max(120).optional(),
          kind: ViewKind.optional(),
          config: ViewConfig.partial().optional(),
        }),
      )
      .output(View),
    removeView: baseContract
      .route({ method: 'DELETE', path: '/views/{viewId}', ...t('databases') })
      .input(ws.extend({ viewId: Id }))
      .output(Ok),

    /** Both ends at once, because a link visible from one side only is the "wrong rollup" bug. */
    setRelation: baseContract
      .route({ method: 'POST', path: '/rows/{rowId}/relations', ...t('databases') })
      .input(ws.extend({ rowId: Id, propertyId: Id, toPageIds: z.array(Id).max(200) }))
      .output(Ok),
  },

  /**
   * The vocabulary a space puts on its pages.
   *
   * Reading is `quire.space.view` and writing is `quire.space.manage`, because a label is part of a
   * space's configuration rather than a page's content: renaming "Draft" changes what it means on
   * every page that wears it, which is not a thing somebody who may edit one page should be able to
   * do to everybody else's.
   */
  labels: {
    list: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}/labels', ...t('labels') })
      .input(ws.extend({ spaceId: Id }))
      .output(z.array(Label)),
    /** What one page wears. `pages.setLabels` is the other half; without this one nothing draws it. */
    forPage: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}/labels', ...t('labels') })
      .input(ws.extend({ pageId: Id }))
      .output(z.array(Label)),
    create: baseContract
      .route({ method: 'POST', path: '/spaces/{spaceId}/labels', ...t('labels') })
      .input(ws.extend({ spaceId: Id, name: Label.shape.name, colour: LabelColour.default('grey') }))
      .output(Label),
    update: baseContract
      .route({ method: 'PATCH', path: '/labels/{labelId}', ...t('labels') })
      .input(
        ws.extend({
          labelId: Id,
          name: Label.shape.name.optional(),
          colour: LabelColour.optional(),
        }),
      )
      .output(Label),
    /** Off every page that wore it, too — a label nothing can name is not a label anybody can remove. */
    remove: baseContract
      .route({ method: 'DELETE', path: '/labels/{labelId}', ...t('labels') })
      .input(ws.extend({ labelId: Id }))
      .output(Ok),
  },

  /**
   * One person's own shortcuts, in the order they arranged them.
   *
   * Every procedure here is filtered to the caller. Row-level security fences the *workspace*, which
   * is the tenant boundary and not a privacy boundary — one colleague's favourites are as visible to
   * the policy as your own — so the `user_id` in each of these queries is the only thing keeping a
   * sidebar personal. The three mutations all answer with the whole ordered list rather than the one
   * row they touched: a fractional-index reorder is only meaningful as an ordering, the list is one
   * person's and therefore short, and it saves the sidebar a refetch to redraw itself.
   */
  favorites: {
    list: baseContract
      .route({ method: 'GET', path: '/favorites', ...t('favorites') })
      .input(ws)
      .output(z.array(FavoriteEntry)),
    /** Lands at the end. Starring the same page twice is the same star, not an error. */
    add: baseContract
      .route({ method: 'POST', path: '/favorites', ...t('favorites') })
      .input(ws.extend({ pageId: Id }))
      .output(z.array(FavoriteEntry)),
    remove: baseContract
      .route({ method: 'DELETE', path: '/favorites/{pageId}', ...t('favorites') })
      .input(ws.extend({ pageId: Id }))
      .output(z.array(FavoriteEntry)),
    /** `afterId` is the favourite to land behind; null means first. The rank is minted server-side. */
    reorder: baseContract
      .route({ method: 'POST', path: '/favorites/{pageId}/move', ...t('favorites') })
      .input(ws.extend({ pageId: Id, afterId: Id.nullable().default(null) }))
      .output(z.array(FavoriteEntry)),
  },

  /** Who asked to hear about a page. Deliberately not the same list as who bookmarked it. */
  watchers: {
    get: baseContract
      .route({ method: 'GET', path: '/pages/{pageId}/watchers', ...t('watchers') })
      .input(ws.extend({ pageId: Id }))
      .output(WatchState),
    set: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/watchers', ...t('watchers') })
      .input(ws.extend({ pageId: Id, watching: z.boolean().default(true) }))
      .output(WatchState),
  },

  /**
   * Where this person has just been, newest first — and only this person.
   *
   * `record` is what a page view calls; it bumps one row rather than appending to a log, so the
   * table is bounded by pages-times-people instead of growing for ever to answer a question that
   * only ever wants the most recent handful.
   */
  recents: {
    list: baseContract
      .route({ method: 'GET', path: '/recents', ...t('recents') })
      .input(ws.extend({ limit: z.number().int().min(1).max(50).default(10) }))
      .output(z.array(RecentEntry)),
    record: baseContract
      .route({ method: 'POST', path: '/recents', ...t('recents') })
      .input(ws.extend({ pageId: Id }))
      .output(Ok),
  },

  /**
   * What somebody writes with: a page, or a whole space, saved so it can be made again.
   *
   * **The five starters Kern ships are constants in this module, not rows in a customer's
   * database.** `migrations/0011_templates.sql` argues that at length; the consequences visible from
   * here are three. `list` answers starters and rows in one list, with a row carrying a starter's
   * `key` standing *in place of* that starter rather than beside it. A starter has no id, so
   * `instantiate` takes `templateId` **or** `starterKey` and refuses both. And `get`, `update` and
   * `remove` take an id, which means they are about rows only — a starter has nothing to fetch or
   * delete, and "reset this one" is deleting the row that replaced it.
   *
   * Reading is `quire.space.view` and writing is `quire.space.manage`, exactly as `labels.*` next
   * door, and for the same reason: a template is part of a space's furniture rather than one page's
   * content. Changing it changes what everybody in the space is offered when they make a page, which
   * is not a thing somebody who may edit one page should be able to do to everybody else's.
   *
   * `instantiate` is the exception and asks `quire.page.create`, because what it does is make a
   * page. Somebody who may write in a space may use its templates; only somebody who configures the
   * space may change them.
   */
  templates: {
    /**
     * What may be made here: the starters, plus this workspace's own, with overrides applied.
     *
     * `spaceId` is the space being written into, and null asks the workspace-wide question — which
     * is what the "New space" picker needs, because there is no space yet. With a space named, the
     * answer is that space's templates *and* the workspace-wide ones: a template scoped to a space
     * is an addition to what is offered there, never a replacement for what is offered everywhere.
     *
     * No body comes back. Thirty page documents to draw thirty names is thirty documents nobody
     * reads — see `TemplateSummary`. `instantiate` is what reads one.
     */
    list: baseContract
      .route({ method: 'GET', path: '/templates', ...t('templates') })
      .input(
        ws.extend({
          kind: TemplateKind.default('page'),
          /** the space a page would be made in; null asks only what is offered everywhere */
          spaceId: Id.nullable().default(null),
        }),
      )
      .output(z.array(TemplateChoice)),
    /**
     * One saved template, body and all — what the edit screen loads.
     *
     * Rows only. A starter has no row, and inventing an id for it would make every other procedure
     * here have to tell the two kinds of id apart.
     */
    get: baseContract
      .route({ method: 'GET', path: '/templates/{templateId}', ...t('templates') })
      .input(ws.extend({ templateId: Id }))
      .output(Template),
    /**
     * Save what is written now as a template.
     *
     * `sourceId` names the page for `kind: 'page'` and the **space** for `kind: 'space'`, the same
     * shape as `exports.start`'s `targetId` and for the same reason: the two kinds have nothing in
     * common to point at, and two nullable id fields would let a caller send both. The procedure is
     * named for the common case; a space template reads the space's whole tree.
     *
     * `key` is what makes a starter editable at all. Passing one writes a row that **replaces** that
     * starter in this workspace's picker; deleting the row brings the shipped one back, current and
     * translated. One row per starter per workspace — the second is a conflict, not a second entry.
     */
    createFromPage: baseContract
      .route({ method: 'POST', path: '/templates', ...t('templates') })
      .input(
        ws.extend({
          kind: TemplateKind.default('page'),
          /** the page for `page`; the space for `space` — `kind` says which */
          sourceId: Id,
          /** null offers it everywhere in the workspace; a space id scopes it to that space */
          spaceId: Id.nullable().default(null),
          name: z.string().min(1).max(120),
          description: z.string().max(2000).default(''),
          icon: z.string().max(64).nullable().default(null),
          variables: z.array(TemplateVariable).max(25).default([]),
          /** replace this shipped starter rather than sitting beside it */
          key: TemplateStarterKey.nullable().default(null),
        }),
      )
      .output(Template),
    /**
     * Rename it, re-scope it, change what it asks for — or replace its body with a page's.
     *
     * `sourceId` is three-valued like `publications.update`'s password: a page (or space) id takes
     * the body from there again, and leaving the key out changes nothing. Without that, updating a
     * template's name would be a separate act from updating its prose, and the second one would have
     * no procedure at all.
     */
    update: baseContract
      .route({ method: 'PATCH', path: '/templates/{templateId}', ...t('templates') })
      .input(
        ws.extend({
          templateId: Id,
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(2000).optional(),
          icon: z.string().max(64).nullable().optional(),
          spaceId: Id.nullable().optional(),
          variables: z.array(TemplateVariable).max(25).optional(),
          /** take the body from this page (or space) again; omit to leave the body alone */
          sourceId: Id.optional(),
        }),
      )
      .output(Template),
    /**
     * Delete it. For a row that replaced a starter this is "reset": the shipped one comes back.
     *
     * Nothing made from a template is touched — a page is a page once it exists, and a template that
     * took its pages with it would be a delete nobody could afford to press.
     */
    remove: baseContract
      .route({ method: 'DELETE', path: '/templates/{templateId}', ...t('templates') })
      .input(ws.extend({ templateId: Id }))
      .output(Ok),
    /**
     * Make the thing: a page, or a whole space and its tree.
     *
     * Exactly one of `templateId` and `starterKey` — a starter is a constant with no id, and a
     * union input would be a shape oRPC has to route. Both, or neither, is a bad request.
     *
     * `values` fills what the template declared. `{{date}}`, `{{time}}`, `{{author}}` and
     * `{{space}}` are filled by the server from the request and are declared by nobody; a name the
     * template never declared is left in the page as it was written, because deleting text somebody
     * typed is worse than showing them a placeholder they can see and fix.
     *
     * Substitution happens **in text, never in JSON**. A value containing a quote, a brace or a
     * newline is characters in a paragraph and cannot be anything else — see `services/templates.ts`.
     */
    instantiate: baseContract
      .route({ method: 'POST', path: '/templates/instantiate', ...t('templates') })
      .input(
        ws.extend({
          /** a saved template; null when `starterKey` names a shipped one */
          templateId: Id.nullable().default(null),
          /** a shipped starter; null when `templateId` names a saved one */
          starterKey: TemplateStarterKey.nullable().default(null),
          /** the space to write into, for a page template. Ignored for a space template. */
          spaceId: Id.nullable().default(null),
          /** where the new page hangs, for a page template */
          parentId: Id.nullable().default(null),
          afterId: Id.nullable().default(null),
          /** what the new page is called; empty takes the template's own name */
          title: z.string().max(300).default(''),
          /** the new space's key and name, for a space template */
          key: Space.shape.key.nullable().default(null),
          name: z.string().max(120).default(''),
          values: TemplateValues.default({}),
        }),
      )
      .output(TemplateResult),
  },

  publishing: {
    /** Make what is written now the version readers are served. Only meaningful for a `page`. */
    publish: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/publish', ...t('publishing') })
      .input(ws.extend({ pageId: Id, label: z.string().min(1).max(120).nullable().default(null) }))
      .output(Page),
    /** Throw the draft away and go back to what readers can already see. */
    revert: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/revert', ...t('publishing') })
      .input(ws.extend({ pageId: Id }))
      .output(Page),
  },

  /**
   * Who has published what, from the inside. Every procedure here is authenticated and asks
   * `quire.page.publish` about the **root page**, because that is the page whose subtree is being
   * handed to the internet.
   */
  publications: {
    list: baseContract
      .route({ method: 'GET', path: '/spaces/{spaceId}/publications', ...t('publications') })
      .input(ws.extend({ spaceId: Id }))
      .output(z.array(Publication)),
    get: baseContract
      .route({ method: 'GET', path: '/publications/{publicationId}', ...t('publications') })
      .input(ws.extend({ publicationId: Id }))
      .output(Publication),
    create: baseContract
      .route({ method: 'POST', path: '/publications', ...t('publications') })
      .input(
        ws.extend({
          rootPageId: Id,
          slug: Publication.shape.slug,
          includeDescendants: z.boolean().default(true),
          /** the password itself, once; the server keeps a hash and never gives one back */
          password: z.string().min(6).max(200).nullable().default(null),
          expiresAt: Timestamp.nullable().default(null),
          seoTitle: z.string().max(200).default(''),
          seoDescription: z.string().max(500).default(''),
          ogImageUrl: z.string().max(2048).nullable().default(null),
          indexable: z.boolean().default(true),
          theme: PublicationTheme.default('auto'),
        }),
      )
      .output(Publication),
    /**
     * `password` is three-valued on purpose: a string sets one, `null` removes it, and leaving the
     * key out changes nothing. A two-valued field would make every "rename the site" request also
     * an "unlock the site" request, which is the shape that quietly takes the door off a handbook.
     */
    update: baseContract
      .route({ method: 'PATCH', path: '/publications/{publicationId}', ...t('publications') })
      .input(
        ws.extend({
          publicationId: Id,
          slug: Publication.shape.slug.optional(),
          includeDescendants: z.boolean().optional(),
          password: z.string().min(6).max(200).nullable().optional(),
          expiresAt: Timestamp.nullable().optional(),
          seoTitle: z.string().max(200).optional(),
          seoDescription: z.string().max(500).optional(),
          ogImageUrl: z.string().max(2048).nullable().optional(),
          indexable: z.boolean().optional(),
          theme: PublicationTheme.optional(),
        }),
      )
      .output(Publication),
    /** The row is the grant, so removing it takes the site down. Nothing else is deleted. */
    remove: baseContract
      .route({ method: 'DELETE', path: '/publications/{publicationId}', ...t('publications') })
      .input(ws.extend({ publicationId: Id }))
      .output(Ok),
    /**
     * Keep one page — and therefore everything under it — out of every publication, present and
     * future.
     *
     * Absolute rather than per-publication, and that is the whole reason it is a flag on the page:
     * an opt-out recorded against one publication says nothing about a publication somebody roots
     * above the page next month, and its author would never see it. This one holds against
     * publications that do not exist yet.
     */
    optOut: baseContract
      .route({ method: 'POST', path: '/pages/{pageId}/public-opt-out', ...t('publications') })
      .input(ws.extend({ pageId: Id, excluded: z.boolean().default(true) }))
      .output(z.object({ pageId: Id, excluded: z.boolean() })),
  },

  /**
   * Taking work out: a page, a page and everything under it, or a whole space, as a file.
   *
   * Three procedures and no fourth, which is the shape worth explaining. There is no `download`:
   * `get` carries a `downloadUrl` it mints as it answers, so the permission is checked on the
   * request that fetches the file rather than baked into a link that outlives the check. And there
   * is no `cancel`: a job either finishes or fails, both terminal, and a cancel that races a worker
   * writing an artefact is a way to end up with an object nothing points at.
   *
   * **What the artefact contains is decided by the job, not by the caller.** `start` names a scope
   * and a format; every page under that scope is then checked against the requester's own
   * `quire.page.view`, and a page they may not read is left out and counted in `skipped`. So a
   * subtree export by somebody with a page-scoped DENY is a smaller file, not a refusal — and
   * `counts.skipped` is how they find out, which is the difference between an export that is quietly
   * missing pages and one that says how many.
   *
   * `format: 'docx'` is declared in `ExportFormat` and refused by `start` today: see the note in
   * `services/export.ts` for what makes a *correct* Word file more than a matter of effort, and why
   * a refusal is better than a document that may not open.
   */
  exports: {
    /** Queue one. The answer is a row to watch, never the file — see the note above. */
    start: baseContract
      .route({ method: 'POST', path: '/exports', ...t('exports') })
      .input(
        ws.extend({
          scope: ExportScope,
          /** the page for `page` and `subtree`, the space for `space`; `scope` says which */
          targetId: Id,
          format: ExportFormat,
        }),
      )
      .output(ExportJobDetail),
    /** Where it has got to, and — once it is `done` — a link that is good for a few minutes. */
    get: baseContract
      .route({ method: 'GET', path: '/exports/{jobId}', ...t('exports') })
      .input(ws.extend({ jobId: Id }))
      .output(ExportJobDetail),
    /**
     * This person's own exports, newest first.
     *
     * Deliberately not the workspace's. Row-level security fences the tenant, which is not a privacy
     * boundary, so the `requested_by` filter in the query is the only thing that keeps one person's
     * export of the salary handbook out of everybody else's list — the same rule `favorites.list`
     * and `recents.list` follow.
     */
    list: baseContract
      .route({ method: 'GET', path: '/exports', ...t('exports') })
      .input(ws.extend({ limit: z.number().int().min(1).max(50).default(20) }))
      .output(z.array(ExportJob)),
  },

  /**
   * Getting work in: a Notion export, a Confluence export or a folder of Markdown, into one space.
   *
   * **The failure list is the feature.** A real export has files that will not map — an attachment,
   * a `.csv` with no header, a page whose link points outside what was exported — and an import that
   * silently drops forty pages is worse than one that refuses. So every file in the archive gets a
   * row in `report` saying whether it became a page, was deliberately left out, or could not be read,
   * and `counts.total` is exactly the number of rows: nothing in the archive goes unaccounted for.
   *
   * Three things follow from the archive being read whole before anything is written, and each is
   * worth knowing before reading the handlers:
   *
   *   - **an import is all or nothing.** A zip that fails half way leaves the space exactly as it
   *     was, because the plan is built in memory and written in one transaction;
   *   - **links between imported pages are rewritten to Quire page ids**, which needs every id to
   *     exist before any body is resolved — a link to a page further down the archive is the normal
   *     case, not the exception. A link that resolves to nothing becomes plain text rather than a
   *     dead link, and the report names the target it could not find;
   *   - **a `.csv` becomes a database with typed columns**, guessed from the values and reported.
   *
   * `quire.page.import` is `dangerous`, as the tracker marks its own imports: this is the one thing
   * in the module that writes hundreds of pages into a space in one act, and it is not undone by
   * pressing something.
   */
  imports: {
    /**
     * Queue one. The answer is a row to watch; nothing has been written to the space yet.
     *
     * `fileId` is an upload — a core file the browser has already put in place — and not the archive
     * itself. A zip is up to a few hundred megabytes, which is a file to be uploaded and then named,
     * never a request body.
     */
    start: baseContract
      .route({ method: 'POST', path: '/imports', ...t('imports') })
      .input(
        ws.extend({
          /** the space being written into; an import always targets exactly one */
          spaceId: Id,
          source: ImportSource,
          /** the uploaded archive, and not something this job produces — see `ImportJob` */
          fileId: Id,
        }),
      )
      .output(ImportJob),
    /** Where it has got to, and — once it has finished — what happened to every file in it. */
    get: baseContract
      .route({ method: 'GET', path: '/imports/{jobId}', ...t('imports') })
      .input(ws.extend({ jobId: Id }))
      .output(ImportJob),
    /**
     * This person's own imports, newest first, without their reports — see `ImportJobSummary`.
     *
     * Deliberately not the workspace's, for the same reason `exports.list` is not: row-level security
     * fences the tenant, which is not a privacy boundary, so the `requested_by` filter in the query
     * is the only thing that keeps one person's import out of everybody else's list.
     */
    list: baseContract
      .route({ method: 'GET', path: '/imports', ...t('imports') })
      .input(ws.extend({ limit: z.number().int().min(1).max(50).default(20) }))
      .output(z.array(ImportJobSummary)),
  },

  /**
   * The signed-out surface. **This is the only part of Kern with no principal behind it.**
   *
   * Five rules hold here, and each of them is a test in `publications.int.test.ts`:
   *
   *   1. A page is public only if it is inside the publication's subtree, not opted out, not
   *      archived, not trashed, and has a published version that has been rendered. Failing any one
   *      of those is **404, never 403** — a refusal that distinguishes "not yours" from "not there"
   *      confirms the page exists to whoever is guessing.
   *   2. Guessing a sibling, a parent, a page in another space or another workspace gets 404 too,
   *      which is free here because nothing is addressed by id: `path` names a place in *this*
   *      publication's tree or it names nothing.
   *   3. No response carries a draft, a comment, an author, a version list, or any id.
   *   4. A password-protected publication answers a challenge and nothing else. `unlock` mints a
   *      **capability token, not a session**: an AES-GCM envelope sealed with the instance secret,
   *      bound by its associated data to this one publication, carrying an expiry and no identity.
   *      The server keeps nothing. The route layer is expected to hold it in an HttpOnly cookie and
   *      pass it back — never to put it in a link, because a token in a URL is a token in a referrer
   *      header and in somebody's access log.
   *   5. An expired publication is 404, checked on the request rather than by a sweep.
   *
   * `workspaceId` is in the path because *anonymous means no principal, not no tenant*: the request
   * has to name a workspace before anything touches `mod_quire`, or row-level security has nothing
   * to fence with. See the note at the top of `migrations/0008_publications.sql`.
   */
  public: {
    site: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}', ...t('public') })
      .input(
        z.object({
          workspaceId: WorkspaceSegment,
          slug: Publication.shape.slug,
          token: z.string().max(4096).nullable().default(null),
        }),
      )
      .output(PublicSite),
    /**
     * One page of a published site.
     *
     * `path` is a query parameter rather than a path segment because it contains slashes: a nested
     * page's address is `guide/install`, and oRPC's route matcher takes one segment per parameter.
     */
    page: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}/page', ...t('public') })
      .input(
        z.object({
          workspaceId: WorkspaceSegment,
          slug: Publication.shape.slug,
          /** '' is the front page */
          path: z.string().max(1024).default(''),
          basePath: PublicBasePath,
          token: z.string().max(4096).nullable().default(null),
        }),
      )
      .output(PublicPage),
    /**
     * Search inside this publication and nowhere else.
     *
     * It reads the **published version's** flattened text, not `pages.text`. That column mirrors the
     * live document, so searching it would put a sentence somebody has not published yet into a
     * snippet on the public internet — the one place in this module where the draft and the
     * published copy differ and the difference is the whole point.
     */
    search: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}/search', ...t('public') })
      .input(
        z.object({
          workspaceId: WorkspaceSegment,
          slug: Publication.shape.slug,
          q: z.string().min(2).max(200),
          limit: z.number().int().min(1).max(50).default(20),
          token: z.string().max(4096).nullable().default(null),
        }),
      )
      .output(z.object({ items: z.array(PublicSearchHit) })),
    /**
     * What a crawler may index, which is not the same list as what a reader may open: a site behind
     * a password, or marked `indexable: false`, has an empty sitemap rather than a private one.
     */
    sitemap: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}/sitemap', ...t('public') })
      .input(z.object({ workspaceId: WorkspaceSegment, slug: Publication.shape.slug }))
      .output(z.object({ entries: z.array(PublicSitemapEntry) })),
    /**
     * The one procedure here that never distinguishes one slug from another.
     *
     * A crawler asking about a slug that does not exist, one that has expired, and one behind a
     * password must all get the same answer, or `robots` becomes the oracle every other procedure
     * refuses to be. So it succeeds for all three and says "do not index". (A workspace with the
     * module switched off is still a 404, from the middleware — that is a statement about the
     * workspace, which the path already named, and not about any slug.)
     */
    robots: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}/robots', ...t('public') })
      .input(z.object({ workspaceId: WorkspaceSegment, slug: Publication.shape.slug }))
      .output(z.object({ indexable: z.boolean(), sitemapPath: z.string().nullable() })),
    /**
     * The bytes of one picture on a published page.
     *
     * `asset` is the opaque reference the page's own HTML carries — an AES-GCM envelope sealed with
     * the instance secret and bound by its associated data to this workspace, so it names nothing
     * on its own and cannot be carried to another instance. Resolving it is not enough on its own:
     * the file has to be referenced by a version that is *currently* public in this publication, so
     * opting a page out stops its pictures resolving in the same breath as its prose.
     *
     * Everything unresolvable is the same 404 as everything else here — a reference that will not
     * decrypt, one for a file nothing public uses, a file that has been deleted, an object over the
     * cap. And a locked publication answers the door first: the pictures are behind the password
     * along with the pages they are on.
     */
    asset: baseContract
      .route({ method: 'GET', path: '/public/{workspaceId}/{slug}/asset', ...t('public') })
      .input(
        z.object({
          workspaceId: WorkspaceSegment,
          slug: Publication.shape.slug,
          asset: z.string().min(1).max(2048),
          token: z.string().max(4096).nullable().default(null),
        }),
      )
      .output(PublicAsset),
    /** Present the password, get a token. A site with no password has no door, and answers 404. */
    unlock: baseContract
      .route({ method: 'POST', path: '/public/{workspaceId}/{slug}/unlock', ...t('public') })
      .input(
        z.object({
          workspaceId: WorkspaceSegment,
          slug: Publication.shape.slug,
          password: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ token: z.string(), expiresAt: Timestamp })),
  },
} as const
export type QuireContract = typeof quireContract

export { Ok }
