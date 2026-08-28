/**
 * Getting work in and out, read as an adversary trying to move data they may not.
 *
 * Everything here is about the *fence*, and nothing about the file formats. Two workspaces, five
 * people with different roles, and a Postgres role that cannot bypass row-level security — because
 * every other suite in this package connects as the superuser the development database hands out,
 * which passes every isolation assertion with no policy at all.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import { channel, type Principal } from '@kernhq/contracts'
import {
  createKernel,
  createRealtime,
  KernError,
  type Kernel,
  type RequestContext,
  rtSubject,
  type Tx,
} from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { implement_ } from './_impl.js'
import { writeZip } from './export/zip.js'
import { quireModule } from './index.js'
import { pages } from './schema.js'
import { exportArtefactKey } from './services/export.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_perm_test_${Date.now().toString(36)}`
const RLS_ROLE = `kern_quire_perm_rls_${Date.now().toString(36)}`

const WS_A = randomUUID()
const WS_B = randomUUID()

/** admin in A — the person every artefact below belongs to */
const ALICE = randomUUID()
/** admin in A too, and therefore the sharpest test of the `requested_by` fence */
const BOB = randomUUID()
/** admin in B and nothing in A */
const CARA = randomUUID()
/** plain member of A: may export by default, may not import */
const MEG = randomUUID()
/** guest of A: may do neither */
const GUS = randomUUID()

type Role = 'owner' | 'admin' | 'member' | 'guest'
const roles = new Map<string, { workspaceId: string; role: Role }>([
  [ALICE, { workspaceId: WS_A, role: 'admin' }],
  [BOB, { workspaceId: WS_A, role: 'admin' }],
  [CARA, { workspaceId: WS_B, role: 'admin' }],
  [MEG, { workspaceId: WS_A, role: 'member' }],
  [GUS, { workspaceId: WS_A, role: 'guest' }],
])

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let databaseUrl = ''
let restricted: pg.Pool | null = null
let router: ReturnType<typeof implement_>

const principal = (userId: string): Principal => {
  const seat = roles.get(userId) ?? { workspaceId: WS_A, role: 'admin' as const }
  return {
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [
      { workspaceId: seat.workspaceId, role: seat.role, roleIds: [], groupIds: [], status: 'active' },
    ],
    permissionVersion: 0,
  } as Principal
}
const alice = () => principal(ALICE)
const bob = () => principal(BOB)
const cara = () => principal(CARA)
const meg = () => principal(MEG)
const gus = () => principal(GUS)

interface Binding {
  subjectType: 'user'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
const bindings = new Map<string, Binding[]>()
const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    ...(bindings.get(userId) ?? []),
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

const documents = new Map<string, Buffer>()
const objects = new Map<string, { body: Buffer; contentType: string }>()
const files = new Map<
  string,
  { workspaceId: string; name: string; mimeType: string; size: number; key: string; status: string }
>()

function registerStubs(k: Kernel) {
  k.broker.register('collab', {
    'document.state': {
      handler: async (input: { name: string }) => ({
        name: input.name,
        state: documents.get(input.name)?.toString('base64') ?? null,
        size: documents.get(input.name)?.length ?? 0,
        updatedAt: documents.has(input.name) ? new Date().toISOString() : null,
      }),
    },
    'document.snapshot': {
      handler: async (input: { name: string }) => {
        const state = documents.get(input.name)
        if (!state) throw new Error('no document')
        return { snapshot: state.toString('base64'), state: state.toString('base64') }
      },
    },
    'document.apply': { handler: async () => ({ ok: true as const, size: 0 }) },
    'document.replace': {
      handler: async (input: { name: string; state: string }) => {
        documents.set(input.name, Buffer.from(input.state, 'base64'))
        return { ok: true as const, size: 0 }
      },
    },
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
    'authz.bindings': { handler: async (input: { userId: string }) => bindings.get(input.userId) ?? [] },
    'settings.getModule': { handler: async () => ({}) },
    'files.get': { handler: async (input: { id: string }) => files.get(input.id) ?? null },
  })
}

/** Object storage in memory. `presignGet` mints the shape MinIO would, key and all. */
function installStorage(k: Kernel) {
  const stub = {
    ...k.storage,
    put: async (key: string, body: Buffer | Uint8Array | string, contentType: string) => {
      objects.set(key, { body: Buffer.from(body as Uint8Array), contentType })
    },
    get: async (key: string) => {
      const found = objects.get(key)
      if (!found) throw new Error(`no object at ${key}`)
      return {
        body: Readable.from(found.body),
        contentType: found.contentType,
        contentLength: found.body.length,
      }
    },
    head: async (key: string) =>
      objects.has(key) ? { contentLength: objects.get(key)?.body.length ?? 0, contentType: 'x' } : null,
    delete: async (key: string) => {
      objects.delete(key)
    },
    presignGet: async (key: string, opts?: { filename?: string }) =>
      `https://storage.test/kern/${key}?X-Amz-Signature=deadbeef&filename=${opts?.filename ?? ''}`,
  }
  ;(k as unknown as { storage: unknown }).storage = stub
}

// ---------------------------------------------------------------------------------------------
// A zip reader written against the format, not against `writeZip`
// ---------------------------------------------------------------------------------------------

function readArchive(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--)
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('no end-of-central-directory record: this is not a zip')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    const method = buffer.readUInt16LE(at + 10)
    const compressed = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const offset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const raw = buffer.subarray(start, start + compressed)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const inWs =
  (workspaceId: string, actor?: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor?.userId ?? null })
const runA = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS_A, alice())(fn)
const runB = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS_B, cara())(fn)

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
/** The router is walked as data, so the leaf it reaches is untyped by construction. */
const invoke = (name: string, input: Record<string, unknown>, who: Principal) =>
  call(procedureAt(name) as any, input as any, { context: context(who) })

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'succeeded',
    (err) => (err instanceof KernError ? err.code : ((err as { code?: string }).code ?? String(err))),
  )

const text = (value: string) => {
  const node = new Y.XmlText()
  node.insert(0, value)
  return node
}
const element = (name: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => {
  const node = new Y.XmlElement(name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value as string)
  if (children.length > 0) node.insert(0, children as never[])
  return node
}
const paragraph = (...children: unknown[]) => element('paragraph', {}, children)
function yjs(build: () => unknown[]): Buffer {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, build() as never[])
  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return state
}
const documentName = (workspaceId: string, pageId: string) => `ws:${workspaceId}:quire:page:${pageId}`

async function makePage(
  workspaceId: string,
  actor: Principal,
  spaceId: string,
  opts: { title: string; parentId: string | null; body: () => unknown[] },
): Promise<string> {
  const created = await inWs(
    workspaceId,
    actor,
  )((tx) =>
    svc.pages.create(tx, actor, workspaceId, {
      spaceId,
      parentId: opts.parentId,
      title: opts.title,
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  documents.set(documentName(workspaceId, created.id), yjs(opts.body))
  await inWs(
    workspaceId,
    actor,
  )((tx) =>
    svc.versions.capture(tx, workspaceId, created.id, {
      kind: 'auto',
      label: null,
      authorId: actor.userId ?? null,
    }),
  )
  return created.id
}

/** A file core would answer for. `owner` is the workspace core says it belongs to. */
function upload(bytes: Buffer, owner: string, name = 'archive.zip'): string {
  const id = randomUUID()
  const key = `ws/${owner}/core/2026/08/${id}/${name}`
  files.set(id, {
    workspaceId: owner,
    name,
    mimeType: 'application/zip',
    size: bytes.length,
    key,
    status: 'ready',
  })
  objects.set(key, { body: bytes, contentType: 'application/zip' })
  return id
}

/** A folder of Markdown that really does import one page — so "wrote nothing" means something. */
const MARKDOWN_ZIP = writeZip([
  { path: 'Smuggled.md', data: Buffer.from('# Smuggled\n\nThis should never appear.\n', 'utf8') },
])

let spaceA = ''
let spaceB = ''
let closedSpace = ''
const page = { root: '', child: '', secret: '', underSecret: '', foreignPicture: '' }

const FOREIGN_FILE = randomUUID()
const FOREIGN_KEY = `ws/${WS_B}/quire/2026/08/${FOREIGN_FILE}/secret-chart.png`
const FOREIGN_BYTES = Buffer.from('PNG-BYTES-THAT-BELONG-TO-WORKSPACE-B', 'utf8')

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

/** A transaction as the unprivileged role, with `app.workspace_id` set to `workspaceId` or unset. */
async function asWorkspace<T>(workspaceId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = await restrictedPool()
  const c = await pool.connect()
  try {
    await c.query('begin')
    if (workspaceId !== null)
      await c.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId])
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (err) {
    await c.query('rollback').catch(() => undefined)
    throw err
  } finally {
    c.release()
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'quire-perm-test',
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
  installStorage(kernel)
  await kernel.start()
  svc = quireServices(kernel)
  router = implement_(kernel)

  spaceA = (
    await runA((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: 'handbook',
        name: 'Company Handbook',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
  ).id
  closedSpace = (
    await runA((tx) =>
      svc.spaces.create(tx, alice(), WS_A, {
        key: 'closed',
        name: 'Closed',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
  ).id
  spaceB = (
    await runB((tx) =>
      svc.spaces.create(tx, cara(), WS_B, {
        key: 'theirs',
        name: 'Their Handbook',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
  ).id

  files.set(FOREIGN_FILE, {
    workspaceId: WS_B,
    name: 'secret-chart.png',
    mimeType: 'image/png',
    size: FOREIGN_BYTES.length,
    key: FOREIGN_KEY,
    status: 'ready',
  })
  objects.set(FOREIGN_KEY, { body: FOREIGN_BYTES, contentType: 'image/png' })

  page.root = await makePage(WS_A, alice(), spaceA, {
    title: 'Handbook',
    parentId: null,
    body: () => [paragraph(text('Everyone may read this.'))],
  })
  page.child = await makePage(WS_A, alice(), spaceA, {
    title: 'Getting started',
    parentId: page.root,
    body: () => [paragraph(text('Welcome aboard.'))],
  })
  page.secret = await makePage(WS_A, alice(), spaceA, {
    title: 'Redundancy plan Q4',
    parentId: page.root,
    body: () => [paragraph(text('Nobody may read this.'))],
  })
  page.underSecret = await makePage(WS_A, alice(), spaceA, {
    title: 'Severance table',
    parentId: page.secret,
    body: () => [paragraph(text('Nor this.'))],
  })
  page.foreignPicture = await makePage(WS_A, alice(), spaceA, {
    title: 'Borrowed picture',
    parentId: page.root,
    body: () => [paragraph(element('image', { fileId: FOREIGN_FILE, alt: 'theirs' }))],
  })
}, 180_000)

afterAll(async () => {
  bindings.clear()
  await restricted?.end().catch(() => undefined)
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

async function exportNow(
  who: Principal,
  input: { scope: 'page' | 'subtree' | 'space'; targetId: string; format: 'markdown' | 'html' },
) {
  const started = await inWs(WS_A, who)((tx) => svc.exports.start(tx, who, WS_A, input))
  await svc.exports.run(WS_A, started.id)
  return inWs(WS_A, who)((tx) => svc.exports.get(tx, WS_A, started.id, who))
}

const artefactOf = (row: { fileId: string | null }): Buffer => {
  expect(row.fileId, 'the job finished without recording an artefact').not.toBeNull()
  const object = objects.get(exportArtefactKey(WS_A, row.fileId as string))
  expect(object, 'the job recorded an artefact that is not in storage').toBeDefined()
  return (object as { body: Buffer }).body
}

const pagesIn = (workspaceId: string, spaceId: string) =>
  inWs(workspaceId)((tx) =>
    tx
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), eq(pages.spaceId, spaceId))),
  )

// ---------------------------------------------------------------------------------------------

describe('a subtree export, with one page inside it closed by an object-scope DENY', () => {
  it('leaves that page and its descendant out of the bytes, in Markdown and in HTML', async () => {
    // The control. Without it every assertion below would pass against an export of nothing.
    const open = readArchive(
      artefactOf(await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })),
    )
    expect([...open.keys()]).toContain('handbook/redundancy-plan-q4/index.md')
    expect([...open.keys()]).toContain('handbook/redundancy-plan-q4/severance-table/index.md')

    for (const format of ['markdown', 'html'] as const) {
      bindings.clear()
      deny(ALICE, ['quire.page.view'], 'object', page.secret)
      const row = await exportNow(alice(), { scope: 'subtree', targetId: page.root, format })
      bindings.clear()

      expect(row.state, row.error ?? '').toBe('done')
      const bytes = artefactOf(row)
      const paths = [...readArchive(bytes).keys()]
      const body = bytes.toString('utf8')

      expect(
        paths.filter((p) => p.includes('redundancy-plan-q4')),
        `${format}: the withheld title survived as a folder name, which is the title`,
      ).toEqual([])
      expect(body, `${format}: the withheld title is in the archive`).not.toContain('Redundancy plan Q4')
      expect(body, `${format}: the withheld prose is in the archive`).not.toContain('Nobody may read this')
      expect(body, `${format}: the withheld descendant is in the archive`).not.toContain('Nor this')
      expect(body, `${format}: the withheld descendant's title is in the archive`).not.toContain(
        'Severance table',
      )
      // Still an export, and it says how much was left out.
      expect(paths.some((p) => p.includes('getting-started'))).toBe(true)
      expect(row.counts).toMatchObject({ skipped: 2, failed: 0 })
    }
  })

  it('holds when the DENY sits on an ancestor that is outside the export scope', async () => {
    /*
     * A subtree rooted at the child, with the parent — which is not in the export at all — denied.
     * The ancestor chain handed to the permission engine is the page's real one rather than the
     * export's, so the DENY has to reach down into a subtree that never mentions the page it is on.
     */
    deny(ALICE, ['quire.page.view'], 'object', page.root)
    const row = await exportNow(alice(), { scope: 'subtree', targetId: page.child, format: 'markdown' })
    bindings.clear()

    expect(row.state, row.error ?? '').toBe('done')
    const bytes = artefactOf(row)
    expect(
      bytes.toString('utf8'),
      'a DENY on a page above the export root did not reach the page inside it',
    ).not.toContain('Welcome aboard')
    expect([...readArchive(bytes).keys()]).toEqual([])
    expect(row.counts).toMatchObject({ total: 1, done: 0, skipped: 1 })
  })

  it('never carries a picture core says belongs to another workspace', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.foreignPicture, format: 'html' })
    expect(row.state, row.error ?? '').toBe('done')
    const bytes = artefactOf(row)
    expect(
      bytes.toString('latin1'),
      "another tenant's bytes were read out of storage and written into this one's archive",
    ).not.toContain('BELONG-TO-WORKSPACE-B')
    expect(
      [...readArchive(bytes).keys()].filter((p) => p.includes('media/')),
      'a file belonging to another workspace was carried into the archive',
    ).toEqual([])
  })
})

describe('an export job somebody else started', () => {
  it('is invisible to another member of the same workspace, link and all', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'markdown' })
    expect(row.state, row.error ?? '').toBe('done')

    const mine = (await invoke('exports.get', { workspaceId: WS_A, jobId: row.id }, alice())) as {
      downloadUrl: string | null
    }
    expect(mine.downloadUrl, 'the owner cannot fetch their own artefact').toContain('X-Amz-Signature')

    expect(
      await codeOf(invoke('exports.get', { workspaceId: WS_A, jobId: row.id }, bob())),
      'FORBIDDEN would confirm the id names an export, which is the leak the code says it avoids',
    ).toBe('NOT_FOUND')
    const listed = (await invoke('exports.list', { workspaceId: WS_A }, bob())) as Array<{ id: string }>
    expect(listed.map((job) => job.id)).not.toContain(row.id)
  })

  it('cannot be reached by a member of another workspace, from either side', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'markdown' })

    // Naming the workspace it really lives in: Cara is not a member, so membership refuses first.
    expect(await codeOf(invoke('exports.get', { workspaceId: WS_A, jobId: row.id }, cara()))).toBe(
      'FORBIDDEN',
    )
    // Naming her own workspace with somebody else's job id: row-level security and the id filter.
    expect(await codeOf(invoke('exports.get', { workspaceId: WS_B, jobId: row.id }, cara()))).toBe(
      'NOT_FOUND',
    )
    const listed = (await invoke('exports.list', { workspaceId: WS_B }, cara())) as Array<{ id: string }>
    expect(listed.map((job) => job.id)).not.toContain(row.id)

    /*
     * And the artefact is not addressable from the other tenant's key space: the key is derived from
     * the workspace the row was read in, so there is no id a member of B can hand a procedure that
     * would make it sign a URL for an object of A's.
     */
    expect(objects.has(exportArtefactKey(WS_B, row.fileId as string))).toBe(false)
    expect(objects.has(exportArtefactKey(WS_A, row.fileId as string))).toBe(true)
  })

  it('is refused to a guest, who has no export permission at all', async () => {
    expect(
      await codeOf(
        invoke(
          'exports.start',
          { workspaceId: WS_A, scope: 'space', targetId: spaceA, format: 'markdown' },
          gus(),
        ),
      ),
      'a guest is somebody invited to read one thing, not to keep a copy of the section around it',
    ).toBe('FORBIDDEN')
  })
})

describe('an import into a space this person may not write to', () => {
  it('imports for somebody who may, so the refusals below mean something', async () => {
    const target = (
      await runA((tx) =>
        svc.spaces.create(tx, alice(), WS_A, {
          key: 'control',
          name: 'Control',
          description: '',
          icon: null,
          visibility: 'open',
        }),
      )
    ).id
    const started = await runA((tx) =>
      svc.imports.start(tx, alice(), WS_A, {
        spaceId: target,
        source: 'markdown',
        fileId: upload(MARKDOWN_ZIP, WS_A),
      }),
    )
    await svc.imports.run(WS_A, started.id)
    const row = await runA((tx) => svc.imports.get(tx, WS_A, started.id, alice()))
    expect(svc.imports.toImportJob(row).state, row.error ?? '').toBe('done')
    expect((await pagesIn(WS_A, target)).map((p) => p.title)).toContain('Smuggled')
  })

  it('is refused to a plain member, who holds no import permission by default', async () => {
    expect(
      await codeOf(
        invoke(
          'imports.start',
          {
            workspaceId: WS_A,
            spaceId: closedSpace,
            source: 'markdown',
            fileId: upload(MARKDOWN_ZIP, WS_A),
          },
          meg(),
        ),
      ),
      'quire.page.import declares owner and admin only — a member who can import makes that a lie',
    ).toBe('FORBIDDEN')
    expect(await pagesIn(WS_A, closedSpace), 'a refused import still wrote pages').toHaveLength(0)
  })

  it('is refused when only quire.page.create is denied, with the import key left alone', async () => {
    /*
     * `requireWritable` asks two keys, and this is the only thing that proves the second one is
     * load-bearing: a space closed for editing during a freeze is closed to an import as well, and
     * reading only `quire.page.import` would walk straight past that.
     */
    deny(ALICE, ['quire.page.create'], 'space', closedSpace)
    const outcome = await codeOf(
      invoke(
        'imports.start',
        {
          workspaceId: WS_A,
          spaceId: closedSpace,
          source: 'markdown',
          fileId: upload(MARKDOWN_ZIP, WS_A),
        },
        alice(),
      ),
    )
    bindings.clear()
    expect(outcome).toBe('FORBIDDEN')
    expect(await pagesIn(WS_A, closedSpace)).toHaveLength(0)
  })

  it('is refused when the space belongs to another workspace', async () => {
    // Cara's space, named from Alice's workspace. Nothing about it may be confirmed.
    expect(
      await codeOf(
        invoke(
          'imports.start',
          { workspaceId: WS_A, spaceId: spaceB, source: 'markdown', fileId: upload(MARKDOWN_ZIP, WS_A) },
          alice(),
        ),
      ),
    ).toBe('NOT_FOUND')
    expect(await pagesIn(WS_B, spaceB), 'an import reached into another tenant').toHaveLength(0)

    // And the other way: a member of B naming A's workspace is not a member of it.
    expect(
      await codeOf(
        invoke(
          'imports.start',
          { workspaceId: WS_A, spaceId: spaceA, source: 'markdown', fileId: upload(MARKDOWN_ZIP, WS_B) },
          cara(),
        ),
      ),
    ).toBe('FORBIDDEN')
  })

  it('is refused when the archive belongs to another workspace', async () => {
    const foreign = upload(MARKDOWN_ZIP, WS_B)
    expect(
      await codeOf(
        invoke(
          'imports.start',
          { workspaceId: WS_A, spaceId: closedSpace, source: 'markdown', fileId: foreign },
          alice(),
        ),
      ),
      'core.files.get answers a service principal without a membership check, so this comparison is the fence',
    ).toBe('NOT_FOUND')
    expect(await pagesIn(WS_A, closedSpace)).toHaveLength(0)
  })
})

describe('the job tables, read as a role that cannot bypass row-level security', () => {
  it('is a role that genuinely cannot', async () => {
    const rows = await asWorkspace(
      WS_A,
      async (c) =>
        (await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows,
    )
    expect(rows[0], 'a superuser passes every assertion below with no policy at all').toEqual({
      rolsuper: false,
      rolbypassrls: false,
    })
  })

  it('shows a workspace its own transfer jobs and none of the other workspace’s', async () => {
    const started = await runA((tx) =>
      svc.exports.start(tx, alice(), WS_A, { scope: 'page', targetId: page.child, format: 'markdown' }),
    )
    const imported = await runA((tx) =>
      svc.imports.start(tx, alice(), WS_A, {
        spaceId: closedSpace,
        source: 'markdown',
        fileId: upload(MARKDOWN_ZIP, WS_A),
      }),
    )

    const mine = await asWorkspace(WS_A, async (c) => ({
      exports: (await c.query('select id from mod_quire.export_jobs')).rows.map((r) => r.id),
      imports: (await c.query('select id from mod_quire.import_jobs')).rows.map((r) => r.id),
    }))
    expect(mine.exports).toContain(started.id)
    expect(mine.imports).toContain(imported.id)

    const theirs = await asWorkspace(WS_B, async (c) => ({
      exports: (await c.query('select id from mod_quire.export_jobs')).rows,
      imports: (await c.query('select id from mod_quire.import_jobs')).rows,
    }))
    expect(theirs.exports, 'another workspace can read this one’s export jobs').toHaveLength(0)
    expect(theirs.imports, 'another workspace can read this one’s import jobs').toHaveLength(0)
  })

  it('shows nothing at all when app.workspace_id was never set', async () => {
    const loose = await asWorkspace(null, async (c) => ({
      exports: (await c.query('select id from mod_quire.export_jobs')).rows,
      imports: (await c.query('select id from mod_quire.import_jobs')).rows,
    }))
    expect(loose.exports, 'a worker that forgets the workspace setting sees every tenant').toHaveLength(0)
    expect(loose.imports).toHaveLength(0)
  })

  it('refuses to write a job into a workspace other than the current one', async () => {
    await expect(
      asWorkspace(WS_B, (c) =>
        c.query(
          `insert into mod_quire.export_jobs (workspace_id, requested_by, scope, target_id, format)
           values ($1, $2, 'space', $3, 'markdown')`,
          [WS_A, ALICE, spaceA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
    await expect(
      asWorkspace(WS_B, (c) =>
        c.query(
          `insert into mod_quire.import_jobs (workspace_id, requested_by, source, target_id, source_file_id)
           values ($1, $2, 'markdown', $3, $4)`,
          [WS_A, ALICE, spaceA, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot update or delete another workspace’s jobs', async () => {
    const started = await runA((tx) =>
      svc.exports.start(tx, alice(), WS_A, { scope: 'page', targetId: page.child, format: 'markdown' }),
    )
    const touched = await asWorkspace(WS_B, async (c) => ({
      updated: (
        await c.query(`update mod_quire.export_jobs set state = 'failed' where id = $1`, [started.id])
      ).rowCount,
      deleted: (await c.query(`delete from mod_quire.export_jobs where id = $1`, [started.id])).rowCount,
    }))
    expect(touched, 'a sweep run in one workspace reached another one’s rows').toEqual({
      updated: 0,
      deleted: 0,
    })
    const still = await runA((tx) => svc.exports.get(tx, WS_A, started.id, alice()))
    expect(still.state).toBe('queued')
  })
})

describe('an export permission taken away between queueing and running', () => {
  /**
   * The hole this was written to find, and it found it.
   *
   * Before the fix the job ran to completion: `done`, five of five pages, a 911-byte archive holding
   * every page of the space, and `exports.get` signed a fifteen-minute link to it. The per-page
   * `quire.page.view` check is not a substitute — revoking somebody's *export* permission leaves
   * every page they may still read, so the one revocation the key exists for did not hold.
   *
   * The assertion is written as an adversary rather than as "the job failed": it goes and looks at
   * whether the bytes exist and whether a link to them can be minted.
   */
  it('fails the job, writes no artefact, and offers no link — at space scope', async () => {
    const started = await runA((tx) =>
      svc.exports.start(tx, alice(), WS_A, { scope: 'space', targetId: spaceA, format: 'markdown' }),
    )
    const objectsBefore = objects.size
    // The same shape the import side is tested with: the DENY lands after the row, before the run.
    deny(ALICE, ['quire.page.export'], 'space', spaceA)
    await svc.exports.run(WS_A, started.id)

    const detail = (await invoke('exports.get', { workspaceId: WS_A, jobId: started.id }, alice())) as {
      state: string
      fileId: string | null
      downloadUrl: string | null
    }
    bindings.clear()

    expect(detail.state, 'a revoked export permission still produced an artefact').toBe('failed')
    expect(detail.fileId, 'a refused job must not point at bytes').toBeNull()
    expect(detail.downloadUrl, 'a link was signed for an export the person may no longer take').toBeNull()
    expect(objects.size, 'a refused export left an archive in storage anyway').toBe(objectsBefore)
  })

  it('fails the job at page scope too, where the DENY is bound to the page itself', async () => {
    const started = await runA((tx) =>
      svc.exports.start(tx, alice(), WS_A, { scope: 'subtree', targetId: page.root, format: 'markdown' }),
    )
    const objectsBefore = objects.size
    deny(ALICE, ['quire.page.export'], 'object', page.root)
    await svc.exports.run(WS_A, started.id)
    const row = await runA((tx) => svc.exports.get(tx, WS_A, started.id, alice()))
    bindings.clear()

    expect(row.state).toBe('failed')
    expect(row.fileId).toBeNull()
    expect(objects.size).toBe(objectsBefore)
  })

  it('still runs a job whose permissions are untouched, so the check is not simply refusing', async () => {
    const row = await exportNow(alice(), { scope: 'space', targetId: spaceA, format: 'markdown' })
    expect(row.state, row.error ?? '').toBe('done')
    expect([...readArchive(artefactOf(row)).keys()]).toContain('handbook/index.md')
  })

  it('writes an empty archive when the requester has left the workspace entirely', async () => {
    const started = await runA((tx) =>
      svc.exports.start(tx, alice(), WS_A, { scope: 'space', targetId: spaceA, format: 'markdown' }),
    )
    const seat = roles.get(ALICE)
    roles.set(ALICE, { workspaceId: randomUUID(), role: 'admin' })
    await svc.exports.run(WS_A, started.id)
    if (seat) roles.set(ALICE, seat)

    const row = await runA((tx) => svc.exports.get(tx, WS_A, started.id, alice()))
    expect(row.state, 'a person with no membership left is refused rather than served').toBe('failed')
    expect(row.fileId).toBeNull()
  })
})

describe('what the rest of the workspace is told about somebody else’s transfer', () => {
  /**
   * The leak this was written to find, and it found it.
   *
   * Every other entity in Quire announces with `kernel.realtime.change`, which publishes to
   * `kern.rt.ch.ws_<workspaceId>` — and `chat/src/gateway.ts` joins **every** socket to its
   * workspace channel at `hello`, with no per-message permission filter. So a transfer announced
   * that way told every member of the workspace that a job with id X was created, and when.
   *
   * That is precisely the fact the rest of the feature refuses to confirm: `exports.get` answers
   * NOT_FOUND rather than FORBIDDEN for somebody else's job id, and `exports.list` never names it,
   * both on the reasoning that a subtree export flattens different readerships into one artefact.
   * The payload carried no content, so what leaked was metadata between co-tenants — a named
   * colleague exported something, at 14:52 — which is the whole of what NOT_FOUND was hiding.
   *
   * The subject is read from the real `createRealtime`, so what is asserted is the subject the
   * module genuinely publishes on rather than a name this test made up.
   */
  const seen: { subject: string; msg: unknown }[] = []
  let realRealtime: Kernel['realtime']

  const swap = (next: Kernel['realtime']) => {
    ;(kernel as unknown as { realtime: Kernel['realtime'] }).realtime = next
  }

  beforeAll(() => {
    realRealtime = kernel.realtime
    swap(createRealtime(undefined, (subject, msg) => seen.push({ subject, msg })))
  })
  afterAll(() => swap(realRealtime))

  const entitiesOn = (subject: string): string[] =>
    seen
      .filter((row) => row.subject === subject)
      .map((row) => (row.msg as { change?: { entity?: string } }).change?.entity)
      .filter((entity): entity is string => typeof entity === 'string')

  it('says nothing on the workspace channel, and tells the person who asked', async () => {
    seen.length = 0
    const started = (await invoke(
      'exports.start',
      { workspaceId: WS_A, scope: 'space', targetId: spaceA, format: 'markdown' },
      alice(),
    )) as { id: string }
    await svc.exports.run(WS_A, started.id)

    const workspaceChannel = rtSubject.channel(channel.workspace(WS_A))
    expect(seen.length, 'the export announced nothing at all').toBeGreaterThan(0)
    expect(
      entitiesOn(workspaceChannel),
      'an export reached the channel every member of the workspace is joined to',
    ).toEqual([])
    // The object channel is the other half of `realtime.change`, and it is fanned out the same way.
    expect(entitiesOn(rtSubject.channel(channel.object(WS_A, 'quire', started.id)))).toEqual([])

    const own = entitiesOn(rtSubject.user(ALICE))
    expect(own, 'the person waiting on the dialog was not told their own job moved').toContain('export')
    // created, claimed, progress, done — the screen still gets every step, on their own subject.
    expect(own.length).toBeGreaterThan(1)
    expect(entitiesOn(rtSubject.user(BOB)), 'a colleague was told about it directly').toEqual([])
  })

  it('tells the workspace that the space changed, and only that, when an import lands in it', async () => {
    const target = (
      await runA((tx) =>
        svc.spaces.create(tx, alice(), WS_A, {
          key: 'announced',
          name: 'Announced',
          description: '',
          icon: null,
          visibility: 'open',
        }),
      )
    ).id
    seen.length = 0
    const started = (await invoke(
      'imports.start',
      { workspaceId: WS_A, spaceId: target, source: 'markdown', fileId: upload(MARKDOWN_ZIP, WS_A) },
      alice(),
    )) as { id: string }
    await svc.imports.run(WS_A, started.id)
    expect(
      (await runA((tx) => svc.imports.get(tx, WS_A, started.id, alice()))).state,
      'the import did not finish, so the announcements below are of nothing',
    ).toBe('done')

    /*
     * This is the line between the two, written as an assertion rather than as a comment: pages
     * arriving in a shared space is news for everyone whose sidebar draws that space — the same
     * change `pages.create` announces. *Which job* put them there is not.
     */
    const broadcast = entitiesOn(rtSubject.channel(channel.workspace(WS_A)))
    expect(broadcast).toContain('space')
    expect(broadcast, 'the import job itself was broadcast beside the space').not.toContain('import')
    expect(entitiesOn(rtSubject.user(ALICE))).toContain('import')
  })
})
