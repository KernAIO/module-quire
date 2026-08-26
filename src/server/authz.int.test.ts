/**
 * Every procedure refuses somebody the space has denied.
 *
 * `requires()` on a procedure asks the workspace-level question, and that is not the question a
 * wiki has to answer: "everyone may read the Handbook, the design team may write it, this
 * contractor may read one page of it" is expressed with a **space- or page-scoped binding**, which
 * `requires()` never looks at. The narrow answer has to be asked a second time inside the handler,
 * through `svc.access.scopeOf` and `svc.access.requirePage`.
 *
 * Eight `databases.*` procedures did not ask it. `requires('quire.page.edit')` was on every one of
 * them, so every structural test passed — and an ordinary member with a space-scoped DENY could
 * still read a database's schema and add, rename, reorder and delete its columns and views.
 *
 * So this file does not count middlewares. It boots the module against a real Postgres, walks
 * `quireProcedureAuthz` — which `module.test.ts` holds to the contract, procedure for procedure —
 * and calls each one through oRPC with exactly one permission denied at space scope. The caller is
 * an **admin**, so the workspace-level gate always passes: the only thing left that can refuse is
 * the check inside the handler. A procedure added later without one fails here the day it is
 * declared.
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, KernError, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { quireContract, quirePermissions, quireProcedureAuthz } from '../contract/index.js'
import { implement_ } from './_impl.js'
import { quireModule } from './index.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_authz_${Date.now().toString(36)}`

const WS = randomUUID()
const OWNER = randomUUID()
/** An admin, so nothing they are refused can be blamed on the workspace-level gate. */
const SWEEP = randomUUID()
/** An ordinary member, for the reproduction exactly as it was reported. */
const MALLORY = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>

interface Binding {
  subjectType: 'user' | 'group' | 'builtin_role'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'project' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
/** What core would answer for a workspace that has written a DENY binding. Set per test. */
const bindings = new Map<string, Binding[]>()

const principal = (userId: string, role: 'owner' | 'admin' | 'member' = 'admin'): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const owner = () => principal(OWNER, 'owner')
const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  kernel.database.withWorkspace(WS, fn, { userId: OWNER })

const context = (who: Principal): RequestContext => ({
  kernel,
  principal: who,
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

/** The procedure at `spaces.get`, walked out of the router the same way the map names it. */
const procedureAt = (name: string): unknown =>
  name
    .split('.')
    .reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      router as unknown as Record<string, unknown>,
    )

const invoke = (name: string, input: Record<string, unknown>, who: Principal) =>
  // biome-ignore lint/suspicious/noExplicitAny: the router is walked as data, so the leaf is untyped
  call(procedureAt(name) as any, input as any, { context: context(who) })

/** The document store the collab stub keeps, so a page can have something to version. */
const documents = new Map<string, string>()

function registerStubs(k: Kernel) {
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

/** Everything the sweep needs to address: a space, a page, a version, a comment, a database, a row. */
const fixture = {
  spaceId: '',
  pageId: '',
  versionId: '',
  commentToUpdate: '',
  commentToRemove: '',
  commentToResolve: '',
  databaseId: '',
  databasePageId: '',
  propertyId: '',
  viewId: '',
  spareViewId: '',
  rowId: '',
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-authz-test',
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

  const space = await run((tx) =>
    svc.spaces.create(tx, owner(), WS, {
      key: 'handbook',
      name: 'Handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  fixture.spaceId = space.id

  const page = await run((tx) =>
    svc.pages.create(tx, owner(), WS, {
      spaceId: space.id,
      parentId: null,
      title: 'A page',
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  fixture.pageId = page.id

  documents.set(`ws:${WS}:quire:page:${page.id}`, 'something written')
  const version = await run((tx) =>
    svc.versions.capture(tx, WS, page.id, { kind: 'auto', label: 'v1', authorId: OWNER }),
  )
  fixture.versionId = version!.id

  // One comment per procedure, authored by the sweep principal. Authored by them, so
  // `comments.update` and `comments.remove` reach the page-scoped check instead of stopping at
  // "those are not your words"; one each, so a procedure that wrongly succeeds cannot make the
  // next one fail for the wrong reason — `remove` soft-deleted the thread `resolve` then looked
  // for, and a NOT_FOUND is not the refusal this file is asserting.
  const comment = (text: string) =>
    run((tx) =>
      svc.comments.create(tx, principal(SWEEP), WS, {
        pageId: page.id,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        anchor: null,
        quotedText: '',
        parentId: null,
      }),
    )
  fixture.commentToUpdate = (await comment('to edit')).id
  fixture.commentToRemove = (await comment('to delete')).id
  fixture.commentToResolve = (await comment('to settle')).id

  const host = await run((tx) =>
    svc.pages.create(tx, owner(), WS, {
      spaceId: space.id,
      parentId: null,
      title: 'Tasks',
      kind: 'database',
      icon: null,
      afterId: null,
    }),
  )
  fixture.databasePageId = host.id
  const database = await run((tx) =>
    svc.databases.create(tx, owner(), WS, {
      spaceId: space.id,
      pageId: host.id,
      name: 'Tasks',
      inline: false,
    }),
  )
  fixture.databaseId = database.id
  fixture.propertyId = database.properties[0]!.id
  fixture.viewId = database.views[0]!.id
  // `removeView` refuses the last view before it would ever check a permission, so there are two.
  const spare = await run((tx) =>
    svc.databases.addView(tx, WS, database.id, { name: 'Board', kind: 'table' }),
  )
  fixture.spareViewId = spare.id

  const row = await run(async (tx) => {
    const created = await svc.pages.create(tx, owner(), WS, {
      spaceId: space.id,
      parentId: host.id,
      title: 'A row',
      kind: 'page',
      icon: null,
      afterId: null,
    })
    await svc.databases.setRowFields(tx, WS, created.id, database.id, {})
    return created
  })
  fixture.rowId = row.id
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

/** One valid input per procedure, so a refusal is a refusal and not a validation error. */
const inputFor = (): Record<string, Record<string, unknown>> => {
  const ws = { workspaceId: WS }
  const space = { ...ws, spaceId: fixture.spaceId }
  const page = { ...ws, pageId: fixture.pageId }
  const database = { ...ws, databaseId: fixture.databaseId }
  return {
    'spaces.list': ws,
    'spaces.get': space,
    'spaces.create': { ...ws, key: 'new-space', name: 'New space' },
    'spaces.update': { ...space, name: 'Renamed' },
    'spaces.archive': { ...space, archived: true },

    'pages.tree': space,
    'pages.get': page,
    'pages.trash': space,
    'pages.create': { ...space, title: 'Another' },
    'pages.update': { ...page, title: 'Renamed' },
    'pages.move': { ...page, parentId: null, afterId: null },
    'pages.archive': { ...page, archived: true },
    'pages.trashPage': page,
    'pages.restore': page,
    'pages.purge': page,

    'versions.list': page,
    'versions.get': { ...ws, versionId: fixture.versionId },
    'versions.create': { ...page, label: 'v2' },
    'versions.restore': { ...ws, versionId: fixture.versionId },

    'comments.list': page,
    'comments.create': {
      ...page,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    },
    'comments.update': {
      ...ws,
      commentId: fixture.commentToUpdate,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] },
    },
    'comments.remove': { ...ws, commentId: fixture.commentToRemove },
    'comments.resolve': { ...ws, commentId: fixture.commentToResolve, resolved: true },

    'databases.get': database,
    'databases.forPage': { ...ws, pageId: fixture.databasePageId },
    'databases.list': space,
    'databases.lookup': { ...database, query: 'a' },
    'databases.create': { ...space, pageId: fixture.pageId, name: 'New database' },
    'databases.rows': database,
    'databases.addRow': { ...database, title: 'Smuggled row' },
    'databases.updateRow': { ...ws, rowId: fixture.rowId, title: 'Renamed row' },
    'databases.addProperty': { ...database, name: 'Smuggled column', type: 'text' },
    'databases.updateProperty': { ...ws, propertyId: fixture.propertyId, name: 'Renamed column' },
    'databases.moveProperty': { ...ws, propertyId: fixture.propertyId, afterId: null },
    'databases.removeProperty': { ...ws, propertyId: fixture.propertyId },
    'databases.addView': { ...database, name: 'Smuggled view', kind: 'table' },
    'databases.updateView': { ...ws, viewId: fixture.viewId, name: 'Renamed view' },
    'databases.removeView': { ...ws, viewId: fixture.spareViewId },
    'databases.setRelation': {
      ...ws,
      rowId: fixture.rowId,
      propertyId: fixture.propertyId,
      toPageIds: [fixture.pageId],
    },

    'publishing.publish': { ...page, label: 'live' },
    'publishing.revert': page,
  }
}

/** Deny exactly one permission, at exactly one scope, for exactly one person. */
const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

const codeOf = (err: unknown) => (err instanceof KernError ? err.code : `${(err as Error)?.name}`)

describe('the reported bypass, exactly as it was reported', () => {
  it('stops an ordinary member with a space-scoped DENY from touching a database', async () => {
    const mallory = principal(MALLORY, 'member')
    deny(MALLORY, ['quire.page.view', 'quire.page.edit', 'quire.page.create'], 'space', fixture.spaceId)

    // The guarded neighbours already refuse; they are here so the contrast is in one place.
    await expect(invoke('pages.get', { workspaceId: WS, pageId: fixture.pageId }, mallory)).rejects.toThrow(
      /forbidden/i,
    )

    const unguarded: Array<[string, Record<string, unknown>]> = [
      ['databases.get', { workspaceId: WS, databaseId: fixture.databaseId }],
      ['databases.addProperty', inputFor()['databases.addProperty']!],
      ['databases.updateProperty', inputFor()['databases.updateProperty']!],
      ['databases.moveProperty', inputFor()['databases.moveProperty']!],
      ['databases.removeProperty', inputFor()['databases.removeProperty']!],
      ['databases.addView', inputFor()['databases.addView']!],
      ['databases.updateView', inputFor()['databases.updateView']!],
      ['databases.removeView', inputFor()['databases.removeView']!],
    ]
    for (const [name, input] of unguarded) {
      await expect(
        invoke(name, input, mallory).then(
          () => 'succeeded',
          (err) => codeOf(err),
        ),
        `${name} let a denied member through`,
      ).resolves.toBe('FORBIDDEN')
    }
    bindings.clear()
  })
})

describe('every procedure in the contract', () => {
  const inputs = () => inputFor()

  for (const [name, authz] of Object.entries(quireProcedureAuthz)) {
    it(`${name} refuses somebody denied ${authz.permission}`, async () => {
      const who = principal(SWEEP, 'admin')
      const input = inputs()[name]
      expect(input, `${name} has no input in this file's fixture table`).toBeDefined()

      if (authz.check === 'workspace') {
        // Nothing narrower exists to bind to, so the workspace-level gate is the whole answer.
        deny(SWEEP, [authz.permission], 'workspace', WS)
      } else {
        // Denied at space scope only: `requires()` is satisfied, so a refusal can only come from
        // the check inside the handler.
        deny(SWEEP, [authz.permission], 'space', fixture.spaceId)
      }

      if (authz.check === 'filter') {
        const listed = (await invoke(name, input!, who)) as Array<{ id: string }>
        expect(
          listed.map((s) => s.id),
          `${name} listed a space this person may not see`,
        ).not.toContain(fixture.spaceId)
        bindings.clear()
        return
      }

      const outcome = await invoke(name, input!, who).then(
        () => 'succeeded',
        (err) => codeOf(err),
      )
      bindings.clear()
      expect(outcome, `${name} did not refuse a principal denied ${authz.permission}`).toBe('FORBIDDEN')
    })
  }

  it('names a permission this module actually declares, for every one of them', () => {
    const known = new Set(quirePermissions.map((p) => p.key))
    for (const [name, authz] of Object.entries(quireProcedureAuthz))
      expect(known.has(authz.permission), `${name} wants undeclared "${authz.permission}"`).toBe(true)
  })

  it('has an input in the fixture table for every procedure the contract declares', () => {
    const declared = Object.keys(quireProcedureAuthz).sort()
    expect(Object.keys(inputs()).sort()).toEqual(declared)
    expect(declared.length, 'the map went empty, which would make every loop above vacuous').toBeGreaterThan(
      Object.keys(quireContract).length,
    )
  })
})
