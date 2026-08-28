/**
 * The one thing a macro must never do.
 *
 * Five of the eight macros read *other pages* — children, excerpt-include, include-page,
 * recently-updated and contributors — and every one of them draws a title, a link or a paragraph
 * that belongs to a page the reader may never have been shown. That is the whole risk of this
 * feature and it is not a risk the type system can carry: a resolver that forgets its filter still
 * compiles, still renders, and looks right to the person who wrote the page, because the person who
 * wrote the page can read everything on it.
 *
 * So the rule is written down here, before the macros were built, and it has three parts:
 *
 *   1. **The renderer never reads a database.** `renderPageDoc` draws a reading macro only from a
 *      `MacroResolver` handed to it. With no resolver — which is what every existing caller passes,
 *      because none of them knew about macros — a reading macro draws its frame and nothing else.
 *      Fail-closed is the default, not a branch somebody has to remember.
 *   2. **A signed-in reader sees exactly what they could open.** Every page a macro names is asked
 *      about with `quire.page.view` at *page* scope, so a DENY bound to one page removes it from a
 *      children list on its parent — and takes its excerpt, its body and its title with it.
 *   3. **A published site has no reader, so the publication is the audience.** The set of publicly
 *      reachable pages is the whole of what exists; anything outside it is not drawn as a title
 *      with a dead link, it is not drawn at all.
 *
 * The assertions below are written as string searches over the rendered HTML rather than over the
 * resolver's return value, deliberately. What leaks is a title on a page, and the only honest place
 * to look for it is the bytes that go out.
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageDocToYState } from './import/ydoc.js'
import { quireModule } from './index.js'
import { renderPageDoc } from './render.js'
import { pages } from './schema.js'
import { type QuireServices, quireServices } from './services/index.js'
import { documentNameOf } from './services/pages.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_macros_${Date.now().toString(36)}`

const WS = randomUUID()
const OWNER = randomUUID()
/** The reader every assertion is about: an admin, so nothing they miss is the workspace gate. */
const READER = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client

interface Binding {
  subjectType: 'user' | 'group' | 'builtin_role'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'project' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
const bindings = new Map<string, Binding[]>()

const principal = (userId: string, role: 'owner' | 'admin' = 'admin'): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId === OWNER ? 'Ada Owner' : 'Bob Reader',
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const owner = () => principal(OWNER, 'owner')
const reader = () => principal(READER, 'admin')

const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  kernel.database.withWorkspace(WS, fn, { userId: OWNER })

/** A DENY of `quire.page.view` on one page, which is the narrowest binding the model has. */
function denyPage(userId: string, pageId: string) {
  bindings.set(userId, [
    {
      subjectType: 'user',
      subjectId: userId,
      permissions: ['quire.page.view'],
      scopeKind: 'object',
      scopeId: pageId,
      deny: true,
    },
  ])
}

/**
 * The live document behind a page, as real Yjs bytes.
 *
 * Bytes rather than a placeholder string, and that is load-bearing rather than tidy. `include-page`
 * and `excerpt-include` both go through `pageDocFromBase64`, which returns null for anything that is
 * not a decodable document — so a page with no *readable* body resolves to nothing **whatever the
 * permission check decides**, and a test asserting only that a denied page draws nothing then passes
 * against a resolver with no permission check in it at all. That is not a hypothetical: these two
 * assertions were written against a stub string and survived deleting the gate. A negative is only
 * evidence when the positive it mirrors is proved beside it.
 */
const documents = new Map<string, Buffer>()

function registerStubs(k: Kernel) {
  const b64 = (v: Buffer) => v.toString('base64')
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
        return { snapshot: b64(documents.get(input.name)!), state: b64(documents.get(input.name)!) }
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
    'settings.getModule': { handler: async () => ({}) },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId) },
    'users.list': {
      handler: async (input: { ids?: string[] }) =>
        (input.ids ?? []).map((id) => ({
          id,
          name: id === OWNER ? 'Ada Owner' : 'Bob Reader',
          email: `${id}@example.test`,
          avatarUrl: null,
        })),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': {
      handler: async (input: { userId?: string }) => bindings.get(input.userId ?? '') ?? [],
    },
  })
}

/** Titles chosen so a substring search cannot match them by accident. */
const TITLES = {
  parent: 'Zephyr parent handbook',
  open: 'Quokka open child',
  secret: 'Basilisk restricted child',
  deeper: 'Wombat grandchild',
  elsewhere: 'Narwhal other branch',
}

const fx = {
  spaceId: '',
  spaceKey: '',
  parent: '',
  open: '',
  secret: '',
  /** a child of the restricted page: private by inheritance, and the reason a prune is not a filter */
  deeper: '',
  elsewhere: '',
}

const makePage = (over: Record<string, unknown>) =>
  run((tx) =>
    svc.pages.create(tx, owner(), WS, {
      spaceId: fx.spaceId,
      parentId: null,
      title: 'Untitled',
      kind: 'page',
      icon: null,
      afterId: null,
      ...over,
    } as never),
  )

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-macros-test',
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

  const space = await run((tx) =>
    svc.spaces.create(tx, owner(), WS, {
      key: 'MAC',
      name: 'Macros',
      description: '',
      icon: null,
      visibility: 'open',
    } as never),
  )
  fx.spaceId = space.id
  fx.spaceKey = space.key

  fx.parent = (await makePage({ title: TITLES.parent })).id
  fx.open = (await makePage({ parentId: fx.parent, title: TITLES.open })).id
  fx.secret = (await makePage({ parentId: fx.parent, title: TITLES.secret })).id
  fx.deeper = (await makePage({ parentId: fx.secret, title: TITLES.deeper })).id
  fx.elsewhere = (await makePage({ title: TITLES.elsewhere })).id

  /*
   * Something to excerpt and something to include, on both children — and a real body for each,
   * because a page with nothing readable in it resolves to nothing for reasons that have nothing to
   * do with permissions. The two are deliberately symmetrical: every assertion that the restricted
   * page draws nothing has a twin asserting the open page draws something, so a resolver that
   * simply stopped working could not pass the file.
   */
  for (const [id, word] of [
    [fx.open, 'quokka'],
    [fx.secret, 'basilisk'],
  ] as const) {
    await run((tx) =>
      tx
        .update(pages)
        .set({ text: `${word} prose that a macro could repeat` })
        .where(eqPage(id)),
    )
    documents.set(
      documentNameOf({ workspaceId: WS, id }),
      pageDocToYState({
        type: 'doc',
        content: [
          {
            type: 'excerpt',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `${word} marked extract` }] }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: `${word} body paragraph` }] },
        ],
      }),
    )
  }
}, 120_000)

const eqPage = (id: string) => and(eq(pages.workspaceId, WS), eq(pages.id, id))

afterAll(async () => {
  await kernel?.stop()
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`)
  await admin.end()
})

/** A page whose whole body is one macro, which is what makes the assertions unambiguous. */
const macroDoc = (type: string, attrs: Record<string, unknown>): PageDoc => ({
  type: 'doc',
  content: [{ type, attrs }],
})

const childrenOf = (pageId: string | null) =>
  macroDoc('pageChildren', { pageId, depth: 2, sort: 'position', showExcerpt: true })

/** Render `doc` as the page `on`, for a signed-in reader. */
const forReader = (doc: PageDoc, on: string, who: Principal = reader()) =>
  run(async (tx) =>
    renderPageDoc(doc, {
      macros: await svc.macros.resolve(tx, WS, doc, { kind: 'reader', principal: who }, { pageId: on }),
    }),
  )

/** Render `doc` as the page `on`, for a published site whose reachable pages are `pageIds`. */
const forPublication = (doc: PageDoc, on: string, pageIds: string[]) =>
  run(async (tx) =>
    renderPageDoc(doc, {
      macros: await svc.macros.resolve(
        tx,
        WS,
        doc,
        { kind: 'publication', pageIds: new Set(pageIds) },
        { pageId: on },
      ),
    }),
  )

describe('a macro with no resolver at all', () => {
  /**
   * The default every caller written before this feature existed already passes.
   *
   * `versions.html` at publish time, the Markdown and HTML exporters, a search preview — none of
   * them knows what a macro is, and none of them should have to. A reading macro with nothing to
   * read draws its frame; it does not go and find something.
   */
  it.each([
    ['pageChildren', { pageId: null, depth: 2, sort: 'position', showExcerpt: true }],
    ['excerptInclude', { pageId: null }],
    ['includePage', { pageId: null }],
    ['recentlyUpdated', { scope: 'space', pageId: null, limit: 10 }],
    ['contributors', { limit: 10 }],
  ])('draws %s as an empty frame rather than reading anything', (type, attrs) => {
    const html = renderPageDoc(macroDoc(type, { ...attrs, pageId: fx.parent }))
    expect(html).toContain('data-macro=')
    for (const title of Object.values(TITLES)) expect(html).not.toContain(title)
  })

  it('is what an unresolved macro looks like even when the page is full of them', () => {
    const html = renderPageDoc({
      type: 'doc',
      content: [
        { type: 'pageChildren', attrs: { pageId: fx.parent, depth: 2 } },
        { type: 'paragraph', content: [{ type: 'text', text: 'between' }] },
        { type: 'includePage', attrs: { pageId: fx.secret } },
      ],
    })
    expect(html).toContain('between')
    for (const title of Object.values(TITLES)) expect(html).not.toContain(title)
  })
})

describe('a children macro, for a signed-in reader', () => {
  it('names a child the reader may open', async () => {
    bindings.clear()
    const html = await forReader(childrenOf(fx.parent), fx.parent)
    expect(html).toContain(TITLES.open)
    expect(html).toContain(TITLES.secret)
  })

  /** The assertion this whole file exists for. */
  it('does not name a child the reader is denied, at render time', async () => {
    denyPage(READER, fx.secret)
    const html = await forReader(childrenOf(fx.parent), fx.parent)
    bindings.clear()
    expect(html).toContain(TITLES.open)
    expect(html, 'a denied page reached a children macro').not.toContain(TITLES.secret)
  })

  /**
   * A prune, not a filter — the same rule the public walk keeps.
   *
   * Removing a page from the list and then listing its children anyway would leave every page under
   * it named by whoever guessed there was something there, which is exactly the shape the
   * publication walk exists to avoid.
   */
  it('takes the descendants of a denied page with it', async () => {
    denyPage(READER, fx.secret)
    const html = await forReader(childrenOf(fx.parent), fx.parent)
    bindings.clear()
    expect(html).not.toContain(TITLES.secret)
    expect(html, 'a grandchild survived its denied parent').not.toContain(TITLES.deeper)
  })

  it('never names a page outside the branch it was asked about', async () => {
    bindings.clear()
    const html = await forReader(childrenOf(fx.parent), fx.parent)
    expect(html).not.toContain(TITLES.elsewhere)
  })
})

describe('a children macro, on a published site', () => {
  /**
   * There is no principal here, so there is nothing to ask. The set of publicly reachable pages —
   * which the publication walk already computes, root first, pruned — is the whole of what exists.
   */
  it('names only what the publication reaches', async () => {
    const html = await forPublication(childrenOf(fx.parent), fx.parent, [fx.parent, fx.open])
    expect(html).toContain(TITLES.open)
    expect(html, 'a page outside the publication reached a public page').not.toContain(TITLES.secret)
    expect(html).not.toContain(TITLES.deeper)
  })

  it('draws an empty frame when the publication reaches nothing below this page', async () => {
    const html = await forPublication(childrenOf(fx.parent), fx.parent, [fx.parent])
    for (const title of Object.values(TITLES)) expect(html).not.toContain(title)
  })
})

describe('the macros that repeat another page', () => {
  /**
   * The positives, and they are the reason the negatives below mean anything.
   *
   * Both of these macros resolve through `pageDocFromBase64`, so an unreadable body draws an empty
   * frame no matter what the permission check says. Asserting only that a denied page draws nothing
   * would therefore pass against a resolver with the gate deleted — which is exactly what these two
   * assertions did before the fixture gave each page a real document.
   */
  it('excerpt-include draws the marked extract of a page the reader may open', async () => {
    bindings.clear()
    const html = await forReader(macroDoc('excerptInclude', { pageId: fx.open }), fx.parent)
    expect(html).toContain('quokka marked extract')
    expect(html).toContain(TITLES.open)
  })

  it('include-page draws the body of a page the reader may open', async () => {
    bindings.clear()
    const html = await forReader(macroDoc('includePage', { pageId: fx.open }), fx.parent)
    expect(html).toContain('quokka body paragraph')
    expect(html).toContain(TITLES.open)
  })

  it('excerpt-include draws nothing at all for a page the reader is denied', async () => {
    denyPage(READER, fx.secret)
    const html = await forReader(macroDoc('excerptInclude', { pageId: fx.secret }), fx.parent)
    bindings.clear()
    expect(html).not.toContain(TITLES.secret)
    expect(html).not.toContain('basilisk')
  })

  it('include-page draws nothing at all for a page the reader is denied', async () => {
    denyPage(READER, fx.secret)
    const html = await forReader(macroDoc('includePage', { pageId: fx.secret }), fx.parent)
    bindings.clear()
    expect(html).not.toContain(TITLES.secret)
    expect(html).not.toContain('basilisk')
  })

  it('include-page draws nothing for a page outside the publication', async () => {
    const html = await forPublication(macroDoc('includePage', { pageId: fx.secret }), fx.parent, [
      fx.parent,
      fx.open,
    ])
    expect(html).not.toContain(TITLES.secret)
    expect(html).not.toContain('basilisk')
  })
})

describe('recently updated', () => {
  it('omits a page the reader is denied', async () => {
    denyPage(READER, fx.secret)
    const html = await forReader(
      macroDoc('recentlyUpdated', { scope: 'space', pageId: null, limit: 25 }),
      fx.parent,
    )
    bindings.clear()
    expect(html).toContain(TITLES.open)
    expect(html).not.toContain(TITLES.secret)
  })

  it('omits every page the publication does not reach', async () => {
    const html = await forPublication(
      macroDoc('recentlyUpdated', { scope: 'space', pageId: null, limit: 25 }),
      fx.parent,
      [fx.parent, fx.open],
    )
    expect(html).toContain(TITLES.open)
    expect(html).not.toContain(TITLES.secret)
    expect(html).not.toContain(TITLES.elsewhere)
  })
})

describe('contributors', () => {
  it('names the people who wrote the page, for a reader who may read it', async () => {
    bindings.clear()
    const html = await forReader(macroDoc('contributors', { limit: 10 }), fx.parent)
    expect(html).toContain('Ada Owner')
  })

  /**
   * The decision, stated so it is a decision rather than an omission.
   *
   * Every other public response in this module is scrubbed of anything identifying a person — see
   * the note at the top of `publications.ts`. A page's authors are the customer's staff, not the
   * page's content: somebody who wants a byline on a published page writes one. So this macro
   * resolves to nobody on a published site, and does it by having no publication branch at all
   * rather than by returning an empty list from one.
   */
  it('names nobody on a published site', async () => {
    const html = await forPublication(macroDoc('contributors', { limit: 10 }), fx.parent, [fx.parent])
    expect(html).not.toContain('Ada Owner')
    expect(html).not.toContain('Bob Reader')
  })
})
