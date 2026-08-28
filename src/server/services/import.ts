/**
 * Getting work *in* — a Notion export, a Confluence export or a folder of Markdown, into one space.
 *
 * Five decisions run through the whole file and are worth having in one place.
 *
 * **1. Nothing is written until the whole archive has been read.** The readers in `../import/` turn
 * an upload into a *plan* — pages with ids, databases with columns, and a row in the report for every
 * file — and this file writes that plan in one transaction. So a zip that fails half way through
 * leaves the space exactly as it was, and there is no state in which a person has to work out which
 * two hundred of their four hundred pages arrived. It also means an import's cost is paid twice in
 * memory, which is what {@link MAX_ARCHIVE_BYTES} and `plan.ts`'s own limits are for.
 *
 * **2. The report is the feature.** Every file gets a row saying whether it became a page, was
 * deliberately left out, or could not be read, and `counts.total` is exactly `report.length` — so
 * nothing in the archive is unaccounted for. A link that named a file the archive does not hold gets
 * a row too. An import that silently drops forty pages is worse than one that refuses.
 *
 * **3. The permission is asked twice, and the second time is the one that counts.** `imports.start`
 * checks it before recording the row; the job checks it again, as the person who asked, at the moment
 * it writes. A job runs minutes after it was queued and a permission can be taken away in between —
 * and unlike an export, which only reads, the consequence of getting that wrong is somebody's pages
 * in somebody else's space.
 *
 * **4. A page's content goes to the collab service *inside* the transaction.** A page in Quire is a
 * row plus a live document, and a row with no document is a blank page in the editor whatever the
 * version history says. `collab.document.replace` is therefore called before the version is written
 * and inside the transaction, so a collab service that is down fails the import rather than importing
 * four hundred empty pages. The cost is stated rather than hidden: a failure at that point can leave
 * documents behind for pages that no longer exist, which are unreachable — nothing addresses a
 * document but the page id — and are what `collab.document.delete` is for when a page is purged.
 *
 * **5. Nothing is swept.** Unlike an export, an import produces no artefact and keeps nothing alive
 * in storage: the archive is the requester's own uploaded file and the report is a few hundred
 * kilobytes of text. The rows are the record of a `dangerous` operation, which is exactly the thing
 * worth still having in three months, so they stay. `exports.sweep` exists because an artefact costs
 * storage; there is no equivalent here and adding one would only delete evidence.
 */
import type { core, Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { initialRank, rankBetween } from '../../client/rank.js'
import type { ImportJob, ImportReportEntry, ImportSource, TransferCounts } from '../../contract/index.js'
import { MODULE_ID } from '../../contract/index.js'
import { type ImportPlan, planImport } from '../import/plan.js'
import { pageDocToYState } from '../import/ydoc.js'
import { readZip } from '../import/zip.js'
import { textFromPageDoc } from '../render.js'
import { importJobs, pages, pageVersions, spaces } from '../schema.js'
import type { QuireAccess } from './access.js'
import type { QuireDatabases } from './databases.js'
import { documentNameOf } from './pages.js'

type ImportRow = typeof importJobs.$inferSelect

/**
 * How long a job may sit un-finished before it is given up on.
 *
 * The same hole as an export's, and worse here on both counts. `retryLimit: 0` means a worker
 * killed mid-import is never re-tried, so the row is `running` from the moment the process dies —
 * and decision 5 above means nothing ever deletes it either, so unlike an export it does not even
 * age out of the list. A row that says "running" a month later is a screen telling somebody their
 * pages are still on their way.
 *
 * Two hours is the job's whole budget with room to spare: `quireJobs` gives `import`
 * `expireInSeconds: 3600` and one attempt. Nothing legitimate is still running after it, and a job
 * that is has already been abandoned by the queue.
 */
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000

/**
 * What a job that lost its worker says.
 *
 * It leads with the thing somebody wants to know before anything else, which is the same thing the
 * dialog says about every other import failure: the write is one transaction, so an import that did
 * not finish did not half-finish.
 */
const ABANDONED =
  'This import stopped before it finished and was given up on after two hours. The worker running ' +
  'it went away — usually a restart, or an archive too big for the memory it had. Nothing was ' +
  'written: an import is one transaction, so the space is exactly as it was. Upload it again.'

/** Neither `done` nor `failed`, and old enough that nothing is still going to happen to it. */
const isAbandoned = (row: { state: string; createdAt: Date }): boolean =>
  (row.state === 'queued' || row.state === 'running') &&
  row.createdAt.getTime() < Date.now() - ABANDONED_AFTER_MS

/**
 * The largest archive one job will read.
 *
 * The plan is built in memory before anything is written — see the note at the top — so the limit is
 * about what one worker may hold rather than about what a person may upload. The zip reader has its
 * own, stricter limit on what an archive *unpacks* to.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** Rows written at a time, so a four-thousand-page import is not four thousand round trips. */
const BATCH = 200

const countsOf = (value: unknown): TransferCounts => {
  const raw = (value ?? {}) as Partial<Record<keyof TransferCounts, unknown>>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)
  return { total: n(raw.total), done: n(raw.done), skipped: n(raw.skipped), failed: n(raw.failed) }
}

/**
 * The stored report, parsed rather than cast.
 *
 * The column is jsonb written by a previous release of this module, so a cast promises fields that
 * may not be there. Anything unreadable is dropped rather than thrown: a report is a record of what
 * happened, and failing to *show* one would be a worse answer than showing what is legible.
 */
function reportOf(value: unknown): ImportReportEntry[] {
  if (!Array.isArray(value)) return []
  const out: ImportReportEntry[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Partial<ImportReportEntry>
    if (typeof entry.path !== 'string') continue
    if (entry.outcome !== 'imported' && entry.outcome !== 'skipped' && entry.outcome !== 'failed') continue
    out.push({
      path: entry.path,
      outcome: entry.outcome,
      pageId: typeof entry.pageId === 'string' ? entry.pageId : null,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
    })
  }
  return out
}

export function toImportJob(row: ImportRow): ImportJob {
  return {
    id: row.id,
    workspaceId: row.workspaceId as ImportJob['workspaceId'],
    requestedBy: row.requestedBy as ImportJob['requestedBy'],
    source: row.source as ImportSource,
    targetId: row.targetId,
    sourceFileId: row.sourceFileId,
    state: row.state as ImportJob['state'],
    error: row.error,
    counts: countsOf(row.counts),
    report: reportOf(row.report),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** Counters over report rows, which is what makes `total` equal to the number of rows in it. */
export function countReport(report: ImportReportEntry[]): TransferCounts {
  return {
    total: report.length,
    done: report.filter((entry) => entry.outcome === 'imported').length,
    skipped: report.filter((entry) => entry.outcome === 'skipped').length,
    failed: report.filter((entry) => entry.outcome === 'failed').length,
  }
}

export function quireImport(kernel: Kernel, access: QuireAccess, databases: QuireDatabases) {
  /** The row, or `notFound`. Fenced to the person who asked for it, exactly as an export is. */
  async function own(tx: Tx, workspaceId: string, jobId: string, principal: Principal): Promise<ImportRow> {
    const [row] = await tx
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, jobId)))
      .limit(1)
    if (!row) throw KernError.notFound('Import')
    /*
     * NOT_FOUND rather than FORBIDDEN, the same as an export and for a related reason: a report names
     * every file in somebody's archive, which is a listing of what they had somewhere else. "That one
     * is not yours" would confirm that a colleague imported something, and when.
     */
    const mine =
      principal.instanceAdmin || principal.kind === 'service' || row.requestedBy === principal.userId
    if (!mine) throw KernError.notFound('Import')
    return row
  }

  /**
   * Tell the one person whose job this is that it moved — and nobody else.
   *
   * `kernel.realtime.change` publishes to the **workspace** channel, which the gateway joins every
   * socket to at `hello` with no per-message filter — right for a page, wrong for a transfer. `own()`
   * answers NOT_FOUND rather than FORBIDDEN so that an id belonging to somebody else's import
   * confirms nothing, and then the broadcast told the whole workspace that a job with that id
   * changed, and when. `services/export.ts` carries the long version of this note.
   */
  async function announce(workspaceId: string, requestedBy: string, jobId: string): Promise<void> {
    await kernel.realtime
      .toUser(requestedBy, {
        t: 'change',
        workspaceId: workspaceId as ImportJob['workspaceId'],
        change: { module: 'quire', entity: 'import', id: jobId, op: 'updated' },
      })
      .catch(() => undefined)
  }

  async function patch(
    workspaceId: string,
    requestedBy: string,
    jobId: string,
    values: Partial<ImportRow>,
  ): Promise<void> {
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(importJobs)
        .set(values)
        .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, jobId)))
    })
    await announce(workspaceId, requestedBy, jobId)
  }

  /**
   * The uploaded archive's bytes, checked against the tenant that is asking for them.
   *
   * The workspace is **compared here rather than trusted**. `core.files.get` answers a service
   * principal without a membership check — that is what makes it callable from a module at all — and
   * `fileId` came from the request, so this comparison is the only thing stopping one workspace
   * naming another's upload and having Quire unpack it into a space of its own.
   */
  async function archiveBytes(workspaceId: string, fileId: string): Promise<Buffer> {
    const file = await kernel
      .call<{ workspaceId: string; name: string; size: number; key: string; status: string } | null>(
        'core.files.get',
        { id: fileId },
      )
      .catch(() => null)
    if (!file || file.workspaceId !== workspaceId) throw KernError.notFound('File')
    if (file.status !== 'ready' || !file.key)
      throw KernError.badRequest('That upload has not finished. Wait for it to appear, then import it.')
    if (file.size > MAX_ARCHIVE_BYTES)
      throw KernError.badRequest(
        `That archive is ${Math.round(file.size / 1_048_576)} MB, and one import may carry ` +
          `${MAX_ARCHIVE_BYTES / 1_048_576} MB. Export it in smaller pieces — one space at a time.`,
      )

    const object = await kernel.storage.get(file.key)
    const chunks: Buffer[] = []
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }

  /**
   * May this person still write here?
   *
   * Both keys, and both at space scope. `quire.page.import` is the one that says the bulk shape is
   * available at all; `quire.page.create` is "a space you may write to", which is a different
   * question a workspace can answer differently — a space closed for editing during a freeze is
   * closed to an import as well, and reading only the import key would walk straight past that.
   */
  async function requireWritable(principal: Principal, workspaceId: string, spaceId: string): Promise<void> {
    await access.requireSpace(principal, 'quire.page.import', workspaceId, spaceId)
    await access.requireSpace(principal, 'quire.page.create', workspaceId, spaceId)
  }

  /**
   * Write the plan.
   *
   * One transaction, in an order that is not arbitrary: pages before databases, because a database
   * hangs on a page; properties before rows, because a row's cells are keyed by the properties'
   * *actual* keys; and documents last, because a document is the only part that leaves the database.
   */
  async function write(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    spaceId: string,
    plan: ImportPlan,
  ): Promise<void> {
    /*
     * Imported pages land after whatever the space already has, so an import never reorders the tree
     * somebody built. The rank is chained from the last existing root rather than minted per page:
     * `rankBetween(last, null)` is only strictly increasing if each call sees the previous answer.
     */
    const [lastRoot] = await tx
      .select({ position: pages.position })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.spaceId, spaceId),
          isNull(pages.parentId),
          isNull(pages.deletedAt),
        ),
      )
      .orderBy(desc(pages.position))
      .limit(1)

    const tail = new Map<string | null, string | null>([[null, lastRoot?.position ?? null]])
    const nextPosition = (parentId: string | null): string => {
      const previous = tail.get(parentId) ?? null
      const position = previous === null ? initialRank() : rankBetween(previous, null)
      tail.set(parentId, position)
      return position
    }

    const now = new Date()
    const rows = plan.pages.map((page) => ({
      id: page.id,
      workspaceId,
      spaceId,
      parentId: page.parentId,
      position: nextPosition(page.parentId),
      kind: 'page',
      title: page.title.slice(0, 500),
      text: textFromPageDoc(page.doc),
      createdBy: principal.userId,
      updatedBy: principal.userId,
      createdAt: now,
      updatedAt: now,
    }))
    for (let at = 0; at < rows.length; at += BATCH) await tx.insert(pages).values(rows.slice(at, at + BATCH))

    const documents: Array<{ pageId: string; doc: PageDoc }> = plan.pages
      .filter((page) => (page.doc.content ?? []).length > 0)
      .map((page) => ({ pageId: page.id, doc: page.doc }))

    for (const planned of plan.databases) {
      const database = await databases.create(tx, principal, workspaceId, {
        spaceId,
        pageId: planned.hostPageId,
        name: planned.name.slice(0, 200),
        inline: false,
      })
      /*
       * `databases.create` seeds a text column called `Name`, which is right for a database somebody
       * creates by hand and wrong for one that arrives with its own columns: the CSV's first column
       * is the row *title*, so the seeded one would sit beside the title, empty, in every view.
       */
      for (const seeded of database.properties) await databases.removeProperty(tx, workspaceId, seeded.id)

      const keys: string[] = []
      for (const column of planned.columns) {
        const property = await databases.addProperty(tx, workspaceId, database.id, {
          name: column.name.slice(0, 120),
          type: column.type,
          config: column.config,
        })
        keys.push(property.key)
      }

      const rowRows = planned.rows.map((row) => {
        const props: Record<string, unknown> = {}
        // Zipped against the keys the database actually minted — never against a key guessed here.
        row.values.forEach((value, index) => {
          const key = keys[index]
          if (key !== undefined && value !== null) props[key] = value
        })
        return {
          id: row.id,
          workspaceId,
          spaceId,
          parentId: planned.hostPageId,
          position: nextPosition(planned.hostPageId),
          kind: 'page',
          title: row.title.slice(0, 500),
          text: textFromPageDoc(row.doc),
          databaseId: database.id,
          props,
          createdBy: principal.userId,
          updatedBy: principal.userId,
          createdAt: now,
          updatedAt: now,
        }
      })
      for (let at = 0; at < rowRows.length; at += BATCH)
        await tx.insert(pages).values(rowRows.slice(at, at + BATCH))

      for (const row of planned.rows)
        if ((row.doc.content ?? []).length > 0) documents.push({ pageId: row.id, doc: row.doc })
    }

    /*
     * The document, then the version — in that order and both inside the transaction.
     *
     * `versions.capture` is not used here on purpose: it reads the state back from the collab service
     * and returns *null* when it cannot, so an import would quietly produce pages with no history at
     * all. The bytes are already in hand, so the row is written from them directly, and a collab
     * service that will not take the document fails the import instead.
     */
    for (const { pageId, doc } of documents) {
      const state = pageDocToYState(doc)
      await kernel.call('collab.document.replace', {
        name: documentNameOf({ workspaceId, id: pageId }),
        state: state.toString('base64'),
      })
      await tx.insert(pageVersions).values({
        id: uuidv7(),
        workspaceId,
        pageId,
        kind: 'import',
        label: null,
        state,
        // `Y.encodeSnapshot` needs a document somebody has edited; a version with no snapshot simply
        // cannot be diffed against another, which is true of the first version of every page.
        snapshot: null,
        text: textFromPageDoc(doc),
        size: state.length,
        authorId: principal.userId ?? null,
      })
    }
  }

  /**
   * Put the imported pages in the workspace search index.
   *
   * Best effort, after the transaction: a page that is not findable until somebody edits it is a real
   * defect — three hundred pages nobody can search for is most of what an import is *for* — and a
   * search service that is briefly down must not undo an import that has already committed.
   *
   * The rule about *which* pages are indexed lives in `server/index.ts`'s `searchDocument`, and is
   * repeated rather than imported because importing it would make this file and the module definition
   * depend on each other. There is exactly one rule to keep in step: only a space whose visibility is
   * `open` is indexed at all, because `SearchDocument.acl` cannot yet express who may read a
   * restricted space.
   */
  async function indexPages(workspaceId: string, spaceId: string, plan: ImportPlan): Promise<void> {
    try {
      const found = await kernel.database.withWorkspace(workspaceId, async (tx) => {
        const [space] = await tx
          .select({ key: spaces.key, visibility: spaces.visibility })
          .from(spaces)
          .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, spaceId)))
          .limit(1)
        if (space?.visibility !== 'open') return null
        const rows = await tx
          .select({
            id: pages.id,
            title: pages.title,
            text: pages.text,
            kind: pages.kind,
            updatedAt: pages.updatedAt,
          })
          .from(pages)
          .where(and(eq(pages.workspaceId, workspaceId), eq(pages.spaceId, spaceId)))
          .orderBy(asc(pages.id))
        return { space, rows }
      })
      if (!found) return

      const imported = new Set([
        ...plan.pages.map((page) => page.id),
        ...plan.databases.flatMap((database) => database.rows.map((row) => row.id)),
      ])
      const documents: core.SearchDocument[] = found.rows
        .filter((row) => imported.has(row.id))
        .map((row) => ({
          workspaceId: workspaceId as core.SearchDocument['workspaceId'],
          object: { module: MODULE_ID, type: 'page', id: row.id },
          title: row.title || 'Untitled',
          body: row.text,
          url: `/quire/${found.space.key}/${row.id}`,
          icon: 'file-text',
          acl: null,
          updatedAt: row.updatedAt.toISOString(),
          attributes: { spaceId, kind: row.kind },
        }))
      for (let at = 0; at < documents.length; at += BATCH)
        await kernel.call('core.search.index', { documents: documents.slice(at, at + BATCH) })
    } catch (err) {
      kernel.log.warn({ err: String(err), spaceId }, 'quire: imported pages could not be indexed')
    }
  }

  return {
    toImportJob,

    /**
     * Record the request and hand it to a worker.
     *
     * Nothing is read here beyond the file's own header: a zip of thousands of files is unbounded
     * work, so the request answers with a row somebody can watch. What *is* done here is every check
     * that can be made cheaply and would otherwise fail a minute later in a worker nobody is
     * watching — the space exists, the caller may write to it, the file is this workspace's and has
     * finished uploading.
     */
    async start(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: { spaceId: string; source: ImportSource; fileId: string },
    ): Promise<ImportRow> {
      const userId = principal.userId
      if (!userId)
        throw new KernError('FORBIDDEN', 'An import belongs to a person, and this caller is a service')

      await access.spaceRow(tx, workspaceId, input.spaceId)
      await requireWritable(principal, workspaceId, input.spaceId)

      const file = await kernel
        .call<{ workspaceId: string; status: string } | null>('core.files.get', { id: input.fileId })
        .catch(() => null)
      if (!file || file.workspaceId !== workspaceId) throw KernError.notFound('File')
      if (file.status !== 'ready')
        throw KernError.badRequest('That upload has not finished. Wait for it to appear, then import it.')

      const [row] = await tx
        .insert(importJobs)
        .values({
          id: uuidv7(),
          workspaceId,
          requestedBy: userId,
          source: input.source,
          targetId: input.spaceId,
          sourceFileId: input.fileId,
          state: 'queued',
          counts: { total: 0, done: 0, skipped: 0, failed: 0 },
          report: [],
        })
        .returning()
      if (!row) throw new KernError('INTERNAL', 'The import could not be recorded')
      return row
    },

    /**
     * One job, and the one place a *watched* job can give up on itself.
     *
     * The dialog polls this and never the list, so `reap` — which runs beside the list — would never
     * reach the row somebody is actually looking at. One row rather than a workspace-wide update,
     * because this is on a path that runs every second and a half while a job is moving.
     */
    async get(tx: Tx, workspaceId: string, jobId: string, principal: Principal): Promise<ImportRow> {
      const row = await own(tx, workspaceId, jobId, principal)
      if (!isAbandoned(row)) return row
      const [failed] = await tx
        .update(importJobs)
        .set({ state: 'failed', error: ABANDONED, finishedAt: new Date() })
        .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, jobId)))
        .returning()
      return failed ?? row
    },

    /**
     * Fail this workspace's abandoned jobs, so a dead one stops reading as work in progress.
     *
     * This is not the sweep decision 5 above argues against, and the difference is the whole point:
     * a sweep would *delete* the record of a dangerous operation, and this writes down that it did
     * not happen. The row stays, with a reason on it.
     *
     * Called from `imports.start` and `imports.list`, which is the same opportunistic shape
     * `exports.sweep` explains: every tenant table is under FORCE row-level security keyed on
     * `app.workspace_id`, and Quire keeps no `workspaces` table, so a cron job has nothing to
     * enumerate. The limit is the same one and is worth stating: a workspace nobody comes back to
     * keeps its lie until somebody looks. The transfers list polls every two seconds while anything
     * is running, so in practice the screen being lied to is the one that ends it.
     */
    async reap(tx: Tx, workspaceId: string): Promise<number> {
      const abandoned = await tx
        .update(importJobs)
        .set({ state: 'failed', error: ABANDONED, finishedAt: new Date() })
        .where(
          and(
            eq(importJobs.workspaceId, workspaceId),
            inArray(importJobs.state, ['queued', 'running']),
            lt(importJobs.createdAt, new Date(Date.now() - ABANDONED_AFTER_MS)),
          ),
        )
        .returning({ id: importJobs.id })
      return abandoned.length
    },

    /** This person's own imports, newest first. Somebody else's are not listed and cannot be. */
    list(tx: Tx, workspaceId: string, principal: Principal, limit: number): Promise<ImportRow[]> {
      const userId = principal.userId
      if (!userId) return Promise.resolve([])
      return tx
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.requestedBy, userId)))
        .orderBy(desc(importJobs.createdAt))
        .limit(limit)
    },

    /**
     * Mark a job failed without having run it.
     *
     * One caller: the router, when the queue refuses the job it has just recorded. Without it the row
     * sits `queued` for ever and reads as work in progress, which is the worst of the three states to
     * be wrong about — worse here than for an export, because somebody watching it is waiting to find
     * out whether their pages arrived.
     */
    async fail(tx: Tx, workspaceId: string, jobId: string, reason: string): Promise<void> {
      await tx
        .update(importJobs)
        .set({ state: 'failed', error: reason.slice(0, 2000), finishedAt: new Date() })
        .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, jobId)))
    },

    /**
     * The job: read the archive, build the plan, write it once.
     *
     * Everything before the transaction holds nothing — fetching a few hundred megabytes from storage
     * and parsing thousands of files must not do so with a connection open. Everything inside it is
     * one act, so the space either gains the whole import or nothing at all.
     */
    async run(workspaceId: string, jobId: string): Promise<void> {
      /*
       * The claim is **one conditional UPDATE**, so exactly one attempt can ever hold this row.
       *
       * `select` then `update` is a lost update under READ COMMITTED — two workers both read
       * `queued`, both write `running`, and both run — and here that means every page in the archive
       * written twice. `where state = 'queued'` closes it: Postgres re-evaluates the predicate after
       * the other transaction commits, so the loser matches no row. `done` and `failed` are excluded
       * by the same clause, which is what makes a retry of a finished job a no-op. See
       * `services/export.ts` for what this costs — a row whose worker died stays `running` until
       * `reap` gives up on it, rather than being re-run by the next retry.
       */
      const job = await kernel.database.withWorkspace(workspaceId, async (tx) => {
        const [row] = await tx
          .update(importJobs)
          .set({ state: 'running', error: null })
          .where(
            and(
              eq(importJobs.workspaceId, workspaceId),
              eq(importJobs.id, jobId),
              eq(importJobs.state, 'queued'),
            ),
          )
          .returning()
        return row ?? null
      })
      if (!job) return
      await announce(workspaceId, job.requestedBy, jobId)

      try {
        /*
         * The import runs as the person who asked for it, which is the whole permission model here.
         * A job has no principal of its own, so it fetches theirs — and when it cannot, it fails
         * rather than falling back to something more permissive.
         */
        const principal = await kernel
          .call<Principal>('core.users.principal', { userId: job.requestedBy })
          .catch(() => null)
        if (!principal)
          throw new KernError('INTERNAL', 'The person who asked for this import could not be identified')

        // Asked again, now, at the moment of writing — see the note at the top of the file.
        await kernel.database.withWorkspace(workspaceId, async (tx) => {
          await access.spaceRow(tx, workspaceId, job.targetId)
          await requireWritable(principal, workspaceId, job.targetId)
        })

        const bytes = await archiveBytes(workspaceId, job.sourceFileId)
        const plan = planImport(readZip(bytes), job.source as ImportSource)
        const counts = countReport(plan.report)

        await kernel.database.withWorkspace(
          workspaceId,
          async (tx) => {
            await write(tx, principal, workspaceId, job.targetId, plan)
            await tx
              .update(importJobs)
              .set({ state: 'done', counts, report: plan.report, finishedAt: new Date() })
              .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, jobId)))
          },
          { userId: principal.userId },
        )

        await indexPages(workspaceId, job.targetId, plan)
        await announce(workspaceId, job.requestedBy, jobId)
        /*
         * The *space* still goes to the whole workspace, and that is the line between the two.
         * Pages arriving in a shared space is news for everyone whose sidebar shows that space — it
         * is the same change a `pages.create` announces. Which job put them there is not.
         */
        await kernel.realtime
          .change(workspaceId, { module: 'quire', entity: 'space', id: job.targetId, op: 'updated' })
          .catch(() => undefined)
        kernel.log.info({ jobId, workspaceId, source: job.source, ...counts }, 'quire: import finished')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await patch(workspaceId, job.requestedBy, jobId, {
          state: 'failed',
          error: message.slice(0, 2000),
          finishedAt: new Date(),
        })
        kernel.log.warn({ err: message, jobId, workspaceId }, 'quire: import failed')
      }
    },
  }
}

export type QuireImport = ReturnType<typeof quireImport>
