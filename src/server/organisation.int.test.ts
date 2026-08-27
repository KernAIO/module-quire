/**
 * Labels, favourites, watchers, recent views and the trash listing, against a real Postgres.
 *
 * Everything here goes through the **router** rather than the services, because the thing most worth
 * proving is a line in a handler rather than a line in a query. Row-level security fences
 * `workspace_id`; it says nothing about who inside a workspace may read a row, so one colleague's
 * favourites are as visible to the policy as your own. What keeps a sidebar personal is that the
 * handler takes the caller's id from the principal and the query filters on it — and a service test
 * that passes the id in by hand would agree with itself no matter which of those was missing.
 *
 * A scratch database per run, dropped afterwards, so it never touches development data.
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FavoriteEntry, Label, Page, RecentEntry, Space, WatchState } from '../contract/index.js'
import { implement_ } from './_impl.js'
import { quireModule } from './index.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_org_${Date.now().toString(36)}`

const WS = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>
let space: Space
let other: Space

const principal = (userId: string): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const alice = () => principal(ALICE)
const bob = () => principal(BOB)

const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  kernel.database.withWorkspace(WS, fn, { userId: ALICE })

const context = (who: Principal): RequestContext => ({
  kernel,
  principal: who,
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

/** The router walked as data, so a procedure is addressed the way the contract names it. */
const invoke = <T>(name: string, input: Record<string, unknown>, who: Principal): Promise<T> => {
  const leaf = name
    .split('.')
    .reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      router as unknown as Record<string, unknown>,
    )
  // The router is walked as data, so the leaf arrives untyped and `call` has to be told nothing.
  return call(leaf as never, input as never, { context: context(who) }) as Promise<T>
}

interface Binding {
  subjectType: 'user'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'project' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
/** What core would answer for a workspace that has written a DENY binding. Set per test. */
const bindings = new Map<string, Binding[]>()

/** Deny one permission on one page for one person — the narrow case the model exists for. */
const denyPage = (userId: string, permission: string, pageId: string) =>
  bindings.set(userId, [
    {
      subjectType: 'user',
      subjectId: userId,
      permissions: [permission],
      scopeKind: 'object',
      scopeId: pageId,
      deny: true,
    },
  ])

function registerStubs(k: Kernel) {
  k.broker.register('collab', {
    'document.state': {
      handler: async (input: { name: string }) => ({
        name: input.name,
        state: null,
        size: 0,
        updatedAt: null,
      }),
    },
    'document.snapshot': { handler: async () => ({ snapshot: null, state: null }) },
    'document.apply': { handler: async () => ({ ok: true as const, size: 0 }) },
    'document.replace': { handler: async () => ({ ok: true as const, size: 0 }) },
    'document.delete': { handler: async () => ({ ok: true as const }) },
  })
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': {
      handler: async (input: { userId: string }) => bindings.get(input.userId) ?? [],
    },
    'settings.getModule': { handler: async () => ({}) },
  })
}

const newPage = (title: string, spaceId = space.id): Promise<Page> =>
  run((tx) =>
    svc.pages.create(tx, alice(), WS, {
      spaceId,
      parentId: null,
      title,
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )

/** `Date` has millisecond resolution, so two views recorded back to back can tie. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-org-test',
    modules: [quireModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerStubs(kernel)
  await kernel.start()
  svc = quireServices(kernel)
  router = implement_(kernel)

  const makeSpace = (key: string, name: string) =>
    run((tx) =>
      svc.spaces.create(tx, alice(), WS, {
        key,
        name,
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
  space = await makeSpace('handbook', 'Handbook')
  other = await makeSpace('playbook', 'Playbook')
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

describe('labels', () => {
  const create = (name: string, spaceId = space.id, colour = 'grey') =>
    invoke<Label>('labels.create', { workspaceId: WS, spaceId, name, colour }, alice())

  it('refuses a name that differs only in case, and keeps the capitalisation it was given', async () => {
    const draft = await create('Draft')
    expect(draft.name).toBe('Draft')
    await expect(create('draft')).rejects.toThrow(/already has a label/i)
    // The same word is a different label in a different space: two teams should not have to agree
    // on what "Draft" means to use the word at all.
    await expect(create('Draft', other.id)).resolves.toMatchObject({ name: 'Draft' })
  })

  it('replaces what a page wears rather than adding to it', async () => {
    const page = await newPage('Onboarding')
    const [a, b, c] = await Promise.all([create('Alpha'), create('Beta'), create('Gamma')])

    const first = await invoke<Label[]>(
      'pages.setLabels',
      { workspaceId: WS, pageId: page.id, labelIds: [a!.id, b!.id] },
      alice(),
    )
    expect(first.map((l) => l.name)).toEqual(['Alpha', 'Beta'])

    // The one the picker unticked has to go, and the one that was already there must not double up.
    const second = await invoke<Label[]>(
      'pages.setLabels',
      { workspaceId: WS, pageId: page.id, labelIds: [b!.id, c!.id] },
      alice(),
    )
    expect(second.map((l) => l.name)).toEqual(['Beta', 'Gamma'])

    const read = await invoke<Label[]>('labels.forPage', { workspaceId: WS, pageId: page.id }, alice())
    expect(read.map((l) => l.name)).toEqual(['Beta', 'Gamma'])

    const none = await invoke<Label[]>(
      'pages.setLabels',
      { workspaceId: WS, pageId: page.id, labelIds: [] },
      alice(),
    )
    expect(none).toEqual([])
  })

  it('refuses a label belonging to another space', async () => {
    const page = await newPage('In the handbook')
    const elsewhere = await create('Elsewhere', other.id)
    await expect(
      invoke('pages.setLabels', { workspaceId: WS, pageId: page.id, labelIds: [elsewhere.id] }, alice()),
    ).rejects.toThrow(/this space declares/i)
  })

  it('takes a removed label off every page that wore it', async () => {
    const page = await newPage('Wearing one')
    const doomed = await create('Doomed')
    await invoke('pages.setLabels', { workspaceId: WS, pageId: page.id, labelIds: [doomed.id] }, alice())
    expect(
      await invoke<Label[]>('labels.forPage', { workspaceId: WS, pageId: page.id }, alice()),
    ).toHaveLength(1)

    await invoke('labels.remove', { workspaceId: WS, labelId: doomed.id }, alice())

    // Nothing cascades — there is no foreign key — so a join row left behind would be a tag the
    // page still carries and no picker can name.
    expect(await invoke<Label[]>('labels.forPage', { workspaceId: WS, pageId: page.id }, alice())).toEqual([])
    const listed = await invoke<Label[]>('labels.list', { workspaceId: WS, spaceId: space.id }, alice())
    expect(listed.map((l) => l.name)).not.toContain('Doomed')
  })

  it('renames without tripping over its own name', async () => {
    const label = await create('Provisional')
    const renamed = await invoke<Label>(
      'labels.update',
      { workspaceId: WS, labelId: label.id, name: 'Provisional', colour: 'danger' },
      alice(),
    )
    expect(renamed).toMatchObject({ name: 'Provisional', colour: 'danger' })
  })
})

describe('favourites', () => {
  const list = (who: Principal) => invoke<FavoriteEntry[]>('favorites.list', { workspaceId: WS }, who)

  it('belongs to the person who made it and to nobody else', async () => {
    const mine = await newPage('Alice keeps this')
    await invoke('favorites.add', { workspaceId: WS, pageId: mine.id }, alice())

    // Same workspace, same page, different person. The row-level policy passes them both — the
    // `user_id` predicate in the query is the only thing between Bob and Alice's sidebar.
    const hers = await list(alice())
    const his = await list(bob())
    expect(hers.map((f) => f.pageId)).toContain(mine.id)
    expect(his.map((f) => f.pageId)).not.toContain(mine.id)
    expect(his.every((f) => f.userId === BOB)).toBe(true)
  })

  it('cannot be removed out of somebody else’s list', async () => {
    const page = await newPage('Alice alone')
    await invoke('favorites.add', { workspaceId: WS, pageId: page.id }, alice())
    await invoke('favorites.remove', { workspaceId: WS, pageId: page.id }, bob())
    expect((await list(alice())).map((f) => f.pageId)).toContain(page.id)
  })

  it('treats a second star on the same page as the same star', async () => {
    const page = await newPage('Starred twice')
    await invoke('favorites.add', { workspaceId: WS, pageId: page.id }, bob())
    const after = await invoke<FavoriteEntry[]>('favorites.add', { workspaceId: WS, pageId: page.id }, bob())
    expect(after.filter((f) => f.pageId === page.id)).toHaveLength(1)
  })

  it('keeps the order it was given, and moves one without renumbering the rest', async () => {
    const who = principal(randomUUID())
    const pages = await Promise.all([newPage('One'), newPage('Two'), newPage('Three')])
    for (const page of pages) await invoke('favorites.add', { workspaceId: WS, pageId: page.id }, who)
    expect((await list(who)).map((f) => f.title)).toEqual(['One', 'Two', 'Three'])

    const before = await list(who)
    const moved = await invoke<FavoriteEntry[]>(
      'favorites.reorder',
      { workspaceId: WS, pageId: pages[2]!.id, afterId: null },
      who,
    )
    expect(moved.map((f) => f.title)).toEqual(['Three', 'One', 'Two'])
    // Only the dragged row got a new rank; that is the whole point of a fractional index.
    const unchanged = moved.filter((f) => f.pageId !== pages[2]!.id)
    for (const row of unchanged)
      expect(row.position).toBe(before.find((f) => f.pageId === row.pageId)?.position)
  })

  it('drops a favourite whose page went to the trash, and brings it back with the page', async () => {
    const who = principal(randomUUID())
    const page = await newPage('Here then gone')
    await invoke('favorites.add', { workspaceId: WS, pageId: page.id }, who)
    expect(await list(who)).toHaveLength(1)

    await invoke('pages.trashPage', { workspaceId: WS, pageId: page.id }, alice())
    expect(await list(who)).toEqual([])

    await invoke('pages.restore', { workspaceId: WS, pageId: page.id }, alice())
    expect((await list(who)).map((f) => f.pageId)).toEqual([page.id])
  })

  /**
   * The list is not "everything you once starred", it is "everything you starred that you may still
   * read". A page-scoped DENY written after the fact leaves a shortcut that refuses to open, which
   * reads as a broken sidebar rather than as a permission.
   */
  it('drops one the space has since closed to you', async () => {
    const userId = randomUUID()
    const who = principal(userId)
    const open = await newPage('Still readable')
    const closed = await newPage('Shut out')
    await invoke('favorites.add', { workspaceId: WS, pageId: open.id }, who)
    await invoke('favorites.add', { workspaceId: WS, pageId: closed.id }, who)
    expect((await list(who)).map((f) => f.pageId)).toEqual([open.id, closed.id])

    denyPage(userId, 'quire.page.view', closed.id)
    try {
      expect((await list(who)).map((f) => f.pageId)).toEqual([open.id])
    } finally {
      bindings.clear()
    }
  })

  /**
   * The other half of the same decision, and the reason `favorites.remove` declares `workspace`
   * rather than `page`: a shortcut you can no longer open is exactly the one you want to be rid of,
   * so requiring read access to delete it would strand it in the sidebar for good.
   */
  it('can still be taken back after you lose access to its page', async () => {
    const userId = randomUUID()
    const who = principal(userId)
    const page = await newPage('Closed after starring')
    await invoke('favorites.add', { workspaceId: WS, pageId: page.id }, who)

    denyPage(userId, 'quire.page.view', page.id)
    try {
      await expect(invoke('favorites.remove', { workspaceId: WS, pageId: page.id }, who)).resolves.toEqual([])
    } finally {
      bindings.clear()
    }
    expect(await list(who)).toEqual([])
  })
})

describe('watchers', () => {
  it('is one list per page, and knows which of them is you', async () => {
    const page = await newPage('Worth following')
    expect(await invoke<WatchState>('watchers.get', { workspaceId: WS, pageId: page.id }, alice())).toEqual({
      watching: false,
      watchers: [],
    })

    await invoke('watchers.set', { workspaceId: WS, pageId: page.id, watching: true }, alice())
    await invoke('watchers.set', { workspaceId: WS, pageId: page.id, watching: true }, bob())

    const forAlice = await invoke<WatchState>('watchers.get', { workspaceId: WS, pageId: page.id }, alice())
    expect(forAlice.watching).toBe(true)
    expect([...forAlice.watchers].sort()).toEqual([ALICE, BOB].sort())

    // Unwatching is one person leaving, not the list being cleared.
    const afterLeaving = await invoke<WatchState>(
      'watchers.set',
      { workspaceId: WS, pageId: page.id, watching: false },
      alice(),
    )
    expect(afterLeaving).toEqual({ watching: false, watchers: [BOB] })
  })

  it('is not the same thing as a favourite', async () => {
    const who = principal(randomUUID())
    const page = await newPage('Watched, not starred')
    await invoke('watchers.set', { workspaceId: WS, pageId: page.id, watching: true }, who)
    expect(await invoke<FavoriteEntry[]>('favorites.list', { workspaceId: WS }, who)).toEqual([])
  })
})

describe('recent views', () => {
  const record = (pageId: string, who: Principal) =>
    invoke('recents.record', { workspaceId: WS, pageId }, who)
  const list = (who: Principal, limit = 10) =>
    invoke<RecentEntry[]>('recents.list', { workspaceId: WS, limit }, who)

  it('comes back newest first, capped at the limit asked for', async () => {
    const who = principal(randomUUID())
    const pages = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((t) => newPage(`Recent ${t}`)))
    for (const page of pages) {
      await record(page.id, who)
      await tick()
    }

    expect((await list(who)).map((r) => r.title)).toEqual([
      'Recent E',
      'Recent D',
      'Recent C',
      'Recent B',
      'Recent A',
    ])
    const capped = await list(who, 2)
    expect(capped.map((r) => r.title)).toEqual(['Recent E', 'Recent D'])
  })

  it('bumps a page it has already seen rather than listing it twice', async () => {
    const who = principal(randomUUID())
    const [first, second] = await Promise.all([newPage('First'), newPage('Second')])
    await record(first!.id, who)
    await tick()
    await record(second!.id, who)
    await tick()
    await record(first!.id, who)

    const seen = await list(who)
    expect(seen.map((r) => r.title)).toEqual(['First', 'Second'])
  })

  it('is one person’s own history', async () => {
    const page = await newPage('Only Alice opened this')
    await record(page.id, alice())
    expect((await list(bob())).map((r) => r.pageId)).not.toContain(page.id)
  })

  it('leaves out a page you may no longer read, and still fills the list', async () => {
    const userId = randomUUID()
    const who = principal(userId)
    const older = await newPage('Older, readable')
    const newer = await newPage('Newer, closed')
    await record(older.id, who)
    await tick()
    await record(newer.id, who)

    denyPage(userId, 'quire.page.view', newer.id)
    try {
      // The over-fetch is what makes this the readable one rather than an empty list: filtering a
      // page of exactly `limit` rows would drop the newest and return nothing at all.
      expect((await list(who, 1)).map((r) => r.pageId)).toEqual([older.id])
    } finally {
      bindings.clear()
    }
  })
})

/**
 * `pages.trash` is the trash *listing* — the verb that puts a page there is `pages.trashPage`.
 *
 * The pair is easy to read backwards, and reading it backwards is how somebody concludes there is no
 * way to list the trash and adds a second procedure on the same route.
 */
describe('the trash listing', () => {
  it('lists what is in this space’s trash and nothing else', async () => {
    const kept = await newPage('Still here')
    const binned = await newPage('Thrown away')
    const elsewhere = await newPage('Binned in another space', other.id)
    await invoke('pages.trashPage', { workspaceId: WS, pageId: binned.id }, alice())
    await invoke('pages.trashPage', { workspaceId: WS, pageId: elsewhere.id }, alice())

    const listed = await invoke<{ items: Page[] }>(
      'pages.trash',
      { workspaceId: WS, spaceId: space.id, limit: 50 },
      alice(),
    )
    const ids = listed.items.map((p) => p.id)
    expect(ids).toContain(binned.id)
    expect(ids, 'a live page is not in the trash').not.toContain(kept.id)
    expect(ids, 'another space’s trash is not this space’s trash').not.toContain(elsewhere.id)
    expect(listed.items.every((p) => p.deletedAt !== null && p.spaceId === space.id)).toBe(true)
  })

  it('empties when the page is restored', async () => {
    const page = await newPage('Second thoughts')
    await invoke('pages.trashPage', { workspaceId: WS, pageId: page.id }, alice())
    await invoke('pages.restore', { workspaceId: WS, pageId: page.id }, alice())
    const listed = await invoke<{ items: Page[] }>(
      'pages.trash',
      { workspaceId: WS, spaceId: space.id, limit: 50 },
      alice(),
    )
    expect(listed.items.map((p) => p.id)).not.toContain(page.id)
  })
})
