/**
 * What a transfer does when its worker goes away.
 *
 * Every other suite here asks what a job does when it runs. This one asks what the *row* does when
 * the process running it stops existing, because that is the only failure the screens cannot draw
 * their way out of: `state` is what a spinner is bound to, and a row that says `running` for ever is
 * a page that spins for ever.
 *
 * The hole this guards was measured rather than reasoned about. A real pg-boss worker was started
 * against a real Postgres, an export was queued through the router, and the worker was SIGKILLed
 * while the row said `running`. Thirty seconds later the row still said `running`; after the pg-boss
 * job was put into its own terminal `failed` state — which is where it lands once its attempts are
 * used up — the row *still* said `running`, with `finished_at` null and no error. `kernel.jobs`
 * registers a handler and nothing else, so pg-boss giving up reaches pg-boss and stops there.
 *
 * So the module has to be able to end its own jobs, and these tests are about the two paths a screen
 * actually reads: the list the transfers screen polls, and the single job a dialog polls.
 *
 * The second half of the file is the opposite failure: not no worker, but **two**. pg-boss
 * re-dispatches a job that outlives `expireInSeconds`, whether or not the first attempt is still
 * going, so a job must be claimable exactly once.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { implement_ } from './_impl.js'
import { writeZip } from './export/zip.js'
import { quireModule } from './index.js'
import { pages } from './schema.js'
import { exportArtefactKey } from './services/export.js'
import { type QuireServices, quireServices } from './services/index.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_jobs_test_${Date.now().toString(36)}`

const WS = randomUUID()
const ALICE = randomUUID()
const FILE = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>
let spaceId = ''
let pageId = ''

const alice = (): Principal =>
  ({
    kind: 'user',
    userId: ALICE,
    email: 'alice@example.test',
    name: 'Alice',
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

function registerStubs(k: Kernel) {
  k.broker.register('collab', {
    'document.state': { handler: async () => ({ name: '', state: null, size: 0, updatedAt: null }) },
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
    'users.principal': { handler: async () => alice() },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
    'files.get': {
      handler: async (input: { id: string }) =>
        input.id === FILE
          ? {
              id: FILE,
              workspaceId: WS,
              status: 'ready',
              name: 'export.zip',
              key: ARCHIVE_KEY,
              size: ARCHIVE.length,
            }
          : null,
    },
  })
}

/**
 * Object storage in memory, so an artefact that is written can be counted.
 *
 * The whole point of the concurrency test below is *how many objects exist* after two attempts, so
 * this has to be a real map rather than a no-op: an orphan is an object nothing addresses, and you
 * cannot see one in a stub that throws its bytes away.
 */
const objects = new Map<string, { body: Buffer; contentType: string }>()

/** One page in a folder of Markdown — enough that a second import would be visible as a second page. */
const ARCHIVE = writeZip([
  { path: 'Twice.md', data: Buffer.from('# Twice\n\nOnce is the whole assertion.\n', 'utf8') },
])
const ARCHIVE_KEY = `ws/${WS}/core/2026/08/${FILE}/export.zip`

function installStorage(k: Kernel) {
  objects.set(ARCHIVE_KEY, { body: ARCHIVE, contentType: 'application/zip' })
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
    presignGet: async (key: string) => `https://storage.test/kern/${key}?X-Amz-Signature=deadbeef`,
  }
  ;(k as unknown as { storage: unknown }).storage = stub
}

const inWs = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  kernel.database.withWorkspace(WS, fn, { userId: ALICE })

const context = (): RequestContext => ({
  kernel,
  principal: alice(),
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
const invoke = (name: string, input: Record<string, unknown>) =>
  call(procedureAt(name) as never, input as never, { context: context() })

/**
 * Put a job where a killed worker leaves one: claimed, never finished, and old.
 *
 * Raw SQL because there is deliberately no service method that writes a row into this state — it is
 * not a state anything is *supposed* to produce, it is what is left behind when a process dies
 * between `run`'s claim and its `patch`.
 */
const strand = (table: 'export_jobs' | 'import_jobs', id: string, state: string, agedHours: number) =>
  inWs((tx) =>
    tx.execute(
      sql`update mod_quire.${sql.raw(table)}
             set state = ${state},
                 created_at = now() - ${`${agedHours} hours`}::interval
           where id = ${id}::uuid`,
    ),
  )

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-jobs-test',
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

  const space = await inWs((tx) =>
    svc.spaces.create(tx, alice(), WS, {
      key: 'handbook',
      name: 'Company Handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  spaceId = space.id
  const page = await inWs((tx) =>
    svc.pages.create(tx, alice(), WS, {
      spaceId,
      parentId: null,
      title: 'Handbook',
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  pageId = page.id
}, 60_000)

afterAll(async () => {
  await kernel?.stop()
  if (admin) {
    await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
    await admin.end()
  }
})

/** A row in the database, as the row rather than as whatever a procedure chose to answer with. */
async function rowOf(table: 'export_jobs' | 'import_jobs', id: string) {
  const found = await inWs((tx) =>
    tx.execute(sql`select state, error, finished_at from mod_quire.${sql.raw(table)} where id = ${id}::uuid`),
  )
  return (found as unknown as { rows: { state: string; error: string | null; finished_at: Date | null }[] })
    .rows[0]
}

const newExport = async (): Promise<string> => {
  const row = await inWs((tx) =>
    svc.exports.start(tx, alice(), WS, { scope: 'page', targetId: pageId, format: 'markdown' }),
  )
  return row.id
}

const newImport = async (): Promise<string> => {
  const row = await inWs((tx) =>
    svc.imports.start(tx, alice(), WS, { spaceId, source: 'notion', fileId: FILE }),
  )
  return row.id
}

describe('a transfer whose worker went away', () => {
  it('is reported failed by the list the transfers screen polls, not running for ever', async () => {
    const stranded = await newExport()
    const stillQueued = await newExport()
    await strand('export_jobs', stranded, 'running', 3)
    await strand('export_jobs', stillQueued, 'queued', 3)

    const rows = (await invoke('exports.list', { workspaceId: WS, limit: 20 })) as {
      id: string
      state: string
      error: string | null
      finishedAt: string | null
    }[]

    for (const id of [stranded, stillQueued]) {
      const seen = rows.find((row) => row.id === id)
      expect(seen, `job ${id} is in the list`).toBeDefined()
      expect(seen?.state).toBe('failed')
      // The reason has to be one an operator can act on, not `running`'s absence.
      expect(seen?.error ?? '').toMatch(/given up on/i)
      expect(seen?.finishedAt).not.toBeNull()
    }
  })

  it('is reported failed by the single job a dialog polls, which never reads the list', async () => {
    const id = await newExport()
    await strand('export_jobs', id, 'running', 3)

    const job = (await invoke('exports.get', { workspaceId: WS, jobId: id })) as {
      state: string
      error: string | null
      finishedAt: string | null
      downloadUrl: string | null
    }
    expect(job.state).toBe('failed')
    expect(job.error ?? '').toMatch(/given up on/i)
    expect(job.finishedAt).not.toBeNull()
    // Nothing was written, so nothing is offered: a failed export must never hand back a link.
    expect(job.downloadUrl).toBeNull()

    // and it is written down, not merely answered with
    const row = await rowOf('export_jobs', id)
    expect(row?.state).toBe('failed')
    expect(row?.finished_at).not.toBeNull()
  })

  it('leaves a job that is still inside its budget exactly where it is', async () => {
    const id = await newExport()
    // Half an hour in, an export is still within its three pg-boss attempts of fifteen minutes.
    await strand('export_jobs', id, 'running', 0.5)

    const job = (await invoke('exports.get', { workspaceId: WS, jobId: id })) as { state: string }
    expect(job.state).toBe('running')
    await invoke('exports.list', { workspaceId: WS, limit: 20 })
    expect((await rowOf('export_jobs', id))?.state).toBe('running')
  })

  it('ends an import the same way, and says the space was not half written', async () => {
    const listed = await newImport()
    const watched = await newImport()
    await strand('import_jobs', listed, 'running', 3)
    await strand('import_jobs', watched, 'queued', 3)

    const rows = (await invoke('imports.list', { workspaceId: WS, limit: 20 })) as {
      id: string
      state: string
      error: string | null
    }[]
    expect(rows.find((row) => row.id === listed)?.state).toBe('failed')

    const job = (await invoke('imports.get', { workspaceId: WS, jobId: watched })) as {
      state: string
      error: string | null
      report: unknown[]
    }
    expect(job.state).toBe('failed')
    // The thing somebody wants to know first about an import that did not finish.
    expect(job.error ?? '').toMatch(/nothing was written/i)
    expect(job.report).toEqual([])
  })
})

describe('a transfer two workers picked up at once', () => {
  /**
   * The defect this was written to find, and it found it.
   *
   * `run` used to `select` the row, check that it was not terminal, and then `update` it to
   * `running` — a lost update under READ COMMITTED, where both workers read `queued` and both write
   * `running`. Measured before the fix by calling `run` twice concurrently on one job: two artefacts
   * were `put` under two fresh uuids, the row named one of them, and the other became an object in
   * storage that nothing addresses. `sweep` deletes the object named by a row's `file_id`, so
   * nothing could ever reach it.
   *
   * It is reachable in production without any of the exotic failures: pg-boss re-dispatches a job
   * that outlives `expireInSeconds` — 900 for an export, which `MAX_PAGES = 5000` makes an ordinary
   * large space — whether or not the first attempt is still running.
   */
  const artefacts = () => [...objects.keys()].filter((key) => key.includes('/quire/exports/'))

  it('writes one artefact, not two, and leaves nothing in storage the row cannot name', async () => {
    const id = await newExport()
    const before = artefacts()

    await Promise.all([svc.exports.run(WS, id), svc.exports.run(WS, id)])

    const row = (await invoke('exports.get', { workspaceId: WS, jobId: id })) as {
      state: string
      fileId: string | null
      error: string | null
    }
    expect(row.state, row.error ?? '').toBe('done')
    const written = artefacts().filter((key) => !before.includes(key))
    expect(written, 'two attempts of one export wrote two archives').toHaveLength(1)
    // and the one that exists is the one the row points at, so `sweep` can reach it
    expect(written[0]).toBe(exportArtefactKey(WS, row.fileId as string))
  })

  it('imports the archive once, however many workers were handed the job', async () => {
    const target = (
      await inWs((tx) =>
        svc.spaces.create(tx, alice(), WS, {
          key: 'twice',
          name: 'Twice',
          description: '',
          icon: null,
          visibility: 'open',
        }),
      )
    ).id
    const id = await inWs((tx) =>
      svc.imports.start(tx, alice(), WS, { spaceId: target, source: 'markdown', fileId: FILE }),
    ).then((row) => row.id)

    await Promise.all([svc.imports.run(WS, id), svc.imports.run(WS, id)])

    const row = (await invoke('imports.get', { workspaceId: WS, jobId: id })) as {
      state: string
      error: string | null
    }
    expect(row.state, row.error ?? '').toBe('done')
    const written = await inWs((tx) =>
      tx
        .select({ title: pages.title })
        .from(pages)
        .where(and(eq(pages.workspaceId, WS), eq(pages.spaceId, target))),
    )
    // The reason an import has `retryLimit: 0`, made into an assertion: a second run is every page
    // in the archive a second time, and a person cannot tell the copies apart afterwards.
    expect(written.map((p) => p.title)).toEqual(['Twice'])
  })

  it('does not re-run a job that already finished, which is what makes a retry harmless', async () => {
    const id = await newExport()
    await svc.exports.run(WS, id)
    const first = (await invoke('exports.get', { workspaceId: WS, jobId: id })) as { fileId: string }
    const count = artefacts().length

    await svc.exports.run(WS, id)

    const again = (await invoke('exports.get', { workspaceId: WS, jobId: id })) as { fileId: string }
    expect(again.fileId, 'a repeat run replaced the artefact the download link points at').toBe(first.fileId)
    expect(artefacts()).toHaveLength(count)
  })
})
