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

export const Ok = z.object({ ok: z.literal(true) })
