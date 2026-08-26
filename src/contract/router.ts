import { baseContract, Id, PageInput, page, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import {
  CommentAnchor,
  CommentThread,
  Ok,
  Page,
  PageKind,
  PageNode,
  PageVersion,
  RichDoc,
  Space,
  SpaceVisibility,
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
} as const
export type QuireContract = typeof quireContract

export { Ok }
