import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { quireModule } from './index.js'
import { type QuireServices, quireServices } from './services/index.js'

/**
 * Cross-tenant isolation, as a class rather than as a list of bugs.
 *
 * Every case hands a service an id that belongs to **workspace A** while the transaction is scoped
 * to **workspace B**. A query whose `WHERE` is only `eq(table.id, input.something)` finds that row
 * and acts on it — which is how a reply count landed on a stranger's comment in the tracker before
 * its own test of this shape existed.
 *
 * Two layers are asserted, because each is a defence the other does not provide:
 *
 *  1. **the service**, which must answer the module's honest *not found* — never `forbidden`,
 *     which would confirm the row exists;
 *  2. **row-level security**, which is only observable under a role that cannot bypass it. The
 *     development user is a superuser and superusers bypass RLS entirely, so the probe below opens
 *     a second connection as an explicit `nosuperuser nobypassrls` role.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_iso_${Date.now().toString(36)}`
const RLS_ROLE = `kern_quire_iso_rls_${Date.now().toString(36)}`

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()

const principal = (userId: string, workspaceId: string): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const inA = principal(ALICE, WS_A)
const inB = principal(BOB, WS_B)

const run =
  (workspaceId: string, actor: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor.userId })

const runA = run(WS_A, inA)
const runB = run(WS_B, inB)

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
    'document.apply': { handler: async () => ({ ok: true as const, size: 0 }) },
    'document.replace': { handler: async () => ({ ok: true as const, size: 0 }) },
  })
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': {
      handler: async (input: { userId: string }) =>
        principal(input.userId, input.userId === BOB ? WS_B : WS_A),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
  })
}

/** Seeded in A, and named by the tests as the id a caller in B tries to reach. */
let spaceA: string
let pageA: string
/** Seeded in B, so a cross-tenant call has somewhere legitimate to stand. */
let spaceB: string

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'quire-isolation-test',
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
  registerStubs(kernel)
  await kernel.start()
  svc = quireServices(kernel)

  const sa = await runA((tx) =>
    svc.spaces.create(tx, inA, WS_A, {
      key: 'ALPHA',
      name: 'Alpha',
      description: '',
      icon: null,
      visibility: 'workspace',
    }),
  )
  spaceA = sa.id
  const pa = await runA((tx) =>
    svc.pages.create(tx, inA, WS_A, {
      spaceId: spaceA,
      parentId: null,
      title: 'Alpha handbook',
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  pageA = pa.id

  const sb = await runB((tx) =>
    svc.spaces.create(tx, inB, WS_B, {
      key: 'BETA',
      name: 'Beta',
      description: '',
      icon: null,
      visibility: 'workspace',
    }),
  )
  spaceB = sb.id
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin?.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('an id from workspace A, used from workspace B', () => {
  it('is not a space B can open', async () => {
    await expect(runB((tx) => svc.spaces.get(tx, inB, WS_B, spaceA))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('is not a page B can open', async () => {
    await expect(runB((tx) => svc.pages.get(tx, WS_B, pageA))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('is not a page B can file a child under', async () => {
    await expect(
      runB((tx) =>
        svc.pages.create(tx, inB, WS_B, {
          spaceId: spaceB,
          parentId: pageA,
          title: 'smuggled child',
          kind: 'page',
          icon: null,
          afterId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('is not a page B can archive or move', async () => {
    await expect(runB((tx) => svc.pages.archive(tx, inB, WS_B, pageA, true))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it("does not appear in B's tree, even by A's space id", async () => {
    const tree = await runB((tx) => svc.pages.tree(tx, WS_B, spaceA, true))
    expect(tree).toEqual([])
  })

  it('leaves A exactly as it was', async () => {
    const page = await runA((tx) => svc.pages.get(tx, WS_A, pageA))
    expect(page.id).toBe(pageA)
    expect(page.archivedAt).toBeNull()
    expect(page.parentId).toBeNull()
    const tree = await runA((tx) => svc.pages.tree(tx, WS_A, spaceA, false))
    expect(tree.map((n) => n.id)).toEqual([pageA])
  })
})

describe('row-level security, under a role that cannot bypass it', () => {
  let plain: pg.Client

  beforeAll(async () => {
    const scratch = new pg.Client({ connectionString: databaseUrl })
    await scratch.connect()
    await scratch.query(`create role "${RLS_ROLE}" login password 'probe' nosuperuser nobypassrls`)
    await scratch.query(`grant usage on schema mod_quire to "${RLS_ROLE}"`)
    await scratch.query(`grant select on all tables in schema mod_quire to "${RLS_ROLE}"`)
    await scratch.end()

    const url = new URL(databaseUrl)
    url.username = RLS_ROLE
    url.password = 'probe'
    plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
  }, 60_000)

  afterAll(async () => {
    await plain?.end().catch(() => undefined)
  })

  const count = async (sqlText: string) => {
    const { rows } = await plain.query<{ n: string }>(sqlText)
    return Number(rows[0]?.n ?? -1)
  }

  it('shows a session bound to B none of A, even when the query asks for A by id', async () => {
    await plain.query(`set app.workspace_id = '${WS_B}'`)
    expect(await count(`select count(*) as n from mod_quire.pages where id = '${pageA}'`)).toBe(0)
    expect(await count(`select count(*) as n from mod_quire.spaces where id = '${spaceA}'`)).toBe(0)
    // and the binding is what admits B's own rows, so the zero above is a policy, not an empty table
    expect(await count(`select count(*) as n from mod_quire.spaces where id = '${spaceB}'`)).toBe(1)
  })

  it('shows a session bound to nothing nothing at all', async () => {
    await plain.query(`reset app.workspace_id`)
    expect(await count(`select count(*) as n from mod_quire.pages`)).toBe(0)
    expect(await count(`select count(*) as n from mod_quire.spaces`)).toBe(0)
  })
})
