/**
 * Getting work out, against a real Postgres.
 *
 * Three things are worth proving here and nowhere else, and each of them is invisible to a type
 * check and to every other suite in this package.
 *
 *   1. **The archive is a real archive.** A zip written by hand is a container that either opens or
 *      does not, and a writer's own reader will happily agree with the writer's own misunderstanding
 *      — so the reader below is written against the specification (central directory, local header,
 *      `inflateRaw`) rather than against `writeZip`, and the same output was checked with the
 *      system `unzip` and with Python's `zipfile` while it was being written.
 *   2. **The permission is asked per page, as the requester.** A subtree export is the one operation
 *      in this module that reads a hundred pages at once on somebody's behalf, so the page-scoped
 *      DENY the whole permission model exists for has to hold against it. The test is written as an
 *      adversary: it does not ask whether the export refused, it takes the bytes it produced and
 *      looks for the withheld page's title in them.
 *   3. **A missing dependency fails cleanly.** Gotenberg is optional in every Kern deployment, so
 *      the PDF path has to end in a job that says what is wrong and an artefact that was never
 *      written — never a half file somebody finds out about by opening it.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import type { Principal } from '@kernhq/contracts'
import { createKernel, KernError, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { PAGE_DOC_NODES } from '@kernhq/ui/editor/page-doc'
import { call } from '@orpc/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { implement_ } from './_impl.js'
import { MARKDOWN_NODES } from './export/markdown.js'
import { quireModule } from './index.js'
import { exportArtefactKey } from './services/export.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_export_test_${Date.now().toString(36)}`

const WS = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>

// ---------------------------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------------------------

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

const alice = () => principal(ALICE)
const bob = () => principal(BOB)

interface Binding {
  subjectType: 'user'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
/** What core would answer for a workspace that has written a DENY. Set per test, cleared after. */
const bindings = new Map<string, Binding[]>()
const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

/** Documents the collab stub holds, as the real Yjs bytes a version is stored from. */
const documents = new Map<string, Buffer>()

/** Object storage, in memory. `presignGet` mints something that looks like what MinIO would. */
const objects = new Map<string, { body: Buffer; contentType: string }>()

/** Files core would answer for, so an exported picture has bytes to become. */
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
    'authz.bindings': { handler: async (input: { userId: string }) => bindings.get(input.userId) ?? [] },
    'settings.getModule': { handler: async () => ({}) },
    'files.get': { handler: async (input: { id: string }) => files.get(input.id) ?? null },
  })
}

/**
 * Storage in memory, installed over the real one.
 *
 * `presignGet` deliberately returns a URL with a signature and the object key in it — the shape the
 * real one returns — so the test that says "no presigned URL reached the archive" is looking for
 * something that would really be there if the code put one there.
 */
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
      objects.has(key) ? { contentLength: objects.get(key)!.body.length, contentType: 'x' } : null,
    delete: async (key: string) => {
      objects.delete(key)
    },
    presignGet: async (key: string, opts?: { filename?: string }) =>
      `https://storage.test/kern/${key}?X-Amz-Signature=deadbeef&filename=${opts?.filename ?? ''}`,
  }
  ;(k as unknown as { storage: unknown }).storage = stub
}

// ---------------------------------------------------------------------------------------------
// A zip reader, written against the format rather than against the writer
// ---------------------------------------------------------------------------------------------

/**
 * Every entry of a zip, by path.
 *
 * Deliberately not `writeZip` run backwards: it starts from the end-of-central-directory record,
 * walks the central directory, and re-reads each local header, which is what a real unzipper does.
 * A reader that shared the writer's assumptions would confirm them rather than check them.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
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
    if (buffer.readUInt32LE(at) !== 0x0201_4b50) throw new Error(`central directory entry ${n} is malformed`)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressed = buffer.readUInt32LE(at + 20)
    const uncompressed = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const offset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)

    if (buffer.readUInt32LE(offset) !== 0x0403_4b50) throw new Error(`${name} has no local header`)
    const localName = buffer.readUInt16LE(offset + 26)
    const localExtra = buffer.readUInt16LE(offset + 28)
    const start = offset + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== uncompressed) throw new Error(`${name} does not match its declared length`)
    if (crc32(data) !== crc) throw new Error(`${name} does not match its declared checksum`)
    out.set(name, data)
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

/** The same polynomial every zip uses, written out here so the reader owes the writer nothing. */
function crc32(data: Buffer): number {
  let c = 0xffff_ffff
  for (const byte of data) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffff_ffff) >>> 0
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const inWs =
  (workspaceId: string, actor?: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor?.userId ?? null })
const run = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS, alice())(fn)

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

const text = (value: string, attributes?: Record<string, unknown>) => {
  const node = new Y.XmlText()
  node.insert(0, value, attributes)
  return node
}
/**
 * Attribute values are whatever ProseMirror put there, not strings.
 *
 * `Y.XmlElement.setAttribute` is *typed* as taking a string and stores whatever it is given, and
 * y-prosemirror hands it the node's real attributes — so `taskItem.checked` in a document a browser
 * wrote is the boolean `true`, and `heading.level` is the number 2. A fixture that writes `'true'`
 * looks right, renders as unchecked in both the HTML renderer and the Markdown writer, and would
 * have this file passing against a document no editor produces.
 */
const element = (name: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => {
  const node = new Y.XmlElement(name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value as string)
  if (children.length > 0) node.insert(0, children as never[])
  return node
}
const paragraph = (...children: unknown[]) => element('paragraph', {}, children)

/** Yjs bytes for a page body, which is the only shape a stored version ever has. */
function yjs(build: () => unknown[]): Buffer {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, build() as never[])
  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return state
}

const documentName = (pageId: string) => `ws:${WS}:quire:page:${pageId}`

let spaceId = ''
const page = {
  root: '',
  child: '',
  secret: '',
  underSecret: '',
  pictured: '',
}

/** Create a page, give it a body, and take a version of it — the state an export reads. */
async function makePage(opts: {
  title: string
  parentId: string | null
  body: () => unknown[]
}): Promise<string> {
  const created = await run((tx) =>
    svc.pages.create(tx, alice(), WS, {
      spaceId,
      parentId: opts.parentId,
      title: opts.title,
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  documents.set(documentName(created.id), yjs(opts.body))
  await run((tx) => svc.versions.capture(tx, WS, created.id, { kind: 'auto', label: null, authorId: ALICE }))
  return created.id
}

const PICTURE_ID = randomUUID()
const PICTURE_KEY = `ws/${WS}/quire/2026/08/${PICTURE_ID}/diagram.png`
/** A one-pixel PNG. Real bytes, so "the picture came out" is about bytes and not about a name. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-export-test',
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
  installStorage(kernel)
  await kernel.start()
  svc = quireServices(kernel)
  router = implement_(kernel)

  const space = await run((tx) =>
    svc.spaces.create(tx, alice(), WS, {
      key: 'handbook',
      name: 'Company Handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  spaceId = space.id

  files.set(PICTURE_ID, {
    workspaceId: WS,
    name: 'diagram.png',
    mimeType: 'image/png',
    size: PICTURE.length,
    key: PICTURE_KEY,
    status: 'ready',
  })
  objects.set(PICTURE_KEY, { body: PICTURE, contentType: 'image/png' })

  page.root = await makePage({
    title: 'Handbook',
    parentId: null,
    body: () => [
      element('heading', { level: 2 }, [text('How we work')]),
      element('bulletList', {}, [
        element('listItem', {}, [paragraph(text('first'))]),
        element('listItem', {}, [paragraph(text('second'))]),
      ]),
      element('taskList', {}, [
        element('taskItem', { checked: true }, [paragraph(text('signed off'))]),
        element('taskItem', { checked: false }, [paragraph(text('still open'))]),
      ]),
      element('codeBlock', { language: 'sql' }, [text('select 1;')]),
      element('callout', { tone: 'warning' }, [paragraph(text('Mind the gap.'))]),
      element('table', {}, [
        element('tableRow', {}, [
          element('tableHeader', {}, [paragraph(text('Name'))]),
          element('tableHeader', {}, [paragraph(text('Role'))]),
        ]),
        element('tableRow', {}, [
          element('tableCell', {}, [paragraph(text('Ada'))]),
          element('tableCell', {}, [paragraph(text('Engineer'))]),
        ]),
      ]),
    ],
  })
  page.child = await makePage({
    title: 'Getting started',
    parentId: page.root,
    body: () => [paragraph(text('Welcome '), text('aboard', { bold: {} }))],
  })
  page.secret = await makePage({
    title: 'Redundancy plan Q4',
    parentId: page.root,
    body: () => [paragraph(text('Nobody may read this.'))],
  })
  page.underSecret = await makePage({
    title: 'Severance table',
    parentId: page.secret,
    body: () => [paragraph(text('Nor this.'))],
  })
  page.pictured = await makePage({
    title: 'With a picture',
    parentId: page.root,
    body: () => [
      paragraph(text('Here it is:')),
      paragraph(element('image', { fileId: PICTURE_ID, alt: 'A diagram' })),
    ],
  })
}, 180_000)

afterAll(async () => {
  bindings.clear()
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

/** Start a job as `who`, run it to completion, and hand back the row it finished as. */
async function exportNow(
  who: Principal,
  input: { scope: 'page' | 'subtree' | 'space'; targetId: string; format: 'markdown' | 'html' | 'pdf' },
) {
  const started = await run((tx) => svc.exports.start(tx, who, WS, input))
  await svc.exports.run(WS, started.id)
  const row = await run((tx) => svc.exports.get(tx, WS, started.id, who))
  return row
}

const artefactOf = (row: { fileId: string | null }): Buffer => {
  expect(row.fileId, 'the job finished without recording an artefact').not.toBeNull()
  const object = objects.get(exportArtefactKey(WS, row.fileId!))
  expect(object, 'the job recorded an artefact that is not in storage').toBeDefined()
  return object!.body
}

// ---------------------------------------------------------------------------------------------

describe('the Markdown writer', () => {
  /**
   * The same check `render.test.ts` makes of the HTML renderer, for the same reason: a node the
   * editor can produce and this file has no case for does not degrade into something plain — it
   * takes somebody's table out of the file without saying so.
   */
  it('has a case for every node a page can contain, and no case for one that cannot', () => {
    const missing = PAGE_DOC_NODES.filter((node) => !MARKDOWN_NODES.includes(node))
    expect(missing, 'these nodes would be silently lost from an exported Markdown file').toEqual([])
    const extra = MARKDOWN_NODES.filter((node) => !(PAGE_DOC_NODES as readonly string[]).includes(node))
    expect(extra, 'these writers are for nodes the schema no longer has').toEqual([])
  })
})

describe('a Markdown export', () => {
  it('writes a folder per page, with the page tree as the folder tree', async () => {
    const row = await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })
    expect(row.state, row.error ?? '').toBe('done')

    const zip = readZip(artefactOf(row))
    const paths = [...zip.keys()].sort()
    expect(paths).toContain('handbook/index.md')
    expect(paths).toContain('handbook/getting-started/index.md')
    expect(paths).toContain('handbook/redundancy-plan-q4/severance-table/index.md')

    const body = zip.get('handbook/index.md')!.toString('utf8')
    // The blocks a round trip has to survive, each in the dialect an importer can read back.
    expect(body).toContain('# Handbook')
    expect(body).toContain('## How we work')
    expect(body).toContain('- first')
    expect(body).toContain('- [x] signed off')
    expect(body).toContain('- [ ] still open')
    expect(body).toContain('```sql\nselect 1;\n```')
    expect(body).toContain('> [!WARNING]')
    expect(body).toContain('| Name | Role |')
    expect(body).toContain('| --- | --- |')
    expect(body).toContain('| Ada | Engineer |')

    expect(zip.get('handbook/getting-started/index.md')!.toString('utf8')).toContain('**aboard**')
  })

  it('counts what it wrote', async () => {
    const row = await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })
    expect(row.state).toBe('done')
    expect(row.counts).toEqual({ total: 5, done: 5, skipped: 0, failed: 0 })
  })

  it('takes one page for `page` and the whole space for `space`', async () => {
    const one = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'markdown' })
    expect([...readZip(artefactOf(one)).keys()]).toEqual(['getting-started/index.md'])

    const whole = await exportNow(alice(), { scope: 'space', targetId: spaceId, format: 'markdown' })
    expect([...readZip(artefactOf(whole)).keys()].filter((p) => p.endsWith('index.md'))).toHaveLength(5)
  })
})

describe('an HTML export', () => {
  it('is a file that stands alone', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.root, format: 'html' })
    expect(row.state, row.error ?? '').toBe('done')
    const html = readZip(artefactOf(row)).get('handbook/index.html')!.toString('utf8')

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html, 'a file with no stylesheet is a wall of unstyled text').toContain('.kern-prose')
    expect(html, 'the same renderer the public site uses, not a second one').toContain('class="kern-callout"')
    expect(html).toContain('<table')
    expect(html).toContain('data-type="taskItem"')
    // Dark mode is not decoration on a file somebody opens at night with nothing to set a theme.
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html, 'nothing in an exported file may be fetched from anywhere').not.toMatch(
      /<(script|link)\b|https?:\/\/(?!schema)/i,
    )
  })
})

describe('attachments', () => {
  it('come out as files beside the page, and never as a storage URL', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.pictured, format: 'html' })
    expect(row.state, row.error ?? '').toBe('done')
    const zip = readZip(artefactOf(row))

    expect([...zip.keys()].sort()).toEqual(['with-a-picture/index.html', 'with-a-picture/media/diagram.png'])
    expect(zip.get('with-a-picture/media/diagram.png')).toEqual(PICTURE)

    const html = zip.get('with-a-picture/index.html')!.toString('utf8')
    expect(html, 'the picture has to be addressed relative to the file it is beside').toContain(
      'src="media/diagram.png"',
    )
    // A `data:` URI is what the PDF path uses, where there is nowhere relative to point at. Using it
    // here would base64 every picture into the prose and roughly double what the archive weighs.
    expect(html, 'a zipped export points at the file beside it').not.toContain('data:image/png')

    /*
     * The leak this is here to stop, spelled out. A presigned GET *is* the object key — it carries
     * the workspace uuid and the file uuid — and it expires an hour after it is minted, so writing
     * one into a file somebody keeps is a leak and a broken picture at the same time. It shipped
     * once, into published HTML, and `migrations/0009` is what it cost.
     */
    const bytes = artefactOf(row).toString('latin1')
    expect(bytes, 'a signed storage URL reached an exported file').not.toContain('X-Amz-Signature')
    expect(bytes, "the tenant's workspace id has no business in an exported file").not.toContain(WS)
    expect(bytes, 'the storage key names the file uuid').not.toContain(PICTURE_KEY)
  })
})

describe('links between exported pages', () => {
  it('are relative paths inside the archive, and plain text for a page that is not in it', async () => {
    const outside = await makePage({
      title: 'Somewhere else',
      parentId: null,
      body: () => [paragraph(text('.'))],
    })
    const linking = await makePage({
      title: 'Links out',
      parentId: page.root,
      body: () => [
        paragraph(element('pageMention', { id: page.child, label: 'Getting started' })),
        paragraph(element('pageMention', { id: outside, label: 'Somewhere else' })),
      ],
    })

    const zip = readZip(
      artefactOf(await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })),
    )
    const body = zip.get('handbook/links-out/index.md')!.toString('utf8')
    expect(body).toContain('[Getting started](../getting-started/index.md)')
    expect(body, 'a link to a page nobody exported would be a dead link').toContain('Somewhere else')
    expect(body).not.toContain('[Somewhere else](')

    // Left where it is for the tests below: they count pages, and this one belongs to the tree now.
    await run((tx) => svc.pages.purge(tx, WS, linking))
    await run((tx) => svc.pages.purge(tx, WS, outside))
  })
})

/**
 * The adversary.
 *
 * Written as one, deliberately. A test that asserted "the export was refused" would pass against a
 * version of this code that refuses nothing and writes everything, because a subtree export is not
 * supposed to refuse — it is supposed to be a smaller file. So this one takes the bytes and looks
 * for what must not be in them.
 */
describe('a page a DENY closed to the person exporting', () => {
  it('is not in the archive, is not named in the archive, and is counted as skipped', async () => {
    // Nothing denied: the fixture really is in the tree, or the assertions below prove nothing.
    const open = readZip(
      artefactOf(await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })),
    )
    expect([...open.keys()]).toContain('handbook/redundancy-plan-q4/index.md')

    deny(ALICE, ['quire.page.view'], 'object', page.secret)
    const row = await exportNow(alice(), { scope: 'subtree', targetId: page.root, format: 'markdown' })
    bindings.clear()

    expect(row.state, row.error ?? '').toBe('done')
    const bytes = artefactOf(row)
    const zip = readZip(bytes)
    const paths = [...zip.keys()]

    expect(paths, 'the withheld page was written into the archive').not.toContain(
      'handbook/redundancy-plan-q4/index.md',
    )
    expect(
      paths.filter((p) => p.includes('redundancy-plan-q4')),
      'the withheld title survived as a folder name, which is the title',
    ).toEqual([])
    expect(
      paths,
      'the child of a withheld page kept its content, and its path would have printed the parent',
    ).not.toContain('handbook/redundancy-plan-q4/severance-table/index.md')
    expect(
      bytes.toString('utf8'),
      "the withheld page's title appears somewhere in the archive",
    ).not.toContain('Redundancy plan Q4')
    expect(bytes.toString('utf8'), 'the withheld prose is in the archive').not.toContain(
      'Nobody may read this',
    )
    expect(bytes.toString('utf8'), 'the withheld descendant is in the archive').not.toContain('Nor this')

    // What is left is still an export, and it says how much was left out.
    expect([...zip.keys()]).toContain('handbook/getting-started/index.md')
    expect(
      row.counts,
      'an export missing two pages that does not say so is worse than one that refuses',
    ).toEqual({ total: 5, done: 3, skipped: 2, failed: 0 })
  })
})

describe('the export procedures', () => {
  it('refuse a page-scoped DENY of quire.page.export', async () => {
    deny(ALICE, ['quire.page.export'], 'object', page.root)
    const outcome = await invoke(
      'exports.start',
      { workspaceId: WS, scope: 'subtree', targetId: page.root, format: 'markdown' },
      alice(),
    ).then(
      () => 'succeeded',
      (err) => (err instanceof KernError ? err.code : String(err)),
    )
    bindings.clear()
    expect(outcome).toBe('FORBIDDEN')
  })

  /**
   * The branch `authz.int.test.ts` cannot reach.
   *
   * Its sweep sends one input per procedure, and `exports.start`'s is a `page` export — so the
   * `space` branch, which asks the same permission at space scope because there is no page to
   * resolve, has nothing else looking at it.
   */
  it('refuse a space-scoped DENY when the scope is a whole space', async () => {
    deny(ALICE, ['quire.page.export'], 'space', spaceId)
    const outcome = await invoke(
      'exports.start',
      { workspaceId: WS, scope: 'space', targetId: spaceId, format: 'markdown' },
      alice(),
    ).then(
      () => 'succeeded',
      (err) => (err instanceof KernError ? err.code : String(err)),
    )
    bindings.clear()
    expect(outcome).toBe('FORBIDDEN')
  })

  it('hand one person nothing about another person s export', async () => {
    const mine = await run((tx) =>
      svc.exports.start(tx, alice(), WS, { scope: 'page', targetId: page.child, format: 'markdown' }),
    )

    const listed = (await invoke('exports.list', { workspaceId: WS }, bob())) as Array<{ id: string }>
    expect(
      listed.map((job) => job.id),
      'row-level security fences the tenant, which is not a privacy boundary — the requested_by filter is',
    ).not.toContain(mine.id)

    const outcome = await invoke('exports.get', { workspaceId: WS, jobId: mine.id }, bob()).then(
      () => 'succeeded',
      (err) => (err instanceof KernError ? err.code : String(err)),
    )
    expect(outcome, 'FORBIDDEN would confirm that this id names an export, which is the leak').toBe(
      'NOT_FOUND',
    )
  })

  it('mint the download link per request rather than storing one', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'markdown' })
    const detail = (await invoke('exports.get', { workspaceId: WS, jobId: row.id }, alice())) as {
      downloadUrl: string | null
      fileId: string | null
    }
    expect(detail.downloadUrl, 'a finished export with no way to fetch it is not finished').toContain(
      'X-Amz-Signature',
    )
    expect(detail.downloadUrl).toContain('filename=getting-started.zip')

    const queued = await run((tx) =>
      svc.exports.start(tx, alice(), WS, { scope: 'page', targetId: page.child, format: 'markdown' }),
    )
    const pending = (await invoke('exports.get', { workspaceId: WS, jobId: queued.id }, alice())) as {
      downloadUrl: string | null
    }
    expect(pending.downloadUrl, 'an artefact that is still being written must not be offered').toBeNull()
  })

  it('refuse docx now rather than after a job has run', async () => {
    await expect(
      invoke(
        'exports.start',
        { workspaceId: WS, scope: 'page', targetId: page.child, format: 'docx' },
        alice(),
      ),
    ).rejects.toThrow(/Word export is not available/i)
  })
})

describe('a PDF export with no Gotenberg behind it', () => {
  it('fails with something an operator can act on, and writes no file', async () => {
    const before = process.env.GOTENBERG_URL
    // A port nothing is listening on, in the reserved-for-documentation range of nothing at all:
    // the failure has to be the code's, not a lucky connection to something else on this machine.
    process.env.GOTENBERG_URL = 'http://127.0.0.1:9'
    const objectsBefore = objects.size
    try {
      const row = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'pdf' })
      expect(row.state).toBe('failed')
      expect(row.fileId, 'a failed job must not point at bytes').toBeNull()
      expect(row.error).toMatch(/Gotenberg/)
      expect(row.error, 'an operator needs the address it tried').toContain('127.0.0.1:9')
      expect(row.error, 'and the name of the thing they can change').toMatch(/GOTENBERG_URL/)
      expect(row.finishedAt, 'a terminal state has a time').not.toBeNull()
      expect(objects.size, 'a failed PDF export left a half file in storage').toBe(objectsBefore)
    } finally {
      if (before === undefined) delete process.env.GOTENBERG_URL
      else process.env.GOTENBERG_URL = before
    }
  })
})

describe('a job that has already finished', () => {
  it('is not run again by a retry', async () => {
    const row = await exportNow(alice(), { scope: 'page', targetId: page.child, format: 'markdown' })
    const first = row.fileId
    await svc.exports.run(WS, row.id)
    const again = await run((tx) => svc.exports.get(tx, WS, row.id, alice()))
    expect(again.fileId, 'a retry of a done job rewrote its artefact').toBe(first)
    expect(again.state).toBe('done')
  })
})
