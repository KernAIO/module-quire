import { Id, Timestamp, UserId, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/** Lowercase, 2-32 characters. Names the API prefix, the Postgres schema `mod_quire` and every event. */
export const MODULE_ID = 'quire'

/**
 * How a space decides who may see it before any binding is consulted.
 *
 * `open` — every member of the workspace may read it.
 * `restricted` — members may find it and see its name, and need a binding to read a page.
 * `private` — only people with a binding know it exists at all.
 */
export const SpaceVisibility = z.enum(['open', 'restricted', 'private'])
export type SpaceVisibility = z.infer<typeof SpaceVisibility>

export const Space = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** unique per workspace; it is what appears in the URL */
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  /** a Lucide icon name, or an emoji */
  icon: z.string().max(64).nullable(),
  visibility: SpaceVisibility,
  /** the page shown when somebody opens the space; null until one is set */
  homepageId: Id.nullable(),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
})
export type Space = z.infer<typeof Space>

/**
 * What a page *is*, which decides what a reader sees.
 *
 * `page` — has a published version and a draft. Everyone editing shares one live document; a reader
 * without edit rights, and every public URL, is served the last published version instead. This is
 * what a documentation site is made of.
 * `live` — always live, like a shared note. There is no draft and no unpublished-changes state;
 * versions still accumulate so history and restore work the same way.
 * `database` — the page *is* a database. Its own body is the description above the view.
 */
export const PageKind = z.enum(['page', 'live', 'database'])
export type PageKind = z.infer<typeof PageKind>

export const Page = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  spaceId: Id,
  parentId: Id.nullable(),
  /**
   * A fractional index, not an integer. Moving one page between two others must not renumber its
   * siblings: two people reordering at once would then write different numbers for the same rows.
   */
  position: z.string().min(1).max(256),
  kind: PageKind,
  title: z.string().max(300),
  icon: z.string().max(64).nullable(),
  coverUrl: z.string().max(2048).nullable(),
  /** the version a reader without edit rights sees; null while a `page` has never been published */
  publishedVersionId: Id.nullable(),
  /** whether the live document has changed since `publishedVersionId` was written */
  hasUnpublishedChanges: z.boolean(),
  createdBy: UserId.nullable(),
  updatedBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
})
export type Page = z.infer<typeof Page>

/** A page in the sidebar tree: enough to draw a row, and nothing that costs a join. */
export const PageNode = z.object({
  id: Id,
  parentId: Id.nullable(),
  position: z.string(),
  kind: PageKind,
  title: z.string(),
  icon: z.string().nullable(),
  hasChildren: z.boolean(),
  archivedAt: Timestamp.nullable(),
  /**
   * Kept out of every publication, present and future — `publications.optOut` sets it.
   *
   * On the node rather than on `Page` because the only screen that reads it is a *list*: the share
   * dialog draws one row per descendant with a switch on it, and a switch whose state has to be
   * fetched page by page is a screen that opens with everything wrong and corrects itself. Two more
   * booleans on a row the sidebar already loads for the whole space is the cheap end of that trade.
   *
   * `.default(false)` so a tree drawn by a client newer than its server still parses; the inferred
   * output type is required either way, which is what makes both constructors supply it.
   */
  excludedFromPublic: z.boolean().default(false),
  /**
   * Whether a reader without edit rights has anything to be served — `publishedVersionId != null`,
   * as a boolean, because the id itself addresses `versions.get` and a tree row has no business
   * carrying it.
   *
   * Here for the same list as the flag above, and it is the half that stops that list lying. An
   * opt-out switch on its own says "this page is public" about a page nobody has ever published,
   * which is the wrong answer in the safe direction — and a screen that is wrong in the safe
   * direction today is one nobody checks tomorrow. Always false for a `live` doc and a `database`:
   * neither has a published version, because `publishing.publish` refuses anything but a `page`.
   */
  hasPublishedVersion: z.boolean().default(false),
})
export type PageNode = z.infer<typeof PageNode>

/**
 * How a version came to exist. `restore` matters: putting an older version back writes a new
 * version rather than rewinding, so restoring is never itself the thing that loses work.
 */
export const VersionKind = z.enum(['auto', 'publish', 'restore', 'import'])
export type VersionKind = z.infer<typeof VersionKind>

export const PageVersion = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  pageId: Id,
  kind: VersionKind,
  label: z.string().max(120).nullable(),
  /** the first line or so of the prose, so a list reads without loading a document */
  preview: z.string(),
  size: z.number().int().nonnegative(),
  authorId: UserId.nullable(),
  createdAt: Timestamp,
  /** whether this is the version a reader is currently served */
  published: z.boolean(),
})
export type PageVersion = z.infer<typeof PageVersion>

/**
 * Where a comment is attached, as **Yjs relative positions**.
 *
 * Not character offsets: an offset names a place that only exists while nobody else is typing, and
 * two words inserted above would move a comment onto text it was never about. A relative position
 * points at the content rather than the index, so it survives concurrent editing — which is the
 * whole reason a comment on a collaborative document is harder than a comment on a row.
 */
export const CommentAnchor = z.object({
  /** base64 `Y.encodeRelativePosition` */
  from: z.base64(),
  to: z.base64(),
})
export type CommentAnchor = z.infer<typeof CommentAnchor>

/** A Tiptap/ProseMirror document. Kept opaque here; the renderer is what knows its shape. */
export const RichDoc = z.record(z.string(), z.unknown())

export const Comment = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  pageId: Id,
  parentId: Id.nullable(),
  threadId: Id,
  authorId: UserId.nullable(),
  body: RichDoc,
  bodyText: z.string(),
  mentionIds: z.array(UserId),
  /** null for a comment about the page rather than a piece of it */
  anchor: CommentAnchor.nullable(),
  /** what the anchor pointed at when it was written, so a thread whose text is gone still reads */
  quotedText: z.string(),
  resolvedAt: Timestamp.nullable(),
  resolvedBy: UserId.nullable(),
  editedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Comment = z.infer<typeof Comment>

/** A root comment and its replies, which is how a page's margin is actually read. */
export const CommentThread = z.object({
  id: Id,
  root: Comment,
  replies: z.array(Comment),
  resolved: z.boolean(),
})
export type CommentThread = z.infer<typeof CommentThread>

/**
 * The colours a label may wear, closed on purpose.
 *
 * `SelectOption.colour` next door is free text, and the comment on `client/database/colours.ts`
 * explains what that costs: one typo renders a chip with no background, and — worse — a colour pair
 * nobody has measured for contrast. These are exactly the keys of `TONES`, so every one of them is a
 * pair the design tokens already tuned for light and dark. A label is picked from a menu rather than
 * typed, so there is no reason to leave the door open here.
 */
export const LabelColour = z.enum([
  'grey',
  'slate',
  'accent',
  'success',
  'warning',
  'danger',
  'info',
  'purple',
])
export type LabelColour = z.infer<typeof LabelColour>

/**
 * A word a space puts on pages, so they can be gathered by something other than where they sit.
 *
 * Scoped to a space, not to the workspace: two teams both wanting "Draft" should not have to agree
 * on what it means, and a label list spanning every space is a list nobody can read. Names are
 * unique per space case-insensitively — "Draft" and "draft" in one picker are broken data.
 */
export const Label = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  spaceId: Id,
  name: z.string().min(1).max(60),
  colour: LabelColour,
  createdAt: Timestamp,
})
export type Label = z.infer<typeof Label>

/**
 * A page somebody put in their own sidebar, and where they put it.
 *
 * `position` is a fractional index, not an integer, for the same reason `Page.position` is: dragging
 * one favourite between two others must not renumber the rest, or two reorders at once write
 * different numbers for the same rows.
 */
export const Favorite = z.object({
  workspaceId: WorkspaceId,
  userId: UserId,
  pageId: Id,
  position: z.string().min(1).max(256),
  createdAt: Timestamp,
})
export type Favorite = z.infer<typeof Favorite>

/**
 * The last time somebody opened a page.
 *
 * One row per person per page, bumped in place — not a visit log. A log grows without bound to
 * answer a question that only ever wants the most recent handful, and needs pruning nobody runs.
 */
export const RecentView = z.object({
  workspaceId: WorkspaceId,
  userId: UserId,
  pageId: Id,
  viewedAt: Timestamp,
})
export type RecentView = z.infer<typeof RecentView>

/**
 * Somebody who asked to hear about a page.
 *
 * Deliberately not the same thing as a favourite: "I want this to hand" and "tell me when this
 * changes" are different requests, and collapsing them gives you either a sidebar full of pages
 * somebody only wanted news about or a notification for every shortcut they made.
 */
export const Watcher = z.object({
  workspaceId: WorkspaceId,
  userId: UserId,
  pageId: Id,
  createdAt: Timestamp,
})
export type Watcher = z.infer<typeof Watcher>

/**
 * How a published site is coloured. `auto` follows the reader's own setting rather than the
 * author's, which is the only one of the three that is a preference and not an instruction.
 */
export const PublicationTheme = z.enum(['auto', 'light', 'dark'])
export type PublicationTheme = z.infer<typeof PublicationTheme>

/**
 * A page, and everything under it, at a URL a signed-out stranger can open.
 *
 * The row *is* the grant: no publication, no public page, and deleting it takes the site down. What
 * a reader is served is the **pinned published version** of each page — `Page.publishedVersionId`
 * and the HTML rendered onto it — never the live document and never the draft. A page with no
 * published version is not public, whatever the tree says.
 *
 * There is no `passwordHash` here and there never should be. `hasPassword` is the whole of what a
 * client needs: whether to ask. A hash is a hash, a salt and a cost, and shipping it to a browser
 * turns an online guess into an offline one.
 */
export const Publication = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** the page the site is rooted at; its own published version is the front page */
  rootPageId: Id,
  /** false publishes exactly one page, which is what a single shared document wants */
  includeDescendants: z.boolean(),
  /**
   * The URL segment. Unique per workspace and not beyond it — the public URL carries the workspace,
   * so two customers both wanting `handbook` is not a collision. Lowercase by the same rule as
   * `Space.key`: a URL that differs only in case is one URL to a person and two rows to Postgres.
   */
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes'),
  /** whether a password is set — never the hash, and never the password */
  hasPassword: z.boolean(),
  /** null never expires; past means the URL is gone */
  expiresAt: Timestamp.nullable(),
  /** what a search result and a link preview say; empty falls back to the root page's own title */
  seoTitle: z.string().max(200),
  seoDescription: z.string().max(500),
  ogImageUrl: z.string().max(2048).nullable(),
  /** false sends `noindex`. Public and findable are different requests, and people mean both. */
  indexable: z.boolean(),
  theme: PublicationTheme,
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Publication = z.infer<typeof Publication>

// =====================================================================================
// Getting work in and out
// =====================================================================================

/**
 * How much of the tree an export takes.
 *
 * `page` is one page; `subtree` is a page and everything under it; `space` is every page in a space.
 * The three are not a convenience — they are the three questions people actually ask ("send me this",
 * "send me this section", "get us off this product"), and the middle one is the one a flat
 * page-by-page export cannot answer without somebody clicking three hundred times.
 */
export const ExportScope = z.enum(['page', 'subtree', 'space'])
export type ExportScope = z.infer<typeof ExportScope>

/**
 * What comes out.
 *
 * `html` and `pdf` are rendered by the same static renderer the public site uses — never the live
 * document and never the draft, so an export of a `page` is what a reader is served rather than what
 * the last person to open it happened to be typing.
 */
export const ExportFormat = z.enum(['markdown', 'html', 'docx', 'pdf'])
export type ExportFormat = z.infer<typeof ExportFormat>

/** Where a transfer is. `done` and `failed` are terminal; nothing moves out of either. */
export const TransferState = z.enum(['queued', 'running', 'done', 'failed'])
export type TransferState = z.infer<typeof TransferState>

/**
 * A job's own progress, shared by both directions.
 *
 * `skipped` is the counter that matters and the one a progress bar leaves out. An export skips a page
 * the requester may not read; an import skips a file it cannot map. Reporting the count is the
 * difference between an artefact that is quietly missing things and one that says how many.
 *
 * Every field defaults, so a job that has not started yet parses as four zeroes rather than as
 * absent — a client should never have to distinguish "no progress" from "no counters".
 */
export const TransferCounts = z.object({
  total: z.number().int().nonnegative().default(0),
  done: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
})
export type TransferCounts = z.infer<typeof TransferCounts>

/**
 * A request to take a page, a subtree or a space out of Quire as a file.
 *
 * There is no artefact URL here and there should not be. `fileId` is an opaque id, not an address:
 * the download is a signed URL a procedure mints per request, so that the fence on who may fetch a
 * subtree export — which flattens pages of different readerships into one file — is applied at the
 * moment of the fetch rather than baked into a link that outlives it. A client that builds a storage
 * key from an id is the mistake `migrations/0009` had to go back and scrub out of published HTML.
 */
export const ExportJob = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  requestedBy: UserId,
  scope: ExportScope,
  /** the page for `page` and `subtree`, the space for `space`; `scope` says which */
  targetId: Id,
  format: ExportFormat,
  state: TransferState,
  /** null until the job succeeds — an artefact that is still being written is not offered */
  fileId: Id.nullable(),
  /**
   * Why it failed, in the words of whatever failed — a Gotenberg refusal, the name of a page that
   * would not render. Diagnostic, not a user-facing string: a screen says its piece from a message
   * key chosen by `state`, and shows this beside it for the person who has to act on it.
   */
  error: z.string().nullable(),
  counts: TransferCounts,
  createdAt: Timestamp,
  /** null while `queued` or `running` */
  finishedAt: Timestamp.nullable(),
})
export type ExportJob = z.infer<typeof ExportJob>

/** What kind of export is being read in. */
export const ImportSource = z.enum(['notion', 'confluence', 'markdown'])
export type ImportSource = z.infer<typeof ImportSource>

/**
 * What happened to one file.
 *
 * Three outcomes and not two, because "not imported" covers two different situations a person needs
 * to tell apart: a file Quire deliberately did not want (an asset already inlined, a Notion index
 * page that duplicates the folder) is `skipped`, and a file that should have become a page and did
 * not is `failed`. Collapsing them turns a broken import into a tidy-looking one.
 */
export const ImportOutcome = z.enum(['imported', 'skipped', 'failed'])
export type ImportOutcome = z.infer<typeof ImportOutcome>

/**
 * One row of the report: what the file was, what became of it, and which.
 *
 * The failure list is the feature. A real Notion export has files that will not map, and an import
 * that silently drops forty pages is worse than one that refuses — so every file in the upload gets
 * an entry, including the ones that worked, and the report is complete rather than a list of
 * complaints. `path` is the path inside the archive, which is what somebody has to go and look at.
 */
export const ImportReportEntry = z.object({
  /** the file's path inside the uploaded archive, exactly as it appeared */
  path: z.string(),
  outcome: ImportOutcome,
  /** the page it became, for `imported`; null for the other two */
  pageId: Id.nullable().default(null),
  /**
   * Why, for `skipped` and `failed`; null for `imported`.
   *
   * Free text on purpose: the reasons are as varied as the exports people have, and a closed enum
   * here would either be wrong within a week or force every unexpected file into an `other` that
   * tells nobody anything.
   */
  reason: z.string().nullable().default(null),
})
export type ImportReportEntry = z.infer<typeof ImportReportEntry>

/**
 * A Notion export zip, a Confluence export or a folder of Markdown, on its way into one space.
 *
 * `sourceFileId` is the upload, not an artefact — the opposite direction from `ExportJob.fileId`, and
 * named differently for that reason. An import produces pages, not a file.
 *
 * Internal links between imported pages are rewritten to Quire page ids as the import goes; a link
 * that cannot be resolved becomes plain text rather than a dead link, and the page that carried it
 * still counts as `imported`. That choice is why `report` is per *file* and not per *link*: a page
 * that arrived with one unresolvable link is an imported page, not a failure.
 */
export const ImportJob = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  requestedBy: UserId,
  source: ImportSource,
  /** the space being written into. An import always targets one space; there is no scope here. */
  targetId: Id,
  /** the uploaded archive — consumed by the job, and present before the job exists */
  sourceFileId: Id,
  state: TransferState,
  /** why the *job* failed; why one *file* failed is that file's entry in `report` */
  error: z.string().nullable(),
  counts: TransferCounts,
  /** one entry per file in the upload, in the order they were read */
  report: z.array(ImportReportEntry),
  createdAt: Timestamp,
  /** null while `queued` or `running` */
  finishedAt: Timestamp.nullable(),
})
export type ImportJob = z.infer<typeof ImportJob>

// =====================================================================================
// Templates
// =====================================================================================

/**
 * What a template makes.
 *
 * `page` — one page; the body is a page doc.
 * `space` — a whole space; the body is a tree of pages, each with its own body.
 *
 * Two rather than one with a "just make the root" flag, because they are made from different places
 * and answer different questions: a page template is offered on "New page" inside a space that
 * already exists, and a space template is what somebody reaches for when there is no space yet.
 */
export const TemplateKind = z.enum(['page', 'space'])
export type TemplateKind = z.infer<typeof TemplateKind>

/**
 * The starters this module ships.
 *
 * **They are constants in the module, not rows in a customer's database**, and the key is what a
 * constant has instead of an id. `migrations/0011_templates.sql` argues the choice at length; the
 * short of it is that a migration runs once per *database* and has no workspace to seed into, that a
 * seeded row is frozen at the release that wrote it, and that a row holds one language in a product
 * that ships five.
 *
 * A workspace edits a starter by **overriding** it: a `Template` row carrying one of these keys takes
 * that starter's place in the picker rather than sitting beside it, so the first edit writes one row,
 * a workspace that never touches them has none, and resetting is deleting the row.
 *
 * `Template.key` is deliberately **not** this enum — see the comment there.
 */
export const TemplateStarterKey = z.enum([
  'meeting-notes',
  'decision-record',
  'requirements',
  'retrospective',
  'how-to',
])
export type TemplateStarterKey = z.infer<typeof TemplateStarterKey>
export const TEMPLATE_STARTER_KEYS = TemplateStarterKey.options

/**
 * What a variable's type decides, which is **the control somebody is shown and not the storage**.
 *
 * Every filled value is substituted into prose as text, whatever the type: `{{sprint}}` in a heading
 * becomes characters in a heading. The type is what turns "type the date" into a date picker and
 * "type one of these four" into a menu — the difference between a form somebody fills correctly and
 * one they fill approximately.
 */
export const TemplateVariableType = z.enum(['text', 'number', 'date', 'select', 'user'])
export type TemplateVariableType = z.infer<typeof TemplateVariableType>

/**
 * The names a template author may not take, because the module already fills them.
 *
 * `date` and `author` are the two the plan names. The other three are reserved now rather than
 * later, and that is the whole reason the list is longer than it needs to be today: adding
 * `{{time}}` in a future release would silently change what an existing template renders if some
 * author had already declared a variable of that name. Reserving a name costs an author one
 * synonym; taking one back costs somebody a document that used to be right.
 */
export const TEMPLATE_BUILT_IN_VARIABLES = ['date', 'time', 'author', 'space', 'workspace'] as const

/**
 * What appears between the braces.
 *
 * ASCII, lowercase, no spaces — the same shape as `Space.key` and for the same reason: this string
 * is matched against the body, so `{{Sprint}}` and `{{sprint}}` being two variables is exactly the
 * near-duplicate that `labels_ws_space_name_uq` refuses next door. An author's own language belongs
 * in `label`, which is the half a person actually reads.
 */
export const TemplateVariableName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores, starting with a letter')
  .refine(
    (name) => !(TEMPLATE_BUILT_IN_VARIABLES as readonly string[]).includes(name),
    'that name is filled by the module itself',
  )

/**
 * One thing somebody is asked before the page is made.
 *
 * Every field but `name`, `label` and `type` defaults, so a variable written by an older client
 * still parses. Note what that does to the *output* type: it makes them required, so anything
 * constructing a variable supplies all six — which is the point, and the reason a widened contract
 * is additive for parsing and breaking for constructing.
 */
export const TemplateVariable = z.object({
  name: TemplateVariableName,
  /** what the person filling it in reads; their own language goes here, not in `name` */
  label: z.string().min(1).max(120),
  type: TemplateVariableType,
  /** the menu, for `select`; empty for every other type */
  options: z.array(z.string().min(1).max(120)).max(50).default([]),
  /** what the field starts with — text whatever the type, because substitution is textual */
  default: z.string().max(2000).nullable().default(null),
  /** whether the page can be made without it */
  required: z.boolean().default(false),
})
export type TemplateVariable = z.infer<typeof TemplateVariable>

/**
 * One page of a space template, and everything under it.
 *
 * Recursive because a space is a tree and flattening it into a list with parent pointers would mean
 * inventing local ids that exist only inside the column — an identifier nothing outside this
 * document ever resolves. The depth is bounded by the space it was made from.
 *
 * The type is written out and the schema annotated with it, rather than left to inference, because
 * a self-referencing `const` has no type TypeScript can name on its own and the package emits
 * declarations.
 */
export type TemplateSpaceNode = {
  title: string
  icon: string | null
  doc: Record<string, unknown>
  children: TemplateSpaceNode[]
}
export const TemplateSpaceNode: z.ZodType<TemplateSpaceNode, TemplateSpaceNode> = z.lazy(() =>
  z.object({
    title: z.string().max(300),
    icon: z.string().max(64).nullable(),
    /** the page's body, with the same `{{variables}}` in it as any other */
    doc: RichDoc,
    children: z.array(TemplateSpaceNode),
  }),
)

/**
 * The body of a `space` template: the tree, under one key.
 *
 * An object rather than a bare array so that `Template.doc` is a JSON object for both kinds — the
 * column defaults to `'{}'`, and a default that is the wrong *type* for half the rows is a default
 * that lies. It also means the two bodies are told apart by their keys rather than by `typeof`.
 */
export const TemplateSpaceBody = z.object({ pages: z.array(TemplateSpaceNode) })
export type TemplateSpaceBody = z.infer<typeof TemplateSpaceBody>

/**
 * A page, or a whole space, saved so it can be made again.
 *
 * `doc` is left opaque here for the reason `RichDoc` is: this file is not what knows the shape of a
 * document. It is a page doc when `kind` is `page` and a `TemplateSpaceBody` when `kind` is `space`,
 * and the server parses the second with the schema above.
 *
 * A shipped starter is not one of these — it has no id, no workspace and no timestamps, because it
 * is a constant. What the picker returns is the starters and these together, with a row carrying a
 * starter's `key` standing in for that starter.
 */
export const Template = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null is workspace-wide; a space id scopes it to one space. Always null when `kind` is `space`. */
  spaceId: Id.nullable(),
  kind: TemplateKind,
  /**
   * The starter this row replaces, or null for somebody's own template.
   *
   * `z.string()` and **not** `TemplateStarterKey`, deliberately. This is stored data: a release that
   * stopped shipping a starter would turn every override of it into a parse failure, which is a
   * picker that throws rather than a picker missing one entry. A key naming a starter that no longer
   * exists is an ordinary custom template, and the read side treats it as one.
   */
  key: z.string().min(1).max(64).nullable(),
  /** true exactly when `key` is set — the database holds the pair to that with a check constraint */
  builtIn: z.boolean(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  /** a Lucide icon name, or an emoji */
  icon: z.string().max(64).nullable(),
  doc: RichDoc,
  variables: z.array(TemplateVariable),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Template = z.infer<typeof Template>

/**
 * A template without its body.
 *
 * This exists so that opening a picker does not download every template's prose to draw a list of
 * names — thirty page docs to render thirty rows, of which one is ever used. The body is fetched
 * when a template is chosen.
 */
export const TemplateSummary = Template.omit({ doc: true })
export type TemplateSummary = z.infer<typeof TemplateSummary>

export const Ok = z.object({ ok: z.literal(true) })
