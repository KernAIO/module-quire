import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedQuireDemo } from './demo.js'
import { pageDocFromBase64 } from './document.js'
import { quireModule } from './index.js'
import { databases, pages, properties, spaces } from './schema.js'
import { documentNameOf } from './services/pages.js'

/**
 * The demo seeder, run against a real Postgres with a stand-in for the collab service.
 *
 * A page's body is not a column — it is a CRDT the collab service holds — so the only way to know
 * the seeder wrote anything readable is to catch what it hands `collab.document.replace` and decode
 * it back into a document. A seeder that made fourteen perfectly-shaped pages with empty bodies
 * would pass every other check there is.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_demo_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client

const WS = randomUUID()
const OWNER = randomUUID()

/** Every document the seeder pushed to collab, by document name. */
const DOCUMENTS = new Map<string, string>()

const actor = (): Principal =>
  ({
    kind: 'service',
    userId: OWNER,
    email: null,
    name: 'service:test',
    locale: 'en',
    instanceAdmin: true,
    service: 'test',
    memberships: [],
    permissionVersion: 0,
  }) as unknown as Principal

const seed = () => seedQuireDemo({ kernel, workspaceId: WS, actorId: OWNER, actor: actor(), now: new Date() })

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-demo-test',
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
  kernel.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'settings.getModule': { handler: async () => ({}) },
    'modules.isEnabled': { handler: async () => true },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'workspaces.members': { handler: async () => [] },
  })
  kernel.broker.register('collab', {
    'document.replace': {
      handler: async (input: { name: string; state: string }) => {
        DOCUMENTS.set(input.name, input.state)
        return { ok: true }
      },
    },
  })
  await kernel.start()
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

describe('the demo seeder', () => {
  it('fills an empty workspace', async () => {
    const summary = await seed()
    expect(summary.skipped).toBeFalsy()

    const rows = await kernel.database.withWorkspace(WS, async (tx) => ({
      spaces: await tx.select().from(spaces).where(eq(spaces.workspaceId, WS)),
      pages: await tx.select().from(pages).where(eq(pages.workspaceId, WS)),
      databases: await tx.select().from(databases).where(eq(databases.workspaceId, WS)),
      properties: await tx.select().from(properties).where(eq(properties.workspaceId, WS)),
    }))

    expect(rows.spaces.map((s) => s.key).sort()).toEqual(['ENG', 'HB', 'PRD'])
    expect(rows.pages.length).toBe(summary.created?.pages)

    // A tree, not a flat list: the handbook's "Welcome" has children under it.
    expect(rows.pages.filter((p) => p.parentId).length).toBeGreaterThan(8)

    // The database page, its three properties, and a row per roadmap entry.
    expect(rows.databases.length).toBe(1)
    // "Name" is the title column `databases.create` mints for every database.
    expect(rows.properties.map((p) => p.name).sort()).toEqual(['Name', 'Quarter', 'Status', 'Team'])
    const rowPages = rows.pages.filter((p) => p.databaseId)
    expect(rowPages.length).toBe(8)
    expect(rowPages.every((p) => Object.keys((p.props ?? {}) as object).length === 3)).toBe(true)

    /*
     * Every prose page has a body that decodes back to what was written, and a mirrored `text` so
     * it is findable before anybody opens it. The database and its rows are excluded: a database
     * page's content is its rows.
     */
    const prose = rows.pages.filter((p) => p.kind === 'page' && !p.databaseId)
    expect(prose.length).toBeGreaterThan(10)
    for (const page of prose) {
      const state = DOCUMENTS.get(documentNameOf({ workspaceId: WS, id: page.id }))
      expect(state, `no document was pushed for "${page.title}"`).toBeTruthy()
      const doc = pageDocFromBase64(state)
      expect(doc?.content?.length, `"${page.title}" decoded to an empty document`).toBeGreaterThan(0)
      expect(page.text.length).toBeGreaterThan(20)
    }
  })

  /*
   * The case the first version of these seeders got wrong: the emptiness guard left `workspace_id`
   * to row-level security, so on any database whose owner can bypass a policy it saw the previous
   * workspace's spaces and skipped. This test database connects as a superuser, which is exactly
   * that kind, so a second workspace is the cheapest reproduction there is.
   */
  it('fills a second workspace in the same database', async () => {
    const other = randomUUID()
    const summary = await seedQuireDemo({
      kernel,
      workspaceId: other,
      actorId: OWNER,
      actor: actor(),
      now: new Date(),
    })
    expect(summary.skipped).toBeFalsy()
    const rows = await kernel.database.withWorkspace(other, (tx) =>
      tx.select().from(spaces).where(eq(spaces.workspaceId, other)),
    )
    expect(rows.length).toBe(3)
  })

  it('leaves a workspace that already holds something alone', async () => {
    const before = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(pages).where(eq(pages.workspaceId, WS)),
    )
    expect((await seed()).skipped).toBe(true)
    const after = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(pages).where(eq(pages.workspaceId, WS)),
    )
    expect(after.length).toBe(before.length)
  })
})
