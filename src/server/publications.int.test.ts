/**
 * The public surface, tested as somebody trying to get at what it is not offering.
 *
 * `/api/quire/public/*` is the only endpoint in Kern with no principal behind it, which means every
 * habit the rest of the codebase relies on is gone at once: there is no `requires()` to forget, no
 * page-scoped binding to lean on, and row-level security fences the *workspace* — which on this
 * path is set by the handler itself and therefore fences nothing an attacker cares about. What
 * stands in its place is that every query carries the **publication**, and the only thing that can
 * hold that is a test which goes looking for the pages the publication does not cover.
 *
 * So this file is written from the outside. It builds one space containing a published site and,
 * around it, every page that must not be reachable — opted out, under something opted out,
 * archived, trashed, never published, under something never published, a sibling of the root, a
 * page in another space, a page in another workspace — and asks the public API for each of them by
 * every address it could have. The answer is **404 every time, never 403**: telling a stranger
 * "that exists and you may not have it" is the confirmation the whole surface is built to withhold.
 *
 * The last two describes are the ones that catch what reading the code does not. One walks every
 * public response looking for an identifier of anything in the fixture, because a leak here is
 * rarely a page body — it is an id in a nav entry that somebody then tries somewhere else. The
 * other connects as a role that cannot bypass row-level security, because the development and CI
 * roles are superusers and a policy proves nothing against a superuser.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { ANONYMOUS, type Principal } from '@kernhq/contracts'
import { createKernel, KernError, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { call } from '@orpc/server'
import { and, eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PublicPage, PublicSite, Space } from '../contract/index.js'
import { implement_ } from './_impl.js'
import { pageDocToYState } from './import/ydoc.js'
import { quireModule } from './index.js'
import { pages, pageVersions } from './schema.js'
import { type QuireServices, quireServices } from './services/index.js'
import { publicHtml, slugifyTitle, withPaths } from './services/publications.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_public_${Date.now().toString(36)}`
const RLS_ROLE = `kern_quire_pub_rls_${Date.now().toString(36)}`

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let restricted: pg.Pool | null = null
let databaseUrl: string
let router: ReturnType<typeof implement_>
/** Flipped by one test, so a workspace that has switched Quire off can be observed going dark. */
let moduleEnabled = true

const principal = (userId: string, workspaceId: string): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role: 'owner', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const alice = () => principal(ALICE, WS_A)
const inWs =
  (workspaceId: string) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: ALICE })
const run = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS_A)(fn)

const context = (who: Principal): RequestContext => ({
  kernel,
  principal: who,
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

const procedureAt = (name: string): unknown =>
  name
    .split('.')
    .reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      router as unknown as Record<string, unknown>,
    )

/** Every call in this file goes through the router, as a stranger, unless it says otherwise. */
const ask = (name: string, input: Record<string, unknown>, who: Principal = ANONYMOUS) =>
  // biome-ignore lint/suspicious/noExplicitAny: the router is walked as data, so the leaf is untyped
  call(procedureAt(name) as any, input as any, { context: context(who) })

const codeOf = (err: unknown) => (err instanceof KernError ? err.code : `${(err as Error)?.name}`)
const refusalFor = (name: string, input: Record<string, unknown>) =>
  ask(name, input).then(
    () => 'succeeded',
    (err) => codeOf(err),
  )

/**
 * A page's live document. A string for the pages whose prose nothing reads, real Yjs bytes for the
 * one carrying a macro — `pageDocFromState` returns null for anything else, and a macro on a page
 * with an unreadable body resolves to nothing for reasons that have nothing to do with publication.
 */
const documents = new Map<string, string | Buffer>()
function registerStubs(k: Kernel) {
  const b64 = (v: string | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(v)).toString('base64')
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
    'modules.isEnabled': { handler: async () => moduleEnabled },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId, WS_A) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
    'files.get': {
      handler: async (input: { id: string }) =>
        input.id === FILE_ID || input.id === UNUSED_FILE_ID
          ? {
              id: input.id,
              key: `ws/${WS_A}/quire/2026/08/${input.id}/office-plan.png`,
              mimeType: 'image/png',
            }
          : null,
    },
  })
}

/**
 * A file store that holds exactly the fixture's picture.
 *
 * Standing in for S3 rather than running one: what is under test is which references resolve and
 * which do not, and every one of those decisions is made before a byte is read. The bytes matter
 * only so that "it served the picture" is distinguishable from "it served nothing".
 */
function stubStorage(k: Kernel) {
  const known = new Set([
    `ws/${WS_A}/quire/2026/08/${FILE_ID}/office-plan.png`,
    `ws/${WS_A}/quire/2026/08/${UNUSED_FILE_ID}/office-plan.png`,
  ])
  Object.assign(k.storage, {
    head: async (key: string) =>
      known.has(key) ? { contentLength: PICTURE.length, contentType: 'image/png' } : null,
    get: async (key: string) => {
      if (!known.has(key)) throw new Error('no such object')
      return { body: Readable.from([PICTURE]), contentType: 'image/png', contentLength: PICTURE.length }
    },
  })
}

/** A pool under a role that can neither bypass row-level security nor own the tables. */
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

/**
 * Every page in the fixture, and what it is there to prove.
 *
 * The private ones are not decoration: each is a different way a page can be inside a published
 * subtree and still not be public, and each has its own assertion below.
 */
const fx = {
  spaceId: '',
  otherSpaceId: '',
  /** the publication's root */
  root: '',
  /** an ordinary published child, and its published child */
  child: '',
  grandchild: '',
  /** published, and marked "never public" */
  excluded: '',
  /** published and *not* excluded — but its parent is, so it must be pruned with it */
  excludedChild: '',
  archived: '',
  trashed: '',
  /** never published, so nothing to serve — and its published child is unreachable through it */
  unpublished: '',
  orphan: '',
  /** a published page beside the root rather than under it */
  sibling: '',
  /** a published page in a different space of the same workspace */
  otherSpacePage: '',
  /** the whole of workspace B */
  otherWorkspacePage: '',
  /** the page whose HTML carries the mentions the scrub has to deal with */
  mentions: '',
  /** the page carrying a children macro, which is the only page here that lists other pages */
  contents: '',
  /** the page whose HTML carries a picture reference and a signed URL left over from 0.12.0 */
  pictured: '',
  /** the root of a publication that was gutted after the fact: the row survives, the site does not */
  guttedRoot: '',
  publicationId: '',
  guttedPublicationId: '',
  lockedPublicationId: '',
  expiredPublicationId: '',
  otherWorkspacePublicationId: '',
  rootVersionId: '',
}

const SLUG = 'handbook'
const LOCKED_SLUG = 'locked-handbook'
const EXPIRED_SLUG = 'expired-handbook'
const GUTTED_SLUG = 'gutted-handbook'
const PASSWORD = 'a-long-enough-password'

/**
 * A picture on a published page, and one that was drawn before there was a safe way to draw one.
 *
 * `FILE_ID` is referenced by the published version, so it is servable. `UNUSED_FILE_ID` is a real
 * file in the same workspace that no published page mentions, which is the case that proves the
 * reference is not a bearer token for the whole file store. `LEGACY_SIGNED` is the exact shape
 * 0.12.0 stored: the object key, carrying the workspace and file uuids, with an hour on it.
 */
const FILE_ID = '01920000-0000-7000-8000-0000000000bb'
const UNUSED_FILE_ID = '01920000-0000-7000-8000-0000000000cc'
const LEGACY_FILE_ID = '01920000-0000-7000-8000-0000000000dd'
const PICTURE = Buffer.from('bytes that stand in for a png')
/** Mirrors `UNLOCK_ATTEMPTS` in the service; a fence nobody can state a number for is not a fence. */
const UNLOCK_ATTEMPTS_EXPECTED = 10
const legacySignedUrl = (workspaceId: string, fileId: string) =>
  `http://localhost:9000/kern/ws/${workspaceId}/quire/2026/08/${fileId}/office-plan.png` +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Expires=3600&amp;X-Amz-Signature=deadbeef'

const page = (over: Record<string, unknown> & { spaceId: string }) =>
  kernel.database.withWorkspace(
    (over.workspaceId as string) ?? WS_A,
    (tx) =>
      svc.pages.create(tx, alice(), (over.workspaceId as string) ?? WS_A, {
        parentId: null,
        title: 'Untitled',
        kind: 'page',
        icon: null,
        afterId: null,
        ...over,
      } as never),
    { userId: ALICE },
  )

/**
 * Publish a page for real: capture a version, pin it, render it.
 *
 * `doc` gives the page a real body rather than a stand-in string, which only the macro page needs —
 * and needs absolutely, because the publish-time render stores what `renderPageDoc` makes of it.
 */
async function publish(pageId: string, workspaceId = WS_A, doc?: PageDoc): Promise<string> {
  documents.set(`ws:${workspaceId}:quire:page:${pageId}`, doc ? pageDocToYState(doc) : `prose of ${pageId}`)
  return kernel.database.withWorkspace(
    workspaceId,
    async (tx) => {
      const row = await svc.versions.publish(tx, principal(ALICE, workspaceId), workspaceId, pageId, null)
      await svc.publications.renderVersion(tx, workspaceId, row.publishedVersionId!)
      return row.publishedVersionId!
    },
    { userId: ALICE },
  )
}

/** Put known HTML and known prose on a pinned version, so the scrub and the search have a target. */
const setVersion = (versionId: string, patch: { html?: string; text?: string }, workspaceId = WS_A) =>
  kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .update(pageVersions)
      .set(patch)
      .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.id, versionId))),
  )

const publication = (
  workspaceId: string,
  rootPageId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string }> =>
  kernel.database.withWorkspace(
    workspaceId,
    (tx) =>
      svc.publications.create(tx, principal(ALICE, workspaceId), workspaceId, {
        rootPageId,
        slug: SLUG,
        includeDescendants: true,
        password: null,
        expiresAt: null,
        seoTitle: '',
        seoDescription: '',
        ogImageUrl: null,
        indexable: true,
        theme: 'auto',
        ...over,
      } as never),
    { userId: ALICE },
  )

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'quire-public-test',
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
  stubStorage(kernel)
  await kernel.start()
  svc = quireServices(kernel)
  router = implement_(kernel)

  const space: Space = await run((tx) =>
    svc.spaces.create(tx, alice(), WS_A, {
      key: 'handbook',
      name: 'Handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  fx.spaceId = space.id
  const other: Space = await run((tx) =>
    svc.spaces.create(tx, alice(), WS_A, {
      key: 'internal',
      name: 'Internal',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  fx.otherSpaceId = other.id

  fx.root = (await page({ spaceId: space.id, title: 'Handbook' })).id
  fx.child = (await page({ spaceId: space.id, parentId: fx.root, title: 'Getting started' })).id
  fx.grandchild = (await page({ spaceId: space.id, parentId: fx.child, title: 'Installing' })).id
  fx.mentions = (await page({ spaceId: space.id, parentId: fx.root, title: 'Links' })).id
  fx.contents = (await page({ spaceId: space.id, parentId: fx.root, title: 'Contents' })).id
  fx.pictured = (await page({ spaceId: space.id, parentId: fx.root, title: 'Office' })).id
  fx.guttedRoot = (await page({ spaceId: space.id, title: 'Gutted' })).id
  fx.excluded = (await page({ spaceId: space.id, parentId: fx.root, title: 'Salaries' })).id
  fx.excludedChild = (await page({ spaceId: space.id, parentId: fx.excluded, title: 'Band 5' })).id
  fx.archived = (await page({ spaceId: space.id, parentId: fx.root, title: 'Old policy' })).id
  fx.trashed = (await page({ spaceId: space.id, parentId: fx.root, title: 'Redundancy plan' })).id
  fx.unpublished = (await page({ spaceId: space.id, parentId: fx.root, title: 'Draft section' })).id
  fx.orphan = (await page({ spaceId: space.id, parentId: fx.unpublished, title: 'Orphan' })).id
  fx.sibling = (await page({ spaceId: space.id, title: 'Beside the handbook' })).id
  fx.otherSpacePage = (await page({ spaceId: other.id, title: 'Internal only' })).id

  // Everything except `unpublished` is published, so "not public" is never merely "not published".
  fx.rootVersionId = await publish(fx.root)
  const childVersion = await publish(fx.child)
  await publish(fx.grandchild)
  const mentionsVersion = await publish(fx.mentions)
  const picturedVersion = await publish(fx.pictured)
  /*
   * The macro page, published with a real body and left with the HTML the publish produced.
   *
   * Every other page here has its stored HTML overwritten by `setVersion`; this one must not be,
   * because what the publish-time render *wrote* is half of what the macro tests assert — an empty
   * frame, resolved against nobody, which is the state a stored public page has to be in.
   */
  await publish(fx.contents, WS_A, {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Everything in this handbook:' }] },
      { type: 'pageChildren', attrs: { pageId: fx.root, depth: 1, sort: 'title' } },
    ],
  })
  const guttedVersion = await publish(fx.guttedRoot)
  await setVersion(guttedVersion, { html: '<p>Nothing left.</p>', text: 'nothing left' })

  /*
   * Every private page gets a word of its own in its *published* text.
   *
   * Without it "search did not find the salary page" is satisfied by there being nothing to find,
   * and the assertion passes against a search that would happily have returned it. Each word is a
   * single token nothing public contains, so a hit for one is a hit on that page and nothing else.
   */
  for (const [pageId, word] of [
    [fx.excluded, 'wordexcluded'],
    [fx.excludedChild, 'wordexcludedchild'],
    [fx.archived, 'wordarchived'],
    [fx.trashed, 'wordtrashed'],
    [fx.orphan, 'wordorphan'],
    [fx.sibling, 'wordsibling'],
    [fx.otherSpacePage, 'wordotherspace'],
  ] as Array<[string, string]>)
    await setVersion(await publish(pageId), { html: `<p>${word}</p>`, text: `${word} and nothing else` })

  await run((tx) => svc.publications.setExcluded(tx, WS_A, fx.excluded, true))
  await run((tx) => svc.pages.archive(tx, alice(), WS_A, fx.archived, true))
  await run((tx) => svc.pages.trashPage(tx, WS_A, fx.trashed))

  await setVersion(fx.rootVersionId, {
    html: '<h1>Handbook</h1><p>Everything about how we work.</p>',
    text: 'Handbook. Everything about how we work.',
  })
  await setVersion(childVersion, {
    html: '<p>Install it first.</p>',
    text: 'Install it first. The published copy says installation.',
  })
  /*
   * What `versions.html` really writes: a page mention is an anchor into the application carrying
   * the mentioned page's id, and it writes one whether or not the reader may open that page. Two of
   * them here — one to a page inside this publication, one to a page that is opted out — plus a
   * user mention, a block id, and a code block whose *text* looks like markup.
   */
  await setVersion(mentionsVersion, {
    html:
      `<p id="blk-1">See <a class="kern-page-mention" href="/quire/handbook/${fx.child}" ` +
      `data-type="pageMention" data-id="${fx.child}">Getting started</a> and ` +
      `<a class="kern-page-mention" href="/quire/handbook/${fx.excluded}" data-type="pageMention" ` +
      `data-id="${fx.excluded}">Salaries</a>, asked by ` +
      `<span class="kern-mention" data-type="mention" data-id="${ALICE}">@alice</span>.</p>` +
      `<pre><code>&lt;p id=&quot;kept&quot;&gt;</code></pre>`,
    text: 'See Getting started and Salaries.',
  })
  /*
   * What a published page looks like with pictures on it, in both shapes at once.
   *
   * The first is what the renderer writes now — a reference that names nothing on its own. The
   * second is what 0.12.0 wrote and stored: the object key, with the workspace uuid and a file uuid
   * in it, and a signature that stopped working an hour after publication. Both are here so the
   * assertions can say which of the two reaches a stranger.
   */
  await setVersion(picturedVersion, {
    html:
      `<p><img src="/__quire-asset/${FILE_ID}" alt="Office plan" loading="lazy"></p>` +
      `<p><img src="${legacySignedUrl(WS_A, LEGACY_FILE_ID)}" alt="Old plan"></p>`,
    text: 'officeplanpicture',
  })

  fx.publicationId = (await publication(WS_A, fx.root)).id
  /*
   * A publication whose root is trashed *after* it is made. Nothing about the row says so — only
   * the walk does — which is what made this the state four handlers forgot to have an answer for.
   */
  fx.guttedPublicationId = (await publication(WS_A, fx.guttedRoot, { slug: GUTTED_SLUG })).id
  await run((tx) => svc.pages.trashPage(tx, WS_A, fx.guttedRoot))
  fx.lockedPublicationId = (await publication(WS_A, fx.root, { slug: LOCKED_SLUG, password: PASSWORD })).id
  fx.expiredPublicationId = (
    await publication(WS_A, fx.root, {
      slug: EXPIRED_SLUG,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
  ).id

  // A second workspace, with a page of its own published under exactly the same slug.
  const otherSpace: Space = await inWs(WS_B)((tx) =>
    svc.spaces.create(tx, principal(ALICE, WS_B), WS_B, {
      key: 'handbook',
      name: 'Their handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  fx.otherWorkspacePage = (
    await page({ spaceId: otherSpace.id, workspaceId: WS_B, title: 'Their handbook' })
  ).id
  const otherVersion = await publish(fx.otherWorkspacePage, WS_B)
  await setVersion(otherVersion, { html: '<p>Belongs to workspace B.</p>', text: 'workspace B' }, WS_B)
  fx.otherWorkspacePublicationId = (await publication(WS_B, fx.otherWorkspacePage)).id
}, 180_000)

afterAll(async () => {
  await restricted?.end().catch(() => undefined)
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

const site = (over: Record<string, unknown> = {}) =>
  ask('public.site', { workspaceId: WS_A, slug: SLUG, ...over }) as Promise<PublicSite>
const publicPage = (path: string, over: Record<string, unknown> = {}) =>
  ask('public.page', { workspaceId: WS_A, slug: SLUG, path, ...over }) as Promise<PublicPage>

describe('what a published site is', () => {
  it('serves the root, its published descendants, and nothing else', async () => {
    const answer = await site()
    expect(answer.locked).toBe(false)
    expect(answer.site?.nav.map((n) => n.path).sort()).toEqual(
      ['', 'contents', 'getting-started', 'getting-started/installing', 'links', 'office'].sort(),
    )
  })

  it('addresses the front page as the empty path and serves its published HTML', async () => {
    const answer = await publicPage('')
    expect(answer.path).toBe('')
    expect(answer.html).toContain('Everything about how we work')
    expect(answer.breadcrumbs).toEqual([])
  })

  it('gives a nested page a breadcrumb trail of paths', async () => {
    const answer = await publicPage('getting-started/installing')
    expect(answer.breadcrumbs.map((b) => b.path)).toEqual(['', 'getting-started'])
  })

  it('reports when a page was published, not when its draft was last touched', async () => {
    // `pages.updated_at` moves on every keystroke in the draft. Publishing it would tell the
    // internet when somebody was working on a change they have not published.
    const before = await publicPage('')
    await run((tx) =>
      tx
        .update(pages)
        .set({ updatedAt: new Date(Date.now() + 86_400_000), title: 'Handbook' })
        .where(and(eq(pages.workspaceId, WS_A), eq(pages.id, fx.root))),
    )
    const after = await publicPage('')
    expect(after.publishedAt).toBe(before.publishedAt)
  })

  it('validates the cache tag against the pinned version without being the version id', async () => {
    const answer = await publicPage('')
    expect(answer.etag.length).toBeGreaterThan(8)
    expect(answer.etag).not.toContain(fx.rootVersionId)
  })
})

/**
 * A macro that lists other pages, on a page with no reader at all.
 *
 * This is the worst thing this slice could ship, so it is asserted from the outside like everything
 * else in this file: a children macro on a published page draws the pages under the handbook, and
 * `Salaries` is one of them. It is published, it is in the subtree, and it is marked never public —
 * so it appears in the macro's *source* and must not appear in its output. A resolver that filtered
 * nothing would put the word "Salaries" on the open internet, under a heading inviting people to
 * read it, and nothing else in this file would notice: the page is 404 by its own address, and the
 * navigation and the search already refuse it.
 *
 * The two halves are asserted separately because they fail separately. The **stored** HTML must
 * hold an empty frame — resolving at publish time would freeze today's titles into a row that is
 * served for ever, including after those pages stop being public — and the **served** HTML must
 * hold the answer, resolved against this publication as it is at the moment of reading.
 */
describe('a macro on a published page', () => {
  const storedHtml = () =>
    run(async (tx) => {
      const [row] = await tx
        .select({ html: pageVersions.html })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, WS_A), eq(pageVersions.pageId, fx.contents)))
        .limit(1)
      return row?.html ?? ''
    })

  it('stores an empty frame at publish time rather than a list of titles', async () => {
    const html = await storedHtml()
    expect(html, 'the publish-time render did not draw the macro at all').toContain('data-macro="children"')
    for (const title of ['Getting started', 'Salaries', 'Old policy', 'Draft section'])
      expect(html, `${title} was resolved into stored HTML`).not.toContain(title)
  })

  it('names the pages the publication reaches, when a stranger reads it', async () => {
    const answer = await publicPage('contents')
    expect(answer.html).toContain('Getting started')
    expect(answer.html).toContain('Links')
    expect(answer.html).toContain('Office')
  })

  /** The assertion the whole slice is judged by. */
  it('names no page the publication does not reach', async () => {
    const answer = await publicPage('contents')
    for (const [title, why] of [
      ['Salaries', 'a page marked never public'],
      ['Band 5', 'a page under one marked never public'],
      ['Old policy', 'an archived page'],
      ['Redundancy plan', 'a trashed page'],
      ['Draft section', 'a page that was never published'],
      ['Beside the handbook', 'a page outside the publication'],
      ['Internal only', 'a page in another space'],
    ] as Array<[string, string]>)
      expect(answer.html, `a macro named ${why} on a public site`).not.toContain(title)
  })

  /**
   * A macro's links go through the same rewrite every other internal link does.
   *
   * The resolver hands the renderer an in-app `/quire/-/<id>` address on purpose, because the public
   * scrub matches that shape and nothing else — a public path handed in early would be the one href
   * it does not recognise, and it would go out with a raw uuid in it. The sweep below covers this
   * too; it is stated here as well because that sweep would report it as "a public response carried
   * a uuid" rather than as the macro's own bug.
   */
  it('links a page it names by its public path, never by its id', async () => {
    const answer = await publicPage('contents')
    expect(answer.html).toContain('getting-started')
    expect(answer.html).not.toContain(fx.child)
    expect(answer.html).not.toContain('/quire/-/')
  })
})

/**
 * Rule 1 and rule 2, one assertion per way a page can fail to be public.
 *
 * Every one of these pages is published, in the same space, inside the publication's subtree, and
 * every one of them must be 404 — including by the path its title would have given it, which is the
 * address somebody who saw it in a search result or an old link would actually try.
 */
describe('the pages a publication does not cover', () => {
  const forbidden: Array<[string, () => string]> = [
    ['a page marked never public', () => slugifyTitle('Salaries')],
    ['a page under one marked never public', () => `${slugifyTitle('Salaries')}/${slugifyTitle('Band 5')}`],
    ['an archived page', () => slugifyTitle('Old policy')],
    ['a trashed page', () => slugifyTitle('Redundancy plan')],
    ['a page that has never been published', () => slugifyTitle('Draft section')],
    [
      'a published page under one that has never been published',
      () => `${slugifyTitle('Draft section')}/${slugifyTitle('Orphan')}`,
    ],
    ['a page beside the root rather than under it', () => slugifyTitle('Beside the handbook')],
    ['a page in another space', () => slugifyTitle('Internal only')],
  ]

  for (const [what, path] of forbidden) {
    it(`answers 404 for ${what}`, async () => {
      expect(await refusalFor('public.page', { workspaceId: WS_A, slug: SLUG, path: path() })).toBe(
        'NOT_FOUND',
      )
    })
  }

  it('never names one of them in the navigation', async () => {
    const answer = await site()
    const titles = (answer.site?.nav ?? []).map((n) => n.title)
    for (const hidden of [
      'Salaries',
      'Band 5',
      'Old policy',
      'Redundancy plan',
      'Draft section',
      'Orphan',
      'Beside the handbook',
      'Internal only',
    ])
      expect(titles, `the navigation named ${hidden}`).not.toContain(hidden)
  })

  it('answers 404 for a page id used as a path, which is the obvious thing to try', async () => {
    for (const id of [fx.excluded, fx.sibling, fx.otherSpacePage, fx.otherWorkspacePage, fx.root])
      expect(await refusalFor('public.page', { workspaceId: WS_A, slug: SLUG, path: id })).toBe('NOT_FOUND')
  })

  it('refuses to be walked out of the publication with a relative path', async () => {
    for (const path of ['../salaries', 'getting-started/../../salaries', '/salaries', '//salaries'])
      expect(await refusalFor('public.page', { workspaceId: WS_A, slug: SLUG, path })).toBe('NOT_FOUND')
  })

  /*
   * The workspace segment reaches the module's middleware before the contract has validated it, so
   * anything at all can arrive there. It must come back as the same 404 as a workspace with Quire
   * switched off — never as a 500, which is what a ZodError out of `isModuleEnabled` produced.
   */
  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['a uuid with a quote glued on', `${WS_A}'`],
    ['a space', ' '],
    ['empty', ''],
    ['the word null', 'null'],
    ['an integer', '1'],
  ])('answers 404, never 500, for a workspace segment that is %s', async (_why, workspaceId) => {
    for (const name of ['public.site', 'public.page', 'public.search', 'public.sitemap', 'public.robots'])
      expect(await refusalFor(name, { workspaceId, slug: SLUG, path: '', q: 'ab' })).toBe('NOT_FOUND')
  })
})

describe('one workspace cannot be read through another', () => {
  it('keeps the same slug in two workspaces pointing at two different sites', async () => {
    const a = await site()
    const b = (await ask('public.site', { workspaceId: WS_B, slug: SLUG })) as PublicSite
    expect(a.site?.title).toBe('Handbook')
    expect(b.site?.title).toBe('Their handbook')
    expect(b.site?.nav.map((n) => n.title)).toEqual(['Their handbook'])
  })

  it('answers 404 for a workspace that has no such publication', async () => {
    expect(await refusalFor('public.site', { workspaceId: randomUUID(), slug: SLUG })).toBe('NOT_FOUND')
    expect(await refusalFor('public.site', { workspaceId: WS_B, slug: LOCKED_SLUG })).toBe('NOT_FOUND')
  })

  it('goes dark for a workspace that has switched the module off', async () => {
    moduleEnabled = false
    // The kernel caches "is this module on" for a TTL, so flipping the stub is not enough — the
    // first version of this test passed the answer straight from the cache and asserted nothing.
    kernel.settings.invalidate(WS_A)
    try {
      // 404 rather than MODULE_DISABLED: a stranger asking for a URL is owed "there is nothing
      // here", not "there is something here that this customer has turned off".
      expect(await refusalFor('public.site', { workspaceId: WS_A, slug: SLUG })).toBe('NOT_FOUND')
    } finally {
      moduleEnabled = true
      kernel.settings.invalidate(WS_A)
    }
  })
})

describe('an expired publication', () => {
  it('is 404 on every read, checked on the request rather than by a sweep', async () => {
    for (const [name, input] of [
      ['public.site', { workspaceId: WS_A, slug: EXPIRED_SLUG }],
      ['public.page', { workspaceId: WS_A, slug: EXPIRED_SLUG, path: '' }],
      ['public.search', { workspaceId: WS_A, slug: EXPIRED_SLUG, q: 'handbook' }],
      ['public.sitemap', { workspaceId: WS_A, slug: EXPIRED_SLUG }],
    ] as Array<[string, Record<string, unknown>]>)
      expect(await refusalFor(name, input), name).toBe('NOT_FOUND')
  })
})

describe('a password-protected publication', () => {
  it('answers a challenge and nothing else', async () => {
    const answer = (await ask('public.site', { workspaceId: WS_A, slug: LOCKED_SLUG })) as PublicSite
    expect(answer.locked).toBe(true)
    // Not even the table of contents: a nav tree is most of what a private handbook is.
    expect(answer.site).toBeNull()
    expect(JSON.stringify(answer)).not.toContain('Getting started')
  })

  it('answers 404 for its pages and its search until the password is presented', async () => {
    expect(await refusalFor('public.page', { workspaceId: WS_A, slug: LOCKED_SLUG, path: '' })).toBe(
      'NOT_FOUND',
    )
    expect(await refusalFor('public.search', { workspaceId: WS_A, slug: LOCKED_SLUG, q: 'handbook' })).toBe(
      'NOT_FOUND',
    )
  })

  it('refuses the wrong password without saying which part was wrong', async () => {
    expect(
      await refusalFor('public.unlock', {
        workspaceId: WS_A,
        slug: LOCKED_SLUG,
        password: 'not-the-password',
      }),
    ).toBe('UNAUTHORIZED')
  })

  it('opens with the right one, and the token is a capability rather than a session', async () => {
    const { token } = (await ask('public.unlock', {
      workspaceId: WS_A,
      slug: LOCKED_SLUG,
      password: PASSWORD,
    })) as { token: string }

    const opened = (await ask('public.site', {
      workspaceId: WS_A,
      slug: LOCKED_SLUG,
      token,
    })) as PublicSite
    expect(opened.locked).toBe(false)
    expect(opened.site?.nav.length).toBeGreaterThan(0)

    // Sealed with associated data naming this publication, so it opens nothing else — which is what
    // makes it a capability. There is no server-side record to look it up in.
    expect(await refusalFor('public.page', { workspaceId: WS_A, slug: SLUG, path: '' })).not.toBe('NOT_FOUND')
    const elsewhere = (await ask('public.site', {
      workspaceId: WS_A,
      slug: LOCKED_SLUG,
      token: `${token.slice(0, -4)}AAAA`,
    })) as PublicSite
    expect(elsewhere.locked, 'a tampered token opened the door').toBe(true)
  })

  it('has no password-hash-shaped string anywhere in any answer', async () => {
    const answers = JSON.stringify([
      await ask('public.site', { workspaceId: WS_A, slug: LOCKED_SLUG }),
      await ask('public.robots', { workspaceId: WS_A, slug: LOCKED_SLUG }),
    ])
    expect(answers).not.toContain('$scrypt$')
  })

  it('is left out of its own sitemap, and told not to be indexed', async () => {
    const map = (await ask('public.sitemap', { workspaceId: WS_A, slug: LOCKED_SLUG })) as {
      entries: unknown[]
    }
    expect(map.entries).toEqual([])
    expect(await ask('public.robots', { workspaceId: WS_A, slug: LOCKED_SLUG })).toEqual({
      indexable: false,
      sitemapPath: null,
    })
  })
})

describe('robots, which must not become the oracle the rest of the surface refuses to be', () => {
  it('answers the same for a slug that does not exist, one that expired, and one behind a door', async () => {
    const shut = { indexable: false, sitemapPath: null }
    expect(await ask('public.robots', { workspaceId: WS_A, slug: 'never-taken' })).toEqual(shut)
    expect(await ask('public.robots', { workspaceId: WS_A, slug: EXPIRED_SLUG })).toEqual(shut)
    expect(await ask('public.robots', { workspaceId: WS_A, slug: LOCKED_SLUG })).toEqual(shut)
    expect(await ask('public.robots', { workspaceId: WS_A, slug: SLUG })).toEqual({
      indexable: true,
      sitemapPath: 'sitemap.xml',
    })
  })
})

describe('search inside a publication', () => {
  it('finds the published prose', async () => {
    const found = (await ask('public.search', {
      workspaceId: WS_A,
      slug: SLUG,
      q: 'installation',
    })) as { items: Array<{ path: string; snippet: string }> }
    expect(found.items.map((i) => i.path)).toContain('getting-started')
    expect(found.items[0]?.snippet).toContain('installation')
  })

  it('does not read the draft, which is the one place the two copies differ', async () => {
    // `pages.text` mirrors the live document. A search that read it would put a sentence nobody has
    // published into a snippet on the public internet.
    const secret = 'weusethiswordonlyinthedraft'
    await run((tx) =>
      tx
        .update(pages)
        .set({ text: `${secret} and nothing else` })
        .where(and(eq(pages.workspaceId, WS_A), eq(pages.id, fx.child))),
    )
    const found = (await ask('public.search', { workspaceId: WS_A, slug: SLUG, q: secret })) as {
      items: unknown[]
    }
    expect(found.items).toEqual([])
  })

  it('cannot be steered out of the publication', async () => {
    // Each of these words is in exactly one private page's *published* text, so an empty result is
    // evidence rather than the absence of it.
    for (const q of [
      'wordexcluded',
      'wordexcludedchild',
      'wordarchived',
      'wordtrashed',
      'wordorphan',
      'wordsibling',
      'wordotherspace',
    ]) {
      const found = (await ask('public.search', { workspaceId: WS_A, slug: SLUG, q })) as {
        items: unknown[]
      }
      expect(found.items, `search reached ${q}`).toEqual([])
    }
  })

  it('treats a wildcard as a word rather than as a pattern', async () => {
    const found = (await ask('public.search', { workspaceId: WS_A, slug: SLUG, q: '%%' })) as {
      items: unknown[]
    }
    expect(found.items).toEqual([])
  })
})

describe('the HTML that reaches a stranger', () => {
  it('re-points a mention of a public page and unlinks one that is not', async () => {
    const answer = await publicPage('links', { basePath: '/p/handbook/' })
    expect(answer.html).toContain('href="/p/handbook/getting-started"')
    // The excluded page keeps its label and loses its address entirely.
    expect(answer.html).toContain('>Salaries</a>')
    expect(answer.html).not.toContain(fx.excluded)
    expect(answer.html).not.toContain('/quire/')
  })

  it('carries no identifier of a page, a version or a person', async () => {
    const answer = await publicPage('links')
    expect(answer.html).not.toContain('data-id')
    expect(answer.html).not.toMatch(/ id="/)
    expect(answer.html).not.toContain(ALICE)
  })

  it('leaves prose that merely looks like markup alone', async () => {
    // The scrub is a regular expression over HTML, which is only safe because `render.ts` escapes
    // every attribute value — so a `"` never appears inside one, and text that reads as an
    // attribute arrives escaped and is not one.
    const answer = await publicPage('links')
    expect(answer.html).toContain('id=&quot;kept&quot;')
  })

  it('refuses a base path that would send every link off-site', async () => {
    for (const basePath of ['//evil.example/', 'https://evil.example/', 'p/handbook/', '/p/<x>/'])
      await expect(publicPage('links', { basePath })).rejects.toThrow()
  })
})

/**
 * The sweep the brief asks for, and the reason it is worth more than reading the handlers.
 *
 * A leak on this surface is rarely a page body. It is an id in a nav entry, a breadcrumb or a cache
 * tag that somebody then tries against an authenticated procedure — so the question is not "does
 * this response look right" but "does anything in it name something private". Every id in the
 * fixture is forbidden, including the ids of pages that *are* public: this API addresses pages by
 * path, so a page id appearing anywhere means something has started handing them out.
 */
/**
 * Pictures, which is the one thing on a published page that the module does not compose itself.
 *
 * Every other public answer is built from columns this module owns, and the sweep below holds them
 * to carrying no identifier. A picture came from somewhere else — a presigned URL minted by the
 * kernel out of a storage key — and it was signed into the *stored* HTML at publish time, so a
 * published page with an illustration on it handed a stranger `ws/<workspaceId>/…/<fileId>/…`,
 * with an hour before the link died. The reference replaced the URL; these are what hold it there.
 */
describe('a picture on a published page', () => {
  const reference = (workspaceId = WS_A, fileId = FILE_ID) =>
    svc.publications.assetReferenceFor(workspaceId, fileId)
  const assetOf = (asset: string, over: Record<string, unknown> = {}) =>
    ask('public.asset', { workspaceId: WS_A, slug: SLUG, asset, ...over })

  it('reaches a stranger with no workspace id, no file id and no signature in it', async () => {
    const { html } = await publicPage('office', { basePath: '/p/' })
    expect(html, 'the workspace uuid was in a published page').not.toContain(WS_A)
    expect(html, 'a file uuid was in a published page').not.toContain(FILE_ID)
    expect(html, 'a storage signature was in a published page').not.toContain('X-Amz-')
    expect(
      html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/),
    ).toBeNull()
    // The picture is still there — dropping every image would satisfy every line above.
    expect(html).toContain('alt="Office plan"')
    expect(html).toContain('src="/p/__media/')
  })

  it('drops the picture a version published by 0.12.0 signed into itself', async () => {
    const { html } = await publicPage('office', { basePath: '/p/' })
    expect(html, 'a legacy signed URL survived the scrub').not.toContain(LEGACY_FILE_ID)
    expect(html).not.toContain('alt="Old plan"')
  })

  it('serves the bytes for the reference its own page carries', async () => {
    const { html } = await publicPage('office', { basePath: '/p/' })
    const asset = decodeURIComponent(/src="\/p\/__media\/([^"]+)"/.exec(html)?.[1] ?? '')
    expect(asset.length).toBeGreaterThan(0)
    const answer = (await assetOf(asset)) as { contentType: string; bytes: string; maxAge: number }
    expect(answer.contentType).toBe('image/png')
    expect(Buffer.from(answer.bytes, 'base64').toString()).toBe(PICTURE.toString())
    expect(answer.maxAge).toBeGreaterThan(0)
  })

  it.each([
    ['a reference that is not one at all', () => 'not-a-reference'],
    ['a reference sealed for another workspace', () => reference(WS_B, FILE_ID)],
    ['a reference for a file no published page uses', () => reference(WS_A, UNUSED_FILE_ID)],
    ['a reference for a file that does not exist', () => reference(WS_A, randomUUID())],
  ])('refuses %s', async (_what, make) => {
    expect(await refusalFor('public.asset', { workspaceId: WS_A, slug: SLUG, asset: make() })).toBe(
      'NOT_FOUND',
    )
  })

  it('is behind the door of a publication that has one', async () => {
    const asset = reference()
    expect(await refusalFor('public.asset', { workspaceId: WS_A, slug: LOCKED_SLUG, asset })).toBe(
      'NOT_FOUND',
    )
    const { token } = (await ask('public.unlock', {
      workspaceId: WS_A,
      slug: LOCKED_SLUG,
      password: PASSWORD,
    })) as { token: string }
    const opened = (await assetOf(asset, { slug: LOCKED_SLUG, token })) as { bytes: string }
    expect(Buffer.from(opened.bytes, 'base64').toString()).toBe(PICTURE.toString())
  })

  it('stops resolving the moment its page is taken out of the site', async () => {
    const asset = reference()
    expect(await refusalFor('public.asset', { workspaceId: WS_A, slug: SLUG, asset })).not.toBe('NOT_FOUND')
    await run((tx) => svc.publications.setExcluded(tx, WS_A, fx.pictured, true))
    try {
      expect(await refusalFor('public.asset', { workspaceId: WS_A, slug: SLUG, asset })).toBe('NOT_FOUND')
    } finally {
      await run((tx) => svc.publications.setExcluded(tx, WS_A, fx.pictured, false))
    }
  })
})

/**
 * The fourth state of a publication, which four handlers did not have an answer for.
 *
 * A publication whose root page has since been trashed still has its row. `site` and `page` said
 * 404, `search` and `sitemap` said 200 with an empty body, and `robots` — the one procedure written
 * to never distinguish one slug from another — said `indexable: true` with a sitemap path. Between
 * them they were an existence oracle for a state nobody had enumerated, on the surface whose whole
 * design is that there is nothing to be learnt from a refusal.
 */
describe('a publication that exists and can serve nothing', () => {
  const NOWHERE = 'no-such-slug-at-all'
  const answerFor = async (name: string, slug: string) =>
    ask(name, { workspaceId: WS_A, slug, q: 'anything' }).then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, value: codeOf(err), message: (err as Error).message }),
    )

  it.each(['public.site', 'public.page', 'public.search', 'public.sitemap', 'public.robots'])(
    'is indistinguishable from a slug nobody has taken, on %s',
    async (name) => {
      expect(await answerFor(name, GUTTED_SLUG)).toEqual(await answerFor(name, NOWHERE))
    },
  )

  it('is not offered to a crawler', async () => {
    expect(await ask('public.robots', { workspaceId: WS_A, slug: GUTTED_SLUG })).toEqual({
      indexable: false,
      sitemapPath: null,
    })
  })
})

describe('the door of a password-protected publication', () => {
  it('stops weighing passwords long before a burst can work through them', async () => {
    // A fresh publication, so the window belongs to this test rather than to whatever ran before.
    const root = (await page({ spaceId: fx.spaceId, title: 'Throttled' })).id
    await publish(root)
    await publication(WS_A, root, { slug: 'throttled-handbook', password: PASSWORD })

    const codes: string[] = []
    for (let attempt = 0; attempt < UNLOCK_ATTEMPTS_EXPECTED + 3; attempt++)
      codes.push(
        await refusalFor('public.unlock', {
          workspaceId: WS_A,
          slug: 'throttled-handbook',
          password: `wrong-${attempt}`,
        }),
      )
    expect(codes.filter((c) => c === 'UNAUTHORIZED').length).toBe(UNLOCK_ATTEMPTS_EXPECTED)
    expect(codes.slice(UNLOCK_ATTEMPTS_EXPECTED)).toEqual(['RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED'])
  })
})

describe('the whole public surface, swept for identifiers', () => {
  const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

  it('names nothing in the fixture, anywhere, in any response', async () => {
    const { token } = (await ask('public.unlock', {
      workspaceId: WS_A,
      slug: LOCKED_SLUG,
      password: PASSWORD,
    })) as { token: string }

    const responses = await Promise.all([
      site(),
      publicPage(''),
      publicPage('getting-started'),
      publicPage('getting-started/installing'),
      publicPage('links'),
      // The macro page: the only response here whose body is built from *other* pages' rows.
      publicPage('contents'),
      ask('public.search', { workspaceId: WS_A, slug: SLUG, q: 'handbook' }),
      ask('public.sitemap', { workspaceId: WS_A, slug: SLUG }),
      ask('public.robots', { workspaceId: WS_A, slug: SLUG }),
      ask('public.site', { workspaceId: WS_A, slug: LOCKED_SLUG }),
      ask('public.site', { workspaceId: WS_A, slug: LOCKED_SLUG, token }),
    ])

    // Every identifier this fixture has, private and public alike, plus the tenant itself.
    const forbidden = new Map<string, string>(
      Object.entries(fx)
        .filter(([, value]) => typeof value === 'string' && UUID.test(value))
        .map(([name, value]) => [value as string, name]),
    )
    forbidden.set(WS_A, 'the workspace')
    forbidden.set(WS_B, 'the other workspace')
    forbidden.set(ALICE, 'the author')

    for (const response of responses) {
      const body = JSON.stringify(response)
      for (const [id, name] of forbidden)
        expect(body.includes(id), `a public response carried ${name}`).toBe(false)
    }
  })

  /*
   * **Page bodies are inside this rule now, and the carve-out is what the leak was hiding behind.**
   *
   * This assertion used to exempt `html`, on the reasoning that a picture's address is somebody
   * else's key and may legitimately carry an id. It may not: that address was the storage key, so
   * the exemption was drawn exactly around the one place a workspace uuid and a file uuid were
   * going out. Pictures are references now and a reference is opaque, so there is nothing left that
   * needs the exception — and the page with pictures on it is in the list precisely so that the
   * rule cannot be satisfied by there being no pictures to leak.
   */
  it('carries no uuid at all, page bodies included', async () => {
    const composed = await Promise.all([
      site(),
      ask('public.search', { workspaceId: WS_A, slug: SLUG, q: 'handbook' }),
      ask('public.sitemap', { workspaceId: WS_A, slug: SLUG }),
      publicPage('getting-started/installing'),
      publicPage('office'),
      publicPage('links'),
      publicPage('contents'),
      publicPage(''),
    ])
    for (const response of composed) {
      const found = JSON.stringify(response).match(UUID)
      expect(found, `a public response carried ${found?.join(', ')}`).toBeNull()
    }
  })
})

describe('the fences behind the queries', () => {
  it('runs the public path in a transaction Postgres will not let write', async () => {
    // Once the handler has set the workspace, row-level security has stopped being a fence around
    // an anonymous request: the whole workspace is inside it. Read-only is what covers `pages` and
    // `page_versions` as well, and it fails in Postgres rather than in a review.
    // drizzle wraps a driver error, so the SQLSTATE is on a `cause` rather than on what was thrown.
    const sqlstateOf = (err: unknown): string | null => {
      let at: unknown = err
      for (let hop = 0; at && hop < 8; hop++) {
        const code = (at as { code?: unknown }).code
        if (typeof code === 'string' && /^\d{5}$/.test(code)) return code
        at = (at as { cause?: unknown }).cause
      }
      return null
    }
    const outcome = await svc.publications
      .read(WS_A, (tx) => tx.execute(sql`update mod_quire.pages set title = 'defaced'`))
      .then(
        () => 'wrote',
        (err: unknown) => sqlstateOf(err),
      )
    expect(outcome).toBe('25006')
  })

  it('shows a role that cannot bypass row-level security only its own workspace', async () => {
    // The development and CI roles are superusers and bypass every policy, so a connection as the
    // service's own role would pass identically with no policy at all.
    const pool = await restrictedPool()
    const client = await pool.connect()
    try {
      const asWorkspace = async (workspaceId: string | null) => {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId ?? ''])
        const res = await client.query('select slug, workspace_id from mod_quire.publications')
        await client.query('rollback')
        return res.rows as Array<{ slug: string; workspace_id: string }>
      }
      const inA = await asWorkspace(WS_A)
      expect(inA.length).toBeGreaterThan(0)
      expect(inA.every((r) => r.workspace_id === WS_A)).toBe(true)
      const inB = await asWorkspace(WS_B)
      expect(inB.map((r) => r.workspace_id)).toEqual([WS_B])
      // The degradation the migration relies on: no workspace resolved is zero rows, never all of
      // them, because `set_config` writes `''` and no `workspace_id::text` is ever `''`.
      expect(await asWorkspace(null)).toEqual([])
    } finally {
      client.release()
    }
  })

  /**
   * The same role, on the tables the content is actually in.
   *
   * The test above reads `publications` and nothing else, which leaves the two tables a published
   * page is made of — `pages` and `page_versions` — measured only by the service's own role. That
   * role is a superuser in development and in CI, so it bypasses every policy: those tables were
   * being checked by a connection for which row-level security does not exist, and would have
   * passed with no policy on them at all.
   */
  it('shows that role no page and no version belonging to another workspace', async () => {
    const pool = await restrictedPool()
    const client = await pool.connect()
    try {
      const inWorkspace = async (workspaceId: string | null) => {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId ?? ''])
        const seen = {
          pages: (await client.query('select workspace_id from mod_quire.pages')).rows as Array<{
            workspace_id: string
          }>,
          versions: (await client.query('select workspace_id from mod_quire.page_versions')).rows as Array<{
            workspace_id: string
          }>,
          // The publication walk itself, rooted at workspace B's page while workspace A is set.
          otherRoot: (
            await client.query('select id from mod_quire.pages where id = $1 and deleted_at is null', [
              fx.otherWorkspacePage,
            ])
          ).rows.length,
        }
        await client.query('rollback')
        return seen
      }

      const a = await inWorkspace(WS_A)
      expect(a.pages.length).toBeGreaterThan(0)
      expect(a.versions.length).toBeGreaterThan(0)
      expect(new Set(a.pages.map((r) => r.workspace_id))).toEqual(new Set([WS_A]))
      expect(new Set(a.versions.map((r) => r.workspace_id))).toEqual(new Set([WS_A]))
      expect(a.otherRoot, "workspace A reached workspace B's root page by id").toBe(0)

      const b = await inWorkspace(WS_B)
      expect(new Set(b.pages.map((r) => r.workspace_id))).toEqual(new Set([WS_B]))
      expect(b.otherRoot).toBe(1)

      // No workspace resolved is nothing, on these two as well as on `publications`.
      const none = await inWorkspace(null)
      expect(none.pages).toEqual([])
      expect(none.versions).toEqual([])
    } finally {
      client.release()
    }
  })

  /**
   * An upper-case workspace uuid in a public URL, which used to fail in the direction that hides.
   *
   * `withWorkspace` writes the caller's string into `app.workspace_id` verbatim, and every policy
   * compares it as text against `workspace_id::text`, which Postgres renders lower case. So the
   * whole surface returned nothing on a hardened instance and served the site normally everywhere
   * the tests run, because the development and CI role is a superuser. This asserts the answer
   * rather than the mechanism: the same URL, cased differently, is the same site.
   */
  it('serves the same site whatever case the workspace id arrives in', async () => {
    const upper = (await ask('public.site', { workspaceId: WS_A.toUpperCase(), slug: SLUG })) as PublicSite
    expect(upper.site?.nav.map((n) => n.path).sort()).toEqual(
      (await site()).site?.nav.map((n) => n.path).sort(),
    )
  })
})

describe('taking a page back out of a site', () => {
  it('removes it and everything under it, on the next read', async () => {
    const before = await site()
    expect(before.site?.nav.map((n) => n.path)).toContain('getting-started/installing')

    await run((tx) => svc.publications.setExcluded(tx, WS_A, fx.child, true))
    const after = await site()
    expect(after.site?.nav.map((n) => n.path)).not.toContain('getting-started')
    expect(
      after.site?.nav.map((n) => n.path),
      'excluding a page left its child reachable',
    ).not.toContain('getting-started/installing')
    expect(await refusalFor('public.page', { workspaceId: WS_A, slug: SLUG, path: 'getting-started' })).toBe(
      'NOT_FOUND',
    )

    await run((tx) => svc.publications.setExcluded(tx, WS_A, fx.child, false))
  })
})

/** The two pure helpers, where the cases are easier to state than to arrange. */
describe('paths', () => {
  it('keeps a Persian title readable rather than reducing it to "untitled"', () => {
    expect(slugifyTitle('راهنمای کارکنان')).toBe('راهنمای-کارکنان')
    expect(slugifyTitle('!!!')).toBe('untitled')
    expect(slugifyTitle('Getting Started')).toBe('getting-started')
  })

  it('disambiguates two siblings that would collide', () => {
    const row = (id: string, parent: string | null, title: string, position: string, depth: number) => ({
      id,
      parent_id: parent,
      title,
      icon: null,
      cover_url: null,
      position,
      version_id: `v-${id}`,
      published_at: new Date(0),
      has_html: true,
      depth,
    })
    const nodes = withPaths([
      row('r', null, 'Root', 'a', 0),
      row('a', 'r', 'Notes', 'a', 1),
      row('b', 'r', 'notes', 'b', 1),
      row('c', 'r', 'NOTES', 'c', 1),
    ])
    expect(nodes.map((n) => n.path)).toEqual(['', 'notes', 'notes-2', 'notes-3'])
  })

  it('drops a page whose parent did not survive the walk', () => {
    const nodes = withPaths([
      {
        id: 'orphan',
        parent_id: 'gone',
        title: 'Orphan',
        icon: null,
        cover_url: null,
        position: 'a',
        version_id: 'v',
        published_at: new Date(0),
        has_html: true,
        depth: 1,
      },
    ])
    expect(nodes).toEqual([])
  })
})

describe('the public scrub, on its own', () => {
  /** No page is public and no picture resolves, unless a case says otherwise. */
  const scrub = (html: string, over: Partial<Parameters<typeof publicHtml>[2]> = {}, basePath = '/p/') =>
    publicHtml(html, basePath, { pagePath: () => null, assetHref: () => null, ...over })

  it('leaves an off-site link alone', () => {
    const html = '<p><a href="https://example.com/x">out</a></p>'
    expect(scrub(html)).toBe(html)
  })

  it('removes only whole id attributes', () => {
    expect(scrub('<td data-colwidth="120" id="x">c</td>')).toBe('<td data-colwidth="120">c</td>')
  })

  it('percent-encodes a path so a Persian slug survives the address bar', () => {
    const html = '<a href="/quire/k/00000000-0000-0000-0000-000000000001">x</a>'
    expect(scrub(html, { pagePath: () => 'راهنما' })).toContain(`/p/${encodeURI('راهنما')}`)
  })

  /*
   * Pictures, which is where the storage key used to go out.
   *
   * A published page drew its images as presigned URLs — `ws/<workspaceId>/<module>/<yyyy>/<mm>/
   * <fileId>/<name>` plus a signature — so a page with one picture on it handed a stranger the
   * tenant's workspace uuid and a file uuid, and stopped loading an hour later. The renderer writes
   * a reference now; these are the shapes that must and must not survive the scrub.
   */
  const WS = '01920000-0000-7000-8000-0000000000aa'
  const FILE = '01920000-0000-7000-8000-0000000000bb'
  const SIGNED =
    `http://localhost:9000/kern/ws/${WS}/quire/2026/08/${FILE}/office-plan.png` +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Credential=kern%2F20260828&amp;X-Amz-Signature=deadbeef'

  it('turns a picture reference into an address on this site', () => {
    const out = scrub(`<p><img src="/__quire-asset/${FILE}" alt="Plan" loading="lazy"></p>`, {
      assetHref: () => '/p/__media/v1.aa.bb.cc',
    })
    expect(out).toBe('<p><img src="/p/__media/v1.aa.bb.cc" alt="Plan" loading="lazy"></p>')
    expect(out).not.toContain(FILE)
  })

  it('drops a picture whose reference cannot be handed out, rather than drawing it broken', () => {
    expect(scrub(`<p>a<img src="/__quire-asset/${FILE}" alt="x">b</p>`)).toBe('<p>ab</p>')
  })

  it.each([
    ['a signed storage URL left in an already-published version', `<img src="${SIGNED}" alt="x">`],
    ['a root-relative source, which is a link into the application', '<img src="/api/core/files/x" alt="">'],
    ['a source with nothing in it', '<img src="" alt="">'],
  ])('drops %s', (_what, html) => {
    const out = scrub(html, { assetHref: () => '/p/__media/tok' })
    expect(out).toBe('')
    expect(out).not.toContain(WS)
    expect(out).not.toContain(FILE)
  })

  it('leaves a picture an author hosts somewhere else alone', () => {
    const html = '<img src="https://example.com/logo.png" alt="Logo">'
    expect(scrub(html)).toBe(html)
  })

  /*
   * A link into the application is not only a page mention.
   *
   * `safeHref` passes any root-relative path through, so an author who pastes a page's address out
   * of their own address bar writes `/quire/<space>/<page-id>#block-7` or `…?comment=1` — and the
   * scrub used to anchor the page id on the closing quote, so anything after it kept the whole
   * href. The result was a live deep link into the private application, carrying the uuid of a page
   * the very same public API answers 404 for. Every shape of that link belongs here, because the
   * one that was tested is the one that never leaked.
   */
  const PRIVATE_ID = '00000000-0000-0000-0000-0000000000ff'
  const linksIntoTheApp = [
    `<a href="/quire/hb/${PRIVATE_ID}">x</a>`,
    `<a href="/quire/hb/${PRIVATE_ID}#block-7">x</a>`,
    `<a href="/quire/hb/${PRIVATE_ID}?comment=1">x</a>`,
    `<a href="/quire/hb/${PRIVATE_ID}/">x</a>`,
    `<a href="/quire/hb/${PRIVATE_ID}/history">x</a>`,
    `<a href="/quire/hb/${PRIVATE_ID}extra">x</a>`,
    `<a href="/quire/hb">x</a>`,
    `<a href="/quire/hb/databases/${PRIVATE_ID}">x</a>`,
  ]

  it.each(linksIntoTheApp)('carries no page id out of a private link: %s', (html) => {
    const out = scrub(html)
    expect(out, 'a page id reached the public HTML').not.toContain(PRIVATE_ID)
    expect(out, 'a link into the application reached the public HTML').not.toContain('/quire/')
  })

  it.each(['#block-7', '?comment=1', '/', '/history'])(
    're-points a public page mention whatever follows its id (%s)',
    (tail) => {
      const html = `<a href="/quire/hb/${PRIVATE_ID}${tail}">x</a>`
      const out = scrub(html, { pagePath: () => 'guide/install' })
      expect(out).toContain('href="/p/guide/install"')
      expect(out).not.toContain(PRIVATE_ID)
    },
  )
})
