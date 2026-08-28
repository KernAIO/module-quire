import type {
  Comment,
  CommentAnchor,
  CommentThread,
  Database,
  DatabaseRef,
  Row as DatabaseRow,
  ExportFormat,
  ExportJob,
  ExportScope,
  FavoriteEntry,
  ImportJob,
  ImportReportEntry,
  ImportSource,
  Label,
  LabelColour,
  Page,
  PageNode,
  PageVersion,
  Property,
  PropertyConfig,
  PropertyType,
  Publication,
  RecentEntry,
  RowRef,
  Space,
  Template,
  TemplateChoice,
  TemplateKind,
  TemplateResult,
  TemplateVariable,
  TransferCounts,
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
    /*
     * Both published, because the share dialog is judged on the difference between them.
     *
     * "Your first week" is in the published site; "Time off" is published and *opted out*, so the
     * demo shows a page that could be public and is deliberately not — which is the one row in that
     * list nobody would otherwise see. A child with no published version at all would have looked
     * the same on screen for an entirely different reason, and the dialog says which is which.
     */
    page(103, uid(1), 'Your first week', 'ba', 102, { publishedVersionId: uid(155) }),
    page(104, uid(1), 'Time off', 'bb', 102, { publishedVersionId: uid(156) }),
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
    version(
      155,
      uid(103),
      'publish',
      null,
      'Everything worth doing in your first five days, in the order it is worth doing it.',
      864e5,
      ME,
    ),
    version(156, uid(104), 'publish', null, 'How much you get, and how to book it.', 1728e5, COLLEAGUE),
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

  /**
   * What has been handed to the internet, and what is held back from it.
   *
   * One publication, rooted at "Working here", so `dev:mock` opens on the published state rather
   * than on the empty one — the empty one is a single button and the populated one is the whole
   * screen. "Time off" is opted out, which is what makes the per-page list in the dialog say
   * something rather than being four switches all pointing the same way.
   *
   * `excludedFromPublic` is a set here rather than a column on the row for the same reason the
   * watchers and the labels are maps: `strip()` only removes `_order`, so anything hung on a `Row`
   * ends up in the `Page` a screen is handed, and this one is a flag about publishing that no
   * screen should read off a page.
   */
  const excludedFromPublic = new Set<string>([uid(104)])

  /**
   * The password is kept in the clear here, and only here.
   *
   * The server keeps a scrypt hash and never gives one back, which is why `Publication` carries
   * `hasPassword` and no hash at all — see the note on the model. The mock has to compare something
   * to answer `public.unlock`, so it keeps the password beside the row and strips it on the way out
   * through `publicationOut`, exactly where the server's own boundary is.
   */
  type PublicationRow = Omit<Publication, 'hasPassword'> & { password: string | null }
  const publicationOut = ({ password, ...rest }: PublicationRow): Publication => ({
    ...rest,
    hasPassword: password !== null,
  })

  const publications: PublicationRow[] = [
    {
      id: uid(400),
      workspaceId: '' as Publication['workspaceId'],
      rootPageId: uid(102),
      includeDescendants: true,
      slug: 'working-here',
      password: null,
      expiresAt: null,
      seoTitle: 'How this team works',
      seoDescription: 'The handbook we point every new person at on their first morning.',
      ogImageUrl: null,
      indexable: true,
      theme: 'auto',
      createdBy: ME as Publication['createdBy'],
      createdAt: iso(432e5),
      updatedAt: iso(432e5),
    },
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

  // ---------------------------------------------------------------------------------------------
  // What a signed-out stranger sees
  // ---------------------------------------------------------------------------------------------

  const thePublication = (id: string): PublicationRow => {
    const found = publications.find((p) => p.id === id)
    if (!found) throw notFound('Publication')
    return found
  }

  /**
   * The five things that keep a page out of a published site, reproduced rather than approximated.
   *
   * A demo whose public walk is looser than the server's is worse than no demo: it shows a page in
   * the site that the real thing would refuse, and the one screen this mock exists to exercise is
   * the one where that difference is a leak. So the rules are the server's, in the server's order —
   * only a `page` (never a live doc, a database or a row), not archived, not trashed, not opted
   * out, and **actually rendered once**, because a page with no published version has nothing to
   * serve however the tree is shaped.
   */
  const isPublicPage = (row: Row): boolean =>
    row.kind === 'page' &&
    !row._databaseId &&
    !row.deletedAt &&
    !row.archivedAt &&
    !excludedFromPublic.has(row.id) &&
    row.publishedVersionId !== null

  /** The server's own slug rule: Unicode letters and digits, so a Persian title keeps a Persian slug. */
  const slugifyTitle = (title: string): string =>
    title
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'untitled'

  interface PublicNode {
    row: Row
    path: string
    parentPath: string | null
  }

  /**
   * Walk the publication, pruning rather than filtering.
   *
   * The distinction is the whole security model and it is worth reproducing here: a page whose
   * *parent* did not survive is unreachable, so it never enters the walk — a child of an opted-out
   * page is not public even though nobody opted the child out. Filtering a flat list would have
   * kept it.
   */
  const publicWalk = (pub: PublicationRow): PublicNode[] => {
    const root = pages.find((p) => p.id === pub.rootPageId)
    if (!root || !isPublicPage(root)) return []
    const out: PublicNode[] = [{ row: root, path: '', parentPath: null }]
    if (!pub.includeDescendants) return out
    const queue: PublicNode[] = [...out]
    while (queue.length > 0) {
      const parent = queue.shift() as PublicNode
      const taken = new Set<string>()
      const children = pages
        .filter((p) => p.parentId === parent.row.id)
        .sort((a, b) => (a._order < b._order ? -1 : a._order > b._order ? 1 : 0))
      for (const child of children) {
        if (!isPublicPage(child)) continue
        const base = slugifyTitle(child.title)
        let slug = base
        for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
        taken.add(slug)
        const node: PublicNode = {
          row: child,
          path: parent.path === '' ? slug : `${parent.path}/${slug}`,
          parentPath: parent.path,
        }
        out.push(node)
        queue.push(node)
      }
    }
    return out
  }

  const publishedAtOf = (row: Row): string =>
    (row.publishedVersionId ? versions.find((v) => v.id === row.publishedVersionId) : null)?.createdAt ??
    row.updatedAt

  const normalisePath = (path: string) =>
    path
      .normalize('NFC')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase()

  /** Expired is gone, checked on the request rather than by a sweep — as the server does it. */
  const publicationBySlug = (slug: string): PublicationRow => {
    const pub = publications.find((p) => p.slug === slug)
    if (!pub) throw notFound('Publication')
    if (pub.expiresAt && new Date(pub.expiresAt).getTime() <= Date.now()) throw notFound('Publication')
    return pub
  }

  /** A capability token, carrying no identity — the shape the server mints, without the sealing. */
  const tokenFor = (pub: PublicationRow) => `mock-unlock:${pub.id}`
  const unlocked = (pub: PublicationRow, token: string | null) =>
    pub.password === null || token === tokenFor(pub)

  const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /**
   * There is no renderer here, so the published version's preview stands in for its prose.
   *
   * Escaped rather than interpolated: the demo is where somebody types `<script>` into a title to
   * see what happens, and a mock that answers with it unescaped teaches the wrong lesson about a
   * surface whose whole job is to be safe.
   */
  const publicHtmlOf = (row: Row): string => {
    const preview =
      (row.publishedVersionId ? versions.find((v) => v.id === row.publishedVersionId) : null)?.preview ?? ''
    return preview ? `<p>${escapeHtml(preview)}</p>` : ''
  }

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

  // ----------------------------------------------------------------------------------------------
  // Getting work in and out
  // ----------------------------------------------------------------------------------------------

  /**
   * A transfer is a job, so the mock has to behave like one rather than answer instantly.
   *
   * Every screen here is a progress bar, a spinner and a report that arrives afterwards, and a mock
   * that returned `done` from `start` would leave all three unreachable — the demo and the
   * end-to-end sweep would only ever see the finished state. So a started job carries a real
   * `createdAt` and its state is **computed from how long ago that was**: queued for the first
   * second, running while it counts, then done. No timers, so nothing keeps running after the tab
   * that made it has gone.
   *
   * The seeded rows cover the three states somebody has to be able to look at without waiting: a
   * finished export with a file, a failed one with a reason worth reading, and a finished import
   * whose report has all three outcomes in it.
   */
  const EXPORT_STEP_MS = 320
  const EXPORT_START_MS = 800
  const IMPORT_READ_MS = 3200

  /**
   * A valid, empty zip — the 22-byte end-of-central-directory record and nothing else.
   *
   * There is no object storage behind `dev:mock`, so a download has to be something the browser can
   * actually save; a `data:` URL is the only address that works without one. Empty rather than
   * fabricated: a demo zip full of invented pages is a file somebody opens expecting their handbook.
   */
  const EMPTY_ZIP = 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=='

  const countsOf = (report: ImportReportEntry[]): TransferCounts => ({
    total: report.length,
    done: report.filter((r) => r.outcome === 'imported').length,
    skipped: report.filter((r) => r.outcome === 'skipped').length,
    failed: report.filter((r) => r.outcome === 'failed').length,
  })

  const exportJobs: ExportJob[] = [
    {
      id: uid(701),
      workspaceId: '' as ExportJob['workspaceId'],
      requestedBy: ME as ExportJob['requestedBy'],
      scope: 'space',
      targetId: uid(1),
      format: 'markdown',
      state: 'done',
      fileId: uid(781),
      error: null,
      counts: { total: 8, done: 7, skipped: 1, failed: 0 },
      createdAt: iso(72e5),
      finishedAt: iso(71e5),
    },
    {
      id: uid(702),
      workspaceId: '' as ExportJob['workspaceId'],
      requestedBy: ME as ExportJob['requestedBy'],
      scope: 'subtree',
      targetId: uid(102),
      format: 'pdf',
      state: 'failed',
      fileId: null,
      // The failure worth seeding is the one an operator can act on, written the way the service
      // writes it: the PDF renderer is a separate container, and a stack with it switched off is by
      // far the most common reason a PDF export dies.
      error: 'The PDF service did not answer at http://gotenberg:3000 (connect ECONNREFUSED)',
      counts: { total: 3, done: 3, skipped: 0, failed: 0 },
      createdAt: iso(864e5),
      finishedAt: iso(8636e4),
    },
  ]

  /** One report with all three outcomes in it, because that is the whole point of the screen. */
  const seededImportReport: ImportReportEntry[] = [
    { path: 'Company Handbook 8f2c41d0.md', outcome: 'imported', pageId: uid(101), reason: null },
    {
      path: 'Company Handbook 8f2c41d0/Getting started 5b91aa02.md',
      outcome: 'imported',
      pageId: uid(103),
      reason: null,
    },
    {
      path: 'Company Handbook 8f2c41d0/Tasks 71cc9e10.csv',
      outcome: 'imported',
      pageId: uid(110),
      // The one `imported` row that carries a reason, exactly as the server writes it: a CSV becomes
      // a database, and the column types it guessed are the thing somebody has to check.
      reason:
        'the first column, Name, became each row’s title; Status: read as a select with 3 choices, from 4 of 4 values; Due: read as a date; Done: read as a checkbox',
    },
    {
      path: 'Company Handbook 8f2c41d0/Tasks 71cc9e10_all.csv',
      outcome: 'skipped',
      pageId: null,
      reason: 'a second view of the same database; its rows came from “Tasks 71cc9e10.csv”',
    },
    {
      path: 'Company Handbook 8f2c41d0/diagram.png',
      outcome: 'skipped',
      pageId: null,
      reason: 'a picture, which an import cannot yet attach to a page',
    },
    {
      path: '__MACOSX/._Company Handbook 8f2c41d0.md',
      outcome: 'skipped',
      pageId: null,
      reason: 'a file the operating system added to the archive',
    },
    {
      path: 'Company Handbook 8f2c41d0/Expenses 04ab7731.md',
      outcome: 'failed',
      pageId: null,
      reason: 'its checksum does not match, so the file is damaged',
    },
    {
      path: 'Archive/Old wiki 22b0cc71.md',
      outcome: 'failed',
      pageId: null,
      reason:
        'nothing in the archive is at this path, so the link to it in “Company Handbook” is now plain text',
    },
  ]

  const importJobs: ImportJob[] = [
    {
      id: uid(711),
      workspaceId: '' as ImportJob['workspaceId'],
      requestedBy: ME as ImportJob['requestedBy'],
      source: 'notion',
      targetId: uid(1),
      sourceFileId: uid(791),
      state: 'done',
      error: null,
      counts: countsOf(seededImportReport),
      report: seededImportReport,
      createdAt: iso(1728e5),
      finishedAt: iso(17274e4),
    },
  ]

  /** Move a queued export along by however long it has been sitting there. */
  function advanceExport(row: ExportJob) {
    if (row.state === 'done' || row.state === 'failed') return
    const elapsed = Date.now() - new Date(row.createdAt).getTime()
    if (elapsed < EXPORT_START_MS) return
    const total = row.counts.total || 12
    const seen = Math.min(total, Math.floor((elapsed - EXPORT_START_MS) / EXPORT_STEP_MS))
    // One page withheld, so the "some pages were left out" sentence is reachable in the demo.
    const skipped = Math.min(total > 4 ? 1 : 0, seen)
    row.counts = { total, done: seen - skipped, skipped, failed: 0 }
    row.state = seen >= total ? 'done' : 'running'
    if (row.state === 'done') {
      row.fileId = row.fileId ?? nextId()
      row.finishedAt = new Date().toISOString()
    }
  }

  /**
   * Move a queued import along, and — when it lands — actually write the pages.
   *
   * The pages matter: an import whose report says three pages arrived and whose sidebar is unchanged
   * is a demo of the wrong thing, and "Open the space" would lead somewhere that has not moved.
   */
  function advanceImport(row: ImportJob) {
    if (row.state === 'done' || row.state === 'failed') return
    const elapsed = Date.now() - new Date(row.createdAt).getTime()
    if (elapsed < EXPORT_START_MS) return
    if (elapsed < IMPORT_READ_MS) {
      row.state = 'running'
      return
    }
    const made = ['Company Handbook', 'Getting started', 'How we work'].map((title, at) => {
      const created = page(++seq, row.targetId, title, `z${at}`, null, {})
      created.id = uid(seq)
      created.createdAt = new Date().toISOString()
      created.updatedAt = created.createdAt
      pages.push(created)
      return created.id
    })
    row.report = [
      { path: 'Company Handbook 8f2c41d0.md', outcome: 'imported', pageId: made[0] ?? null, reason: null },
      {
        path: 'Company Handbook 8f2c41d0/Getting started 5b91aa02.md',
        outcome: 'imported',
        pageId: made[1] ?? null,
        reason: null,
      },
      {
        path: 'Company Handbook 8f2c41d0/How we work 90ff1a44.md',
        outcome: 'imported',
        pageId: made[2] ?? null,
        reason: null,
      },
      {
        path: 'Company Handbook 8f2c41d0/logo.png',
        outcome: 'skipped',
        pageId: null,
        reason: 'a picture, which an import cannot yet attach to a page',
      },
      {
        path: 'Company Handbook 8f2c41d0/Notes 04ab7731.md',
        outcome: 'failed',
        pageId: null,
        reason: 'its checksum does not match, so the file is damaged',
      },
    ]
    row.counts = countsOf(row.report)
    row.state = 'done'
    row.finishedAt = new Date().toISOString()
  }

  /**
   * The five starters, **in English only**.
   *
   * The real ones are constants on the server with a five-locale table beside them, resolved against
   * the reader's own locale — `server/services/templates.ts` explains why they cannot live in this
   * package's message bundle. This mock has no server and no principal, so it carries the English
   * names and nothing else: it is the demo interface, and a demo of the picker is a demo of the
   * shape rather than of the translation. Anything that needs to see a starter in Persian needs a
   * server.
   */
  const STARTER_NAMES: Array<[string, string, string, string]> = [
    ['meeting-notes', 'users', 'Meeting notes', 'Who was there, what was decided, and who does what next.'],
    [
      'decision-record',
      'flag',
      'Decision record',
      'One decision, why it was taken, and what it commits you to.',
    ],
    [
      'requirements',
      'target',
      'Requirements',
      'What a piece of work has to do, and what it deliberately does not.',
    ],
    [
      'retrospective',
      'refresh-cw',
      'Retrospective',
      'What went well, what got in the way, and what to change.',
    ],
    ['how-to', 'wrench', 'How-to', 'A task somebody can follow from start to finish.'],
  ]

  /**
   * One template somebody in this workspace already saved, so the picker is not five shipped entries
   * and nothing else — the interesting half of the feature is the one a colleague made.
   */
  const templateRows: Template[] = [
    {
      id: uid(700),
      workspaceId: '' as Template['workspaceId'],
      spaceId: uid(1),
      kind: 'page',
      key: null,
      builtIn: false,
      name: 'Weekly review',
      description: 'What moved this week, and what is stuck.',
      icon: 'calendar-days',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Week {{week}} · {{author}}' }] }],
      },
      variables: [
        {
          name: 'week',
          label: 'Which week',
          type: 'text',
          options: [],
          default: null,
          required: true,
        },
      ],
      createdBy: COLLEAGUE as Template['createdBy'],
      createdAt: iso(9e6),
      updatedAt: iso(9e6),
    },
  ]

  const templateChoice = (row: Template): TemplateChoice => ({
    id: row.id,
    key: row.key,
    builtIn: row.builtIn,
    kind: row.kind,
    spaceId: row.spaceId,
    name: row.name,
    description: row.description,
    icon: row.icon,
    variables: row.variables,
    updatedAt: row.updatedAt,
  })

  /** The same single-pass, text-only substitution the server does — see `services/templates.ts`. */
  const fill = (text: string, values: Record<string, string>) =>
    text.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (whole, name: string) => values[name] ?? whole)

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
          excludedFromPublic: excludedFromPublic.has(r.id),
          hasPublishedVersion: r.publishedVersionId !== null,
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

    /**
     * Taking work out.
     *
     * `list` and `get` advance every job before answering, which is what makes the progress bar move
     * in `dev:mock` — there is no worker here, so the passage of time is the worker. `docx` is
     * refused exactly as the server refuses it, with the same shape of message: a mock that quietly
     * accepted it would make the one format the product does not have look like the one it does.
     */
    exports: {
      start: async (input: { scope: ExportScope; targetId: string; format: ExportFormat }) => {
        if (input.format === 'docx')
          throw Object.assign(
            new Error(
              'Word export is not available yet. Export as HTML or PDF, both of which Word opens, ' +
                'or as Markdown to move the pages somewhere else.',
            ),
            { code: 'BAD_REQUEST' },
          )
        if (input.scope === 'space') {
          if (!spaces.some((s) => s.id === input.targetId)) throw notFound('Space')
        } else found(input.targetId)
        const row: ExportJob = {
          id: nextId(),
          workspaceId: '' as ExportJob['workspaceId'],
          requestedBy: ME as ExportJob['requestedBy'],
          scope: input.scope,
          targetId: input.targetId,
          format: input.format,
          state: 'queued',
          fileId: null,
          error: null,
          counts: { total: 0, done: 0, skipped: 0, failed: 0 },
          createdAt: new Date().toISOString(),
          finishedAt: null,
        }
        exportJobs.unshift(row)
        return { ...row, downloadUrl: null }
      },

      get: async ({ jobId }: { jobId: string }) => {
        const row = exportJobs.find((j) => j.id === jobId)
        if (!row) throw notFound('Export')
        advanceExport(row)
        /*
         * The link is minted here and not stored, exactly as the server does it — the download is a
         * signed URL that expires, so a row carrying one would be a row carrying an address that
         * stops working. A PDF export hands back the same empty zip: there is nothing to render.
         */
        return { ...row, downloadUrl: row.state === 'done' ? EMPTY_ZIP : null }
      },

      list: async ({ limit = 20 }: { limit?: number } = {}) => {
        for (const row of exportJobs) advanceExport(row)
        return exportJobs.slice(0, limit).map((row) => ({ ...row }))
      },
    },

    /**
     * Getting work in.
     *
     * `start` does not read the upload — there is no storage behind `dev:mock` and nothing to read —
     * but it does keep the two checks that decide whether the job may exist at all: the space is
     * real, and the archive is a file this mock knows about. The pages appear when the job lands,
     * so the sidebar changes underneath the report rather than the report claiming pages nobody has.
     */
    imports: {
      start: async (input: { spaceId: string; source: ImportSource; fileId: string }) => {
        if (!spaces.some((s) => s.id === input.spaceId)) throw notFound('Space')
        const row: ImportJob = {
          id: nextId(),
          workspaceId: '' as ImportJob['workspaceId'],
          requestedBy: ME as ImportJob['requestedBy'],
          source: input.source,
          targetId: input.spaceId,
          sourceFileId: input.fileId,
          state: 'queued',
          error: null,
          counts: { total: 0, done: 0, skipped: 0, failed: 0 },
          report: [],
          createdAt: new Date().toISOString(),
          finishedAt: null,
        }
        importJobs.unshift(row)
        return { ...row }
      },

      get: async ({ jobId }: { jobId: string }) => {
        const row = importJobs.find((j) => j.id === jobId)
        if (!row) throw notFound('Import')
        advanceImport(row)
        return { ...row }
      },

      /** Without the reports, as the server answers it — a list of thousands-of-rows reports is not a list. */
      list: async ({ limit = 20 }: { limit?: number } = {}) => {
        for (const row of importJobs) advanceImport(row)
        return importJobs.slice(0, limit).map(({ report: _report, ...summary }) => summary)
      },
    },

    /**
     * What somebody writes with.
     *
     * The starters and the rows come back as one list with the override rule applied, exactly as the
     * server does it — a row carrying a starter's key stands in that starter's place rather than
     * appearing beside it, which is the whole shape a picker has to draw.
     *
     * `instantiate` makes a real page in the tree. It cannot write a *body*: there is no collab
     * service behind `dev:mock`, and a page's prose lives there rather than in this list. So the
     * title is substituted and the page appears where it should, and the body is the one thing a
     * demo of this feature cannot show.
     */
    templates: {
      list: async ({
        kind = 'page',
        spaceId = null,
      }: {
        kind?: TemplateKind
        spaceId?: string | null
      } = {}) => {
        const rows = templateRows.filter(
          (row) => row.kind === kind && (row.spaceId === null || row.spaceId === spaceId),
        )
        const byKey = new Map(rows.filter((row) => row.key).map((row) => [row.key as string, row]))
        const out: TemplateChoice[] = []
        if (kind === 'page')
          for (const [key, icon, name, description] of STARTER_NAMES) {
            const override = byKey.get(key)
            out.push(
              override
                ? templateChoice(override)
                : {
                    id: null,
                    key,
                    builtIn: true,
                    kind: 'page',
                    spaceId: null,
                    name,
                    description,
                    icon,
                    variables: [],
                    updatedAt: null,
                  },
            )
          }
        for (const row of rows)
          if (!row.key || !STARTER_NAMES.some(([key]) => key === row.key)) out.push(templateChoice(row))
        return out
      },

      get: async ({ templateId }: { templateId: string }) => {
        const row = templateRows.find((t) => t.id === templateId)
        if (!row) throw notFound('Template')
        return row
      },

      createFromPage: async (input: {
        kind?: TemplateKind
        sourceId: string
        spaceId?: string | null
        name: string
        description?: string
        icon?: string | null
        variables?: TemplateVariable[]
        key?: string | null
      }) => {
        if (input.key && templateRows.some((t) => t.key === input.key))
          throw Object.assign(new Error('This workspace already has its own version of that template'), {
            code: 'CONFLICT',
          })
        const source = input.kind === 'space' ? null : found(input.sourceId)
        const row: Template = {
          id: nextId(),
          workspaceId: '' as Template['workspaceId'],
          spaceId: input.kind === 'space' ? null : (input.spaceId ?? null),
          kind: input.kind ?? 'page',
          key: input.key ?? null,
          builtIn: Boolean(input.key),
          name: input.name,
          description: input.description ?? '',
          icon: input.icon ?? null,
          // No collab service, so there is no body to read — the title stands in for the prose, which
          // is enough for the picker and honest about what a mock can know.
          doc:
            input.kind === 'space'
              ? { pages: [] }
              : {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: source?.title ?? '' }] }],
                },
          variables: input.variables ?? [],
          createdBy: ME as Template['createdBy'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        templateRows.push(row)
        return row
      },

      update: async ({ templateId, ...patch }: { templateId: string } & Partial<Template>) => {
        const row = templateRows.find((t) => t.id === templateId)
        if (!row) throw notFound('Template')
        Object.assign(row, patch, { updatedAt: new Date().toISOString() })
        return row
      },

      remove: async ({ templateId }: { templateId: string }) => {
        const at = templateRows.findIndex((t) => t.id === templateId)
        if (at < 0) throw notFound('Template')
        templateRows.splice(at, 1)
        return { ok: true as const }
      },

      instantiate: async (input: {
        templateId?: string | null
        starterKey?: string | null
        spaceId?: string | null
        parentId?: string | null
        afterId?: string | null
        title?: string
        key?: string | null
        name?: string
        values?: Record<string, string>
      }): Promise<TemplateResult> => {
        const row = input.templateId
          ? templateRows.find((t) => t.id === input.templateId)
          : templateRows.find((t) => t.key === input.starterKey)
        const starter = STARTER_NAMES.find(([key]) => key === input.starterKey)
        if (!row && !starter) throw notFound('Template')

        const values: Record<string, string> = {
          date: new Date().toLocaleDateString(),
          time: new Date().toLocaleTimeString(),
          author: 'You',
          space: spaces.find((s) => s.id === input.spaceId)?.name ?? '',
          ...(input.values ?? {}),
        }
        for (const variable of row?.variables ?? [])
          if (variable.required && !values[variable.name])
            throw Object.assign(new Error(`"${variable.label}" is needed before this can be made`), {
              code: 'BAD_REQUEST',
            })

        if (row?.kind === 'space') {
          if (!input.key || !input.name)
            throw Object.assign(new Error('A space template needs a name and an address'), {
              code: 'BAD_REQUEST',
            })
          const space: Space = {
            id: nextId(),
            workspaceId: '' as Space['workspaceId'],
            key: input.key,
            name: fill(input.name, values),
            description: '',
            icon: null,
            visibility: 'open',
            homepageId: null,
            createdBy: ME as Space['createdBy'],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
          }
          spaces.push(space)
          return { spaceId: space.id, pageId: null, pageCount: 0 }
        }

        const spaceId = input.spaceId
        if (!spaceId) throw Object.assign(new Error('A page template needs a space'), { code: 'BAD_REQUEST' })
        const siblings = pages
          .filter((p) => p.spaceId === spaceId && p.parentId === (input.parentId ?? null) && !p.deletedAt)
          .sort((a, b) => (a._order < b._order ? -1 : 1))
        const title = fill(input.title || row?.name || starter?.[2] || '', values)
        const created = page(++seq, spaceId, title, `${siblings.at(-1)?._order ?? 'a'}m`, null, {
          icon: row?.icon ?? starter?.[1] ?? null,
        })
        created.id = uid(seq)
        created.parentId = input.parentId ?? null
        created.createdAt = new Date().toISOString()
        created.updatedAt = created.createdAt
        pages.push(created)
        return { spaceId, pageId: created.id, pageCount: 1 }
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

    publications: {
      list: async ({ spaceId }: { spaceId: string }) =>
        publications
          .filter((p) => pages.find((row) => row.id === p.rootPageId)?.spaceId === spaceId)
          .map(publicationOut),

      get: async ({ publicationId }: { publicationId: string }) =>
        publicationOut(thePublication(publicationId)),

      create: async (input: {
        rootPageId: string
        slug: string
        includeDescendants?: boolean
        password?: string | null
        expiresAt?: string | null
        seoTitle?: string
        seoDescription?: string
        ogImageUrl?: string | null
        indexable?: boolean
        theme?: Publication['theme']
      }) => {
        found(input.rootPageId)
        if (publications.some((p) => p.slug === input.slug))
          throw Object.assign(new Error(`Another site already uses the address “${input.slug}”`), {
            code: 'CONFLICT',
          })
        const row: PublicationRow = {
          id: nextId(),
          workspaceId: '' as Publication['workspaceId'],
          rootPageId: input.rootPageId,
          includeDescendants: input.includeDescendants ?? true,
          slug: input.slug,
          password: input.password ?? null,
          expiresAt: input.expiresAt ?? null,
          seoTitle: input.seoTitle ?? '',
          seoDescription: input.seoDescription ?? '',
          ogImageUrl: input.ogImageUrl ?? null,
          indexable: input.indexable ?? true,
          theme: input.theme ?? 'auto',
          createdBy: ME as Publication['createdBy'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        publications.push(row)
        return publicationOut(row)
      },

      /**
       * `password` is three-valued here too, and the mock is where that is easiest to get wrong: a
       * key left out changes nothing, `null` takes the door off, a string sets a new one. Spreading
       * the patch would turn every "rename the site" into an "unlock the site".
       */
      update: async ({
        publicationId,
        ...patch
      }: {
        publicationId: string
        slug?: string
        includeDescendants?: boolean
        password?: string | null
        expiresAt?: string | null
        seoTitle?: string
        seoDescription?: string
        ogImageUrl?: string | null
        indexable?: boolean
        theme?: Publication['theme']
      }) => {
        const row = thePublication(publicationId)
        if (patch.slug !== undefined && publications.some((p) => p.slug === patch.slug && p.id !== row.id))
          throw Object.assign(new Error(`Another site already uses the address “${patch.slug}”`), {
            code: 'CONFLICT',
          })
        for (const [key, value] of Object.entries(patch))
          if (value !== undefined) Object.assign(row, { [key]: value })
        row.updatedAt = new Date().toISOString()
        return publicationOut(row)
      },

      remove: async ({ publicationId }: { publicationId: string }) => {
        const row = thePublication(publicationId)
        publications.splice(publications.indexOf(row), 1)
        return { ok: true as const }
      },

      optOut: async ({ pageId, excluded = true }: { pageId: string; excluded?: boolean }) => {
        found(pageId)
        if (excluded) excludedFromPublic.add(pageId)
        else excludedFromPublic.delete(pageId)
        return { pageId, excluded }
      },
    },

    /**
     * The signed-out surface, reproduced so the share dialog's "what does a stranger see" check has
     * something honest to answer it in `dev:mock`.
     *
     * There is no principal to ignore here, which is exactly the point: none of these reads the
     * signed-in member the rest of this file assumes. Everything they answer comes out of
     * `publicWalk`, so a page the walk pruned cannot be reached by asking for it by path either.
     */
    public: {
      site: async ({ slug, token = null }: { slug: string; token?: string | null }) => {
        const pub = publicationBySlug(slug)
        if (!unlocked(pub, token)) return { slug: pub.slug, theme: pub.theme, locked: true, site: null }
        const nodes = publicWalk(pub)
        const root = nodes[0]
        if (!root) throw notFound('Publication')
        return {
          slug: pub.slug,
          theme: pub.theme,
          locked: false,
          site: {
            title: pub.seoTitle || root.row.title || 'Untitled',
            description: pub.seoDescription,
            ogImageUrl: pub.ogImageUrl,
            indexable: pub.indexable,
            updatedAt: nodes
              .map((n) => publishedAtOf(n.row))
              .sort()
              .at(-1) as string,
            nav: nodes.map((n) => ({
              path: n.path,
              parentPath: n.parentPath,
              title: n.row.title || 'Untitled',
              icon: n.row.icon,
            })),
          },
        }
      },

      /**
       * `basePath` is accepted and unused, deliberately.
       *
       * The real handler rewrites every inter-page link in the rendered HTML against it, and there
       * is no rendered HTML here — but a mock whose *signature* differs from the contract is a
       * screen that works in the demo and throws in production, which is the one thing this file
       * exists to prevent.
       */
      page: async ({
        slug,
        path = '',
        token = null,
      }: {
        slug: string
        path?: string
        basePath?: string
        token?: string | null
      }) => {
        const pub = publicationBySlug(slug)
        if (!unlocked(pub, token)) throw notFound('Page')
        const nodes = publicWalk(pub)
        const wanted = normalisePath(path)
        const node = nodes.find((n) => normalisePath(n.path) === wanted)
        if (!node) throw notFound('Page')
        const trail: { path: string; title: string }[] = []
        for (let at: PublicNode | undefined = node; at; ) {
          trail.unshift({ path: at.path, title: at.row.title || 'Untitled' })
          const parentPath: string | null = at.parentPath
          at = parentPath === null ? undefined : nodes.find((n) => n.path === parentPath)
        }
        return {
          path: node.path,
          title: node.row.title || 'Untitled',
          icon: node.row.icon,
          coverUrl: node.row.coverUrl,
          html: publicHtmlOf(node.row),
          publishedAt: publishedAtOf(node.row),
          // A hash of the version rather than the version id, because the id addresses a procedure
          // that asks a permission. There is nothing to hash with here, so it is prefixed instead —
          // what matters is that the value a browser caches on is not an identifier of anything.
          etag: `mock-${node.row.publishedVersionId ?? 'none'}`,
          breadcrumbs: trail,
        }
      },

      /**
       * Reads the published version's text, never the draft.
       *
       * The mock has one string per version and it is the published one, so this is true here by
       * construction rather than by care — which is the reason to write the search against
       * `versions` rather than against `pages`, even though both would look right in a demo.
       */
      search: async ({ slug, q, limit = 20 }: { slug: string; q: string; limit?: number }) => {
        const pub = publicationBySlug(slug)
        const needle = q.trim().toLowerCase()
        const items = publicWalk(pub)
          .flatMap((node) => {
            const preview =
              (node.row.publishedVersionId
                ? versions.find((v) => v.id === node.row.publishedVersionId)
                : null
              )?.preview ?? ''
            const haystack = `${node.row.title} ${preview}`.toLowerCase()
            if (!haystack.includes(needle)) return []
            return [{ path: node.path, title: node.row.title || 'Untitled', snippet: preview.slice(0, 200) }]
          })
          .slice(0, limit)
        return { items }
      },

      // A site behind a password, or one asked to stay out of search, has an empty sitemap rather
      // than a private one — the file exists to be fetched by robots.
      sitemap: async ({ slug }: { slug: string }) => {
        const pub = publicationBySlug(slug)
        if (pub.password !== null || !pub.indexable) return { entries: [] }
        return {
          entries: publicWalk(pub).map((n) => ({
            path: n.path,
            lastModified: publishedAtOf(n.row),
          })),
        }
      },

      // The one call that never distinguishes a missing slug from an expired or locked one.
      robots: async ({ slug }: { slug: string }) => {
        const pub = publications.find((p) => p.slug === slug)
        const gone = !pub || (pub.expiresAt !== null && new Date(pub.expiresAt).getTime() <= Date.now())
        if (gone || pub.password !== null || !pub.indexable) return { indexable: false, sitemapPath: null }
        return { indexable: true, sitemapPath: 'sitemap.xml' }
      },

      /*
       * There are no files behind the mock, so nothing resolves — and that is the honest answer
       * rather than a gap. `publicHtmlOf` draws a version's preview as one paragraph and never
       * emits an `<img>`, so no page here carries a reference to resolve; a demo that invented
       * bytes would be showing a picture the real surface would have refused.
       */
      asset: async () => {
        throw notFound('Asset')
      },

      unlock: async ({ slug, password }: { slug: string; password: string }) => {
        const pub = publicationBySlug(slug)
        // A site with no password has no door, and saying so would confirm the slug exists.
        if (pub.password === null) throw notFound('Publication')
        if (pub.password !== password)
          throw Object.assign(new Error('That password does not open this site'), {
            code: 'UNAUTHORIZED',
          })
        return { token: tokenFor(pub), expiresAt: new Date(Date.now() + 12 * 36e5).toISOString() }
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
