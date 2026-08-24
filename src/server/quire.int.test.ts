/**
 * Integration coverage against a real Postgres.
 *
 * A scratch database per run, dropped afterwards, so it never touches development data. What is
 * worth asserting here rather than in a unit test: the migrations apply, the row-level security
 * policy actually bites (through a role that cannot bypass it — the development and CI roles are
 * superusers, so an ordinary connection would pass identically with no policy at all), the tree
 * survives the moves people really make, and `collab.access` answers what the gateway asks.
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { CollabAccess, CollabAccessInput } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page, PageNode, Space } from '../contract/index.js'
import { quireModule } from './index.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_test_${Date.now().toString(36)}`
const RLS_ROLE = `kern_quire_rls_${Date.now().toString(36)}`

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let restricted: pg.Pool | null = null
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()

const principal = (
  userId: string,
  workspaceId: string,
  role: 'owner' | 'admin' | 'member' | 'guest' = 'admin',
): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const alice = () => principal(ALICE, WS_A)
const inWs =
  (workspaceId: string, actor?: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor?.userId ?? null })
const run = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS_A, alice())(fn)

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': {
      handler: async (input: { userId: string }) => principal(input.userId, WS_A),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
  })
}

/** A pool under a role that can neither bypass RLS nor own the tables. */
async function restrictedPool(): Promise<pg.Pool> {
  if (restricted) return restricted
  await admin.query(`create role "${RLS_ROLE}" login password 'rls' nosuperuser nobypassrls`)
  const owner = new pg.Client({ connectionString: databaseUrl })
  await owner.connect()
  await owner.query(`grant usage on schema mod_quire to "${RLS_ROLE}"`)
  await owner.query(`grant select, insert, update, delete on all tables in schema mod_quire to "${RLS_ROLE}"`)
  await owner.end()
  const url = new URL(databaseUrl)
  url.username = RLS_ROLE
  url.password = 'rls'
  restricted = new pg.Pool({ connectionString: url.toString(), max: 2 })
  return restricted
}

async function asWorkspace<T>(workspaceId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = await restrictedPool()
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId])
    const out = await fn(c)
    await c.query('commit')
    return out
  } finally {
    c.release()
  }
}

let space: Space

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'quire-test',
    modules: [quireModule],
    role: 'api',
    env: {
      DATABASE_URL: databaseUrl,
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
  svc = quireServices(kernel)

  space = await run((tx) =>
    svc.spaces.create(tx, alice(), WS_A, {
      key: 'handbook',
      name: 'Handbook',
      description: 'How we work',
      icon: null,
      visibility: 'open',
    }),
  )
}, 180_000)

afterAll(async () => {
  await restricted?.end().catch(() => undefined)
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

const newPage = (over: Partial<Parameters<QuireServices['pages']['create']>[3]> = {}) =>
  run((tx) =>
    svc.pages.create(tx, alice(), WS_A, {
      spaceId: space.id,
      parentId: null,
      title: 'Untitled',
      kind: 'page',
      icon: null,
      afterId: null,
      ...over,
    }),
  )

describe('migrations', () => {
  it('creates mod_quire with row-level security forced on every tenant table', async () => {
    const res = await kernel.database.db.execute<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(`select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relnamespace = 'mod_quire'::regnamespace and relkind = 'r'
        order by relname`)
    const tables = res.rows.filter((r) => r.relname !== '__migrations')
    expect(tables.map((r) => r.relname)).toEqual(['pages', 'spaces'])
    for (const t of tables) {
      expect(t.relrowsecurity, `${t.relname} has RLS off`).toBe(true)
      expect(t.relforcerowsecurity, `${t.relname} does not force RLS`).toBe(true)
    }
  })

  it('sorts page positions by code point, not by language', async () => {
    // The ordering keys are base-62 fractions whose alphabet is ordered by code point. Under this
    // database's en_US.UTF-8 collation `'U' < 'c'` is false, so without an explicit C collation on
    // the column three pages created in order come back reversed — which is exactly what happened.
    const res = await kernel.database.db.execute<{ collname: string }>(
      `select coll.collname from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_collation coll on coll.oid = a.attcollation
        where c.relnamespace = 'mod_quire'::regnamespace
          and c.relname = 'pages' and a.attname = 'position'`,
    )
    expect(res.rows[0]?.collname).toBe('C')
  })

  it('applies again without changing anything', async () => {
    await expect(
      kernel.database.migrateModule('quire', new URL('../../migrations', import.meta.url).pathname),
    ).resolves.toBeUndefined()
  })
})

describe('tenant isolation', () => {
  it('uses a role that genuinely cannot bypass the policy', async () => {
    const rows = await asWorkspace(
      WS_A,
      async (c) =>
        (await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows,
    )
    expect(rows[0], 'a superuser would pass every assertion below with no policy at all').toEqual({
      rolsuper: false,
      rolbypassrls: false,
    })
  })

  it('hides another workspace’s spaces and pages entirely', async () => {
    await newPage({ title: 'Only in A' })
    const mine = await asWorkspace(WS_A, async (c) => (await c.query('select id from mod_quire.pages')).rows)
    expect(mine.length).toBeGreaterThan(0)

    const theirs = await asWorkspace(WS_B, async (c) => ({
      pages: (await c.query('select id from mod_quire.pages')).rows,
      spaces: (await c.query('select id from mod_quire.spaces')).rows,
    }))
    expect(theirs.pages).toHaveLength(0)
    expect(theirs.spaces).toHaveLength(0)
  })

  it('refuses to write a row into a workspace other than the current one', async () => {
    await expect(
      asWorkspace(WS_B, (c) =>
        c.query(
          `insert into mod_quire.spaces (workspace_id, key, name) values ($1, 'smuggled', 'Smuggled')`,
          [WS_A],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('spaces', () => {
  it('refuses a duplicate key in the same workspace, and allows it in another', async () => {
    await expect(
      run((tx) =>
        svc.spaces.create(tx, alice(), WS_A, {
          key: 'handbook',
          name: 'Handbook again',
          description: '',
          icon: null,
          visibility: 'open',
        }),
      ),
    ).rejects.toThrow(/already exists/i)

    const other = await inWs(
      WS_B,
      principal(ALICE, WS_B),
    )((tx) =>
      svc.spaces.create(tx, principal(ALICE, WS_B), WS_B, {
        key: 'handbook',
        name: 'Their handbook',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    expect(other.key).toBe('handbook')
  })

  it('refuses a home page that belongs to a different space', async () => {
    const outsider = await run((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: 'other',
        name: 'Other',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    const page = await newPage({ title: 'In the handbook' })
    await expect(
      run((tx) => svc.spaces.update(tx, WS_A, outsider.id, { homepageId: page.id })),
    ).rejects.toThrow(/must be a page in this space/i)
  })
})

describe('the page tree', () => {
  it('keeps siblings in the order they were placed, without renumbering', async () => {
    const s = await run((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: 'ordering',
        name: 'Ordering',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    const mk = (title: string, afterId: string | null) =>
      run((tx) =>
        svc.pages.create(tx, alice(), WS_A, {
          spaceId: s.id,
          parentId: null,
          title,
          kind: 'page',
          icon: null,
          afterId,
        }),
      )
    const first = await mk('First', null)
    const third = await mk('Third', first.id)
    const second = await mk('Second', first.id)

    const tree = await run((tx) => svc.pages.tree(tx, WS_A, s.id, false))
    expect(tree.map((n) => n.title)).toEqual(['First', 'Second', 'Third'])
    // The point of a fractional index: inserting in the middle touched only the new row.
    const after = await run((tx) => svc.pages.get(tx, WS_A, first.id))
    expect(after.position).toBe(first.position)
    expect(second.position > first.position && second.position < third.position).toBe(true)
  })

  it('reports which nodes have children', async () => {
    const parent = await newPage({ title: 'Parent' })
    await newPage({ title: 'Child', parentId: parent.id })
    const tree = await run((tx) => svc.pages.tree(tx, WS_A, space.id, false))
    const node = tree.find((n: PageNode) => n.id === parent.id)
    expect(node?.hasChildren).toBe(true)
  })

  it('refuses to move a page inside its own descendant', async () => {
    const parent = await newPage({ title: 'Ancestor' })
    const child = await newPage({ title: 'Child', parentId: parent.id })
    const grandchild = await newPage({ title: 'Grandchild', parentId: child.id })

    await expect(
      run((tx) => svc.pages.move(tx, alice(), WS_A, parent.id, grandchild.id, null)),
    ).rejects.toThrow(/own descendants/i)
    await expect(run((tx) => svc.pages.move(tx, alice(), WS_A, parent.id, parent.id, null))).rejects.toThrow(
      /its own parent/i,
    )
  })

  it('refuses to move a page into another space', async () => {
    const elsewhere = await run((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: 'elsewhere',
        name: 'Elsewhere',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    const there = await run((tx) =>
      svc.pages.create(tx, alice(), WS_A, {
        spaceId: elsewhere.id,
        parentId: null,
        title: 'Over there',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    const here = await newPage({ title: 'Over here' })
    await expect(run((tx) => svc.pages.move(tx, alice(), WS_A, here.id, there.id, null))).rejects.toThrow(
      /within its own space/i,
    )
  })
})

describe('trash', () => {
  it('takes the whole subtree and brings it all back', async () => {
    const parent = await newPage({ title: 'Doomed' })
    const child = await newPage({ title: 'Doomed child', parentId: parent.id })
    const grandchild = await newPage({ title: 'Doomed grandchild', parentId: child.id })

    const trashed = await run((tx) => svc.pages.trashPage(tx, WS_A, parent.id))
    expect(trashed.ids.sort()).toEqual([parent.id, child.id, grandchild.id].sort())

    const tree = await run((tx) => svc.pages.tree(tx, WS_A, space.id, true))
    expect(
      tree.some((n: PageNode) => n.id === child.id),
      'a trashed page is out of the tree',
    ).toBe(false)

    const listed = await run((tx) => svc.pages.trash(tx, WS_A, space.id, 50, null))
    expect(listed.items.map((p: Page) => p.id)).toContain(parent.id)

    await run((tx) => svc.pages.restore(tx, WS_A, parent.id))
    const back = await run((tx) => svc.pages.tree(tx, WS_A, space.id, true))
    expect(back.filter((n: PageNode) => [parent.id, child.id, grandchild.id].includes(n.id))).toHaveLength(3)
  })

  it('restores a page to the top of the space when its parent is still in the trash', async () => {
    const parent = await newPage({ title: 'Stays deleted' })
    const child = await newPage({ title: 'Comes back alone', parentId: parent.id })

    await run((tx) => svc.pages.trashPage(tx, WS_A, parent.id))
    const restored = await run((tx) => svc.pages.restore(tx, WS_A, child.id))
    expect(restored.parentId, 'restoring under a deleted parent would hide it for ever').toBeNull()
  })

  it('purges the subtree for good', async () => {
    const parent = await newPage({ title: 'Purge me' })
    await newPage({ title: 'And me', parentId: parent.id })
    const purged = await run((tx) => svc.pages.purge(tx, WS_A, parent.id))
    expect(purged.ids).toHaveLength(2)
    await expect(run((tx) => svc.pages.get(tx, WS_A, parent.id))).rejects.toThrow()
  })
})

describe('collab.access', () => {
  const ask = (input: unknown) => kernel.call<CollabAccess>('quire.collab.access', input)

  it('answers the question the gateway actually asks', async () => {
    const page = await newPage({ title: 'Collaborative' })
    const answer = await ask(
      CollabAccessInput.parse({ workspaceId: WS_A, type: 'page', id: page.id, userId: ALICE }),
    )
    expect(CollabAccess.parse(answer)).toEqual({ canRead: true, canWrite: true })
  })

  it('refuses a document type this module does not own', async () => {
    const page = await newPage({ title: 'Not a whiteboard' })
    await expect(
      ask(CollabAccessInput.parse({ workspaceId: WS_A, type: 'whiteboard', id: page.id, userId: ALICE })),
    ).resolves.toEqual({ canRead: false, canWrite: false })
  })

  it('refuses a page that does not exist rather than throwing at the gateway', async () => {
    await expect(
      ask(CollabAccessInput.parse({ workspaceId: WS_A, type: 'page', id: randomUUID(), userId: BOB })),
    ).resolves.toEqual({ canRead: false, canWrite: false })
  })
})
