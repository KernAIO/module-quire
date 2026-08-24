import { baseContract, Id, PageInput, page, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { Ok, Page, PageKind, PageNode, Space, SpaceVisibility } from './models.js'

const ws = z.object({ workspaceId: WorkspaceId })
const t = (...tags: string[]) => ({ tags })

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
  },
} as const
export type QuireContract = typeof quireContract

export { Ok }
