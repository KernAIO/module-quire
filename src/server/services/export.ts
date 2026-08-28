/**
 * Getting work *out* — a page, a page and everything under it, or a whole space, as a file.
 *
 * Four decisions run through the whole file and are worth having in one place.
 *
 * **1. It renders a stored version, never the live document.** HTML and PDF come from
 * `renderPageDoc`, the same static renderer the public site uses, and Markdown comes from the same
 * `PageDoc` through the writer next door. What is rendered is the page's *published* version when it
 * has one and its newest stored version otherwise — never the Y.Doc somebody may be typing into
 * right now. An export is a document, and a document taken mid-sentence is not one.
 *
 * **2. The permission is asked per page, as the person who asked for the export.** A subtree is a
 * tree of different readerships, and the whole point of a page-scoped DENY is that it holds against
 * a bulk read as well as against a click. So the job resolves the requester's principal and asks
 * `quire.page.view` about every page it is about to write, with that page's own ancestor chain. A
 * page they may not read is not in the archive, is not named in the archive, and is counted in
 * `skipped` so they can see that something was left out. A page whose *parent* was withheld goes
 * with it: a folder path is built from ancestors' titles, so keeping the child would print the title
 * of the page that was withheld. `publications.ts` prunes its tree on exactly the same reasoning.
 * `quire.page.export` itself is asked twice — once by the router before a row exists, and again by
 * the job at the same scope, because a job runs minutes after it was queued and the revocation that
 * happens in between is the one this key exists for.
 *
 * **3. Nothing that reaches a file is an address.** A picture becomes bytes in the archive and a
 * relative `src`; for a PDF it becomes a `data:` URI. It is never a presigned storage URL, because
 * that URL *is* the object key — `ws/<workspaceId>/<module>/<yyyy>/<mm>/<fileId>/<name>` — so it
 * carries the tenant's workspace uuid and the file's uuid, and it stops working an hour after it is
 * minted. That combination shipped once, into published HTML, and `migrations/0009` is what it cost.
 *
 * **4. The artefact is the module's own object, and the module deletes it.** Core exposes exactly
 * one file procedure over the broker — `files.get` — so a background job cannot mint a `FileObject`:
 * `createUpload` needs a user principal and hands back a presigned PUT for a browser. Rather than
 * pretend, this writes the artefact into `kernel.storage` under a key derived from the job's own
 * `file_id`, so the row that knows about the object is the only thing that can address it and
 * deleting the row deletes the object. That is a smaller claim than a `FileObject` and an honest
 * one: an export artefact does not appear in the workspace's file list, is not counted against the
 * `storageBytes` entitlement, and is swept after {@link EXPORT_TTL_DAYS} days — see `sweep` for how,
 * and for what that sweep cannot reach. The day core grows a procedure that mints a file for a
 * service principal, this gets shorter and the artefact becomes a real file.
 */
import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { ExportFormat, ExportJob, ExportScope, TransferCounts } from '../../contract/index.js'
import { pageDocFromState } from '../document.js'
import { type ExportedPage, exportedHtmlDocument, exportLinks } from '../export/html.js'
import { pageDocToMarkdown } from '../export/markdown.js'
import { htmlToPdf } from '../export/pdf.js'
import { safeZipPath, writeZip, type ZipEntry } from '../export/zip.js'
import { referencesIn, renderPageDoc } from '../render.js'
import { exportJobs, pages, pageVersions, spaces } from '../schema.js'
import type { QuireAccess } from './access.js'
import { slugifyTitle } from './publications.js'

type ExportRow = typeof exportJobs.$inferSelect
type PageRow = typeof pages.$inferSelect

/** How long an artefact is kept. Long enough to fetch twice, short enough not to be an archive. */
export const EXPORT_TTL_DAYS = 7

/**
 * How long a job may sit un-finished before it is given up on.
 *
 * **Nothing else can end a job that lost its worker.** `run` writes `failed` from its own `catch`,
 * and the router writes it when the queue refuses the send — both need the process to still be
 * there. A worker killed mid-export (an OOM, a deploy, `docker compose restart core-worker`) leaves
 * the row `running`, and pg-boss's own give-up path ends at pg-boss: `kernel.jobs` registers a
 * handler and nothing else, so there is no dead-letter callback that reaches this table. Measured
 * with a real worker and a SIGKILL: the row was still `running`, `finished_at` null, after the
 * pg-boss job had reached its terminal `failed` state. `exports.list` — which the transfers screen
 * polls every two seconds — reported `running` for ever, and the dialog spun with
 * `aria-busy="true"` for ever.
 *
 * The number is the job's whole budget with room to spare, so nothing legitimate is ever cut off:
 * `quireJobs` gives `export` `expireInSeconds: 900` with `retryLimit: 2`, so three attempts and
 * their backoff are under fifty minutes, and `import` one attempt of an hour. A job still running at
 * two hours has already been abandoned by the queue.
 */
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000

/**
 * What a job that lost its worker says.
 *
 * Diagnostic like every other `error` here — the state's own label is what the screen says in the
 * reader's language — and written for the person who has to decide what to do next rather than for
 * the one who wrote the worker.
 */
const ABANDONED =
  'This export stopped before it finished and was given up on after two hours. The worker running ' +
  'it went away — usually a restart, or a job too big for the memory it had. Nothing was written. ' +
  'Start it again, a subtree at a time if it was a whole space.'

/** Neither `done` nor `failed`, and old enough that nothing is still going to happen to it. */
const isAbandoned = (row: { state: string; createdAt: Date }): boolean =>
  (row.state === 'queued' || row.state === 'running') &&
  row.createdAt.getTime() < Date.now() - ABANDONED_AFTER_MS

/** How long a download link lives. It is minted per request, so it never has to outlive one. */
const DOWNLOAD_TTL_SEC = 900

/** A picture bigger than this is left out rather than allowed to define the size of the archive. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** The whole artefact, held in memory before it is written. Beyond this the job fails and says so. */
const MAX_ARTEFACT_BYTES = 256 * 1024 * 1024

/** Enough pages that no real space is refused, few enough that one job cannot become an outage. */
const MAX_PAGES = 5000

/** How often the row's counters are written while the job runs. A progress bar, not a write log. */
const PROGRESS_EVERY = 25

/**
 * What a format produces, which is deliberately not a decision the job makes at run time.
 *
 * Markdown and HTML are always a zip, even for a single page with no pictures. A page's attachments
 * live beside it, so the container has to exist as soon as there is one attachment — and a rule that
 * says "a zip, unless" produces two shapes for one request and a filename nobody can predict. The
 * uniform shape is also what makes an export re-importable: a folder of `.md` with its media beside
 * it is exactly the "plain folder of Markdown" the import side reads.
 *
 * A PDF is one document however much went into it, because that is what a PDF is for: a subtree
 * becomes one file with a page break between pages and internal links between them.
 */
const ARTEFACT = {
  markdown: { extension: 'zip', contentType: 'application/zip' },
  html: { extension: 'zip', contentType: 'application/zip' },
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  docx: {
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
} as const satisfies Record<ExportFormat, { extension: string; contentType: string }>

/**
 * Why `docx` is declared and refused.
 *
 * `prosemirror-docx` was the intended route and does not fit, for a structural reason rather than
 * for want of effort: it serialises a **ProseMirror `Node`**, and building one needs the schema —
 * which lives in `@kernhq/ui`'s `page-schema.ts`, is assembled out of a dozen Tiptap extensions, and
 * is browser code. A server that has deliberately never loaded Tiptap (see `document.ts`, which
 * reads a page out of Yjs *without* a schema for exactly this reason) has none to give it. Beyond
 * that, the library ships handlers for the basic nodes only, so Quire's callouts, toggles, task
 * lists and page mentions would each need one written by hand against an API that throws on an
 * unknown node.
 *
 * The alternative — emitting OOXML directly — is a zip of XML this file could write, and that is the
 * reason it is not written: nothing here can open the result in Word, so the only thing that could
 * ship is a file that is *probably* valid. A refusal an operator reads is better than a document a
 * customer cannot open, so the format refuses at `start`, immediately, rather than after a job.
 */
const DOCX_REFUSAL =
  'Word export is not available yet. Export as HTML or PDF, both of which Word opens, or as ' +
  'Markdown to move the pages somewhere else.'

export const exportArtefactKey = (workspaceId: string, fileId: string): string =>
  `ws/${workspaceId}/quire/exports/${fileId}`

/**
 * The `# Title` line at the top of an exported Markdown file.
 *
 * Exported so the round-trip test can build its fixture from the line the job actually writes rather
 * than from a copy of it — a title is the one thing in an export that has to come back *identical*,
 * because it is the page's name rather than part of its body.
 *
 * The escape set is the same one `export/markdown.ts` uses for inline text — what changes meaning
 * anywhere — plus **one position**: a run of hashes at the end. That is the ATX *closing sequence*,
 * so `Roadmap #` written plainly is a heading whose content is `Roadmap`, per CommonMark, and the
 * page came back under a different name. Escaping the run is the only spelling that survives, and
 * escaping it only there is what keeps `# Sharp C#` — where the hash is ordinary text — readable in
 * every other editor. The reader's half of this is `RE_ATX_CLOSING` in `import/markdown.ts`.
 */
export const markdownTitleLine = (title: string): string =>
  `# ${title.replace(/([\\`*_[\]<>|~])/g, '\\$1').replace(/(^|[ \t])(#+)([ \t]*)$/, '$1\\$2$3')}`

const countsOf = (value: unknown): TransferCounts => {
  const raw = (value ?? {}) as Partial<Record<keyof TransferCounts, unknown>>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)
  return { total: n(raw.total), done: n(raw.done), skipped: n(raw.skipped), failed: n(raw.failed) }
}

export function toExportJob(row: ExportRow): ExportJob {
  return {
    id: row.id,
    workspaceId: row.workspaceId as ExportJob['workspaceId'],
    requestedBy: row.requestedBy as ExportJob['requestedBy'],
    scope: row.scope as ExportScope,
    targetId: row.targetId,
    format: row.format as ExportFormat,
    state: row.state as ExportJob['state'],
    fileId: row.fileId,
    error: row.error,
    counts: countsOf(row.counts),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** The path of one archive folder written from another, so a link between two files resolves. */
export function relativeFolder(from: string, to: string, file: string): string {
  const a = from ? from.split('/') : []
  const b = to ? to.split('/') : []
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  const up = Array.from({ length: a.length - shared }, () => '..')
  const path = [...up, ...b.slice(shared), file].join('/')
  return path.startsWith('.') ? path : `./${path}`
}

/** A file name that is a name and not a path, and that no two pictures in one folder can share. */
function attachmentName(raw: string, taken: Set<string>): string {
  const cleaned = safeZipPath(raw.split('/').pop() ?? '') || 'attachment'
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const extension = dot > 0 ? cleaned.slice(dot) : ''
  let name = cleaned
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${extension}`
  taken.add(name)
  return name
}

interface SelectedPage {
  id: string
  parentId: string | null
  title: string
  state: Buffer | null
}

interface PreparedPage extends SelectedPage {
  /** where it sits in the archive: `handbook/getting-started`, from its ancestors' titles */
  folder: string
  /** the titles above it, outermost first — drawn as a trail so a loose file says where it is from */
  trail: string[]
}

/**
 * Tree order, and a folder per page whose siblings cannot collide.
 *
 * A page whose parent is not in the export is a root of the archive, which is what puts a subtree's
 * own root at the top level. Sibling slugs are suffixed `-2`, `-3` in tree order, the same rule
 * `withPaths` uses for a published site — so two people exporting the same space get the same names.
 */
export function prepareFolders(selected: SelectedPage[]): PreparedPage[] {
  const byId = new Map(selected.map((p) => [p.id, p]))
  const children = new Map<string | null, SelectedPage[]>()
  for (const page of selected) {
    const parent = page.parentId !== null && byId.has(page.parentId) ? page.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), page])
  }
  const out: PreparedPage[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null, base: string, trail: string[]): void => {
    const taken = new Set<string>()
    for (const page of children.get(parent) ?? []) {
      // `seen` is what stops a cycle — a page that became its own ancestor — from recurring for ever.
      if (seen.has(page.id)) continue
      seen.add(page.id)
      const stem = slugifyTitle(page.title || 'Untitled')
      let slug = stem
      for (let n = 2; taken.has(slug); n++) slug = `${stem}-${n}`
      taken.add(slug)
      const folder = safeZipPath(base ? `${base}/${slug}` : slug) || slug
      out.push({ ...page, folder, trail })
      walk(page.id, folder, [...trail, page.title || 'Untitled'])
    }
  }
  walk(null, '', [])
  return out
}

export function quireExport(kernel: Kernel, access: QuireAccess) {
  /** The row, or `notFound`. Fenced to the person who asked for it — see `requested_by`'s comment. */
  async function own(tx: Tx, workspaceId: string, jobId: string, principal: Principal): Promise<ExportRow> {
    const [row] = await tx
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.id, jobId)))
      .limit(1)
    if (!row) throw KernError.notFound('Export')
    /*
     * NOT_FOUND rather than FORBIDDEN, for the usual reason: a subtree export flattens pages of
     * different readerships into one artefact, so "that one is not yours" would confirm that
     * somebody else exported something and when. An id another person's job owns names nothing here.
     */
    const mine =
      principal.instanceAdmin || principal.kind === 'service' || row.requestedBy === principal.userId
    if (!mine) throw KernError.notFound('Export')
    return row
  }

  /**
   * Tell the one person whose job this is that it moved — and nobody else.
   *
   * Every other entity in this module announces with `kernel.realtime.change`, which publishes to the
   * **workspace** channel; the gateway subscribes every socket to its workspace at `hello`, with no
   * per-message filter, so a `change` there is read by every member. For a page or a label that is
   * correct and is the point. For a transfer it contradicts the rest of the feature: `own()` answers
   * NOT_FOUND rather than FORBIDDEN precisely so that an id belonging to somebody else's export
   * confirms nothing, and `list` returns only the caller's own rows — and then the broadcast handed
   * the whole workspace the job's id and the moment it changed. The payload carried no content, so
   * what leaked was that a named colleague exported something and when, which is the fact the
   * NOT_FOUND was protecting.
   *
   * `toUser` is delivered by the gateway straight to that user's sockets (`kern.rt.user.<id>`, which
   * every socket is joined to at `hello`), and `@kernhq/ui`'s realtime client dispatches on `msg.t`
   * without caring which channel carried it — so the invalidation reaches the screen exactly as
   * before. An instance admin may *read* another person's job through `own()`; they do not get a
   * push about it, which is the same asymmetry as the list.
   */
  async function announce(workspaceId: string, requestedBy: string, jobId: string): Promise<void> {
    await kernel.realtime
      .toUser(requestedBy, {
        t: 'change',
        workspaceId: workspaceId as ExportJob['workspaceId'],
        change: { module: 'quire', entity: 'export', id: jobId, op: 'updated' },
      })
      .catch(() => undefined)
  }

  async function patch(
    workspaceId: string,
    requestedBy: string,
    jobId: string,
    values: Partial<ExportRow>,
  ): Promise<void> {
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(exportJobs)
        .set(values)
        .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.id, jobId)))
    })
    await announce(workspaceId, requestedBy, jobId)
  }

  /**
   * Every page in scope that this person may read, in position order, with the version to draw.
   *
   * One flat read of the space rather than a recursive query per page: `access.scopeOf` is a
   * recursive query each time, and a five-hundred-page space would be five hundred of them before a
   * byte is written. Every ancestor of a page is in the same space by construction — `pages.create`
   * and `pages.move` both refuse a parent from another one — so the flat read holds every chain.
   */
  async function select(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    job: ExportRow,
  ): Promise<{ pages: SelectedPage[]; title: string; skipped: number }> {
    let spaceId: string
    let title: string
    if (job.scope === 'space') {
      const space = await access.spaceRow(tx, workspaceId, job.targetId)
      spaceId = space.id
      title = space.name
    } else {
      const page: PageRow = await access.pageRow(tx, workspaceId, job.targetId)
      spaceId = page.spaceId
      title = page.title
    }

    const all = await tx
      .select({
        id: pages.id,
        parentId: pages.parentId,
        title: pages.title,
        archivedAt: pages.archivedAt,
        publishedVersionId: pages.publishedVersionId,
      })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.position))

    const parentOf = new Map(all.map((p) => [p.id, p.parentId]))
    const ancestorsOf = (id: string): string[] => {
      const chain: string[] = []
      const seen = new Set([id])
      let at = parentOf.get(id) ?? null
      while (at !== null && !seen.has(at)) {
        chain.push(at)
        seen.add(at)
        at = parentOf.get(at) ?? null
      }
      return chain
    }

    /* Trashed pages are already out of `all`; archived ones are out of the tree on purpose. */
    const live = all.filter((p) => p.archivedAt === null)
    let inScope = live
    if (job.scope !== 'space') {
      const wanted = new Set<string>([job.targetId])
      // `live` is ordered by position, which is not tree order, so this runs until it settles.
      for (let changed = true; changed; ) {
        changed = false
        for (const p of live)
          if (!wanted.has(p.id) && p.parentId !== null && wanted.has(p.parentId)) {
            wanted.add(p.id)
            changed = true
          }
      }
      inScope = live.filter((p) => wanted.has(p.id))
      // `page` takes the one page; `subtree` takes it and everything beneath it.
      if (job.scope === 'page') inScope = inScope.filter((p) => p.id === job.targetId)
    }

    if (inScope.length > MAX_PAGES)
      throw KernError.badRequest(
        `This export covers ${inScope.length} pages, and one job may carry ${MAX_PAGES}. ` +
          'Export a subtree at a time.',
      )

    const verdicts = await Promise.all(
      inScope.map(async (p) => ({
        id: p.id,
        allowed: await access.canPage(principal, 'quire.page.view', workspaceId, {
          pageId: p.id,
          spaceId,
          ancestorIds: ancestorsOf(p.id),
        }),
      })),
    )
    const allowed = new Set(verdicts.filter((v) => v.allowed).map((v) => v.id))
    /*
     * A page whose parent was withheld goes with it, because its folder path is built from its
     * ancestors' titles — keeping the child would print the title of the page that was withheld.
     *
     * The walk stops at the edge of the export rather than at the top of the tree, and that is the
     * whole of it: an ancestor outside the scope was never checked, so it is not in `allowed`, and a
     * walk that kept going would find it missing and drop every page. A `page`-scoped export is the
     * case that makes this visible — its one page has a parent that is not in the export at all.
     */
    const inScopeIds = new Set(inScope.map((p) => p.id))
    const kept = inScope.filter((p) => {
      if (!allowed.has(p.id)) return false
      let at = p.parentId
      const seen = new Set<string>([p.id])
      while (at !== null && inScopeIds.has(at) && !seen.has(at)) {
        if (!allowed.has(at)) return false
        seen.add(at)
        at = parentOf.get(at) ?? null
      }
      return true
    })

    const states = new Map<string, Buffer>()
    /*
     * The published version if there is one, the newest stored version otherwise — never the live
     * document. `page_versions.id` is a uuidv7, so `desc(id)` is newest-first without a sort on a
     * timestamp two versions can share.
     */
    const pinned = kept.map((p) => p.publishedVersionId).filter((id): id is string => id !== null)
    if (pinned.length > 0) {
      const rows = await tx
        .select({ pageId: pageVersions.pageId, state: pageVersions.state })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), inArray(pageVersions.id, pinned)))
      for (const r of rows) states.set(r.pageId, r.state)
    }
    for (const p of kept) {
      if (states.has(p.id)) continue
      const [newest] = await tx
        .select({ state: pageVersions.state })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.pageId, p.id)))
        .orderBy(desc(pageVersions.id))
        .limit(1)
      if (newest) states.set(p.id, newest.state)
    }

    return {
      title,
      skipped: inScope.length - kept.length,
      pages: kept.map((p) => ({
        id: p.id,
        parentId: p.parentId,
        title: p.title,
        state: states.get(p.id) ?? null,
      })),
    }
  }

  /** The picture with this id, if it belongs to this workspace and is small enough to carry. */
  async function attachment(
    workspaceId: string,
    fileId: string,
  ): Promise<{ name: string; mimeType: string; bytes: Buffer } | null> {
    try {
      const file = await kernel.call<{
        workspaceId: string
        name: string
        mimeType: string
        size: number
        key: string
        status: string
      } | null>('core.files.get', { id: fileId })
      /*
       * The workspace is compared here rather than trusted. `core.files.get` answers a **service**
       * principal without a membership check — that is what makes it callable from a module at all —
       * so this comparison is the only thing keeping an export inside its tenant. The id comes out
       * of a page document, which is data somebody wrote.
       */
      if (!file || file.workspaceId !== workspaceId || file.status !== 'ready' || !file.key) return null
      if (file.size > MAX_ATTACHMENT_BYTES) return null
      const object = await kernel.storage.get(file.key)
      const chunks: Buffer[] = []
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array))
      return { name: file.name, mimeType: file.mimeType, bytes: Buffer.concat(chunks) }
    } catch (err) {
      // A deleted file, storage that is not configured, a picture somebody purged: the page is still
      // worth exporting without it, and `renderPageDoc` drops an unresolvable picture by design.
      kernel.log.warn({ err: String(err), fileId }, 'quire: an export could not read an attachment')
      return null
    }
  }

  /**
   * A zip of one folder per page: `index.md` or `index.html`, with `media/` beside it.
   *
   * Links between two pages that are both in the archive become relative paths, so the export opens
   * and navigates on a laptop with nothing running. A mention of a page that is *not* in the
   * archive — withheld, purged, or in another space — degrades to plain text rather than to a link
   * that goes nowhere, the same rule `renderPageDoc` follows.
   */
  async function buildZip(
    workspaceId: string,
    prepared: PreparedPage[],
    format: 'markdown' | 'html',
    counts: TransferCounts,
    progress: () => Promise<void>,
  ): Promise<Buffer> {
    const file = format === 'markdown' ? 'index.md' : 'index.html'
    const folderOf = new Map(prepared.map((p) => [p.id, p.folder]))
    const entries: ZipEntry[] = []
    let written = 0

    for (const page of prepared) {
      try {
        const doc = pageDocFromState(page.state)
        const media = new Map<string, string>()
        const taken = new Set<string>()
        for (const fileId of doc ? referencesIn(doc).fileIds : []) {
          const found = await attachment(workspaceId, fileId)
          if (!found) continue
          const name = attachmentName(found.name, taken)
          entries.push({ path: `${page.folder}/media/${name}`, data: found.bytes })
          media.set(fileId, `media/${name}`)
        }
        const fileSrc = (id: string) => media.get(id) ?? null
        const pageHref = (id: string) => {
          const to = folderOf.get(id)
          return to === undefined ? null : relativeFolder(page.folder, to, file)
        }
        const title = page.title || 'Untitled'
        let body: string
        if (format === 'markdown') {
          body = `${markdownTitleLine(title)}\n\n${pageDocToMarkdown(doc, { fileSrc, pageHref })}`
        } else {
          /*
           * Both of this page's addresses are ones `safeHref` refuses — a relative picture and a
           * relative link to another file — so they go through the renderer as tokens and come back
           * afterwards. See `exportLinks` for why that is the right place to bend rather than
           * `safeHref`.
           */
          const links = exportLinks()
          const html = renderPageDoc(doc, {
            fileSrc: (id) => {
              const path = fileSrc(id)
              return path === null ? null : links.to(path)
            },
            pageHref: (id) => {
              const path = pageHref(id)
              return path === null ? null : links.to(path)
            },
          })
          body = links.resolve(
            exportedHtmlDocument({
              title,
              pages: [{ id: page.id, title, trail: page.trail, html }],
            }),
          )
        }
        entries.push({ path: `${page.folder}/${file}`, data: Buffer.from(body, 'utf8') })
        counts.done++
      } catch (err) {
        counts.failed++
        kernel.log.warn({ err: String(err), pageId: page.id }, 'quire: a page could not be exported')
      }
      if (++written % PROGRESS_EVERY === 0) await progress()
    }
    return writeZip(entries)
  }

  /**
   * One PDF for the whole export.
   *
   * Every page becomes a section of one document with a page break between them, so a subtree is a
   * booklet rather than a folder of files — and a mention of another exported page becomes an
   * internal link, which is the thing a PDF can do that a folder of PDFs cannot. Pictures are
   * `data:` URIs: Gotenberg's Chromium fetches whatever the document references from inside its own
   * container, so anything else would be a broken picture or a storage URL handed to a third
   * process.
   */
  async function buildPdf(
    workspaceId: string,
    prepared: PreparedPage[],
    title: string,
    counts: TransferCounts,
    progress: () => Promise<void>,
  ): Promise<Buffer> {
    const known = new Set(prepared.map((p) => p.id))
    // One token space for the whole document: the same picture on two pages is inlined once.
    const links = exportLinks()
    const sections: ExportedPage[] = []
    let written = 0
    for (const page of prepared) {
      try {
        const doc = pageDocFromState(page.state)
        const media = new Map<string, string>()
        for (const fileId of doc ? referencesIn(doc).fileIds : []) {
          const found = await attachment(workspaceId, fileId)
          if (!found) continue
          media.set(fileId, `data:${found.mimeType};base64,${found.bytes.toString('base64')}`)
        }
        sections.push({
          id: page.id,
          title: page.title || 'Untitled',
          trail: page.trail,
          html: renderPageDoc(doc, {
            // `data:` is one of the two shapes `safeHref` refuses; `#p-<id>` is a fragment, which it
            // accepts, so only the picture needs a token.
            fileSrc: (id) => {
              const inlined = media.get(id)
              return inlined === undefined ? null : links.to(inlined)
            },
            pageHref: (id) => (known.has(id) ? `#p-${id}` : null),
          }),
        })
        counts.done++
      } catch (err) {
        counts.failed++
        kernel.log.warn({ err: String(err), pageId: page.id }, 'quire: a page could not be exported')
      }
      if (++written % PROGRESS_EVERY === 0) await progress()
    }
    const document = links.resolve(exportedHtmlDocument({ title: title || 'Untitled', pages: sections }))
    return htmlToPdf(document, { title })
  }

  return {
    toExportJob,

    /**
     * Record the request and hand it to a worker.
     *
     * Nothing is rendered here. A whole space is unbounded work and a PDF is a round trip to
     * Chromium, so the request answers with a row somebody can watch rather than a response somebody
     * has to keep a browser open for. The row exists before the job is sent, which is the order that
     * matters: a job whose row is missing fails, and a row whose job never arrived stays `queued`
     * and can be sent again.
     */
    async start(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: { scope: ExportScope; targetId: string; format: ExportFormat },
    ): Promise<ExportRow> {
      if (input.format === 'docx') throw KernError.badRequest(DOCX_REFUSAL, { format: 'docx' })
      const userId = principal.userId
      if (!userId)
        throw new KernError('FORBIDDEN', 'An export belongs to a person, and this caller is a service')

      // Existence before anything is queued: an id that names nothing is a 404 now rather than a job
      // that fails in a minute's time.
      if (input.scope === 'space') await access.spaceRow(tx, workspaceId, input.targetId)
      else await access.pageRow(tx, workspaceId, input.targetId)

      const [row] = await tx
        .insert(exportJobs)
        .values({
          id: uuidv7(),
          workspaceId,
          requestedBy: userId,
          scope: input.scope,
          targetId: input.targetId,
          format: input.format,
          state: 'queued',
          counts: { total: 0, done: 0, skipped: 0, failed: 0 },
        })
        .returning()
      if (!row) throw new KernError('INTERNAL', 'The export could not be recorded')
      return row
    },

    /**
     * One job, and the one place a *watched* job can give up on itself.
     *
     * The dialog polls this and never the list, so `reap` — which runs beside the list — would never
     * reach the row somebody is actually looking at. One row rather than a workspace-wide update,
     * because this is on a path that runs every second and a half while a job is moving: the write
     * happens only for a row that is already stale, which is never, until it is.
     */
    async get(tx: Tx, workspaceId: string, jobId: string, principal: Principal): Promise<ExportRow> {
      const row = await own(tx, workspaceId, jobId, principal)
      if (!isAbandoned(row)) return row
      const [failed] = await tx
        .update(exportJobs)
        .set({ state: 'failed', error: ABANDONED, finishedAt: new Date() })
        .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.id, jobId)))
        .returning()
      return failed ?? row
    },

    /** This person's own exports, newest first. Somebody else's are not listed and cannot be. */
    list(tx: Tx, workspaceId: string, principal: Principal, limit: number): Promise<ExportRow[]> {
      const userId = principal.userId
      if (!userId) return Promise.resolve([])
      return tx
        .select()
        .from(exportJobs)
        .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.requestedBy, userId)))
        .orderBy(desc(exportJobs.createdAt))
        .limit(limit)
    },

    /**
     * A short-lived link to the artefact, minted per request and never stored.
     *
     * This is the fence. A subtree export flattens pages of different readerships into one file, so
     * whoever can fetch it can read everything that went into it — which is right for the person the
     * permission check was run as and for nobody else. Minting the URL here rather than writing one
     * into the row is what puts that check at the moment of the fetch instead of an hour earlier.
     */
    async downloadUrl(tx: Tx, workspaceId: string, row: ExportRow): Promise<string | null> {
      if (row.state !== 'done' || !row.fileId) return null
      const artefact = ARTEFACT[row.format as ExportFormat] ?? ARTEFACT.markdown
      const [target] =
        row.scope === 'space'
          ? await tx
              .select({ title: spaces.name })
              .from(spaces)
              .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, row.targetId)))
              .limit(1)
          : await tx
              .select({ title: pages.title })
              .from(pages)
              .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, row.targetId)))
              .limit(1)
      const name = `${slugifyTitle(target?.title || 'quire export')}.${artefact.extension}`
      try {
        return await kernel.storage.presignGet(exportArtefactKey(workspaceId, row.fileId), {
          expiresIn: DOWNLOAD_TTL_SEC,
          filename: name,
          disposition: 'attachment',
          contentType: artefact.contentType,
        })
      } catch (err) {
        /*
         * Signing is arithmetic and fails only when storage is not configured at all — an instance
         * with no S3 credentials. A screen polling this every second must not be answered with a 500
         * because of that: null means "no link", which is what there is.
         */
        kernel.log.warn({ err: String(err), jobId: row.id }, 'quire: an export link could not be signed')
        return null
      }
    },

    /**
     * Mark a job failed without having run it.
     *
     * There is exactly one caller: the router, when the queue refuses the job it has just recorded.
     * Without it that row sits `queued` for ever and reads as work in progress, which is the worst
     * of the three states to be wrong about.
     */
    async fail(tx: Tx, workspaceId: string, jobId: string, reason: string): Promise<void> {
      await tx
        .update(exportJobs)
        .set({ state: 'failed', error: reason.slice(0, 2000), finishedAt: new Date() })
        .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.id, jobId)))
    },

    /**
     * Fail this workspace's abandoned jobs, so a dead one stops reading as work in progress.
     *
     * Called from the same two places as `sweep` and for the same reason — see the note there for
     * why neither can be a cron job. It is deliberately a separate method: `sweep` deletes an
     * artefact that has aged out of a job that *finished*, and this ends a job that never will.
     *
     * The screen that is being lied to is the one that fixes it: the transfers list polls
     * `exports.list` every two seconds while anything is running, so an abandoned job is failed by
     * the very poll that would otherwise draw its spinner for ever. `get` does the same for the one
     * row a dialog is watching.
     *
     * Marked, never deleted. The row is the only record that somebody asked for this and did not get
     * it, and it is what `sweep` will remove on its own schedule.
     */
    async reap(tx: Tx, workspaceId: string): Promise<number> {
      const abandoned = await tx
        .update(exportJobs)
        .set({ state: 'failed', error: ABANDONED, finishedAt: new Date() })
        .where(
          and(
            eq(exportJobs.workspaceId, workspaceId),
            inArray(exportJobs.state, ['queued', 'running']),
            lt(exportJobs.createdAt, new Date(Date.now() - ABANDONED_AFTER_MS)),
          ),
        )
        .returning({ id: exportJobs.id })
      return abandoned.length
    },

    /**
     * Throw away this workspace's expired artefacts.
     *
     * Called from `start` and `list` rather than from a cron, and the reason is worth writing down:
     * a scheduled sweep has to enumerate workspaces, and every tenant table here is under FORCE
     * row-level security keyed on `app.workspace_id`, so a cross-workspace scan has nothing to scan
     * with. Quire keeps no `workspaces` table of its own — the tracker does, which is how its cron
     * jobs manage — and adding one is a migration rather than a service.
     *
     * The limit of doing it this way is real, which is why it is stated: a workspace whose exports
     * nobody looks at again keeps its artefacts until somebody does. They are bounded by what that
     * workspace exported, unreachable without a row, and the row is the only thing that addresses
     * the object — so this is stale storage, not a leak.
     */
    async sweep(tx: Tx, workspaceId: string): Promise<number> {
      const before = new Date(Date.now() - EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000)
      const stale = await tx
        .delete(exportJobs)
        .where(and(eq(exportJobs.workspaceId, workspaceId), lt(exportJobs.createdAt, before)))
        .returning({ fileId: exportJobs.fileId })
      await Promise.all(
        stale
          .map((r) => r.fileId)
          .filter((id): id is string => id !== null)
          .map((id) => kernel.storage.delete(exportArtefactKey(workspaceId, id)).catch(() => undefined)),
      )
      return stale.length
    },

    /**
     * The job.
     *
     * Three phases, and the split is not tidiness. The database work happens in short transactions;
     * decoding a space's worth of Yjs, pulling its pictures out of storage and waiting on Chromium
     * happen between them, holding nothing. The artefact is written to storage in one piece, and
     * only then does the row point at it — so there is no moment at which `file_id` names bytes that
     * are still arriving, and a failure anywhere leaves `file_id` null and the row `failed`.
     */
    async run(workspaceId: string, jobId: string): Promise<void> {
      /*
       * The claim is **one conditional UPDATE**, and reading the row first was the bug.
       *
       * `select` then `update` is a lost update under READ COMMITTED: two workers both read
       * `queued`, both write `running`, and both run the job. That is not hypothetical here — a
       * pg-boss job that outlives `expireInSeconds` (900 for an export, which `MAX_PAGES = 5000`
       * makes an ordinary large space) is re-dispatched while the first attempt is still going. Both
       * attempts then built the archive and `put` it under a fresh uuid, the row named one of them,
       * and the other became an object in storage that nothing addresses — `sweep` deletes the
       * object named by a row's `file_id`, so it could never reach it. Measured: two concurrent
       * `run`s wrote two objects and orphaned one.
       *
       * `where state = 'queued'` closes it, because Postgres re-evaluates the predicate against the
       * committed row after waiting for the other transaction's lock: the loser matches no row and
       * returns. What that costs is automatic recovery — a row stays `running` until `reap` gives up
       * on it after two hours, rather than being re-run by the next retry. That is the right trade
       * in both directions: a second export attempt leaks an artefact, and a second *import* attempt
       * writes every page in the archive twice.
       */
      const job = await kernel.database.withWorkspace(workspaceId, async (tx) => {
        const [row] = await tx
          .update(exportJobs)
          .set({ state: 'running', error: null })
          .where(
            and(
              eq(exportJobs.workspaceId, workspaceId),
              eq(exportJobs.id, jobId),
              eq(exportJobs.state, 'queued'),
            ),
          )
          .returning()
        return row ?? null
      })
      if (!job) return
      await announce(workspaceId, job.requestedBy, jobId)

      const counts: TransferCounts = { total: 0, done: 0, skipped: 0, failed: 0 }
      const progress = () => patch(workspaceId, job.requestedBy, jobId, { counts })
      try {
        const format = job.format as ExportFormat
        if (format === 'docx') throw KernError.badRequest(DOCX_REFUSAL, { format: 'docx' })

        /*
         * The export runs as the person who asked for it, which is the whole permission model here.
         * A job has no principal of its own, so it fetches theirs — and when it cannot, it fails
         * rather than falling back to something more permissive.
         */
        const principal = await kernel
          .call<Principal>('core.users.principal', { userId: job.requestedBy })
          .catch(() => null)
        if (!principal)
          throw new KernError('INTERNAL', 'The person who asked for this export could not be identified')

        /*
         * Asked again, now, at the scope `exports.start` asked it at — because a job runs minutes
         * after it was queued and a permission can be taken away in between.
         *
         * The per-page `quire.page.view` check below is not a substitute for this one, and the gap
         * between them is exactly the shape of the hole: revoking somebody's *export* permission
         * leaves every page they may still read, so a job queued a moment earlier finished with a
         * complete archive of the space and `exports.get` signed a link to it. That is the one
         * revocation the key exists for — the leaver's last afternoon — and it did not hold.
         * `services/import.ts` re-asks for the same reason; the difference is only that an import
         * writes, so the consequence of missing it was noticed there first.
         */
        await kernel.database.withWorkspace(workspaceId, async (tx) => {
          if (job.scope === 'space') {
            await access.spaceRow(tx, workspaceId, job.targetId)
            await access.requireSpace(principal, 'quire.page.export', workspaceId, job.targetId)
          } else {
            await access.pageRow(tx, workspaceId, job.targetId)
            const scope = await access.scopeOf(tx, workspaceId, job.targetId)
            await access.requirePage(principal, 'quire.page.export', workspaceId, scope)
          }
        })

        const selected = await kernel.database.withWorkspace(workspaceId, (tx) =>
          select(tx, principal, workspaceId, job),
        )
        counts.total = selected.pages.length + selected.skipped
        counts.skipped = selected.skipped
        await progress()

        const prepared = prepareFolders(selected.pages)
        const bytes =
          format === 'pdf'
            ? await buildPdf(workspaceId, prepared, selected.title, counts, progress)
            : await buildZip(workspaceId, prepared, format, counts, progress)

        if (bytes.length > MAX_ARTEFACT_BYTES)
          throw KernError.badRequest(
            `This export came to ${Math.round(bytes.length / 1_048_576)} MB and the limit is ` +
              `${MAX_ARTEFACT_BYTES / 1_048_576} MB. Export a subtree at a time.`,
          )

        const fileId = uuidv7()
        await kernel.storage.put(exportArtefactKey(workspaceId, fileId), bytes, ARTEFACT[format].contentType)
        await patch(workspaceId, job.requestedBy, jobId, {
          state: 'done',
          fileId,
          counts,
          finishedAt: new Date(),
        })
        kernel.log.info({ jobId, workspaceId, format, bytes: bytes.length }, 'quire: export finished')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await patch(workspaceId, job.requestedBy, jobId, {
          state: 'failed',
          error: message.slice(0, 2000),
          counts,
          finishedAt: new Date(),
        })
        kernel.log.warn({ err: message, jobId, workspaceId }, 'quire: export failed')
      }
    },
  }
}

export type QuireExport = ReturnType<typeof quireExport>
