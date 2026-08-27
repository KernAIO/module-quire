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

export const Ok = z.object({ ok: z.literal(true) })
