import type {
  Comment,
  CommentAnchor,
  CommentThread,
  Database,
  DatabaseRef,
  Row as DatabaseRow,
  FavoriteEntry,
  Label,
  LabelColour,
  Page,
  PageNode,
  PageVersion,
  Property,
  PropertyConfig,
  PropertyType,
  RecentEntry,
  RowRef,
  Space,
  View,
  ViewConfig,
  ViewKind,
  WatchState,
} from '../contract/index.js'
import { rankBetween, rankSequence } from './rank.js'

/**
 * The in-memory quire API.
 *
 * A module missing from the mock has a working page and no way to reach it in exactly the
 * environment used for demos and end-to-end tests. Keep it in step with the contract.
 *
 * Ordering keys here are plain strings that happen to sort — the real ones are base-62 fractions
 * minted by `rankBetween`. Nothing in the mock inserts between two siblings often enough to need it,
 * and a second implementation of that algorithm is a second place for it to be wrong.
 */
const now = Date.now()
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString()

const uid = (n: number) => `01920000-0000-7000-8000-0000000${String(n).padStart(5, '0')}`

/**
 * The people the app's own mock signs you in as.
 *
 * Written out rather than derived: this module cannot see the shell's mock, and a comment with
 * nobody's id on it loses the delete control only its author is offered — so the margin would look
 * complete and be missing the one action that belongs to you.
 *
 * Declared here, above every factory that reads them, rather than beside the comment seed that used
 * to own them: the page factory now stamps an author too, and it is called while the module body is
 * still running. A `const` further down the same scope is in its temporal dead zone at that point,
 * so the whole mock throws on import and every Quire screen renders nothing.
 */
const ME = '01920000-0000-7000-8000-000000000001'
const COLLEAGUE = '01920000-0000-7000-8000-000000000002'

interface Row extends Page {
  /** the mock keeps trashed rows in the same list, as the server does */
  _order: string
  /** set when this page is a row of a database, exactly as the server's column means it */
  _databaseId?: string
  _props?: Record<string, unknown>
  _computed?: Record<string, unknown>
}

/** The complete `ViewConfig` the server always answers with, so the client can trust its type. */
const BLANK_VIEW_CONFIG: ViewConfig = {
  filters: [],
  filterMode: 'and',
  sorts: [],
  groupBy: null,
  dateProperty: null,
  visibleProperties: null,
  columnWidths: {},
  cardSize: 'medium',
  coverProperty: null,
}

export function createMockQuireApi() {
  const spaces: Space[] = [
    {
      id: uid(1),
      workspaceId: '' as Space['workspaceId'],
      key: 'handbook',
      name: 'Handbook',
      description: 'How this team works',
      icon: 'scroll-text',
      visibility: 'open',
      homepageId: uid(101),
      createdBy: null,
      createdAt: iso(9e7),
      updatedAt: iso(36e5),
      archivedAt: null,
    },
    {
      id: uid(2),
      workspaceId: '' as Space['workspaceId'],
      key: 'engineering',
      name: 'Engineering',
      description: 'Architecture notes, runbooks and decisions',
      icon: 'git-branch',
      visibility: 'restricted',
      homepageId: null,
      createdBy: null,
      createdAt: iso(8e7),
      updatedAt: iso(72e5),
      archivedAt: null,
    },
  ]

  const page = (
    id: number,
    spaceId: string,
    title: string,
    order: string,
    parent: number | null = null,
    over: Partial<Page> = {},
  ): Row => ({
    id: uid(id),
    workspaceId: '' as Page['workspaceId'],
    spaceId,
    parentId: parent === null ? null : uid(parent),
    position: order,
    kind: 'page',
    title,
    icon: null,
    coverUrl: null,
    publishedVersionId: null,
    hasUnpublishedChanges: false,
    /*
     * A seeded page has an author, because the byline reads one.
     *
     * These were both null, so `PageView` took its "author unknown" fallback on every page in the
     * demo — the one environment where the byline is ever looked at — and the named path it now
     * has shipped without anything rendering it. `ME` is the demo's signed-in member, so it
     * resolves through `core.workspaces.members.list` like a comment's author does.
     */
    createdBy: ME as Page['createdBy'],
    updatedBy: ME as Page['updatedBy'],
    createdAt: iso(9e7),
    updatedAt: iso(36e5),
    archivedAt: null,
    deletedAt: null,
    _order: order,
    ...over,
  })

  const pages: Row[] = [
    page(101, uid(1), 'Welcome', 'a', null, { publishedVersionId: uid(152) }),
    // A page with a draft readers cannot see yet, so the banner above the body is reachable. The
    // server only ever sets this on a page that has been published once, and neither does this.
    page(102, uid(1), 'Working here', 'b', null, {
      publishedVersionId: uid(153),
      hasUnpublishedChanges: true,
    }),
    page(103, uid(1), 'Your first week', 'ba', 102),
    page(104, uid(1), 'Time off', 'bb', 102),
    page(105, uid(1), 'Expenses', 'c', null, { kind: 'live' }),
    /*
     * A subtree in the trash, because that is the case the trash screen exists for.
     *
     * Deleting a page takes everything under it, and the flat listing the server answers with has
     * one row per page — so a demo whose trash holds a single orphan never exercises the grouping,
     * which is the whole difference between "one page was deleted" and "three were". These two are
     * a parent and its child, deleted together.
     */
    page(106, uid(1), 'Old expenses policy', 'ca', null, { deletedAt: iso(1728e5) }),
    page(107, uid(1), 'Receipts', 'caa', 106, { deletedAt: iso(1728e5) }),
    page(110, uid(1), 'Onboarding tasks', 'd', null, { kind: 'database' }),
    page(201, uid(2), 'Architecture', 'a'),
    page(202, uid(2), 'Runbooks', 'b'),
    page(203, uid(2), 'Deploying', 'ba', 202),
    page(204, uid(2), 'An old note', 'c', null, { deletedAt: iso(864e5) }),
  ]

  const DB_ID = uid(120)
  const DB_PAGE = uid(110)

  /**
   * One seeded database, so `dev:mock` and the end-to-end sweep have a real screen rather than an
   * empty state. Deliberately mixed: one row with every cell empty, so the empty-cell rendering is
   * exercised, and one status option with nothing in it, so an empty board lane is too.
   */
  const prop = (
    n: number,
    key: string,
    name: string,
    type: PropertyType,
    position: string,
    config: PropertyConfig = {},
  ): Property => ({ id: uid(n), databaseId: DB_ID, key, name, type, config, position, hidden: false })

  const properties: Property[] = [
    prop(121, 'owner', 'Owner', 'person', 'b', { multiple: false }),
    prop(122, 'status', 'Status', 'status', 'c', {
      options: [
        { id: 'todo', label: 'To do', colour: 'slate', group: 'todo' },
        { id: 'doing', label: 'In progress', colour: 'accent', group: 'doing' },
        { id: 'blocked', label: 'Blocked', colour: 'danger', group: 'doing' },
        { id: 'done', label: 'Done', colour: 'success', group: 'done' },
      ],
    }),
    prop(123, 'due', 'Due', 'date', 'd', {}),
    prop(124, 'days', 'Days', 'number', 'e', { precision: 0 }),
    prop(125, 'done', 'Signed off', 'checkbox', 'f', {}),
    prop(126, 'notes', 'Notes', 'text', 'g', {}),
  ]

  const views: View[] = [
    {
      id: uid(130),
      databaseId: DB_ID,
      name: 'All tasks',
      kind: 'table',
      config: { ...BLANK_VIEW_CONFIG },
      position: 'a',
      isDefault: true,
    },
    {
      id: uid(131),
      databaseId: DB_ID,
      name: 'By status',
      kind: 'board',
      config: { ...BLANK_VIEW_CONFIG, groupBy: 'status' },
      position: 'b',
      isDefault: false,
    },
    {
      id: uid(132),
      databaseId: DB_ID,
      name: 'Schedule',
      kind: 'calendar',
      config: { ...BLANK_VIEW_CONFIG, dateProperty: 'due' },
      position: 'c',
      isDefault: false,
    },
  ]

  const databases: Database[] = [
    {
      id: DB_ID,
      workspaceId: '' as Database['workspaceId'],
      spaceId: uid(1),
      pageId: DB_PAGE,
      name: 'Onboarding tasks',
      description: '',
      inline: false,
      properties,
      views,
      createdAt: iso(9e7),
      updatedAt: iso(36e5),
    },
  ]

  const day = (offset: number) => {
    const at = new Date(now + offset * 864e5)
    return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 9).toISOString()
  }

  const seedRows: [number, string, Record<string, unknown>][] = [
    [140, 'Read the handbook', { status: 'done', due: day(-6), days: 1, done: true, notes: 'Start here' }],
    [141, 'Meet the team', { status: 'done', due: day(-4), days: 1, done: true, notes: '' }],
    [
      142,
      'Set up your laptop',
      { status: 'doing', due: day(0), days: 2, done: false, notes: 'IT has the keys' },
    ],
    [143, 'Pick a starter task', { status: 'doing', due: day(1), days: 3, done: false, notes: '' }],
    [144, 'Book a 1:1', { status: 'todo', due: day(3), days: 1, done: false, notes: '' }],
    [
      145,
      'Payroll paperwork',
      { status: 'blocked', due: day(2), days: 1, done: false, notes: 'Waiting on HR' },
    ],
    [146, 'Add yourself to the rota', { status: 'todo', due: day(8), days: 1, done: false, notes: '' }],
    // Every cell empty on purpose: this is the row that finds an empty-cell rendering bug.
    [147, 'Anything else?', {}],
  ]

  for (const [n, title, props] of seedRows) {
    const row = page(n, uid(1), title, `z${n}`, 110)
    row._databaseId = DB_ID
    row._props = props
    row._computed = {}
    pages.push(row)
  }

  /**
   * What the pages used to say, and what people have asked about them.
   *
   * Seeded rather than left empty. Version history and the comment margin are two of the three
   * things a page screen is for, and until these existed the demo interface answered the history
   * sheet with "The history could not be loaded" and never drew a margin at all — in exactly the
   * environment used for demos and end-to-end tests. Two pages differ on purpose, so a page with a
   * margin and a page without one are both reachable.
   */
  const version = (
    n: number,
    pageId: string,
    kind: PageVersion['kind'],
    label: string | null,
    preview: string,
    msAgo: number,
    authorId: string,
  ): PageVersion => ({
    id: uid(n),
    workspaceId: '' as PageVersion['workspaceId'],
    pageId,
    kind,
    label,
    preview,
    // The server reports the length of the encoded document; the order of magnitude is all any
    // screen does with it.
    size: preview.length * 4,
    authorId: authorId as PageVersion['authorId'],
    createdAt: iso(msAgo),
    // Which version readers are served is a property of the page, so it is worked out on the way
    // out rather than stored here twice and left to disagree with itself.
    published: false,
  })

  const versions: PageVersion[] = [
    version(150, uid(101), 'publish', 'The first handbook', 'Welcome to Northstar.', 9e7, ME),
    version(
      151,
      uid(101),
      'auto',
      null,
      'Welcome to Northstar. We are a small team and we write things down.',
      108e5,
      COLLEAGUE,
    ),
    version(
      152,
      uid(101),
      'publish',
      null,
      'Welcome to Northstar. We are a small team and we write things down, so that nobody has to ask the same question twice.',
      72e5,
      ME,
    ),
    version(153, uid(102), 'publish', null, 'How this team works, in one page.', 108e5, ME),
    version(
      154,
      uid(102),
      'auto',
      null,
      'How this team works, in one page. Start with your first week.',
      36e5,
      COLLEAGUE,
    ),
  ]

  const richDoc = (text: string): Record<string, unknown> => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })

  /** The same dumb walk the server does: whatever the editor produced, minus everything but text. */
  const flatten = (body: unknown): string => {
    const out: string[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as { text?: unknown; content?: unknown[] }
      if (typeof n.text === 'string') out.push(n.text)
      if (Array.isArray(n.content)) for (const child of n.content) walk(child)
    }
    walk(body)
    return out.join(' ').replace(/\s+/g, ' ').trim()
  }

  const comment = (
    n: number,
    pageId: string,
    threadId: string,
    parentId: string | null,
    authorId: string,
    text: string,
    msAgo: number,
  ): Comment => ({
    id: uid(n),
    workspaceId: '' as Comment['workspaceId'],
    pageId,
    parentId,
    threadId,
    authorId: authorId as Comment['authorId'],
    body: richDoc(text),
    bodyText: text,
    mentionIds: [],
    /*
     * No anchor, and none of these quote anything.
     *
     * An anchor is a pair of Yjs relative positions into a document that only exists behind the
     * collab service, and there is no collab service here — a made-up one would point at nothing
     * and the editor would draw a highlight over the wrong words, which is worse than no highlight.
     */
    anchor: null,
    quotedText: '',
    resolvedAt: null,
    resolvedBy: null,
    editedAt: null,
    createdAt: iso(msAgo),
  })

  const comments: Comment[] = [
    comment(160, uid(101), uid(160), null, COLLEAGUE, 'Should this mention the on-call rota?', 72e5),
    comment(161, uid(101), uid(160), uid(160), ME, 'Good point — I will link to it from here.', 36e5),
  ]

  /**
   * How a space is organised, and what one person has made of it.
   *
   * Seeded rather than left empty for the same reason the versions and comments above are: a screen
   * with no data in the demo is a screen the end-to-end sweep cannot see, so an empty favourites
   * group and an empty label picker would ship without anything ever rendering the populated case.
   *
   * Two spaces on purpose. Labels belong to a space — two teams both wanting "Draft" should not
   * have to agree on what it means — and a seed with one space's vocabulary would let a bug that
   * leaks labels across the boundary pass unnoticed.
   */
  const label = (n: number, spaceId: string, name: string, colour: LabelColour, msAgo: number): Label => ({
    id: uid(n),
    workspaceId: '' as Label['workspaceId'],
    spaceId,
    name,
    colour,
    createdAt: iso(msAgo),
  })

  const labels: Label[] = [
    label(300, uid(1), 'Draft', 'warning', 8e7),
    label(301, uid(1), 'Needs review', 'info', 79e6),
    label(302, uid(1), 'Reference', 'purple', 78e6),
    label(303, uid(2), 'ADR', 'slate', 77e6),
  ]

  /** page id → label ids. A page wears a set, and `pages.setLabels` replaces the whole of it. */
  const pageLabels = new Map<string, string[]>([
    [uid(101), [uid(302)]],
    [uid(102), [uid(300), uid(301)]],
    [uid(103), [uid(300)]],
    [uid(201), [uid(303)]],
  ])

  /**
   * One person's shortcuts, in the order they arranged them.
   *
   * Ranks come from the real `rankBetween` rather than from the plain sortable strings the rest of
   * this file uses. Reordering favourites is a drag, so the mock is the only thing the interaction
   * is ever tested against — and a second implementation of fractional indexing is a second place
   * for it to be wrong. Three of them, across two spaces, because a favourite is a workspace list
   * and a demo confined to one space would never show that.
   */
  const favouriteSeed = rankSequence(3)
  const favorites: { pageId: string; position: string; createdAt: string }[] = [
    { pageId: uid(101), position: favouriteSeed[0] as string, createdAt: iso(72e5) },
    { pageId: uid(105), position: favouriteSeed[1] as string, createdAt: iso(54e5) },
    { pageId: uid(202), position: favouriteSeed[2] as string, createdAt: iso(36e5) },
  ]

  /** page id → the people watching it. Deliberately not the same list as the favourites above. */
  const watchers = new Map<string, string[]>([
    [uid(101), [ME, COLLEAGUE]],
    [uid(102), [COLLEAGUE]],
  ])

  /** One row per page, bumped in place — never a visit log. */
  const recents: { pageId: string; viewedAt: string }[] = [
    { pageId: uid(102), viewedAt: iso(6e5) },
    { pageId: uid(110), viewedAt: iso(18e5) },
    { pageId: uid(201), viewedAt: iso(9e6) },
  ]

  let seq = 900
  const nextId = () => uid(++seq)
  const strip = ({ _order, ...p }: Row): Page => p
  const found = (id: string) => {
    const row = pages.find((p) => p.id === id)
    if (!row) throw Object.assign(new Error('Page not found'), { code: 'NOT_FOUND' })
    return row
  }
  /** Every descendant of `id`, including it — the same subtree the server acts on. */
  const subtree = (id: string): Row[] => {
    const out: Row[] = []
    const walk = (parent: string) => {
      out.push(...pages.filter((p) => p.id === parent))
      for (const child of pages.filter((p) => p.parentId === parent)) walk(child.id)
    }
    walk(id)
    return out
  }
  const touch = (row: Row) => {
    row.updatedAt = new Date().toISOString()
  }

  const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { code: 'NOT_FOUND' })

  const theVersion = (id: string): PageVersion => {
    const found = versions.find((v) => v.id === id)
    if (!found) throw notFound('Version')
    return found
  }
  const theComment = (id: string): Comment => {
    const found = comments.find((c) => c.id === id)
    if (!found) throw notFound('Comment')
    return found
  }

  /** Which version a reader is served, which the list and the sheet both have to agree about. */
  const publishedOn = (pageId: string) => pages.find((p) => p.id === pageId)?.publishedVersionId ?? null
  const asVersion = (v: PageVersion): PageVersion => ({ ...v, published: v.id === publishedOn(v.pageId) })

  /**
   * Write down what the page says now, exactly where the server takes a version.
   *
   * There is no document behind this, so the newest version's prose stands in for the live one —
   * enough that restoring writes a new row saying what it restored, which is the behaviour the
   * history sheet is judged on.
   */
  const capture = (pageId: string, kind: PageVersion['kind'], label: string | null, preview?: string) => {
    const latest = versions.filter((v) => v.pageId === pageId).at(-1)
    const taken = version(
      ++seq,
      pageId,
      kind,
      label,
      preview ?? latest?.preview ?? found(pageId).title,
      0,
      ME,
    )
    versions.push(taken)
    return taken
  }

  const theDatabase = (id: string): Database => {
    const db = databases.find((d) => d.id === id)
    if (!db) throw notFound('Database')
    return db
  }
  const theProperty = (id: string): Property => {
    for (const db of databases) {
      const property = db.properties.find((p) => p.id === id)
      if (property) return property
    }
    throw notFound('Property')
  }
  const theView = (id: string): View => {
    for (const db of databases) {
      const view = db.views.find((v) => v.id === id)
      if (view) return view
    }
    throw notFound('View')
  }

  const theLabel = (id: string): Label => {
    const found = labels.find((l) => l.id === id)
    if (!found) throw notFound('Label')
    return found
  }

  /**
   * The page fields a shortcut row draws — or nothing, when the page has been trashed or purged.
   *
   * The server composes these with a join to `pages`, which is why a favourite whose page is gone
   * simply stops being drawn: the row survives (nothing cascades from a purge), and every read
   * joins. Reproducing that here is the difference between a demo where trashing a favourited page
   * quietly removes it from the sidebar and one where the sidebar keeps a shortcut to nothing.
   */
  const pageBitsOf = (pageId: string) => {
    const row = pages.find((p) => p.id === pageId && !p.deletedAt)
    return row ? { spaceId: row.spaceId, title: row.title, icon: row.icon, kind: row.kind } : null
  }

  const byPosition = (a: { position: string }, b: { position: string }) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0

  const favoriteList = (): FavoriteEntry[] =>
    [...favorites].sort(byPosition).flatMap((f) => {
      const bits = pageBitsOf(f.pageId)
      if (!bits) return []
      return [
        {
          workspaceId: '' as FavoriteEntry['workspaceId'],
          userId: ME as FavoriteEntry['userId'],
          pageId: f.pageId,
          position: f.position,
          createdAt: f.createdAt,
          ...bits,
        },
      ]
    })

  const recentList = (limit: number): RecentEntry[] =>
    [...recents]
      .sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1))
      .flatMap((r) => {
        const bits = pageBitsOf(r.pageId)
        if (!bits) return []
        return [
          {
            workspaceId: '' as RecentEntry['workspaceId'],
            userId: ME as RecentEntry['userId'],
            pageId: r.pageId,
            viewedAt: r.viewedAt,
            ...bits,
          },
        ]
      })
      .slice(0, limit)

  const watchStateOf = (pageId: string): WatchState => {
    const list = watchers.get(pageId) ?? []
    return { watching: list.includes(ME), watchers: list as WatchState['watchers'] }
  }

  const labelsOn = (pageId: string): Label[] =>
    (pageLabels.get(pageId) ?? []).flatMap((id) => {
      const found = labels.find((l) => l.id === id)
      return found ? [found] : []
    })

  /**
   * A copy on the way out, because a real API answers with fresh JSON every time.
   *
   * Handing back the live object makes the mock *look* right and behave wrongly in one specific
   * way: TanStack's structural sharing compares the new answer with the cached one, finds the same
   * object, and keeps the old reference — so `query.data` never changes identity, no `$derived`
   * re-runs, and every schema change (a new column, a deleted view) is applied to the data and
   * invisible on screen. Rows never showed it, because `toDatabaseRow` already built a new object.
   */
  const copy = <T>(value: T): T => structuredClone(value)

  const toDatabaseRow = (row: Row): DatabaseRow => ({
    id: row.id,
    databaseId: row._databaseId ?? '',
    title: row.title,
    icon: row.icon,
    props: { ...(row._props ?? {}) },
    computed: { ...(row._computed ?? {}) },
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })

  /**
   * Filtering and sorting in memory.
   *
   * The server does both in SQL, and this is a deliberately smaller reimplementation of the same
   * rules — enough that a filter really does shrink the list and a sort really does reorder it, so
   * the end-to-end tests are testing behaviour rather than a screen that never changes.
   */
  const cellOf = (row: Row, property: Property): unknown =>
    property.type === 'formula' || property.type === 'rollup'
      ? (row._computed ?? {})[property.key]
      : property.type === 'created_time'
        ? row.createdAt
        : property.type === 'edited_time'
          ? row.updatedAt
          : (row._props ?? {})[property.key]

  const isEmpty = (value: unknown) =>
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

  function matches(row: Row, operator: string, wanted: unknown, property: Property): boolean {
    const value = cellOf(row, property)
    if (operator === 'is_empty') return isEmpty(value)
    if (operator === 'is_not_empty') return !isEmpty(value)

    const list = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]
    const asked = Array.isArray(wanted) ? wanted.map(String) : wanted == null ? [] : [String(wanted)]

    switch (operator) {
      case 'equals':
        return property.type === 'checkbox'
          ? (value === true) === (wanted === true || wanted === 'true')
          : String(value ?? '') === String(wanted ?? '')
      case 'not_equals':
        return String(value ?? '') !== String(wanted ?? '')
      case 'contains':
        return Array.isArray(value)
          ? asked.some((a) => list.includes(a))
          : String(value ?? '')
              .toLowerCase()
              .includes(String(wanted ?? '').toLowerCase())
      case 'not_contains':
        return !(Array.isArray(value)
          ? asked.some((a) => list.includes(a))
          : String(value ?? '')
              .toLowerCase()
              .includes(String(wanted ?? '').toLowerCase()))
      case 'starts_with':
        return String(value ?? '')
          .toLowerCase()
          .startsWith(String(wanted ?? '').toLowerCase())
      case 'ends_with':
        return String(value ?? '')
          .toLowerCase()
          .endsWith(String(wanted ?? '').toLowerCase())
      case 'greater_than':
        return Number(value) > Number(wanted)
      case 'less_than':
        return Number(value) < Number(wanted)
      case 'on_or_after':
        return new Date(String(value)).getTime() >= new Date(String(wanted)).getTime()
      case 'on_or_before':
        return new Date(String(value)).getTime() <= new Date(String(wanted)).getTime()
      case 'is_any_of':
        return asked.some((a) => list.includes(a))
      case 'is_none_of':
        return !asked.some((a) => list.includes(a))
      default:
        return true
    }
  }

  function compareBy(a: Row, b: Row, property: Property): number {
    const left = cellOf(a, property)
    const right = cellOf(b, property)
    if (isEmpty(left) && isEmpty(right)) return 0
    // Nulls last, whichever way the sort runs — an empty cell is not "the smallest value".
    if (isEmpty(left)) return 1
    if (isEmpty(right)) return -1
    if (property.type === 'number' || property.type === 'formula' || property.type === 'rollup')
      return Number(left) - Number(right)
    if (property.type === 'checkbox') return Number(left === true) - Number(right === true)
    if (property.type === 'date' || property.type === 'created_time' || property.type === 'edited_time')
      return new Date(String(left)).getTime() - new Date(String(right)).getTime()
    return String(left).localeCompare(String(right))
  }

  return {
    spaces: {
      list: async ({ includeArchived = false }: { includeArchived?: boolean } = {}) =>
        spaces.filter((s) => includeArchived || !s.archivedAt),
      get: async ({ spaceId }: { spaceId: string }) => {
        const s = spaces.find((x) => x.id === spaceId)
        if (!s) throw Object.assign(new Error('Space not found'), { code: 'NOT_FOUND' })
        return s
      },
      create: async (input: {
        key: string
        name: string
        description?: string
        icon?: string | null
        visibility?: Space['visibility']
      }) => {
        if (spaces.some((s) => s.key === input.key))
          throw Object.assign(new Error(`A space with the key "${input.key}" already exists`), {
            code: 'CONFLICT',
          })
        const s: Space = {
          id: nextId(),
          workspaceId: '' as Space['workspaceId'],
          key: input.key,
          name: input.name,
          description: input.description ?? '',
          icon: input.icon ?? null,
          visibility: input.visibility ?? 'open',
          homepageId: null,
          createdBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        }
        spaces.push(s)
        return s
      },
      update: async ({ spaceId, ...patch }: { spaceId: string } & Partial<Space>) => {
        const s = spaces.find((x) => x.id === spaceId)
        if (!s) throw Object.assign(new Error('Space not found'), { code: 'NOT_FOUND' })
        Object.assign(s, patch, { updatedAt: new Date().toISOString() })
        return s
      },
      archive: async ({ spaceId, archived = true }: { spaceId: string; archived?: boolean }) => {
        const s = spaces.find((x) => x.id === spaceId)
        if (!s) throw Object.assign(new Error('Space not found'), { code: 'NOT_FOUND' })
        s.archivedAt = archived ? new Date().toISOString() : null
        return s
      },
    },

    pages: {
      tree: async ({
        spaceId,
        includeArchived = false,
      }: {
        spaceId: string
        includeArchived?: boolean
      }): Promise<PageNode[]> => {
        const rows = pages
          // A row is a page parented to its database's page, and five hundred of them under one
          // node is an unusable sidebar — the server excludes them from the tree for the same reason.
          .filter((p) => !p._databaseId)
          .filter((p) => p.spaceId === spaceId && !p.deletedAt && (includeArchived || !p.archivedAt))
          .sort((a, b) => (a._order < b._order ? -1 : a._order > b._order ? 1 : 0))
        const parents = new Set(rows.map((r) => r.parentId).filter((x): x is string => x !== null))
        return rows.map((r) => ({
          id: r.id,
          parentId: r.parentId,
          position: r.position,
          kind: r.kind,
          title: r.title,
          icon: r.icon,
          hasChildren: parents.has(r.id),
          archivedAt: r.archivedAt,
        }))
      },
      get: async ({ pageId }: { pageId: string }) => strip(found(pageId)),
      trash: async ({ spaceId, limit = 50 }: { spaceId: string; limit?: number }) => ({
        items: pages
          .filter((p) => p.spaceId === spaceId && p.deletedAt)
          .slice(0, limit)
          .map(strip),
        nextCursor: null,
      }),
      create: async (input: {
        spaceId: string
        parentId?: string | null
        title?: string
        kind?: Page['kind']
        icon?: string | null
        afterId?: string | null
      }) => {
        const siblings = pages
          .filter(
            (p) => p.spaceId === input.spaceId && p.parentId === (input.parentId ?? null) && !p.deletedAt,
          )
          .sort((a, b) => (a._order < b._order ? -1 : 1))
        const last = siblings.at(-1)?._order ?? 'a'
        const row = page(++seq, input.spaceId, input.title ?? '', `${last}m`, null, {
          kind: input.kind ?? 'page',
          icon: input.icon ?? null,
        })
        row.id = uid(seq)
        row.parentId = input.parentId ?? null
        row.createdAt = new Date().toISOString()
        row.updatedAt = row.createdAt
        pages.push(row)
        return strip(row)
      },
      update: async ({ pageId, ...patch }: { pageId: string } & Partial<Page>) => {
        const row = found(pageId)
        Object.assign(row, patch)
        touch(row)
        return strip(row)
      },
      move: async ({
        pageId,
        parentId,
        afterId = null,
      }: {
        pageId: string
        parentId: string | null
        afterId?: string | null
      }) => {
        const row = found(pageId)
        if (parentId === pageId)
          throw Object.assign(new Error('A page cannot be its own parent'), { code: 'BAD_REQUEST' })
        if (parentId && subtree(pageId).some((p) => p.id === parentId))
          throw Object.assign(new Error('A page cannot move inside one of its own descendants'), {
            code: 'BAD_REQUEST',
          })
        row.parentId = parentId
        const siblings = pages
          .filter(
            (p) => p.spaceId === row.spaceId && p.parentId === parentId && p.id !== pageId && !p.deletedAt,
          )
          .sort((a, b) => (a._order < b._order ? -1 : 1))
        const at = afterId ? siblings.findIndex((s) => s.id === afterId) : -1
        const before = at >= 0 ? siblings[at]?._order : undefined
        row._order = before ? `${before}m` : `${siblings[0]?._order ?? 'a'.repeat(1)}0`
        row.position = row._order
        touch(row)
        return strip(row)
      },
      archive: async ({ pageId, archived = true }: { pageId: string; archived?: boolean }) => {
        const row = found(pageId)
        row.archivedAt = archived ? new Date().toISOString() : null
        touch(row)
        return strip(row)
      },
      trashPage: async ({ pageId }: { pageId: string }) => {
        const rows = subtree(pageId)
        const at = new Date().toISOString()
        for (const r of rows) r.deletedAt = at
        return { ok: true as const, count: rows.length }
      },
      restore: async ({ pageId }: { pageId: string }) => {
        const row = found(pageId)
        // Restoring under a parent that is still in the trash would hide it for ever.
        if (row.parentId && pages.find((p) => p.id === row.parentId)?.deletedAt) row.parentId = null
        for (const r of subtree(pageId)) r.deletedAt = null
        touch(row)
        return strip(row)
      },
      purge: async ({ pageId }: { pageId: string }) => {
        const ids = new Set(subtree(pageId).map((r) => r.id))
        for (let i = pages.length - 1; i >= 0; i--) if (ids.has(pages[i]!.id)) pages.splice(i, 1)
        /*
         * The favourites, watches and labels of a purged page are deliberately left behind, because
         * that is what the server does: there is no foreign key, so the rows survive and every read
         * joins to `pages` — which is why they are invisible rather than broken. Cleaning them up
         * here would hide the one thing worth noticing about that decision.
         */
        return { ok: true as const, count: ids.size }
      },

      setLabels: async ({ pageId, labelIds }: { pageId: string; labelIds: string[] }) => {
        const row = found(pageId)
        for (const id of labelIds) {
          const label = theLabel(id)
          // A label belongs to a space; putting another space's on a page would leak its vocabulary.
          if (label.spaceId !== row.spaceId)
            throw Object.assign(new Error('Every label has to be one this space declares'), {
              code: 'BAD_REQUEST',
            })
        }
        pageLabels.set(pageId, [...labelIds])
        return labelsOn(pageId).map((l) => ({ ...l }))
      },
    },

    /**
     * The space's vocabulary. Names clash case-insensitively, as they do in the database — "Draft"
     * beside "draft" in one picker is broken data rather than two labels — and the capitalisation
     * somebody typed is what is kept.
     */
    labels: {
      list: async ({ spaceId }: { spaceId: string }) =>
        labels.filter((l) => l.spaceId === spaceId).map((l) => ({ ...l })),

      forPage: async ({ pageId }: { pageId: string }) => labelsOn(pageId).map((l) => ({ ...l })),

      create: async (input: { spaceId: string; name: string; colour?: LabelColour }) => {
        const name = input.name.trim()
        if (!name) throw Object.assign(new Error('A label needs a name'), { code: 'BAD_REQUEST' })
        if (labels.some((l) => l.spaceId === input.spaceId && l.name.toLowerCase() === name.toLowerCase()))
          throw Object.assign(new Error(`This space already has a label called "${name}"`), {
            code: 'CONFLICT',
          })
        const made: Label = {
          id: nextId(),
          workspaceId: '' as Label['workspaceId'],
          spaceId: input.spaceId,
          name,
          colour: input.colour ?? 'grey',
          createdAt: new Date().toISOString(),
        }
        labels.push(made)
        return { ...made }
      },

      update: async (input: { labelId: string; name?: string; colour?: LabelColour }) => {
        const label = theLabel(input.labelId)
        if (input.name !== undefined) {
          const name = input.name.trim()
          if (!name) throw Object.assign(new Error('A label needs a name'), { code: 'BAD_REQUEST' })
          if (
            labels.some(
              (l) =>
                l.id !== label.id &&
                l.spaceId === label.spaceId &&
                l.name.toLowerCase() === name.toLowerCase(),
            )
          )
            throw Object.assign(new Error(`This space already has a label called "${name}"`), {
              code: 'CONFLICT',
            })
          label.name = name
        }
        if (input.colour !== undefined) label.colour = input.colour
        return { ...label }
      },

      remove: async ({ labelId }: { labelId: string }) => {
        const label = theLabel(labelId)
        labels.splice(labels.indexOf(label), 1)
        // Off every page that wore it — a label nothing can name is not one anybody can remove.
        for (const [pageId, ids] of pageLabels)
          if (ids.includes(labelId))
            pageLabels.set(
              pageId,
              ids.filter((id) => id !== labelId),
            )
        return { ok: true as const }
      },
    },

    /**
     * One person's own shortcuts. Every mutation answers with the whole ordered list, because a
     * fractional-index reorder is only meaningful as an ordering — and because it saves the sidebar
     * a refetch to redraw itself.
     */
    favorites: {
      list: async () => favoriteList(),

      add: async ({ pageId }: { pageId: string }) => {
        found(pageId)
        // Starring the same page twice is the same star, not an error.
        if (!favorites.some((f) => f.pageId === pageId)) {
          const last = [...favorites].sort(byPosition).at(-1)?.position ?? null
          favorites.push({
            pageId,
            position: rankBetween(last, null),
            createdAt: new Date().toISOString(),
          })
        }
        return favoriteList()
      },

      remove: async ({ pageId }: { pageId: string }) => {
        const at = favorites.findIndex((f) => f.pageId === pageId)
        if (at >= 0) favorites.splice(at, 1)
        return favoriteList()
      },

      reorder: async ({ pageId, afterId = null }: { pageId: string; afterId?: string | null }) => {
        const moving = favorites.find((f) => f.pageId === pageId)
        if (!moving) throw notFound('Favourite')
        const rest = [...favorites].filter((f) => f.pageId !== pageId).sort(byPosition)
        const at = afterId ? rest.findIndex((f) => f.pageId === afterId) : -1
        if (afterId && at < 0)
          throw Object.assign(new Error('afterId is not one of your favourites'), {
            code: 'BAD_REQUEST',
          })
        moving.position = rankBetween(
          at >= 0 ? (rest[at]?.position ?? null) : null,
          rest[at + 1]?.position ?? null,
        )
        return favoriteList()
      },
    },

    watchers: {
      get: async ({ pageId }: { pageId: string }) => {
        found(pageId)
        return watchStateOf(pageId)
      },

      set: async ({ pageId, watching = true }: { pageId: string; watching?: boolean }) => {
        found(pageId)
        const list = watchers.get(pageId) ?? []
        const next = watching ? (list.includes(ME) ? list : [...list, ME]) : list.filter((id) => id !== ME)
        watchers.set(pageId, next)
        return watchStateOf(pageId)
      },
    },

    recents: {
      list: async ({ limit = 10 }: { limit?: number } = {}) => recentList(limit),

      record: async ({ pageId }: { pageId: string }) => {
        found(pageId)
        const existing = recents.find((r) => r.pageId === pageId)
        // Bumped in place, never appended: this is one row per page, not a visit log.
        if (existing) existing.viewedAt = new Date().toISOString()
        else recents.push({ pageId, viewedAt: new Date().toISOString() })
        return { ok: true as const }
      },
    },

    versions: {
      list: async ({ pageId, limit = 50 }: { pageId: string; limit?: number }) => ({
        // Newest first, and the ids sort because they are minted in order — the same thing the
        // server gets from ordering on a uuidv7.
        items: versions
          .filter((v) => v.pageId === pageId)
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .slice(0, limit)
          .map(asVersion),
        nextCursor: null,
      }),

      get: async ({ versionId }: { versionId: string }) => {
        const found = theVersion(versionId)
        return {
          ...asVersion(found),
          text: found.preview,
          // The server renders the stored document; the escaping is the part worth keeping, since
          // a screen hands this straight to a renderer.
          html: `<p>${found.preview.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
        }
      },

      create: async ({ pageId, label = null }: { pageId: string; label?: string | null }) =>
        asVersion(capture(pageId, 'auto', label)),

      restore: async ({ versionId }: { versionId: string }) => {
        const wanted = theVersion(versionId)
        // The state about to be replaced is captured first, so restoring is itself undoable — the
        // reason the sheet offers it without a confirmation.
        capture(wanted.pageId, 'auto', null)
        const restored = capture(wanted.pageId, 'restore', wanted.label, wanted.preview)
        touch(found(wanted.pageId))
        return asVersion(restored)
      },
    },

    comments: {
      list: async ({
        pageId,
        includeResolved = false,
      }: {
        pageId: string
        includeResolved?: boolean
      }): Promise<CommentThread[]> => {
        const byThread = new Map<string, Comment[]>()
        for (const c of comments.filter((c) => c.pageId === pageId)) {
          byThread.set(c.threadId, [...(byThread.get(c.threadId) ?? []), c])
        }
        const threads: CommentThread[] = []
        for (const [threadId, list] of byThread) {
          const ordered = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
          // A thread whose root was deleted while replies remain is still somebody's conversation,
          // so the oldest remaining comment leads it — as it does on the server.
          const lead = ordered.find((c) => c.id === threadId) ?? ordered[0]
          if (!lead) continue
          const resolved = Boolean(lead.resolvedAt)
          if (resolved && !includeResolved) continue
          threads.push({
            id: threadId,
            root: structuredClone(lead),
            replies: ordered.filter((c) => c.id !== lead.id).map((c) => structuredClone(c)),
            resolved,
          })
        }
        return threads
      },

      create: async (input: {
        pageId: string
        body: Record<string, unknown>
        anchor?: CommentAnchor | null
        quotedText?: string
        parentId?: string | null
      }) => {
        const parent = input.parentId ? theComment(input.parentId) : null
        const id = nextId()
        const made: Comment = {
          id,
          workspaceId: '' as Comment['workspaceId'],
          pageId: input.pageId,
          parentId: parent?.id ?? null,
          // A reply belongs to the thread its parent is in, never to a thread of its own.
          threadId: parent?.threadId ?? id,
          authorId: ME as Comment['authorId'],
          body: input.body,
          bodyText: flatten(input.body),
          mentionIds: [],
          anchor: input.anchor ?? null,
          quotedText: input.quotedText ?? '',
          resolvedAt: null,
          resolvedBy: null,
          editedAt: null,
          createdAt: new Date().toISOString(),
        }
        comments.push(made)
        return structuredClone(made)
      },

      update: async ({ commentId, body }: { commentId: string; body: Record<string, unknown> }) => {
        const found = theComment(commentId)
        found.body = body
        found.bodyText = flatten(body)
        found.editedAt = new Date().toISOString()
        return structuredClone(found)
      },

      remove: async ({ commentId }: { commentId: string }) => {
        const found = theComment(commentId)
        comments.splice(comments.indexOf(found), 1)
        return { ok: true as const }
      },

      resolve: async ({ commentId, resolved = true }: { commentId: string; resolved?: boolean }) => {
        const lead = theComment(commentId)
        // Resolving is a property of the conversation, so it is written on the comment that leads
        // it and read from there — never on each reply.
        lead.resolvedAt = resolved ? new Date().toISOString() : null
        lead.resolvedBy = resolved ? (ME as Comment['resolvedBy']) : null
        const rest = comments.filter((c) => c.threadId === lead.threadId && c.id !== lead.id)
        return {
          id: lead.threadId,
          root: structuredClone(lead),
          replies: rest.map((c) => structuredClone(c)),
          resolved,
        }
      },
    },

    publishing: {
      publish: async ({ pageId, label = null }: { pageId: string; label?: string | null }) => {
        const row = found(pageId)
        if (row.kind !== 'page')
          throw Object.assign(new Error('Only a page has a published version; a live doc is always live'), {
            code: 'BAD_REQUEST',
          })
        const taken = capture(pageId, 'publish', label)
        row.publishedVersionId = taken.id
        row.hasUnpublishedChanges = false
        touch(row)
        return strip(row)
      },

      revert: async ({ pageId }: { pageId: string }) => {
        const row = found(pageId)
        if (!row.publishedVersionId)
          throw Object.assign(
            new Error('This page has never been published, so there is nothing to go back to'),
            { code: 'BAD_REQUEST' },
          )
        // The draft being discarded is kept, because discarding it should not be a way to lose an
        // afternoon's writing with no way back.
        capture(pageId, 'auto', null)
        row.hasUnpublishedChanges = false
        touch(row)
        return strip(row)
      },
    },

    databases: {
      list: async ({ spaceId }: { spaceId: string }): Promise<DatabaseRef[]> =>
        databases
          .filter((d) => d.spaceId === spaceId)
          .map((d) => ({ id: d.id, pageId: d.pageId, name: d.name })),

      get: async ({ databaseId }: { databaseId: string }) => copy(theDatabase(databaseId)),

      forPage: async ({ pageId }: { pageId: string }) => {
        const db = databases.find((d) => d.pageId === pageId)
        return db ? copy(db) : null
      },

      create: async (input: { spaceId: string; pageId: string; name?: string; inline?: boolean }) => {
        const db: Database = {
          id: nextId(),
          workspaceId: '' as Database['workspaceId'],
          spaceId: input.spaceId,
          pageId: input.pageId,
          name: input.name ?? '',
          description: '',
          inline: input.inline ?? false,
          properties: [],
          views: [
            {
              id: nextId(),
              databaseId: '',
              name: 'Table',
              kind: 'table',
              config: { ...BLANK_VIEW_CONFIG },
              position: 'a',
              isDefault: true,
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        for (const view of db.views) view.databaseId = db.id
        databases.push(db)
        found(input.pageId).kind = 'database'
        return copy(db)
      },

      rows: async (input: {
        databaseId: string
        viewId?: string | null
        limit?: number
        cursor?: string | null
      }) => {
        const db = theDatabase(input.databaseId)
        const view = input.viewId
          ? db.views.find((v) => v.id === input.viewId)
          : (db.views.find((v) => v.isDefault) ?? db.views[0])
        const config = view?.config ?? BLANK_VIEW_CONFIG

        let selected = pages.filter((r) => r._databaseId === input.databaseId && !r.deletedAt)
        if (config.filters.length > 0)
          selected = selected.filter((row) => {
            const results = config.filters.map((filter) => {
              const property = db.properties.find((p) => p.key === filter.propertyKey)
              if (!property)
                throw Object.assign(new Error(`No such property: ${filter.propertyKey}`), {
                  code: 'BAD_REQUEST',
                })
              return matches(row, filter.operator, filter.value, property)
            })
            return config.filterMode === 'or' ? results.some(Boolean) : results.every(Boolean)
          })

        for (const sort of [...config.sorts].reverse()) {
          const property = db.properties.find((p) => p.key === sort.propertyKey)
          if (!property) continue
          const direction = sort.direction === 'desc' ? -1 : 1
          selected = [...selected].sort((a, b) => direction * compareBy(a, b, property))
        }

        const limit = input.limit ?? 50
        const from = Number.parseInt(input.cursor ?? '0', 10) || 0
        const window = selected.slice(from, from + limit)
        return {
          items: window.map(toDatabaseRow),
          nextCursor: from + window.length < selected.length ? String(from + window.length) : null,
        }
      },

      addRow: async (input: { databaseId: string; title?: string; props?: Record<string, unknown> }) => {
        const db = theDatabase(input.databaseId)
        const row = page(++seq, db.spaceId, input.title ?? '', `z${seq}`, null)
        row.id = uid(seq)
        row.parentId = db.pageId
        row._databaseId = db.id
        row._props = { ...(input.props ?? {}) }
        row._computed = {}
        row.createdAt = new Date().toISOString()
        row.updatedAt = row.createdAt
        pages.push(row)
        return toDatabaseRow(row)
      },

      updateRow: async (input: { rowId: string; title?: string; props?: Record<string, unknown> }) => {
        const row = found(input.rowId)
        if (input.title !== undefined) row.title = input.title
        if (input.props) row._props = { ...(row._props ?? {}), ...input.props }
        touch(row)
        return toDatabaseRow(row)
      },

      lookup: async (input: {
        databaseId: string
        query?: string
        ids?: string[]
        limit?: number
      }): Promise<RowRef[]> => {
        const term = (input.query ?? '').trim().toLowerCase()
        const ids = input.ids ?? []
        return pages
          .filter((r) => r._databaseId === input.databaseId && !r.deletedAt)
          .filter(
            (r) =>
              ids.includes(r.id) ||
              (term !== '' && r.title.toLowerCase().includes(term)) ||
              (term === '' && ids.length === 0),
          )
          .slice(0, input.limit ?? 25)
          .map((r) => ({ id: r.id, title: r.title, icon: r.icon }))
      },

      addProperty: async (input: {
        databaseId: string
        name: string
        type: PropertyType
        config?: PropertyConfig
      }) => {
        const db = theDatabase(input.databaseId)
        const taken = new Set(db.properties.map((p) => p.key))
        let key =
          input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'field'
        let n = 2
        while (taken.has(key)) key = `${key}_${n++}`
        const property: Property = {
          id: nextId(),
          databaseId: db.id,
          key,
          name: input.name,
          type: input.type,
          config: input.config ?? {},
          position: `z${db.properties.length}`,
          hidden: false,
        }
        db.properties.push(property)
        return copy(property)
      },

      updateProperty: async (input: {
        propertyId: string
        name?: string
        type?: PropertyType
        config?: PropertyConfig
        hidden?: boolean
      }) => {
        const property = theProperty(input.propertyId)
        if (input.name !== undefined) property.name = input.name
        if (input.type !== undefined) property.type = input.type
        if (input.config !== undefined) property.config = input.config
        if (input.hidden !== undefined) property.hidden = input.hidden
        return copy(property)
      },

      moveProperty: async (input: { propertyId: string; afterId?: string | null }) => {
        const property = theProperty(input.propertyId)
        const db = theDatabase(property.databaseId)
        const rest = db.properties.filter((p) => p.id !== property.id)
        const at = input.afterId ? rest.findIndex((p) => p.id === input.afterId) : -1
        rest.splice(at + 1, 0, property)
        db.properties.length = 0
        db.properties.push(...rest)
        // The real service mints a fractional index; the mock only has to keep the order it shows.
        db.properties.forEach((p, index) => {
          p.position = String(index).padStart(4, '0')
        })
        return copy(property)
      },

      removeProperty: async (input: { propertyId: string }) => {
        const property = theProperty(input.propertyId)
        const db = theDatabase(property.databaseId)
        db.properties.splice(db.properties.indexOf(property), 1)
        return { ok: true as const }
      },

      addView: async (input: {
        databaseId: string
        name: string
        kind?: ViewKind
        config?: Partial<ViewConfig>
      }) => {
        const db = theDatabase(input.databaseId)
        const view: View = {
          id: nextId(),
          databaseId: db.id,
          name: input.name,
          kind: input.kind ?? 'table',
          config: { ...BLANK_VIEW_CONFIG, ...(input.config ?? {}) },
          position: `z${db.views.length}`,
          isDefault: db.views.length === 0,
        }
        db.views.push(view)
        return copy(view)
      },

      updateView: async (input: {
        viewId: string
        name?: string
        kind?: ViewKind
        config?: Partial<ViewConfig>
      }) => {
        const view = theView(input.viewId)
        if (input.name !== undefined) view.name = input.name
        if (input.kind !== undefined) view.kind = input.kind
        // Replaced wholesale, exactly as the service does it — the client must send the merged whole.
        if (input.config !== undefined) view.config = { ...BLANK_VIEW_CONFIG, ...input.config }
        return copy(view)
      },

      removeView: async (input: { viewId: string }) => {
        const view = theView(input.viewId)
        const db = theDatabase(view.databaseId)
        if (db.views.length <= 1)
          throw Object.assign(new Error('A database keeps at least one view'), { code: 'BAD_REQUEST' })
        db.views.splice(db.views.indexOf(view), 1)
        if (view.isDefault && db.views[0]) db.views[0].isDefault = true
        return { ok: true as const }
      },

      setRelation: async (input: { rowId: string; propertyId: string; toPageIds: string[] }) => {
        const property = theProperty(input.propertyId)
        const row = found(input.rowId)
        row._props = { ...(row._props ?? {}), [property.key]: input.toPageIds }
        return { ok: true as const }
      },
    },
  }
}
