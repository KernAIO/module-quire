import type {
  Database,
  DatabaseRef,
  Row as DatabaseRow,
  Page,
  PageNode,
  Property,
  PropertyConfig,
  PropertyType,
  RowRef,
  Space,
  View,
  ViewConfig,
  ViewKind,
} from '../contract/index.js'

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
    createdBy: null,
    updatedBy: null,
    createdAt: iso(9e7),
    updatedAt: iso(36e5),
    archivedAt: null,
    deletedAt: null,
    _order: order,
    ...over,
  })

  const pages: Row[] = [
    page(101, uid(1), 'Welcome', 'a'),
    page(102, uid(1), 'Working here', 'b'),
    page(103, uid(1), 'Your first week', 'ba', 102),
    page(104, uid(1), 'Time off', 'bb', 102),
    page(105, uid(1), 'Expenses', 'c', null, { kind: 'live' }),
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
        return { ok: true as const, count: ids.size }
      },
    },

    databases: {
      list: async ({ spaceId }: { spaceId: string }): Promise<DatabaseRef[]> =>
        databases
          .filter((d) => d.spaceId === spaceId)
          .map((d) => ({ id: d.id, pageId: d.pageId, name: d.name })),

      get: async ({ databaseId }: { databaseId: string }) => theDatabase(databaseId),

      forPage: async ({ pageId }: { pageId: string }) => databases.find((d) => d.pageId === pageId) ?? null,

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
        return db
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
        return property
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
        return property
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
        return property
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
        return view
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
        return view
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
