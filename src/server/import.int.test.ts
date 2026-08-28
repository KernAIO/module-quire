/**
 * Getting work in, against a real Postgres and a real archive.
 *
 * Four things are worth proving here and nowhere else.
 *
 *   1. **The report says exactly what happened to every file.** A test that imports a clean zip is
 *      not a test of this feature: the whole point is the archive that does not fit. So the fixture
 *      below is a Notion export with a nested page, a title containing a slash its filename cannot
 *      hold, a database beside a second view of itself, a page that is a *row* of that database, a
 *      picture, an operating-system file, a file nothing can read, an entry whose bytes are corrupt,
 *      and a link to a page that was never exported — and every one of those gets an assertion on
 *      the row it produced, not merely on the total.
 *   2. **Nothing is written until the whole archive has been read.** Proved the only way it can be:
 *      by breaking the write half way through and then counting the pages in the space.
 *   3. **An import writes only into a space you may write to.** Written as an adversary — the test
 *      does not ask whether the call was refused, it goes and looks at whether the pages appeared.
 *   4. **The archive is a real archive and the writer is not the reader.** The zip in this file is
 *      built by hand, byte by byte, so it can carry things `../export/zip.ts` cannot produce: a
 *      broken checksum, an unsupported compression method, a stored entry beside a deflated one.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportReportEntry, ImportSource } from '../contract/index.js'
import { implement_ } from './_impl.js'
import { pageDocFromState } from './document.js'
import { pageDocToMarkdown } from './export/markdown.js'
import { markdownToPageDoc, splitTitle } from './import/markdown.js'
import { pageDocToYState } from './import/ydoc.js'
import { quireModule } from './index.js'
import { databases as databasesTable, pages, pageVersions, properties } from './schema.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_import_test_${Date.now().toString(36)}`

const WS = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>

// ---------------------------------------------------------------------------------------------
// A zip writer, by hand, so the fixture can be wrong on purpose
// ---------------------------------------------------------------------------------------------

interface ZipFixtureEntry {
  path: string
  data: Buffer
  /** 0 stored, 8 deflated, anything else so the reader can be shown refusing it */
  method?: number
  /** write a checksum that does not match, which is what a truncated download looks like */
  corrupt?: boolean
}

/**
 * The 1989 format: a local header per entry, then a central directory, then the end record.
 *
 * `declaredCount` overrides what the end record *claims* the directory holds, so the fixture can be
 * an archive that lists more files than it admits to — the one shape in which a file could reach the
 * reader and appear in no report row at all.
 */
function buildZip(entries: ZipFixtureEntry[], declaredCount = entries.length): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const method = entry.method ?? 8
    const body = method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data)
    const crc = entry.corrupt ? 0xdead_beef : crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0o100644 * 0x1_0000, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(declaredCount, 8)
  end.writeUInt16LE(declaredCount, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Written out rather than imported, so the fixture owes the reader under test nothing. */
function crc32(data: Buffer): number {
  let c = 0xffff_ffff
  for (const byte of data) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffff_ffff) >>> 0
}

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
const bindings = new Map<string, Binding[]>()
const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

/** Documents the collab stub holds, as the real Yjs bytes an import writes. */
const documents = new Map<string, Buffer>()

/** Set to make the nth `document.replace` throw, which is how the atomicity test breaks the write. */
let breakReplaceAfter: number | null = null
let replaceCalls = 0

/** Object storage, in memory: the uploaded archive lives here, keyed as core would key it. */
const objects = new Map<string, Buffer>()

/** Files core would answer for. `workspaceId` is what the import compares against, so it is real. */
const files = new Map<
  string,
  { workspaceId: string; name: string; size: number; key: string; status: string }
>()

/** Everything `core.search.index` was told about, so "an imported page is findable" is checkable. */
const indexed: Array<{ id: string; title: string; body: string }> = []

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
        replaceCalls++
        if (breakReplaceAfter !== null && replaceCalls > breakReplaceAfter)
          throw new Error('the collab service is unavailable')
        documents.set(input.name, Buffer.from(input.state, 'base64'))
        return { ok: true as const, size: 0 }
      },
    },
    'document.delete': { handler: async () => ({ ok: true as const }) },
  })
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': {
      handler: async (input: {
        documents: Array<{ object: { id: string }; title: string; body: string }>
      }) => {
        for (const doc of input.documents)
          indexed.push({ id: doc.object.id, title: doc.title, body: doc.body })
        return { ok: true }
      },
    },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async (input: { userId: string }) => bindings.get(input.userId) ?? [] },
    'settings.getModule': { handler: async () => ({}) },
    'files.get': { handler: async (input: { id: string }) => files.get(input.id) ?? null },
  })
}

function installStorage(k: Kernel) {
  const stub = {
    ...k.storage,
    put: async (key: string, body: Buffer | Uint8Array) => {
      objects.set(key, Buffer.from(body as Uint8Array))
    },
    get: async (key: string) => {
      const found = objects.get(key)
      if (!found) throw new Error(`no object at ${key}`)
      return { body: Readable.from(found), contentType: 'application/zip', contentLength: found.length }
    },
    head: async (key: string) =>
      objects.has(key) ? { contentLength: objects.get(key)!.length, contentType: 'x' } : null,
    delete: async (key: string) => {
      objects.delete(key)
    },
    presignGet: async (key: string) => `https://storage.test/${key}`,
  }
  ;(k as unknown as { storage: unknown }).storage = stub
}

/** Put an archive where an import will find it, and hand back the file id that names it. */
function upload(bytes: Buffer, opts: { workspaceId?: string; status?: string } = {}): string {
  const id = randomUUID()
  const key = `ws/${opts.workspaceId ?? WS}/quire/uploads/${id}/export.zip`
  objects.set(key, bytes)
  files.set(id, {
    workspaceId: opts.workspaceId ?? WS,
    name: 'export.zip',
    size: bytes.length,
    key,
    status: opts.status ?? 'ready',
  })
  return id
}

// ---------------------------------------------------------------------------------------------
// The fixture: a Notion export with everything that does not fit
// ---------------------------------------------------------------------------------------------

const ID = {
  handbook: '1111111111111111111111111111aaaa',
  started: '2222222222222222222222222222bbbb',
  handover: '3333333333333333333333333333cccc',
  tasks: '4444444444444444444444444444dddd',
  ship: '5555555555555555555555555555eeee',
  missing: '9999999999999999999999999999ffff',
}

const ROOT = 'Export-8f1c'
const PATH = {
  handbook: `${ROOT}/Company Handbook ${ID.handbook}.md`,
  started: `${ROOT}/Company Handbook ${ID.handbook}/Getting started ${ID.started}.md`,
  /** Notion's filename sanitiser has removed the slash; the `# ` heading inside still has it. */
  handover: `${ROOT}/Company Handbook ${ID.handbook}/Q3Q4 Handover ${ID.handover}.md`,
  tasks: `${ROOT}/Company Handbook ${ID.handbook}/Tasks ${ID.tasks}.csv`,
  tasksAll: `${ROOT}/Company Handbook ${ID.handbook}/Tasks ${ID.tasks}_all.csv`,
  ship: `${ROOT}/Company Handbook ${ID.handbook}/Tasks ${ID.tasks}/Ship the handbook ${ID.ship}.md`,
  picture: `${ROOT}/Company Handbook ${ID.handbook}/diagram.png`,
  unreadable: `${ROOT}/Company Handbook ${ID.handbook}/notes.pages`,
  broken: `${ROOT}/Company Handbook ${ID.handbook}/Broken page ${ID.missing}.md`,
  noise: `__MACOSX/${ROOT}/._Company Handbook ${ID.handbook}.md`,
}

/** The link a real Notion export writes: relative to the file, and percent-encoded. */
const link = (from: string, to: string) => {
  const fromDir = from.slice(0, from.lastIndexOf('/'))
  const relative = to.startsWith(`${fromDir}/`) ? to.slice(fromDir.length + 1) : to
  return relative.split('/').map(encodeURIComponent).join('/')
}

const HANDBOOK_MD = `# Company Handbook

How we work, and where everything is.

- See [Getting started](${link(PATH.handbook, PATH.started)}) first.
- Then [Q3/Q4 Handover](https://www.notion.so/Q3-Q4-Handover-${ID.handover}).
- The [Old wiki](${link(PATH.handbook, `${ROOT}/Archive/Old wiki ${ID.missing}.md`)}) has the rest.

![A diagram](${link(PATH.handbook, PATH.picture)})

> [!WARNING]
> Mind the gap.
`

const STARTED_MD = `# Getting started

Welcome **aboard**.

- [x] read the handbook
- [ ] meet the team

\`\`\`sql
select 1;
\`\`\`
`

const HANDOVER_MD = `# Q3/Q4 Handover

| Area | Owner |
| --- | --- |
| Docs | Ada |
`

const TASKS_CSV = `Name,Status,Due,Estimate,Done,Owner,Tags
Ship the handbook,In progress,2026-09-01,3.5,Yes,ada@example.test,"Docs, Urgent"
Review the draft,Todo,2026-09-15,1,No,grace@example.test,Docs
Archive the old wiki,Done,2026-10-01,2,Yes,ada@example.test,"Ops, Docs"
Plan the migration,Todo,2026-11-02,0.5,No,ada@example.test,Ops
`

const SHIP_MD = `# Ship the handbook

The last step before the announcement.
`

/** A one-pixel PNG. Real bytes, so "the picture was reported" is about a picture. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const NOTION_ZIP = buildZip([
  { path: PATH.handbook, data: Buffer.from(HANDBOOK_MD, 'utf8') },
  { path: PATH.started, data: Buffer.from(STARTED_MD, 'utf8') },
  { path: PATH.handover, data: Buffer.from(HANDOVER_MD, 'utf8') },
  { path: PATH.tasks, data: Buffer.from(TASKS_CSV, 'utf8') },
  { path: PATH.tasksAll, data: Buffer.from(TASKS_CSV, 'utf8') },
  { path: PATH.ship, data: Buffer.from(SHIP_MD, 'utf8') },
  // Stored rather than deflated, which is what an archiver does with a picture that will not shrink.
  { path: PATH.picture, data: PICTURE, method: 0 },
  { path: PATH.unreadable, data: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]) },
  {
    path: PATH.broken,
    data: Buffer.from('# Broken page\n\nNobody will read this.\n', 'utf8'),
    corrupt: true,
  },
  { path: PATH.noise, data: Buffer.from([0x00, 0x05]) },
])

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

let spaceId = ''
/** A second space, so "a space you may write to" is a question with two answers in one workspace. */
let closedSpaceId = ''

async function makeSpace(key: string, name: string): Promise<string> {
  const space = await run((tx) =>
    svc.spaces.create(tx, alice(), WS, { key, name, description: '', icon: null, visibility: 'open' }),
  )
  return space.id
}

/** Start an import as `who`, run it to completion, and hand back the finished job. */
async function importNow(who: Principal, into: string, fileId: string, source: ImportSource = 'notion') {
  const started = await run((tx) => svc.imports.start(tx, who, WS, { spaceId: into, source, fileId }))
  await svc.imports.run(WS, started.id)
  const row = await run((tx) => svc.imports.get(tx, WS, started.id, who))
  return svc.imports.toImportJob(row)
}

const pagesIn = (space: string) =>
  run((tx) =>
    tx
      .select()
      .from(pages)
      .where(and(eq(pages.workspaceId, WS), eq(pages.spaceId, space))),
  )

const rowFor = (report: ImportReportEntry[], path: string): ImportReportEntry => {
  const found = report.find((entry) => entry.path === path)
  expect(found, `the report has no row for ${path}`).toBeDefined()
  return found!
}

let job: Awaited<ReturnType<typeof importNow>>
let report: ImportReportEntry[]

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-import-test',
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

  spaceId = await makeSpace('handbook', 'Company Handbook')
  closedSpaceId = await makeSpace('finance', 'Finance')

  job = await importNow(alice(), spaceId, upload(NOTION_ZIP))
  report = job.report
}, 180_000)

afterAll(async () => {
  bindings.clear()
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

// ---------------------------------------------------------------------------------------------

describe('the report', () => {
  it('finishes, and accounts for every file in the archive', () => {
    expect(job.state, job.error ?? '').toBe('done')
    // The invariant the whole report rests on: a row per thing, and the counters are those rows.
    expect(job.counts.total).toBe(report.length)
    expect(job.counts.done + job.counts.skipped + job.counts.failed).toBe(report.length)
    for (const path of Object.values(PATH)) rowFor(report, path)
  })

  it('gives every file exactly one row, and adds a row for nothing that is not a file', () => {
    /*
     * The invariant that lets `counts` be read as a statement about the *upload*. A second row about
     * one file — the truncated-database note this used to write, say — makes `counts.skipped` count
     * something that was not skipped, and makes "23 of 40 files" a sentence nobody can check.
     */
    const archived = Object.values(PATH)
    for (const path of archived)
      expect(
        report.filter((entry) => entry.path === path),
        `${path} has more than one row`,
      ).toHaveLength(1)
    const notFiles = report.filter((entry) => !archived.includes(entry.path))
    expect(notFiles.map((entry) => entry.path)).toEqual([expect.stringContaining('Old wiki')])
  })

  it('says which of the three things happened to each file, and why', () => {
    expect(rowFor(report, PATH.handbook).outcome).toBe('imported')
    expect(rowFor(report, PATH.started).outcome).toBe('imported')
    expect(rowFor(report, PATH.handover).outcome).toBe('imported')

    // A database, and the second view of it that Notion writes beside every database.
    expect(rowFor(report, PATH.tasks).outcome).toBe('imported')
    const second = rowFor(report, PATH.tasksAll)
    expect(second.outcome).toBe('skipped')
    expect(second.reason).toContain(PATH.tasks)

    // A picture cannot be attached yet, and saying which limit it hit is the whole point of the row.
    const picture = rowFor(report, PATH.picture)
    expect(picture.outcome).toBe('skipped')
    expect(picture.reason).toMatch(/picture/i)

    const unreadable = rowFor(report, PATH.unreadable)
    expect(unreadable.outcome).toBe('skipped')
    expect(unreadable.reason).toMatch(/\.pages/)

    // A corrupt entry is `failed`, not `skipped`: it should have become a page and did not.
    const broken = rowFor(report, PATH.broken)
    expect(broken.outcome).toBe('failed')
    expect(broken.reason).toMatch(/checksum/i)

    const noise = rowFor(report, PATH.noise)
    expect(noise.outcome).toBe('skipped')
    expect(noise.reason).toMatch(/operating system/i)
  })

  it('names the link target the archive never held, and only once', () => {
    const missing = report.filter((entry) => entry.path.includes('Old wiki'))
    expect(missing, 'an unresolvable link produced no row, or produced several').toHaveLength(1)
    expect(missing[0]!.outcome).toBe('skipped')
    expect(missing[0]!.reason).toMatch(/nothing in the archive/i)
    expect(missing[0]!.reason).toContain('Company Handbook')
  })

  it('says what it guessed each database column was', () => {
    const reason = rowFor(report, PATH.tasks).reason ?? ''
    expect(reason).toContain("the first column, Name, became each row's title")
    expect(reason).toContain('Status: read as a select')
    expect(reason).toContain('Due: read as a date')
    expect(reason).toContain('Estimate: read as a number')
    expect(reason).toContain('Done: read as a checkbox')
    expect(reason).toContain('Owner: read as an email address')
    expect(reason).toContain('Tags: read as a multi-select')
  })

  it('reads in the order the archive lists its files', () => {
    const order = report.map((entry) => entry.path)
    expect(order.indexOf(PATH.handbook)).toBeLessThan(order.indexOf(PATH.started))
    expect(order.indexOf(PATH.tasks)).toBeLessThan(order.indexOf(PATH.picture))
    // The rows for link targets that are not files at all come after every file.
    expect(order.findIndex((path) => path.includes('Old wiki'))).toBeGreaterThan(order.indexOf(PATH.noise))
  })
})

describe('the pages it made', () => {
  it('rebuilds the tree Notion spelled with folders', async () => {
    const rows = await pagesIn(spaceId)
    const byTitle = new Map(rows.map((row) => [row.title, row]))

    const handbook = byTitle.get('Company Handbook')
    const started = byTitle.get('Getting started')
    expect(handbook, 'the top-level page is missing').toBeDefined()
    expect(started, 'the nested page is missing').toBeDefined()
    expect(started!.parentId).toBe(handbook!.id)
    expect(handbook!.parentId).toBeNull()
  })

  it('takes the title from the heading, not from the filename Notion could write', async () => {
    const rows = await pagesIn(spaceId)
    /*
     * The case this whole assertion exists for. Notion cannot put a `/` in a filename, so the file is
     * called `Q3Q4 Handover <id>.md` while the page is called `Q3/Q4 Handover` — and taking the title
     * from the filename imports every such page under a name nobody chose.
     */
    expect(rows.map((row) => row.title)).toContain('Q3/Q4 Handover')
    expect(rows.map((row) => row.title)).not.toContain('Q3Q4 Handover')
  })

  it('writes the body into the live document and into a version, not just one of them', async () => {
    const rows = await pagesIn(spaceId)
    const started = rows.find((row) => row.title === 'Getting started')!

    const live = documents.get(`ws:${WS}:quire:page:${started.id}`)
    expect(live, 'the page has no live document, so the editor would open it blank').toBeDefined()
    const doc = pageDocFromState(live!)
    expect(doc?.content?.map((node) => node.type)).toEqual(['paragraph', 'taskList', 'codeBlock'])

    const [version] = await run((tx) =>
      tx
        .select()
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, WS), eq(pageVersions.pageId, started.id))),
    )
    expect(version, 'the page arrived with no history').toBeDefined()
    expect(version!.kind).toBe('import')
    expect(version!.text).toContain('Welcome aboard')
    // The version is what an export and a publication read, so it has to be the same bytes.
    expect(Buffer.from(version!.state).equals(live!)).toBe(true)
  })

  it('keeps the blocks the Markdown carried', async () => {
    const rows = await pagesIn(spaceId)
    const started = rows.find((row) => row.title === 'Getting started')!
    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${started.id}`)!)
    const tasks = doc?.content?.find((node) => node.type === 'taskList')
    expect(tasks?.content?.map((item) => item.attrs?.checked)).toEqual([true, false])
    const code = doc?.content?.find((node) => node.type === 'codeBlock')
    expect(code?.attrs?.language).toBe('sql')
    expect(code?.content?.[0]?.text).toBe('select 1;')

    const handover = rows.find((row) => row.title === 'Q3/Q4 Handover')!
    const table = pageDocFromState(documents.get(`ws:${WS}:quire:page:${handover.id}`)!)?.content?.[0]
    expect(table?.type).toBe('table')
    expect(table?.content?.[0]?.content?.map((cell) => cell.type)).toEqual(['tableHeader', 'tableHeader'])
  })

  it('puts the imported pages in the search index', () => {
    expect(indexed.map((doc) => doc.title)).toContain('Q3/Q4 Handover')
    expect(indexed.find((doc) => doc.title === 'Getting started')?.body).toContain('Welcome aboard')
  })
})

describe('the links between imported pages', () => {
  it('rewrites a relative link to the page it names', async () => {
    const rows = await pagesIn(spaceId)
    const handbook = rows.find((row) => row.title === 'Company Handbook')!
    const started = rows.find((row) => row.title === 'Getting started')!
    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${handbook.id}`)!)

    const mentions = collect(doc, 'pageMention')
    expect(mentions.map((node) => node.attrs?.id)).toContain(started.id)
    expect(mentions.find((node) => node.attrs?.id === started.id)?.attrs?.label).toBe('Getting started')
  })

  it('rewrites a notion.so address by the page id inside it', async () => {
    const rows = await pagesIn(spaceId)
    const handbook = rows.find((row) => row.title === 'Company Handbook')!
    const handover = rows.find((row) => row.title === 'Q3/Q4 Handover')!
    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${handbook.id}`)!)
    expect(collect(doc, 'pageMention').map((node) => node.attrs?.id)).toContain(handover.id)
  })

  it('leaves an unresolvable link as plain text rather than a link that goes nowhere', async () => {
    const rows = await pagesIn(spaceId)
    const handbook = rows.find((row) => row.title === 'Company Handbook')!
    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${handbook.id}`)!)

    /*
     * The words survive, joined to their neighbours rather than standing alone — which is itself the
     * evidence the mark went. A run of text carrying no marks is one `Y.XmlText` delta, so "The ",
     * "Old wiki" and " has the rest." only merge into one node once the link mark is off the middle
     * one. A dead link would still be its own node, wearing its `link` mark.
     */
    const texts = collect(doc, 'text')
    expect(texts.map((node) => node.text).join('|')).toContain('The Old wiki has the rest.')
    const links = texts.filter((node) => (node.marks ?? []).some((mark) => mark.type === 'link'))
    expect(
      links.map((node) => node.text),
      'a link that goes nowhere is still drawn as a link',
    ).toEqual([])
  })

  it('drops a picture it cannot attach rather than drawing a broken one', async () => {
    const rows = await pagesIn(spaceId)
    const handbook = rows.find((row) => row.title === 'Company Handbook')!
    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${handbook.id}`)!)
    expect(collect(doc, 'image')).toHaveLength(0)
    // The prose around it survived, which is the difference between dropping a node and dropping a block.
    expect(collect(doc, 'callout')).toHaveLength(1)
  })
})

describe('the database it made', () => {
  it('creates one database, on a page of its own, with the guessed column types', async () => {
    const [database] = await run((tx) =>
      tx.select().from(databasesTable).where(eq(databasesTable.workspaceId, WS)),
    )
    expect(database, 'the CSV did not become a database').toBeDefined()
    expect(database!.name).toBe('Tasks')

    const [host] = await run((tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, WS), eq(pages.id, database!.pageId))),
    )
    expect(host!.kind).toBe('database')
    const rows = await pagesIn(spaceId)
    expect(host!.parentId).toBe(rows.find((row) => row.title === 'Company Handbook')!.id)

    const columns = await run((tx) =>
      tx
        .select()
        .from(properties)
        .where(and(eq(properties.workspaceId, WS), eq(properties.databaseId, database!.id))),
    )
    const byName = new Map(columns.map((column) => [column.name, column]))
    expect(byName.get('Status')?.type).toBe('select')
    expect(byName.get('Due')?.type).toBe('date')
    expect(byName.get('Estimate')?.type).toBe('number')
    expect(byName.get('Done')?.type).toBe('checkbox')
    expect(byName.get('Owner')?.type).toBe('email')
    expect(byName.get('Tags')?.type).toBe('multi_select')
    // The seeded `Name` column is gone: the CSV's first column is the row title, not a column.
    expect(byName.has('Name')).toBe(false)
  })

  it('writes each cell under the key its own column reads', async () => {
    const [database] = await run((tx) =>
      tx.select().from(databasesTable).where(eq(databasesTable.workspaceId, WS)),
    )
    const columns = await run((tx) =>
      tx
        .select()
        .from(properties)
        .where(and(eq(properties.workspaceId, WS), eq(properties.databaseId, database!.id))),
    )
    const keyOf = (name: string) => columns.find((column) => column.name === name)!.key

    const rows = await run((tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, WS), eq(pages.databaseId, database!.id))),
    )
    expect(rows).toHaveLength(4)
    const ship = rows.find((row) => row.title === 'Ship the handbook')!
    const props = ship.props as Record<string, unknown>

    expect(props[keyOf('Due')]).toBe('2026-09-01')
    expect(props[keyOf('Estimate')]).toBe(3.5)
    expect(props[keyOf('Done')]).toBe(true)
    expect(props[keyOf('Owner')]).toBe('ada@example.test')
    // A multi-select stores an array of option ids; a select stores one id, not an array — a select
    // holding `["in-progress"]` matches no filter anybody can write. See `csv.ts`.
    expect(props[keyOf('Tags')]).toEqual(['docs', 'urgent'])
    expect(props[keyOf('Status')]).toBe('in-progress')

    const status = columns.find((column) => column.name === 'Status')!
    expect(
      (status.config as { options: Array<{ id: string; label: string }> }).options.map((o) => o.label),
    ).toEqual(['In progress', 'Todo', 'Done'])
  })

  it('gives a row the page body the archive carried for it', async () => {
    const [database] = await run((tx) =>
      tx.select().from(databasesTable).where(eq(databasesTable.workspaceId, WS)),
    )
    const rows = await run((tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, WS), eq(pages.databaseId, database!.id))),
    )
    const ship = rows.find((row) => row.title === 'Ship the handbook')!
    // The row's own `.md` is reported against the row it belongs to, not as a page beside it.
    expect(rowFor(report, PATH.ship).pageId).toBe(ship.id)
    expect(ship.text).toContain('The last step before the announcement.')
  })
})

describe('a zip that fails half way', () => {
  it('leaves the space exactly as it was', async () => {
    const space = await makeSpace('rollback', 'Rollback')
    const before = await pagesIn(space)
    expect(before).toHaveLength(0)

    // The write reaches the collab service once and then cannot. Everything before that point —
    // every page row, every property, every database — is already in the transaction.
    replaceCalls = 0
    breakReplaceAfter = 1
    const failed = await importNow(alice(), space, upload(NOTION_ZIP))
    breakReplaceAfter = null

    expect(failed.state).toBe('failed')
    expect(failed.error).toMatch(/collab service is unavailable/)
    expect(
      replaceCalls,
      'the write never got as far as the failure it is meant to be testing',
    ).toBeGreaterThan(1)

    const after = await pagesIn(space)
    expect(after, 'a failed import left pages behind').toHaveLength(0)
    const [database] = await run((tx) =>
      tx
        .select()
        .from(databasesTable)
        .where(and(eq(databasesTable.workspaceId, WS), eq(databasesTable.spaceId, space))),
    )
    expect(database, 'a failed import left a database behind').toBeUndefined()
  })

  it('refuses an upload that is not a zip, before touching the space', async () => {
    const space = await makeSpace('not-a-zip', 'Not a zip')
    const failed = await importNow(alice(), space, upload(Buffer.from('this is a text file, not an archive')))
    expect(failed.state).toBe('failed')
    expect(failed.error).toMatch(/not a zip archive/i)
    expect(await pagesIn(space)).toHaveLength(0)
  })

  it('refuses an upload belonging to another workspace', async () => {
    const space = await makeSpace('other-tenant', 'Other tenant')
    const foreign = upload(NOTION_ZIP, { workspaceId: randomUUID() })
    await expect(
      run((tx) => svc.imports.start(tx, alice(), WS, { spaceId: space, source: 'notion', fileId: foreign })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await pagesIn(space)).toHaveLength(0)
  })
})

describe('the permission, written as an adversary', () => {
  it('refuses an import into a space this person may not write to, and writes nothing', async () => {
    deny(BOB, ['quire.page.import'], 'space', closedSpaceId)
    await expect(
      invoke(
        'imports.start',
        { workspaceId: WS, spaceId: closedSpaceId, source: 'notion', fileId: upload(NOTION_ZIP) },
        bob(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    bindings.clear()
    expect(await pagesIn(closedSpaceId), 'a refused import still wrote pages').toHaveLength(0)
  })

  it('refuses when the permission is taken away between queueing and running', async () => {
    const space = await makeSpace('revoked', 'Revoked')
    const started = await run((tx) =>
      svc.imports.start(tx, bob(), WS, { spaceId: space, source: 'notion', fileId: upload(NOTION_ZIP) }),
    )

    /*
     * The gap this closes. A job runs minutes after it was queued, and an import *writes* — so
     * checking only at the moment of the request means a permission taken away in between is a
     * permission that did not hold. The job asks again, as the person who asked for it.
     */
    deny(BOB, ['quire.page.import'], 'space', space)
    await svc.imports.run(WS, started.id)
    bindings.clear()

    const row = await run((tx) => svc.imports.get(tx, WS, started.id, bob()))
    expect(svc.imports.toImportJob(row).state).toBe('failed')
    expect(await pagesIn(space), 'the job wrote pages a revoked permission should have stopped').toHaveLength(
      0,
    )
  })

  it('does not name somebody else’s import, and answers NOT_FOUND rather than FORBIDDEN', async () => {
    await expect(invoke('imports.get', { workspaceId: WS, jobId: job.id }, bob())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const mine = (await invoke('imports.list', { workspaceId: WS }, bob())) as Array<{ id: string }>
    expect(mine.map((entry) => entry.id)).not.toContain(job.id)
  })

  it('leaves the report out of a listing and keeps it in a single read', async () => {
    const listed = (await invoke('imports.list', { workspaceId: WS }, alice())) as Array<
      Record<string, unknown>
    >
    const summary = listed.find((entry) => entry.id === job.id)
    expect(summary, 'the import is not in its own author’s list').toBeDefined()
    expect('report' in summary!, 'a listing carried every report row').toBe(false)

    const one = (await invoke('imports.get', { workspaceId: WS, jobId: job.id }, alice())) as {
      report: unknown[]
    }
    expect(one.report.length).toBe(report.length)
  })
})

// ---------------------------------------------------------------------------------------------
// The readers, on their own — no database, no kernel
// ---------------------------------------------------------------------------------------------

describe('a Quire export read back in', () => {
  /**
   * The round trip the Markdown writer exists for.
   *
   * `../export/markdown.ts` writes every block in the dialect an importer can recognise, and this is
   * the only thing that checks the claim. It is written against the *writer's own output* rather than
   * against a file typed by hand, so a change to either side that breaks the pairing fails here.
   */
  it('comes back as the same blocks it went out as', () => {
    const original: PageDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'How we work' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Welcome ' },
            { type: 'text', text: 'aboard', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'onwards', marks: [{ type: 'italic' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'signed off' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still open' }] }],
            },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'select 1;' }] },
        {
          type: 'callout',
          attrs: { tone: 'warning' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mind the gap.' }] }],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Somebody said this.' }] }],
        },
        { type: 'horizontalRule' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Role' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ada' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pipe | here' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
            {
              type: 'detailsContent',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden until asked.' }] }],
            },
          ],
        },
      ],
    }

    const markdown = pageDocToMarkdown(original)
    const back = markdownToPageDoc(markdown)
    expect(back.content).toEqual(original.content)
  })

  it('takes the title back off the top of the file', () => {
    const markdown = `# Company Handbook\n\n${pageDocToMarkdown({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body.' }] }],
    })}`
    const { title, body } = splitTitle(markdown)
    expect(title).toBe('Company Handbook')
    expect(markdownToPageDoc(body).content?.[0]?.type).toBe('paragraph')
  })
})

describe('the Yjs writer', () => {
  /**
   * The other round trip, and the one nothing else could catch.
   *
   * `document.ts` reads a page out of Yjs without a ProseMirror schema; `import/ydoc.ts` writes one
   * back the same way. Nothing type-checks the pairing — the bytes are opaque — so the only honest
   * check is to write a document and read it back with the reader every other part of the module
   * uses. Attribute *types* are the part that goes wrong silently: a `checked` written as the string
   * `'true'` renders as unchecked everywhere and looks perfect in the source.
   */
  it('produces bytes the module’s own reader decodes as the same document', () => {
    const doc = markdownToPageDoc(STARTED_MD)
    const back = pageDocFromState(pageDocToYState(doc))
    /*
     * Compared against the *stored* shape rather than against the parser's output, because the two
     * differ in one way that is the decoder's doing and not a loss: a mark with no attributes comes
     * back carrying `attrs: {}`. Every document in Quire has been through this round trip — the
     * editor writes Yjs and `document.ts` reads it — so `{ type: 'bold', attrs: {} }` is what a
     * stored document looks like, and asserting the parser's shape would be asserting a shape
     * nothing in the module ever holds.
     */
    expect(back?.content).toEqual(storedShape(doc).content)

    const task = back?.content?.find((node) => node.type === 'taskList')?.content?.[0]
    expect(task?.attrs?.checked, 'checked came back as a string, which renders as unchecked').toBe(true)
    const heading = pageDocFromState(
      pageDocToYState({ type: 'doc', content: [{ type: 'heading', attrs: { level: 3 }, content: [] }] }),
    )
    expect(heading?.content?.[0]?.attrs?.level, 'a heading level came back as a string').toBe(3)
  })

  it('folds a run of text into one Y.XmlText, as an editor would', () => {
    const doc: PageDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a ' },
            { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' c' },
          ],
        },
      ],
    }
    const back = pageDocFromState(pageDocToYState(doc))
    expect(back?.content?.[0]?.content?.map((node) => node.text)).toEqual(['a ', 'b', ' c'])
    expect(back?.content?.[0]?.content?.[1]?.marks?.map((mark) => mark.type)).toEqual(['bold'])
  })
})

/**
 * The archive that is nasty in the four ways the fixture above is not.
 *
 * Its own archive and its own space rather than more files in `NOTION_ZIP`, so the counts every
 * assertion up there is written against stay what they are. Each case here is one that produced a
 * report saying something untrue:
 *
 *   - a link to a file the archive **does** hold but that did not become a page — an attachment, a
 *     picture, a second database view, a `.md` whose bytes are damaged. `ctx.keys` was built from the
 *     pages rather than from the archive, so every one of those was reported "nothing in the archive
 *     is at this path", which is false, and gave the file a **second row** on top of triage's — which
 *     is what makes `counts.total` stop being a statement about the upload.
 *   - two rows of one database called the same thing, which Notion writes as two `.md` files called
 *     the same thing. A `Map` of title → row keeps the last, so both files matched one row: the first
 *     body was thrown away, both files were reported `imported`, and both rows carried the *same*
 *     page id.
 *   - a picture whose file the archive never held. It was dropped from the document and appeared in
 *     no row at all — the only silent drop left in the reader.
 *   - a file with no extension, described as "a file with no extension file".
 */
describe('an archive that lies are easy about', () => {
  const RID = {
    guide: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0001',
    rota: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0002',
    ada1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0003',
    ada2: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0004',
    ada3: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0005',
    gone: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0006',
  }
  const ROOT2 = 'Export-4b7a'
  const RPATH = {
    guide: `${ROOT2}/Guide ${RID.guide}.md`,
    attachment: `${ROOT2}/handbook.pdf`,
    notice: `${ROOT2}/NOTICE`,
    rota: `${ROOT2}/Rota ${RID.rota}.csv`,
    rotaAll: `${ROOT2}/Rota ${RID.rota}_all.csv`,
    ada1: `${ROOT2}/Rota ${RID.rota}/Ada ${RID.ada1}.md`,
    ada2: `${ROOT2}/Rota ${RID.rota}/Ada ${RID.ada2}.md`,
    ada3: `${ROOT2}/Rota ${RID.rota}/Ada ${RID.ada3}.md`,
  }
  const MISSING_PICTURE = `${ROOT2}/never-exported.png`
  const GONE = `${ROOT2}/Archive/Gone ${RID.gone}.md`

  const GUIDE_MD = `# Guide

- The [handbook](${link(RPATH.guide, RPATH.attachment)}) is beside this file.
- The [notice](${link(RPATH.guide, RPATH.notice)}) is too.
- The [other view](${link(RPATH.guide, RPATH.rotaAll)}) is a second view of the rota.
- The [old wiki](${link(RPATH.guide, GONE)}) is not in the export at all.

![A picture nobody exported](${link(RPATH.guide, MISSING_PICTURE)})
`

  /** Two rows called the same thing, which is a database a person is entitled to have. */
  const ROTA_CSV = `Name,Shift
Ada,Morning
Ada,Evening
Grace,Night
`

  const HONEST_ZIP = buildZip([
    { path: RPATH.guide, data: Buffer.from(GUIDE_MD, 'utf8') },
    { path: RPATH.attachment, data: Buffer.from('%PDF-1.4 not really\n', 'utf8') },
    { path: RPATH.notice, data: Buffer.from('AGPL-3.0-only\n', 'utf8') },
    { path: RPATH.rota, data: Buffer.from(ROTA_CSV, 'utf8') },
    { path: RPATH.rotaAll, data: Buffer.from(ROTA_CSV, 'utf8') },
    { path: RPATH.ada1, data: Buffer.from('# Ada\n\nADA-BODY-ONE\n', 'utf8') },
    { path: RPATH.ada2, data: Buffer.from('# Ada\n\nADA-BODY-TWO\n', 'utf8') },
    // A third file for a title only two rows carry: surplus, and it has to say so.
    { path: RPATH.ada3, data: Buffer.from('# Ada\n\nADA-BODY-THREE\n', 'utf8') },
  ])
  const ARCHIVED = [
    RPATH.guide,
    RPATH.attachment,
    RPATH.notice,
    RPATH.rota,
    RPATH.rotaAll,
    RPATH.ada1,
    RPATH.ada2,
    RPATH.ada3,
  ]

  let honestSpace = ''
  let done: Awaited<ReturnType<typeof importNow>>
  let rows: ImportReportEntry[]

  beforeAll(async () => {
    honestSpace = await makeSpace('honest', 'Honest')
    done = await importNow(alice(), honestSpace, upload(HONEST_ZIP))
    rows = done.report
  }, 60_000)

  it('gives every file in the archive exactly one row, and nothing else a file row', () => {
    expect(done.state, done.error ?? '').toBe('done')
    expect(done.counts.total).toBe(rows.length)
    for (const path of ARCHIVED)
      expect(
        rows.filter((entry) => entry.path === path).map((entry) => entry.reason),
        `${path} does not have exactly one row`,
      ).toHaveLength(1)
    // Exactly two rows are not files, and both name something the archive genuinely does not hold.
    expect(
      rows
        .filter((entry) => !ARCHIVED.includes(entry.path))
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([GONE, MISSING_PICTURE].sort())
  })

  it('never says a file the archive holds is not in the archive', () => {
    const held = new Set(ARCHIVED)
    const lies = rows.filter(
      (entry) => held.has(entry.path) && /nothing in the archive is at this path/.test(entry.reason ?? ''),
    )
    expect(
      lies.map((entry) => entry.path),
      'a file that is right there was reported missing',
    ).toEqual([])

    // What each of those files should say instead — its own reason, written by whoever left it out.
    expect(rowFor(rows, RPATH.attachment).reason).toMatch(/attachment/i)
    expect(rowFor(rows, RPATH.rotaAll).reason).toContain(RPATH.rota)
    expect(rowFor(rows, RPATH.notice).reason).toBe(
      'a file with no extension, which an import has no way to read as a page',
    )
  })

  it('accounts for a picture the archive never held instead of dropping it in silence', () => {
    const picture = rowFor(rows, MISSING_PICTURE)
    expect(picture.outcome).toBe('skipped')
    expect(picture.reason).toMatch(/nothing in the archive is at this path/)
    // A dead picture is not "now plain text" — that is what happens to a dead link, next to it.
    expect(picture.reason).toMatch(/picture/)
    expect(rowFor(rows, GONE).reason).toMatch(/plain text/)
  })

  it('gives two rows of one name two pages, and keeps both bodies', async () => {
    const claimed = rows.filter((entry) => entry.pageId).map((entry) => entry.pageId!)
    expect(
      claimed.filter((id, at) => claimed.indexOf(id) !== at),
      'two files were reported as one page, so one file’s body is nowhere',
    ).toEqual([])

    const text = (await pagesIn(honestSpace)).map((row) => row.text).join('\n')
    expect(text, 'the first of two rows with one name lost its body').toContain('ADA-BODY-ONE')
    expect(text).toContain('ADA-BODY-TWO')
  })

  it('says which file a surplus row page lost out to, rather than claiming no such row exists', () => {
    const surplus = rowFor(rows, RPATH.ada3)
    expect(surplus.outcome).toBe('skipped')
    expect(surplus.pageId).toBeNull()
    // "no row is called Ada" would be a lie: there are two, and both already have a page.
    expect(surplus.reason).toContain('already has a page')
    expect(surplus.reason).toContain(RPATH.ada2)
    expect(rowFor(rows, RPATH.ada1).outcome).toBe('imported')
    expect(rowFor(rows, RPATH.ada2).outcome).toBe('imported')
  })

  it('refuses an archive that admits to fewer files than its list holds', async () => {
    /*
     * The last way a file could vanish without a row. The reader walks exactly as many directory
     * headers as the end record claims, so an archive listing three files and claiming two was read
     * as two — the third imported nothing, reported nothing, and counted as nothing. Everything else
     * that goes wrong with a file becomes a row; a file nobody read cannot, so the archive is refused
     * whole rather than imported short.
     */
    const target = await makeSpace('short-count', 'Short count')
    const short = buildZip(
      [
        { path: 'Short/One 11111111111111111111111111110001.md', data: Buffer.from('# One\n\na\n') },
        { path: 'Short/Two 11111111111111111111111111110002.md', data: Buffer.from('# Two\n\nb\n') },
        { path: 'Short/Three 1111111111111111111111111110003.md', data: Buffer.from('# Three\n\nc\n') },
      ],
      2,
    )
    const refused = await importNow(alice(), target, upload(short))
    expect(refused.state).toBe('failed')
    expect(refused.error).toMatch(/file list holds more/)
    expect(await pagesIn(target), 'a short-counted archive was imported anyway').toHaveLength(0)
  })

  it('leaves a space that already has pages exactly as it was when the write fails', async () => {
    const target = await makeSpace('occupied', 'Occupied')
    const seeded = await run((tx) =>
      svc.pages.create(tx, alice(), WS, {
        spaceId: target,
        parentId: null,
        title: 'Already here',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    /*
     * The rollback test above imports into an *empty* space, so it cannot see an import that damages
     * what was already there — a reordered tree, or a page adopted by an imported parent. Here the
     * whole row is compared, not the count.
     */
    const before = (await pagesIn(target)).map(
      (row) => `${row.id}|${row.title}|${row.position}|${row.parentId}`,
    )
    expect(before).toHaveLength(1)

    replaceCalls = 0
    breakReplaceAfter = 2
    const failed = await importNow(alice(), target, upload(NOTION_ZIP))
    breakReplaceAfter = null

    expect(failed.state).toBe('failed')
    expect(replaceCalls, 'the write never reached the failure').toBeGreaterThan(2)
    expect(
      (await pagesIn(target)).map((row) => `${row.id}|${row.title}|${row.position}|${row.parentId}`),
    ).toEqual(before)
    expect((await pagesIn(target))[0]!.id).toBe(seeded.id)
  })
})

describe('a Confluence export', () => {
  const page = (title: string, body: string, crumbs: string) => `<!DOCTYPE html>
<html><head><title>Handbook : ${title}</title></head><body>
<div id="breadcrumb-section"><ol class="breadcrumb"><li><a href="index.html">Handbook</a></li>${crumbs}</ol></div>
<h1 id="title-heading"><span id="title-text">${title}</span></h1>
<div id="main-content" class="wiki-content">${body}</div>
</body></html>`

  it('rebuilds the tree from the breadcrumbs and reads the macros it can', async () => {
    const space = await makeSpace('confluence', 'From Confluence')
    const zip = buildZip([
      {
        path: 'Handbook_65601.html',
        data: Buffer.from(page('Team handbook', '<p>How we <strong>work</strong>.</p>', ''), 'utf8'),
      },
      {
        path: 'Onboarding_65602.html',
        data: Buffer.from(
          page(
            'Onboarding',
            [
              '<div class="confluence-information-macro confluence-information-macro-warning">',
              '<div class="confluence-information-macro-body"><p>Mind the gap.</p></div></div>',
              '<ul class="inline-task-list"><li class="checked"><span>read this</span></li>',
              '<li class="unchecked"><span>meet the team</span></li></ul>',
              '<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: sql">select 1;</pre>',
              '<p>See <a href="Handbook_65601.html">the handbook</a>.</p>',
            ].join(''),
            '<li><a href="Handbook_65601.html">Team handbook</a></li>',
          ),
          'utf8',
        ),
      },
      { path: 'index.html', data: Buffer.from('<html><body><h1>Handbook</h1></body></html>', 'utf8') },
      { path: 'styles/site.css', data: Buffer.from('body{}', 'utf8') },
      { path: 'attachments/65602/1/diagram.png', data: PICTURE, method: 0 },
    ])

    const done = await importNow(alice(), space, upload(zip), 'confluence' as never)
    expect(done.state, done.error ?? '').toBe('done')

    const rows = await run((tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, WS), eq(pages.spaceId, space))),
    )
    const handbook = rows.find((row) => row.title === 'Team handbook')!
    const onboarding = rows.find((row) => row.title === 'Onboarding')!
    expect(onboarding.parentId, 'the breadcrumb did not become the tree').toBe(handbook.id)

    const doc = pageDocFromState(documents.get(`ws:${WS}:quire:page:${onboarding.id}`)!)
    expect(collect(doc, 'callout')[0]?.attrs?.tone).toBe('warning')
    expect(collect(doc, 'taskItem').map((node) => node.attrs?.checked)).toEqual([true, false])
    expect(collect(doc, 'codeBlock')[0]?.content?.[0]?.text).toBe('select 1;')
    expect(collect(doc, 'pageMention')[0]?.attrs?.id, 'a link between two pages was not rewritten').toBe(
      handbook.id,
    )

    // The export's own furniture is reported rather than silently swallowed.
    const report = done.report
    expect(rowFor(report, 'index.html').reason).toMatch(/index of pages/i)
    expect(rowFor(report, 'styles/site.css').reason).toMatch(/styling/i)
    expect(rowFor(report, 'attachments/65602/1/diagram.png').reason).toMatch(/attachment/i)
    expect(done.counts.total).toBe(report.length)
  })
})

/**
 * A document as Yjs stores it: every mark carries an `attrs`, even an empty one.
 *
 * y-prosemirror's reader sets `mark.attrs` unconditionally, so a `bold` written with no attributes
 * decodes with `attrs: {}`. It is normalisation rather than loss — nothing reads a mark's attributes
 * without checking its type first — but a round-trip assertion has to expect the stored shape or it
 * fails on a difference that is not a defect.
 */
function storedShape(doc: PageDoc): PageDoc {
  const walk = (node: PageDoc): PageDoc => ({
    ...node,
    ...(node.marks ? { marks: node.marks.map((mark) => ({ ...mark, attrs: mark.attrs ?? {} })) } : {}),
    ...(node.content ? { content: node.content.map(walk) } : {}),
  })
  return walk(doc)
}

/** Every node of a type, anywhere in the document. */
function collect(doc: PageDoc | null | undefined, type: string): PageDoc[] {
  const out: PageDoc[] = []
  const walk = (node: PageDoc) => {
    if (node.type === type) out.push(node)
    for (const child of node.content ?? []) walk(child)
  }
  if (doc) walk(doc)
  return out
}
