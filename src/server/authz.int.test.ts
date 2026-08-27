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
import { ANONYMOUS, type Principal } from '@kernhq/contracts'
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
  labelId: '',
  // One each, for the same reason there are three comments: a procedure that wrongly succeeds must
  // not be able to make the next one fail with NOT_FOUND, which is not the refusal being asserted.
  labelToRemove: '',
  publicationId: '',
  publicationToRemove: '',
  publicationSlug: 'handbook-site',
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

  const label = (name: string) =>
    run((tx) => svc.organisation.createLabel(tx, WS, space.id, { name, colour: 'accent' }))
  fixture.labelId = (await label('Draft')).id
  fixture.labelToRemove = (await label('Archive')).id

  /*
   * A real, servable published site, so the `check: 'public'` pass below compares two real answers
   * rather than two identical 404s. Publishing renders the version, which is what makes the page
   * public at all — see `publications.ts`.
   */
  await run(async (tx) => {
    const published = await svc.versions.publish(tx, owner(), WS, page.id, 'live')
    if (published.publishedVersionId)
      await svc.publications.renderVersion(tx, WS, published.publishedVersionId)
  })
  const publication = (slug: string) =>
    run((tx) =>
      svc.publications.create(tx, owner(), WS, {
        rootPageId: page.id,
        slug,
        includeDescendants: true,
        password: null,
        expiresAt: null,
        seoTitle: '',
        seoDescription: '',
        ogImageUrl: null,
        indexable: true,
        theme: 'auto',
      }),
    )
  fixture.publicationId = (await publication(fixture.publicationSlug)).id
  fixture.publicationToRemove = (await publication('site-to-remove')).id
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
    'pages.setLabels': { ...page, labelIds: [fixture.labelId] },

    'labels.list': space,
    'labels.forPage': page,
    'labels.create': { ...space, name: 'Smuggled label' },
    'labels.update': { ...ws, labelId: fixture.labelId, name: 'Renamed label' },
    'labels.remove': { ...ws, labelId: fixture.labelToRemove },

    'favorites.list': ws,
    'favorites.add': { ...page },
    'favorites.remove': { ...page },
    'favorites.reorder': { ...page, afterId: null },

    'watchers.get': page,
    'watchers.set': { ...page, watching: true },

    'recents.list': ws,
    'recents.record': page,

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

    'publications.list': space,
    'publications.get': { ...ws, publicationId: fixture.publicationId },
    'publications.create': { ...ws, rootPageId: fixture.pageId, slug: 'smuggled-site' },
    'publications.update': { ...ws, publicationId: fixture.publicationId, seoTitle: 'Renamed site' },
    'publications.remove': { ...ws, publicationId: fixture.publicationToRemove },
    'publications.optOut': { ...page, excluded: true },

    // The public surface takes no id at all — a slug and a path, both of which name a place inside
    // one publication or name nothing.
    'public.site': { workspaceId: WS, slug: fixture.publicationSlug },
    'public.page': { workspaceId: WS, slug: fixture.publicationSlug, path: '' },
    'public.search': { workspaceId: WS, slug: fixture.publicationSlug, q: 'something' },
    'public.sitemap': { workspaceId: WS, slug: fixture.publicationSlug },
    'public.robots': { workspaceId: WS, slug: fixture.publicationSlug },
    // The fixture publication has no password, so this is a door that is not there: NOT_FOUND, for
    // an administrator and for a stranger alike, which is what the pass below compares.
    'public.unlock': { workspaceId: WS, slug: fixture.publicationSlug, password: 'not-the-password' },
  }
}

/** Deny exactly one permission, at exactly one scope, for exactly one person. */
const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

/** The same, at object scope on several pages at once — a restriction on one page, not the space. */
const denyOnPages = (userId: string, permissions: string[], pageIds: string[]) =>
  bindings.set(
    userId,
    pageIds.map((scopeId) => ({
      subjectType: 'user' as const,
      subjectId: userId,
      permissions,
      scopeKind: 'object' as const,
      scopeId,
      deny: true,
    })),
  )

const codeOf = (err: unknown) => (err instanceof KernError ? err.code : `${(err as Error)?.name}`)

/** What a call did, as one comparable value: the error code, or the body it answered with. */
const outcomeOf = (name: string, input: Record<string, unknown>, who: Principal) =>
  invoke(name, input, who).then(
    (value) => ({ code: null as string | null, body: JSON.stringify(value) }),
    (err) => ({ code: codeOf(err), body: '' }),
  )

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

/*
 * The pass above denies at **space** scope, and a space check and a page check both catch that — so
 * it proves each procedure's permission *key* and nothing about its `check` column. Downgrading the
 * shared `requirePage` helper to `requireSpace` left it 45/45 green, which is the whole per-page
 * half of the model silently gone.
 *
 * This pass writes the narrower binding instead: a DENY at **object** scope on the pages themselves.
 * A space-level check cannot see it — a space check asks about the space, and the space is not
 * denied — so anything declaring `check: 'page'` must refuse here or it is not checking a page.
 *
 * Every page in the fixture is denied at once, because which one a procedure resolves to is the
 * thing under test: a database procedure scopes to its host page, a row procedure to the row.
 */
describe('every procedure that claims to check a page', () => {
  const inputs = () => inputFor()
  const pageScoped = Object.entries(quireProcedureAuthz).filter(([, a]) => a.check === 'page')

  it('is a set worth sweeping', () => {
    expect(pageScoped.length, 'nothing declares check: page, so the loop below is vacuous').toBeGreaterThan(
      20,
    )
  })

  for (const [name, authz] of pageScoped) {
    it(`${name} refuses a DENY bound to the page rather than the space`, async () => {
      const who = principal(SWEEP, 'admin')
      const input = inputs()[name]
      expect(input, `${name} has no input in this file's fixture table`).toBeDefined()

      denyOnPages(SWEEP, [authz.permission], [fixture.pageId, fixture.databasePageId, fixture.rowId])
      const outcome = await invoke(name, input!, who).then(
        () => 'succeeded',
        (err) => codeOf(err),
      )
      bindings.clear()
      expect(
        outcome,
        `${name} declares check: 'page' but let a page-scoped DENY of ${authz.permission} through — ` +
          'which is what a space-level check does',
      ).toBe('FORBIDDEN')
    })
  }
})

describe('every procedure in the contract', () => {
  const inputs = () => inputFor()

  it('has a public site a stranger can really open, or the public pass proves nothing', async () => {
    // Two identical 404s would satisfy the comparison in the sweep below without ever exercising a
    // published page. This is the assertion that stops that pass going quietly vacuous.
    const site = (await invoke('public.site', inputs()['public.site']!, ANONYMOUS)) as {
      locked: boolean
      site: { nav: unknown[] } | null
    }
    expect(site.locked).toBe(false)
    expect(site.site?.nav.length ?? 0).toBeGreaterThan(0)
  })

  for (const [name, authz] of Object.entries(quireProcedureAuthz)) {
    it(`${name} refuses somebody denied ${authz.permission}`, async () => {
      const who = principal(SWEEP, 'admin')
      const input = inputs()[name]
      expect(input, `${name} has no input in this file's fixture table`).toBeDefined()

      /*
       * A public procedure has no principal to refuse, so "does it refuse" is the wrong question
       * and asking it would be vacuous. The question that matters is whether the principal changes
       * anything: the only person who ever checks that a published site works is its author, signed
       * in, and a surface that shows them more than it shows a stranger fails in exactly the
       * situation where somebody is looking at it.
       *
       * So it is called twice — once as an administrator with the permission denied outright, once
       * as a genuine anonymous request — and the two answers must be identical. That is what
       * `anonymousOnly` in `_impl.ts` buys, and it is the only thing that keeps buying it.
       */
      if (authz.check === 'public') {
        deny(SWEEP, [authz.permission], 'workspace', WS)
        const asAuthor = await outcomeOf(name, input!, who)
        bindings.clear()
        const asStranger = await outcomeOf(name, input!, ANONYMOUS)

        expect(asAuthor.code, `${name} answered FORBIDDEN on a surface with no principal`).not.toBe(
          'FORBIDDEN',
        )
        expect(
          asAuthor,
          `${name} answered a signed-in author differently from a signed-out stranger`,
        ).toEqual(asStranger)
        return
      }

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

/*
 * Both passes above ask whether a procedure *refuses*. A listing has a third answer available to
 * it — succeed, and name something in the result the caller may not read — and neither pass can
 * see it, because a listing that returns a row is a listing that returned.
 *
 * `pages.trash` is the one that mattered. It is scoped to the space, so reaching the screen only
 * takes an edit permission somewhere in it, and every trashed title came back to whoever got that
 * far. The page-scoped DENY is exactly the case the model exists for, and the row it produced was
 * inert as well as private: `pages.get`, `pages.restore` and `pages.purge` all refuse it.
 */
describe('the trash listing, against a page-scoped DENY', () => {
  it('does not name a page this person may not read', async () => {
    const who = principal(SWEEP, 'admin')
    const title = 'Redundancy plan Q4'
    const doomed = await run((tx) =>
      svc.pages.create(tx, owner(), WS, {
        spaceId: fixture.spaceId,
        parentId: null,
        title,
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    await run((tx) => svc.pages.trashPage(tx, WS, doomed.id))

    const space = { workspaceId: WS, spaceId: fixture.spaceId }
    type Listing = { items: Array<{ title: string }> }

    // Listed when nothing is denied, so the assertion below cannot pass for want of a fixture.
    const open = (await invoke('pages.trash', space, who)) as Listing
    expect(
      open.items.map((p) => p.title),
      'the fixture never reached the trash, so the DENY below would prove nothing',
    ).toContain(title)

    denyOnPages(SWEEP, ['quire.page.view'], [doomed.id])
    const closed = (await invoke('pages.trash', space, who)) as Listing
    const opened = await invoke('pages.get', { workspaceId: WS, pageId: doomed.id }, who).then(
      () => 'succeeded',
      (err) => codeOf(err),
    )
    bindings.clear()

    expect(opened, 'pages.get let the DENY through, so this is not the case it claims to be').toBe(
      'FORBIDDEN',
    )
    expect(
      closed.items.map((p) => p.title),
      'the trash screen showed the title of a page a page-scoped DENY closed to this reader',
    ).not.toContain(title)
  })
})
