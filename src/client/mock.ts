import type { Page, PageNode, Space } from './index.js'

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
    page(201, uid(2), 'Architecture', 'a'),
    page(202, uid(2), 'Runbooks', 'b'),
    page(203, uid(2), 'Deploying', 'ba', 202),
    page(204, uid(2), 'An old note', 'c', null, { deletedAt: iso(864e5) }),
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
  }
}
