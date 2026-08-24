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

export const Ok = z.object({ ok: z.literal(true) })
