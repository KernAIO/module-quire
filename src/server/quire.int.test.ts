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
import { createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Page, PageNode, Space } from '../contract/index.js'
import { implement_ } from './_impl.js'
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

/**
 * A stand-in for the collab service.
 *
 * The real one is tested in its own repository against real sockets; what matters here is that the
 * module asks it the right questions and does the right thing with the answers. The stub keeps one
 * "document" per name as a string, which is enough to tell a replace from a merge — the distinction
 * the whole restore path turns on.
 */
const documents = new Map<string, string>()
function registerCollabStub(k: Kernel) {
  const b64 = (v: string) => Buffer.from(v).toString('base64')
  k.broker.register('collab', {
    'document.state': {
      handler: async (input: { name: string }) => ({
        name: input.name,
        state: documents.has(input.name) ? b64(documents.get(input.name)!) : null,
        size: documents.get(input.name)?.length ?? 0,
        updatedAt: documents.has(input.name) ? new Date().toISOString() : null,
      }),
    },
    'document.snapshot': {
      handler: async (input: { name: string }) => {
        if (!documents.has(input.name)) throw new Error('no document')
        return { snapshot: b64(`snap:${documents.get(input.name)}`), state: b64(documents.get(input.name)!) }
      },
    },
    'document.apply': {
      handler: async (input: { name: string; update: string }) => {
        const incoming = Buffer.from(input.update, 'base64').toString()
        documents.set(input.name, `${documents.get(input.name) ?? ''}${incoming}`)
        return { ok: true as const, size: documents.get(input.name)!.length }
      },
    },
    'document.replace': {
      handler: async (input: { name: string; state: string }) => {
        documents.set(input.name, Buffer.from(input.state, 'base64').toString())
        return { ok: true as const, size: documents.get(input.name)!.length }
      },
    },
    'document.delete': {
      handler: async (input: { name: string }) => {
        documents.delete(input.name)
        return { ok: true as const }
      },
    },
  })
}

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
  // `drop database ... with (force)` in afterAll SIGTERMs every backend still attached to the scratch
  // database, and `pool.end()` destroys a client's socket as soon as it has sent Terminate — so a backend
  // that has not reaped its socket yet can still land a terminating FATAL (57P01) in the buffer of an
  // idle pooled client. pg-pool re-emits an idle client's error on the pool, and an unlistened 'error'
  // event fails the entire vitest run after every test in it has already passed. The database is on its
  // way out by then, so there is nothing to do but swallow it.
  restricted.on('error', () => undefined)
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
  registerCollabStub(kernel)
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
    // Deliberately the exact list rather than a subset: a new table that forgets its policy should
    // fail here, which is what this assertion is for.
    expect(tables.map((r) => r.relname)).toEqual([
      'comments',
      'databases',
      'export_jobs',
      'favorites',
      'import_jobs',
      'labels',
      'page_labels',
      'page_versions',
      'pages',
      'properties',
      'publications',
      'recent_views',
      'relations',
      'spaces',
      'templates',
      'views',
      'watchers',
    ])
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

  it('sorts every other fractional index by code point too', async () => {
    // `pages.position` carried `COLLATE "C"` from the first migration and `properties` and `views`
    // did not, so a database's second view — rank 'k' against the first's 'V' — sorted in front of
    // its first, and moving a column put it somewhere nobody asked for. Nothing failed; the rows
    // came back in the wrong order, which is the only symptom a collation bug has.
    //
    // Every `position` column rather than a list of the ones that exist today. drizzle-kit does not
    // carry collation in its snapshot, so a regenerated migration drops it silently and a new
    // fractional index is born without it — naming the tables here would mean this test only ever
    // guards the columns somebody remembered to add to it, which is how the last two were missed.
    const res = await kernel.database.db.execute<{ relname: string; collname: string }>(
      `select c.relname, coll.collname from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_collation coll on coll.oid = a.attcollation
        where c.relnamespace = 'mod_quire'::regnamespace
          and c.relkind = 'r' and a.attname = 'position' and a.attnum > 0
        order by c.relname`,
    )
    expect(res.rows.length, 'no position column found — this test is checking nothing').toBeGreaterThan(3)
    for (const row of res.rows) {
      expect(row.collname, `${row.relname}.position is not COLLATE "C"`).toBe('C')
    }
    expect(res.rows.map((r) => r.relname)).toContain('favorites')
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

    const listed = await run((tx) => svc.pages.trash(tx, alice(), WS_A, space.id, 50, null))
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

describe('versions, drafts and publishing', () => {
  const docName = (pageId: string) => `ws:${WS_A}:quire:page:${pageId}`

  /** Stand in for somebody typing: the stub's "document" is just its text. */
  const write = (pageId: string, text: string) => {
    documents.set(docName(pageId), text)
    return run((tx) =>
      kernel.database.db
        .execute(`update mod_quire.pages set text = '${text.replace(/'/g, "''")}' where id = '${pageId}'`)
        .then(() => undefined),
    )
  }

  it('takes a version of what is written, and lists it', async () => {
    const page = await newPage({ title: 'Versioned' })
    await write(page.id, 'the first draft')

    const v = await run((tx) =>
      svc.versions.capture(tx, WS_A, page.id, { kind: 'auto', label: null, authorId: ALICE }),
    )
    expect(v).not.toBeNull()

    const listed = await run((tx) => svc.versions.list(tx, WS_A, page.id, 20, null))
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.preview).toBe('the first draft')
    expect(listed.items[0]?.published, 'nothing is published yet').toBe(false)
  })

  it('takes no version of a page nobody has written in', async () => {
    const page = await newPage({ title: 'Never opened' })
    const v = await run((tx) =>
      svc.versions.capture(tx, WS_A, page.id, { kind: 'auto', label: null, authorId: ALICE }),
    )
    expect(v, 'an empty row in the history claims somebody saved something').toBeNull()
  })

  it('publishes what is written, and says so', async () => {
    const page = await newPage({ title: 'To publish' })
    await write(page.id, 'ready for readers')

    const published = await run((tx) => svc.versions.publish(tx, alice(), WS_A, page.id, 'v1'))
    expect(published.publishedVersionId).not.toBeNull()
    expect(published.hasUnpublishedChanges).toBe(false)

    const listed = await run((tx) => svc.versions.list(tx, WS_A, page.id, 20, null))
    const live = listed.items.find((v) => v.published)
    expect(live?.label).toBe('v1')
  })

  it('refuses to publish a live doc, which has nothing to publish', async () => {
    const page = await newPage({ title: 'Always live', kind: 'live' })
    await write(page.id, 'typing')
    await expect(run((tx) => svc.versions.publish(tx, alice(), WS_A, page.id, null))).rejects.toThrow(
      /live doc is always live/i,
    )
  })

  it('replaces the document on revert rather than merging the draft back in', async () => {
    const page = await newPage({ title: 'Reverted' })
    await write(page.id, 'the published text')
    await run((tx) => svc.versions.publish(tx, alice(), WS_A, page.id, null))

    await write(page.id, 'a draft nobody approved')
    const reverted = await run((tx) => svc.versions.revert(tx, alice(), WS_A, page.id))

    expect(reverted.hasUnpublishedChanges).toBe(false)
    expect(
      documents.get(docName(page.id)),
      'the draft was merged in rather than replaced — every discarded paragraph would come back',
    ).toBe('the published text')
  })

  it('keeps the draft it discarded, so revert cannot lose an afternoon', async () => {
    const page = await newPage({ title: 'Revert keeps' })
    await write(page.id, 'published')
    await run((tx) => svc.versions.publish(tx, alice(), WS_A, page.id, null))
    await write(page.id, 'the discarded draft')
    await run((tx) => svc.versions.revert(tx, alice(), WS_A, page.id))

    const listed = await run((tx) => svc.versions.list(tx, WS_A, page.id, 20, null))
    expect(listed.items.map((v) => v.preview)).toContain('the discarded draft')
  })

  it('restores an older version, and records the restore as a version of its own', async () => {
    const page = await newPage({ title: 'Restored' })
    await write(page.id, 'the good version')
    const good = await run((tx) =>
      svc.versions.capture(tx, WS_A, page.id, { kind: 'auto', label: 'good', authorId: ALICE }),
    )
    await write(page.id, 'the bad rewrite')

    const restored = await run((tx) => svc.versions.restore(tx, alice(), WS_A, good!.id))
    expect(restored.kind).toBe('restore')
    expect(documents.get(docName(page.id))).toBe('the good version')

    const listed = await run((tx) => svc.versions.list(tx, WS_A, page.id, 20, null))
    expect(
      listed.items.map((v) => v.preview),
      'the state that was replaced has to survive, or restoring is how you lose work',
    ).toContain('the bad rewrite')
  })

  /**
   * A page written by hand as Yjs, because that is the only shape a version is ever stored in.
   *
   * The collab stub above keeps a "document" as a string, which is enough to tell a replace from a
   * merge and nothing like enough to draw. This builds the real thing — a paragraph with a bold run
   * and a mention of another page — so the render path is exercised end to end rather than against
   * a fixture somebody wrote to match the assertion.
   */
  const yjsPage = (mentionId: string, mentionLabel: string): Buffer => {
    const doc = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'plain ')
    text.insert(6, 'bold', { bold: {} })
    const mention = new Y.XmlElement('pageMention')
    mention.setAttribute('id', mentionId)
    mention.setAttribute('label', mentionLabel)
    paragraph.insert(0, [text, mention])
    doc.getXmlFragment('default').insert(0, [paragraph])
    const state = Buffer.from(Y.encodeStateAsUpdate(doc))
    doc.destroy()
    return state
  }

  it('draws a stored version as HTML, with its page mentions linked', async () => {
    const mentioned = await newPage({ title: 'Linked to' })
    const html = await run((tx) => svc.versions.html(tx, WS_A, yjsPage(mentioned.id, 'Linked to')))

    expect(html, 'the marks are what a plain-text preview throws away').toContain('<strong>bold</strong>')
    expect(
      html,
      'a mention has to resolve to /quire/<space key>/<page id> or it is not a link at all',
    ).toContain(`href="/quire/${space.key}/${mentioned.id}"`)
  })

  it('hands that HTML to whoever asks for the version, through the router', async () => {
    // The point of the render is that a *client* can get at it. `versions.get` is the route that
    // carries it, and its output schema now says so — so a handler that forgot the field would
    // fail oRPC's output validation here rather than quietly returning a version without one.
    const page = await newPage({ title: 'Fetched' })
    const mentioned = await newPage({ title: 'Mentioned' })
    await write(page.id, 'something to version')
    const [version] = await run(async (tx) => {
      const row = await svc.versions.capture(tx, WS_A, page.id, {
        kind: 'auto',
        label: null,
        authorId: ALICE,
      })
      return [row]
    })
    // `capture` stores whatever the collab stub holds, which is a string; replace it with a real
    // document so the row under test is the shape a real one has.
    await kernel.database.db.execute(
      `update mod_quire.page_versions set state = decode('${yjsPage(mentioned.id, 'Mentioned').toString(
        'hex',
      )}', 'hex') where id = '${version!.id}'`,
    )

    const router = implement_(kernel)
    const fetched = await call(
      // biome-ignore lint/suspicious/noExplicitAny: the leaf is reached as data, so it is untyped
      router.versions.get as any,
      { workspaceId: WS_A, versionId: version!.id },
      {
        context: {
          kernel,
          principal: alice(),
          requestId: randomUUID(),
          ip: '127.0.0.1',
          headers: {},
        } as RequestContext,
      },
    )
    expect((fetched as { html: string }).html).toContain('<strong>bold</strong>')
  })

  it('leaves a mention of a page it cannot address as readable text', async () => {
    const html = await run((tx) => svc.versions.html(tx, WS_A, yjsPage(randomUUID(), 'Gone')))
    expect(html).toContain('<span class="kern-page-mention"')
    expect(html, 'a link to nothing is worse than a label').not.toContain('<a class="kern-page-mention"')
  })

  it('renders nothing at all for a version whose bytes will not decode', async () => {
    expect(await run((tx) => svc.versions.html(tx, WS_A, Buffer.from('not yjs')))).toBe('')
    expect(await run((tx) => svc.versions.html(tx, WS_A, null))).toBe('')
  })

  it('refuses to revert a page that has never been published', async () => {
    const page = await newPage({ title: 'Never published' })
    await write(page.id, 'draft only')
    await expect(run((tx) => svc.versions.revert(tx, alice(), WS_A, page.id))).rejects.toThrow(
      /never been published/i,
    )
  })
})

describe('comments', () => {
  const body = (text: string, mention?: string) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text },
          ...(mention ? [{ type: 'mention', attrs: { id: mention, label: 'Bob' } }] : []),
        ],
      },
    ],
  })

  it('starts a thread anchored to a piece of the page', async () => {
    const page = await newPage({ title: 'Commented' })
    const c = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('is this still true?'),
        anchor: { from: 'AQID', to: 'BAUG' },
        quotedText: 'the sentence in question',
        parentId: null,
      }),
    )
    expect(c.threadId, 'a root comment leads its own thread').toBe(c.id)
    expect(c.bodyText).toBe('is this still true?')
    expect(c.quotedText).toBe('the sentence in question')

    const threads = await run((tx) => svc.comments.list(tx, WS_A, page.id, false))
    expect(threads).toHaveLength(1)
    expect(threads[0]?.root.id).toBe(c.id)
  })

  it('flattens the body and collects mentions without a second parse', async () => {
    const page = await newPage({ title: 'Mentioning' })
    const c = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('what do you think ', BOB),
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
    expect(c.mentionIds).toEqual([BOB])
    // The name stays in the text: the margin draws `bodyText`, and so does the notification that
    // tells Bob he was named — both of which used to drop him. See `comments.test.ts`.
    expect(c.bodyText).toBe('what do you think @Bob')
  })

  it('joins replies to the thread rather than nesting them further', async () => {
    const page = await newPage({ title: 'Threaded' })
    const root = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('first'),
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
    const reply = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('second'),
        anchor: null,
        quotedText: '',
        parentId: root.id,
      }),
    )
    const deep = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('third'),
        anchor: null,
        quotedText: '',
        parentId: reply.id,
      }),
    )
    expect(deep.threadId, 'a reply to a reply is still the same conversation').toBe(root.id)

    const threads = await run((tx) => svc.comments.list(tx, WS_A, page.id, false))
    expect(threads).toHaveLength(1)
    expect(threads[0]?.replies).toHaveLength(2)
  })

  it('resolves the whole thread, not one remark in it', async () => {
    const page = await newPage({ title: 'Resolvable' })
    const root = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('a question'),
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
    const reply = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('an answer'),
        anchor: null,
        quotedText: '',
        parentId: root.id,
      }),
    )
    // Resolving from the reply settles the conversation it belongs to.
    await run((tx) => svc.comments.resolve(tx, alice(), WS_A, reply.id, true))

    expect(await run((tx) => svc.comments.list(tx, WS_A, page.id, false))).toHaveLength(0)
    const withResolved = await run((tx) => svc.comments.list(tx, WS_A, page.id, true))
    expect(withResolved[0]?.resolved).toBe(true)
  })

  it('refuses to let one person edit another’s words', async () => {
    const page = await newPage({ title: 'Not yours' })
    const c = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('mine'),
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
    await expect(
      run((tx) => svc.comments.update(tx, principal(BOB, WS_A), WS_A, c.id, body('rewritten'))),
    ).rejects.toThrow()
  })

  it('keeps a thread readable when the remark that started it is deleted', async () => {
    const page = await newPage({ title: 'Orphaned' })
    const root = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('the original point'),
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
    await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, {
        pageId: page.id,
        body: body('the reply that still matters'),
        anchor: null,
        quotedText: '',
        parentId: root.id,
      }),
    )
    await run((tx) => svc.comments.remove(tx, alice(), WS_A, root.id))

    const threads = await run((tx) => svc.comments.list(tx, WS_A, page.id, false))
    expect(threads, 'the replies are still somebody’s words').toHaveLength(1)
    expect(threads[0]?.root.bodyText).toBe('the reply that still matters')
  })
})

describe('databases', () => {
  let dbId: string
  let dbSpace: string

  const mkDatabase = async (name: string) => {
    const space = await run((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: `db-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    const host = await run((tx) =>
      svc.pages.create(tx, alice(), WS_A, {
        spaceId: space.id,
        parentId: null,
        title: name,
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    const db = await run((tx) =>
      svc.databases.create(tx, alice(), WS_A, {
        spaceId: space.id,
        pageId: host.id,
        name,
        inline: false,
      }),
    )
    return { db, space }
  }

  const addRow = (
    databaseId: string,
    spaceId: string,
    parentId: string,
    title: string,
    props: Record<string, unknown>,
  ) =>
    run(async (tx) => {
      const created = await svc.pages.create(tx, alice(), WS_A, {
        spaceId,
        parentId,
        title,
        kind: 'page',
        icon: null,
        afterId: null,
      })
      await svc.databases.setRowFields(tx, WS_A, created.id, databaseId, props)
      await svc.databases.recompute(tx, WS_A, created.id)
      return svc.databases.rowById(tx, WS_A, created.id)
    })

  beforeAll(async () => {
    const made = await mkDatabase('Tasks')
    dbId = made.db.id
    dbSpace = made.space.id
  }, 60_000)

  it('does not list its own page as a row of itself', async () => {
    const { db } = await mkDatabase('SelfRow')
    const rows = await run((tx) =>
      svc.databases.rows(tx, WS_A, db.id, { view: null, limit: 50, cursor: null }),
    )
    expect(
      rows.items.map((r) => r.id),
      'database_id means "row of"; setting it on the host page made the database a row of itself',
    ).not.toContain(db.pageId)
  })

  it('arrives with a column and a view, never an empty screen', async () => {
    const db = await run((tx) => svc.databases.get(tx, WS_A, dbId))
    expect(db.properties.map((p) => p.key)).toEqual(['name'])
    expect(db.views).toHaveLength(1)
    expect(db.views[0]?.isDefault).toBe(true)
  })

  it('keeps a column’s data when it is renamed', async () => {
    const db = await run((tx) => svc.databases.get(tx, WS_A, dbId))
    const host = db.pageId
    const estimate = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, dbId, { name: 'Estimate', type: 'number' }),
    )
    const row = await addRow(dbId, dbSpace, host, 'A task', { [estimate.key]: 5 })
    await run((tx) => svc.databases.updateProperty(tx, WS_A, estimate.id, { name: 'Points' }))

    const after = await run((tx) => svc.databases.rowById(tx, WS_A, row.id))
    expect(
      after.props[estimate.key],
      'renaming a column emptied it — props is keyed by key for exactly this reason',
    ).toBe(5)
  })

  it('sorts numbers as numbers, not as text', async () => {
    const { db, space } = await mkDatabase('Sorting')
    const size = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, { name: 'Size', type: 'number' }),
    )
    for (const n of [9, 10, 2]) await addRow(db.id, space.id, db.pageId, `n${n}`, { [size.key]: n })

    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { sorts: [{ propertyKey: size.key, direction: 'asc' }] } as never,
      }),
    )
    const rows = await run((tx) => svc.databases.rows(tx, WS_A, db.id, { view, limit: 50, cursor: null }))
    expect(
      rows.items.map((r) => r.props[size.key]),
      'lexicographic ordering would put 10 before 9',
    ).toEqual([2, 9, 10])
  })

  it('filters in SQL, so a page of rows is a full page', async () => {
    const { db, space } = await mkDatabase('Filtering')
    const done = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, { name: 'Done', type: 'checkbox' }),
    )
    for (let i = 0; i < 6; i++)
      await addRow(db.id, space.id, db.pageId, `row ${i}`, { [done.key]: i % 2 === 0 })

    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { filters: [{ propertyKey: done.key, operator: 'equals', value: true }] } as never,
      }),
    )
    const first = await run((tx) => svc.databases.rows(tx, WS_A, db.id, { view, limit: 2, cursor: null }))
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor, 'there are three matches, so a page of two has more').not.toBeNull()

    const rest = await run((tx) =>
      svc.databases.rows(tx, WS_A, db.id, { view, limit: 10, cursor: first.nextCursor }),
    )
    expect(rest.items).toHaveLength(1)
  })

  it('treats an untouched checkbox as false rather than as missing', async () => {
    const { db, space } = await mkDatabase('Unchecked')
    const done = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, { name: 'Done', type: 'checkbox' }),
    )
    await addRow(db.id, space.id, db.pageId, 'never touched', {})

    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { filters: [{ propertyKey: done.key, operator: 'equals', value: false }] } as never,
      }),
    )
    const rows = await run((tx) => svc.databases.rows(tx, WS_A, db.id, { view, limit: 10, cursor: null }))
    expect(rows.items, 'most rows are ones nobody has touched').toHaveLength(1)
  })

  it('refuses a filter naming a property that does not exist', async () => {
    const { db } = await mkDatabase('Unknown')
    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { filters: [{ propertyKey: 'injected', operator: 'equals', value: 'x' }] } as never,
      }),
    )
    await expect(
      run((tx) => svc.databases.rows(tx, WS_A, db.id, { view, limit: 10, cursor: null })),
    ).rejects.toThrow(/No such property/i)
  })

  it('computes a formula and stores it, so a view can sort by one', async () => {
    const { db, space } = await mkDatabase('Formulas')
    const hours = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, { name: 'Hours', type: 'number' }),
    )
    await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, {
        name: 'Days',
        type: 'formula',
        config: { expression: 'round(prop("Hours") / 8, 2)' },
      }),
    )
    const row = await addRow(db.id, space.id, db.pageId, 'a job', { [hours.key]: 20 })
    expect(row.computed.days).toBe(2.5)
  })

  it('puts a broken formula in its own cell rather than failing the write', async () => {
    const { db, space } = await mkDatabase('Broken')
    await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, {
        name: 'Oops',
        type: 'formula',
        config: { expression: 'prop("Missing") / prop("AlsoMissing")' },
      }),
    )
    const row = await addRow(db.id, space.id, db.pageId, 'still saved', {})
    expect(row.title).toBe('still saved')
    // Dividing by nothing is a blank cell, and the row saved regardless.
    expect(row.computed.oops).toBeNull()
  })

  it('links both ends of a relation, and rolls up through it', async () => {
    const projects = await mkDatabase('Projects')
    const tasks = await mkDatabase('RelTasks')

    const toTasks = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, projects.db.id, {
        name: 'Tasks',
        type: 'relation',
        config: { relationDatabaseId: tasks.db.id },
      }),
    )
    const toProject = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, tasks.db.id, {
        name: 'Project',
        type: 'relation',
        config: { relationDatabaseId: projects.db.id, relationPropertyId: toTasks.id },
      }),
    )
    await run((tx) =>
      svc.databases.updateProperty(tx, WS_A, toTasks.id, {
        config: { relationDatabaseId: tasks.db.id, relationPropertyId: toProject.id },
      }),
    )
    const points = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, tasks.db.id, { name: 'Points', type: 'number' }),
    )
    const total = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, projects.db.id, {
        name: 'Total',
        type: 'rollup',
        config: {
          rollupRelationPropertyId: toTasks.id,
          rollupTargetPropertyId: points.id,
          rollupFunction: 'sum',
        },
      }),
    )

    const project = await addRow(projects.db.id, projects.space.id, projects.db.pageId, 'Northstar', {})
    const t1 = await addRow(tasks.db.id, tasks.space.id, tasks.db.pageId, 'one', { [points.key]: 3 })
    const t2 = await addRow(tasks.db.id, tasks.space.id, tasks.db.pageId, 'two', { [points.key]: 5 })

    await run((tx) => svc.databases.setRelation(tx, WS_A, toTasks.id, project.id, [t1.id, t2.id]))

    const after = await run((tx) => svc.databases.rowById(tx, WS_A, project.id))
    expect(after.computed[total.key]).toBe(8)

    // Set from one side, visible from the other — a link that is not is the "wrong rollup" bug.
    const backlink = await run((tx) => svc.databases.rowById(tx, WS_A, t1.id))
    const deps = await run((tx) => svc.databases.dependentsOf(tx, WS_A, t1.id))
    expect(backlink.id).toBe(t1.id)
    expect(deps, 'the project rolls this task up, so editing it must recompute the project').toContain(
      project.id,
    )
  })

  it('sorts by a formula, which lives in computed rather than in props', async () => {
    const { db, space } = await mkDatabase('FormulaSort')
    const hours = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, { name: 'Hours', type: 'number' }),
    )
    const days = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, db.id, {
        name: 'Days',
        type: 'formula',
        config: { expression: 'round(prop("Hours") / 8, 2)' },
      }),
    )
    await addRow(db.id, space.id, db.pageId, 'four', { [hours.key]: 4 })
    await addRow(db.id, space.id, db.pageId, 'twenty', { [hours.key]: 20 })

    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { sorts: [{ propertyKey: days.key, direction: 'desc' }] } as never,
      }),
    )
    const rows = await run((tx) => svc.databases.rows(tx, WS_A, db.id, { view, limit: 50, cursor: null }))
    expect(
      rows.items.map((r) => r.title),
      'a formula lives in computed, not props — reading props sorts nothing and says nothing',
    ).toEqual(['twenty', 'four'])
  })

  it('pages a sorted view without dropping or repeating a row', async () => {
    const { db, space } = await mkDatabase('Paging')
    const n = await run((tx) => svc.databases.addProperty(tx, WS_A, db.id, { name: 'N', type: 'number' }))
    for (const value of [5, 4, 3, 2, 1])
      await addRow(db.id, space.id, db.pageId, `row ${value}`, { [n.key]: value })

    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { sorts: [{ propertyKey: n.key, direction: 'asc' }] } as never,
      }),
    )

    const seen: string[] = []
    const ids: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof svc.databases.rows>> = await run((tx) =>
        svc.databases.rows(tx, WS_A, db.id, { view, limit: 2, cursor }),
      )
      seen.push(...page.items.map((r) => r.title))
      ids.push(...page.items.map((r) => r.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen, 'a keyset on pages.id is only a valid cursor when id is the whole ordering').toEqual([
      'row 1',
      'row 2',
      'row 3',
      'row 4',
      'row 5',
    ])
    expect(new Set(ids).size).toBe(5)
  })

  it('reads a relation from both rows, because the join table alone draws nothing', async () => {
    const projects = await mkDatabase('MirrorProjects')
    const tasks = await mkDatabase('MirrorTasks')
    const toTasks = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, projects.db.id, {
        name: 'Tasks',
        type: 'relation',
        config: { relationDatabaseId: tasks.db.id },
      }),
    )
    const toProject = await run((tx) =>
      svc.databases.addProperty(tx, WS_A, tasks.db.id, {
        name: 'Project',
        type: 'relation',
        config: { relationDatabaseId: projects.db.id, relationPropertyId: toTasks.id },
      }),
    )
    await run((tx) =>
      svc.databases.updateProperty(tx, WS_A, toTasks.id, {
        config: { relationDatabaseId: tasks.db.id, relationPropertyId: toProject.id },
      }),
    )

    const project = await addRow(projects.db.id, projects.space.id, projects.db.pageId, 'Northstar', {})
    const t1 = await addRow(tasks.db.id, tasks.space.id, tasks.db.pageId, 'one', {})
    const t2 = await addRow(tasks.db.id, tasks.space.id, tasks.db.pageId, 'two', {})
    await run((tx) => svc.databases.setRelation(tx, WS_A, toTasks.id, project.id, [t1.id, t2.id]))

    const after = await run((tx) => svc.databases.rowById(tx, WS_A, project.id))
    expect(
      after.props[toTasks.key],
      'toRow reads props and nothing else, so an unmirrored relation is a blank column',
    ).toEqual([t1.id, t2.id])
    const back = await run((tx) => svc.databases.rowById(tx, WS_A, t1.id))
    expect(back.props[toProject.key]).toContain(project.id)

    // …and a view can filter by it, which is the same read.
    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, projects.db.views[0]!.id, {
        config: {
          filters: [{ propertyKey: toTasks.key, operator: 'is_any_of', value: [t1.id] }],
        } as never,
      }),
    )
    const rows = await run((tx) =>
      svc.databases.rows(tx, WS_A, projects.db.id, { view, limit: 10, cursor: null }),
    )
    expect(rows.items.map((r) => r.id)).toEqual([project.id])

    // Unlinking clears the mirror on the row that lost the link, not just the join table.
    await run((tx) => svc.databases.setRelation(tx, WS_A, toTasks.id, project.id, [t2.id]))
    const dropped = await run((tx) => svc.databases.rowById(tx, WS_A, t1.id))
    expect(dropped.props[toProject.key]).toEqual([])
  })

  it('deletes a default view when another one remains', async () => {
    const { db } = await mkDatabase('TwoViews')
    const second = await run((tx) => svc.databases.addView(tx, WS_A, db.id, { name: 'Board', kind: 'board' }))
    await run((tx) => svc.databases.removeView(tx, WS_A, db.views[0]!.id))

    const after = await run((tx) => svc.databases.get(tx, WS_A, db.id))
    expect(after.views.map((v) => v.id)).toEqual([second.id])
    expect(after.views[0]?.isDefault, 'a database with views and no default renders nothing at all').toBe(
      true,
    )
  })

  it('keeps at least one view — the last one, not the first', async () => {
    const { db } = await mkDatabase('LastView')
    const second = await run((tx) => svc.databases.addView(tx, WS_A, db.id, { name: 'Extra', kind: 'table' }))
    // The old test deleted the only view, which is also the default, so it passed on the wrong rule.
    await run((tx) => svc.databases.removeView(tx, WS_A, second.id))
    await expect(run((tx) => svc.databases.removeView(tx, WS_A, db.views[0]!.id))).rejects.toThrow(
      /at least one view/i,
    )
  })

  it('moves a column behind another one', async () => {
    const { db } = await mkDatabase('Reorder')
    const b = await run((tx) => svc.databases.addProperty(tx, WS_A, db.id, { name: 'B', type: 'text' }))
    const c = await run((tx) => svc.databases.addProperty(tx, WS_A, db.id, { name: 'C', type: 'text' }))
    await run((tx) => svc.databases.moveProperty(tx, WS_A, c.id, db.properties[0]!.id))

    const after = await run((tx) => svc.databases.get(tx, WS_A, db.id))
    expect(after.properties.map((p) => p.key)).toEqual(['name', c.key, b.key])

    // …and to the front.
    await run((tx) => svc.databases.moveProperty(tx, WS_A, b.id, null))
    const front = await run((tx) => svc.databases.get(tx, WS_A, db.id))
    expect(front.properties.map((p) => p.key)).toEqual([b.key, 'name', c.key])
  })

  it('hands back a complete view configuration, not the fragment last written', async () => {
    const { db } = await mkDatabase('Config')
    const view = await run((tx) =>
      svc.databases.updateView(tx, WS_A, db.views[0]!.id, {
        config: { sorts: [{ propertyKey: 'name', direction: 'desc' }] } as never,
      }),
    )
    expect(
      view.config.filterMode,
      'toView casting rather than parsing promises a default and hands over undefined',
    ).toBe('and')
    expect(view.config.columnWidths).toEqual({})
    expect(view.config.visibleProperties).toBeNull()
  })

  it('keeps rows out of the page tree', async () => {
    const { db, space } = await mkDatabase('TreeRows')
    const rows = []
    for (const title of ['one', 'two', 'three'])
      rows.push(await addRow(db.id, space.id, db.pageId, title, {}))

    const tree = await run((tx) => svc.pages.tree(tx, WS_A, space.id, false))
    const ids = tree.map((n) => n.id)
    expect(ids, 'the database itself is a page and belongs in the tree').toContain(db.pageId)
    for (const row of rows)
      expect(ids, 'five hundred rows under one node is an unusable sidebar').not.toContain(row.id)
  })

  it('finds the database a page is, and null for a page that is not one', async () => {
    const { db, space } = await mkDatabase('ForPage')
    const found = await run((tx) => svc.databases.forPage(tx, WS_A, db.pageId))
    expect(found?.id).toBe(db.id)

    const plain = await run((tx) =>
      svc.pages.create(tx, alice(), WS_A, {
        spaceId: space.id,
        parentId: null,
        title: 'Just prose',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    expect(await run((tx) => svc.databases.forPage(tx, WS_A, plain.id))).toBeNull()
  })

  it('lists the databases of a space, so a relation has something to point at', async () => {
    const made = await mkDatabase('Listed')
    const refs = await run((tx) => svc.databases.list(tx, WS_A, made.space.id))
    expect(refs.map((r) => r.id)).toEqual([made.db.id])
    expect(refs[0]?.name).toBe('Listed')
    expect(refs[0]?.pageId).toBe(made.db.pageId)
  })

  it('looks rows up by name and by id, so a relation cell can draw and search', async () => {
    const { db, space } = await mkDatabase('Lookup')
    const one = await addRow(db.id, space.id, db.pageId, 'Alpha one', {})
    const two = await addRow(db.id, space.id, db.pageId, 'Beta two', {})

    const searched = await run((tx) =>
      svc.databases.lookup(tx, WS_A, db.id, { query: 'alpha', ids: [], limit: 25 }),
    )
    expect(searched.map((r) => r.id)).toEqual([one.id])

    // The ids a cell already holds come back even when they match nothing being typed.
    const resolved = await run((tx) =>
      svc.databases.lookup(tx, WS_A, db.id, { query: 'zzz', ids: [one.id, two.id], limit: 25 }),
    )
    expect(resolved.map((r) => r.title).sort()).toEqual(['Alpha one', 'Beta two'])
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
