import { defineEvent, Id, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

const page = z.object({ pageId: Id, spaceId: Id, workspaceId: WorkspaceId })

/** `<module>.<entity>.<action>`. Anything that emits one declares it here. */
export const quireEvents = {
  spaceCreated: defineEvent('quire.space.created', z.object({ spaceId: Id, workspaceId: WorkspaceId })),
  spaceUpdated: defineEvent('quire.space.updated', z.object({ spaceId: Id, workspaceId: WorkspaceId })),
  spaceArchived: defineEvent(
    'quire.space.archived',
    z.object({ spaceId: Id, workspaceId: WorkspaceId, archived: z.boolean() }),
  ),
  pageCreated: defineEvent('quire.page.created', page),
  pageUpdated: defineEvent('quire.page.updated', page),
  pageMoved: defineEvent('quire.page.moved', page.extend({ parentId: Id.nullable() })),
  pageArchived: defineEvent('quire.page.archived', page.extend({ archived: z.boolean() })),
  pageTrashed: defineEvent('quire.page.trashed', page.extend({ count: z.number().int().nonnegative() })),
  pageRestored: defineEvent('quire.page.restored', page),
  pagePublished: defineEvent('quire.page.published', page.extend({ versionId: Id })),
  pageRestoredVersion: defineEvent(
    'quire.page.restored_version',
    z.object({ pageId: Id, workspaceId: WorkspaceId, versionId: Id }),
  ),
  commentCreated: defineEvent(
    'quire.comment.created',
    z.object({ commentId: Id, pageId: Id, workspaceId: WorkspaceId }),
  ),
  /** The page and its descendants are gone; anything holding a reference should drop it. */
  pageDeleted: defineEvent('quire.page.deleted', page.extend({ pageIds: z.array(Id) })),
} as const
