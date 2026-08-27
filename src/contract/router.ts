import { baseContract, Id, PageInput, page, UserId, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import {
  CommentAnchor,
  CommentThread,
  Favorite,
  Label,
  LabelColour,
  Ok,
  Page,
  PageKind,
  PageNode,
  PageVersion,
  RecentView,
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
