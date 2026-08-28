/**
 * An archive read into a plan: what pages would be created, what databases, and what happened to
 * every file.
 *
 * **Nothing here writes anything.** That is the point of the file existing rather than the service
 * doing this inline: the rule the slice is built on is that a zip which fails half way leaves the
 * space untouched, and the only way to be sure of that is for the whole archive to be read, resolved
 * and reported on before the first insert. `services/import.ts` takes the finished plan and writes it
 * in one transaction. A failure in here is a job that failed and a space that is exactly as it was.
 *
 * **The report is the feature, not the by-product.** Every file in the upload gets a row saying
 * whether it became a page, was deliberately left out, or could not be read — and a link that names a
 * file the archive does not contain gets a row too, because "40 pages silently lost their links" is
 * the failure people actually meet and the one nothing else would report. `counts.total` is exactly
 * `report.length`, which is a property `import.int.test.ts` asserts rather than a claim in a comment.
 *
 * **Ids are minted here, before anything is written, and that is what makes links work.** A page's
 * body may link to a page that appears later in the archive, so the ids have to exist before any body
 * is resolved — which rules out letting the database mint them. `uuidv7` is what the rest of the
 * module uses for exactly this reason.
 */
import { uuidv7 } from '@kernhq/kernel'
import type { PageDoc, PageDocNode } from '@kernhq/ui/editor/page-doc'
import type { ImportReportEntry, ImportSource } from '../../contract/index.js'
import { coerceValue, type GuessedColumn, guessColumn, parseCsv } from './csv.js'
import { classesOf, findElement, htmlToPageDoc, parseHtml, textContent } from './html.js'
import { markdownToPageDoc, splitTitle } from './markdown.js'
import { type ArchiveEntry, basenameOf, dirnameOf, extensionOf, resolveArchivePath, textOf } from './zip.js'

/** Enough that no real export is refused, few enough that one import cannot become an outage. */
export const MAX_PAGES = 2_000

/** A database bigger than this is a spreadsheet somebody should keep being a spreadsheet. */
export const MAX_ROWS = 5_000

/** A page whose file is larger than this is not prose. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

export interface PlannedPage {
  /** minted here so a link written in one file can name a page defined in another */
  id: string
  /** the normalised archive path this page came from, which is what a link resolves against */
  key: string
  title: string
  /** another planned page's id, or null for a page at the top of the target space */
  parentId: string | null
  doc: PageDoc
}

export interface PlannedRow {
  id: string
  title: string
  /**
   * One value per entry in the database's `columns`, in the same order, or null for an empty cell.
   *
   * Positional rather than keyed by property key, and deliberately: the key a column ends up with is
   * minted by `databases.addProperty` against the keys already in the database, which is knowledge
   * this file does not have and must not guess. Duplicating that derivation here is how every
   * imported cell lands under a key no column reads — invisible on screen, because a table draws the
   * columns it has and simply shows them empty. The service zips these against the properties it
   * actually created.
   */
  values: unknown[]
  /** the row's own page body, when the archive carried one; an empty document otherwise */
  doc: PageDoc
}

export interface PlannedDatabase {
  /** the page the database hangs on — always one of `pages`, created for it */
  hostPageId: string
  name: string
  columns: GuessedColumn[]
  rows: PlannedRow[]
}

export interface ImportPlan {
  pages: PlannedPage[]
  databases: PlannedDatabase[]
  report: ImportReportEntry[]
}

// ------------------------------------------------------------------------------------------------
// Report building
// ------------------------------------------------------------------------------------------------

class Report {
  private readonly rows: ImportReportEntry[] = []
  /** Unresolvable targets, gathered so twenty pages pointing at one missing file are one row. */
  private readonly missing = new Map<string, { kind: 'link' | 'picture'; from: Set<string> }>()

  /**
   * Where each path sat in the archive, so the finished report reads in the order the files did.
   *
   * The rows are not produced in that order and cannot be: a page's row is written after every id
   * exists, a database's after its columns are guessed, and a file nobody could read is rejected
   * before either. Sorting at the end is what makes the report comparable against the archive
   * listing — and against the last time somebody ran the same import.
   */
  constructor(private readonly order: Map<string, number>) {}

  imported(path: string, pageId: string, reason: string | null = null): void {
    this.rows.push({ path, outcome: 'imported', pageId, reason })
  }
  skipped(path: string, reason: string): void {
    this.rows.push({ path, outcome: 'skipped', pageId: null, reason })
  }
  failed(path: string, reason: string): void {
    this.rows.push({ path, outcome: 'failed', pageId: null, reason })
  }
  /**
   * A link or a picture that named a file the archive does not hold, and the page that carried it.
   *
   * A picture is worth its own sentence rather than sharing the link one: "now plain text" is what
   * happens to a dead link and is not what happens to a dead picture, which is drawn nowhere at all.
   * Without a row it is drawn nowhere and *said* nowhere, which is the silent drop this report exists
   * to make impossible. The first sighting of a path decides which sentence it gets, so a page that
   * both links to and shows one missing file is still one row about one missing file.
   */
  unresolved(target: string, from: string, kind: 'link' | 'picture' = 'link'): void {
    const seen = this.missing.get(target)
    if (seen) seen.from.add(from)
    else this.missing.set(target, { kind, from: new Set([from]) })
  }

  /**
   * The finished report: **exactly one row per file in the archive, in archive order**, followed by
   * one row per link target the archive never contained.
   *
   * The first half is the invariant worth stating that plainly, because it is what lets `counts` be
   * read as a statement about the upload rather than about the report: every file is accounted for,
   * once, and nothing about a file goes into a second row. A database that was truncated, or whose
   * columns were guessed, says so on the row it already has.
   *
   * The second half is deliberately *not* a file, and gets its own row rather than a note on the page
   * that carried the link, for two reasons. A page that arrived with one dead link is an *imported*
   * page, and saying anything else about it would be wrong; and twenty pages linking to one missing
   * file would be twenty copies of the same sentence instead of one row naming the thing somebody has
   * to go and find.
   */
  finish(): ImportReportEntry[] {
    const at = (path: string) => this.order.get(path) ?? Number.MAX_SAFE_INTEGER
    // A stable sort, so the order below is the archive's and nothing else's.
    const files = this.rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => at(a.row.path) - at(b.row.path) || a.index - b.index)
      .map((entry) => entry.row)

    const extra = [...this.missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, { kind, from }]): ImportReportEntry => {
        const names = [...from].slice(0, 3).join(', ')
        const more = from.size > 3 ? ` and ${from.size - 3} more` : ''
        return {
          path: target,
          outcome: 'skipped',
          pageId: null,
          reason:
            kind === 'picture'
              ? `nothing in the archive is at this path, so the picture in ${names}${more} was left out`
              : `nothing in the archive is at this path, so the link to it in ${names}${more} is now plain text`,
        }
      })
    return [...files, ...extra]
  }
}

// ------------------------------------------------------------------------------------------------
// Link and picture resolution
// ------------------------------------------------------------------------------------------------

/** Anything with a scheme is somebody else's address and is left exactly as it was written. */
const isAbsolute = (href: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('//')

/** `Getting%20started%2012ab.md#section` → `Getting started 12ab.md`. */
function archiveTarget(fromKey: string, href: string): string | null {
  const cleaned = href.split('#')[0]!.split('?')[0]!
  if (cleaned === '') return null
  let decoded = cleaned
  try {
    decoded = decodeURIComponent(cleaned)
  } catch {
    // A stray `%` that is not an escape: the raw path is still a path worth trying.
  }
  return resolveArchivePath(fromKey, decoded)
}

/** The 32-hex id Notion appends to every name, wherever it appears in a URL or a filename. */
const NOTION_ID = /([0-9a-f]{32})/i

interface ResolveContext {
  /** the archive path of the file this document came from */
  fromKey: string
  /** how the page is named in the report, for the sentence about a link that went nowhere */
  fromLabel: string
  /** archive path → the page created from it */
  pageByKey: Map<string, string>
  /** a Notion page id → the page created from it, so a `notion.so/…` link resolves too */
  pageBySourceId: Map<string, string>
  /**
   * Every path the archive holds, so "not imported" and "not there at all" are different answers.
   *
   * The archive's own listing, **not** the set of pages that were made from it. Building it from the
   * pages is the bug this comment used to describe rather than state: a link to an attachment, a
   * picture, a `_all.csv` or a `.md` whose bytes were damaged would then be reported as "nothing in
   * the archive is at this path" — which is false, and which gives that file a *second* row on top of
   * the one triage already wrote for it. Two rows for one file is what makes `counts.total` stop
   * being a statement about the upload.
   */
  keys: Set<string>
  report: Report
}

/**
 * Rewrite what can be rewritten, degrade what cannot, and say so.
 *
 * Three outcomes and they are deliberately different. A link to a page that was imported becomes a
 * `pageMention`, which is Quire's own way of naming a page and survives a rename. A link to a file
 * the archive holds but that did not become a page — an attachment, a stylesheet — becomes plain
 * text, because a link that goes nowhere is worse than a name. A link to something the archive never
 * held becomes plain text *and* a row in the report, since that is the one case where somebody has
 * to go and find the missing thing.
 */
function resolveInline(nodes: PageDocNode[], ctx: ResolveContext): PageDocNode[] {
  const out: PageDocNode[] = []

  for (const node of nodes) {
    if (node.type === 'image') {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      if (isAbsolute(src)) {
        out.push(node)
        continue
      }
      /*
       * A picture that lives in the archive is dropped rather than drawn, and the file's own report
       * row says why. An `image` node needs a `fileId` that `core.files.get` can answer for, and core
       * exposes exactly one file procedure over the broker — `files.get`. `createUpload` needs a
       * *user* principal and hands back a presigned PUT for a browser, so a background job cannot
       * mint a file at all; the export side reached the same wall from the other direction and wrote
       * its artefact into `kernel.storage` under a key of its own. That trick does not work here,
       * because nothing renders an image from a module-owned object. The day core grows a procedure
       * that mints a file for a service principal, this becomes three lines and the picture arrives.
       *
       * A picture the archive never held has no row of its own to carry that sentence, so it gets one
       * here — the same answer a dead link gets, and for the same reason: dropping a node without
       * saying so is the one thing this report is for.
       *
       * **The alt text stays where the picture was.** It is the only thing about the picture the
       * archive can still carry into the page, it was written to be read when the image is not
       * there, and throwing it away turned a described diagram into a blank line. Where there is no
       * alt text there is nothing to keep, and `resolveNodes` then drops the paragraph rather than
       * leaving an empty block behind.
       */
      const picture = archiveTarget(ctx.fromKey, src)
      if (picture === null || !ctx.keys.has(picture))
        ctx.report.unresolved(picture ?? src, ctx.fromLabel, 'picture')
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : ''
      if (alt) out.push({ type: 'text', text: alt })
      continue
    }

    const link = (node.marks ?? []).find((mark) => mark.type === 'link')
    const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : null
    if (!link || !href) {
      out.push(node)
      continue
    }

    const label = node.text ?? ''
    const pageId = targetPageId(href, ctx)
    if (pageId) {
      const previous = out.at(-1)
      // `[**Bold** and plain](page.md)` arrives as two text nodes carrying one link; two mentions of
      // the same page in a row is not what the author wrote.
      if (previous?.type === 'pageMention' && previous.attrs?.id === pageId) {
        previous.attrs.label = `${String(previous.attrs.label ?? '')}${label}`
        continue
      }
      out.push({ type: 'pageMention', attrs: { id: pageId, label: label || 'Untitled' } })
      continue
    }

    if (!isAbsolute(href)) {
      const target = archiveTarget(ctx.fromKey, href)
      // A target the archive does hold is a file that deliberately did not become a page — its own
      // row already says so, and repeating it here would be a second row for one fact.
      if (target === null || !ctx.keys.has(target)) ctx.report.unresolved(target ?? href, ctx.fromLabel)
      out.push({ ...node, marks: (node.marks ?? []).filter((mark) => mark.type !== 'link') })
      continue
    }

    out.push(node)
  }

  return out.filter((node) => node.type !== 'text' || (node.text ?? '').length > 0)
}

/** The page a link names, whether it is an archive path or a `notion.so` address. */
function targetPageId(href: string, ctx: ResolveContext): string | null {
  if (isAbsolute(href)) {
    if (!/notion\.(so|site)\b/i.test(href)) return null
    const id = NOTION_ID.exec(href.replaceAll('-', ''))?.[1]
    return id ? (ctx.pageBySourceId.get(id.toLowerCase()) ?? null) : null
  }
  const target = archiveTarget(ctx.fromKey, href)
  return target ? (ctx.pageByKey.get(target) ?? null) : null
}

/** The same walk over every block, so a link inside a table cell is resolved like any other. */
function resolveNodes(nodes: PageDocNode[], ctx: ResolveContext): PageDocNode[] {
  const out: PageDocNode[] = []
  for (const node of resolveInline(nodes, ctx)) {
    if (!node.content || node.content.length === 0) {
      out.push(node)
      continue
    }
    const content = resolveNodes(node.content, ctx)
    /*
     * A paragraph that held nothing but a picture the import could not attach goes with it.
     *
     * The picture is dropped above and its file gets a report row saying so; leaving the wrapper
     * behind put a blank block in the middle of the page, which says nothing to the person reading
     * it and is not what the archive contained. Only a `paragraph` — an emptied table cell has to
     * keep its place in the row and an emptied list item its place in the numbering, so those are
     * left exactly as they are.
     */
    if (content.length === 0 && node.type === 'paragraph') continue
    out.push({ ...node, content })
  }
  return out
}

function resolveDocument(doc: PageDoc, ctx: ResolveContext): PageDoc {
  return { ...doc, content: resolveNodes(doc.content ?? [], ctx) }
}

// ------------------------------------------------------------------------------------------------
// Reading the archive
// ------------------------------------------------------------------------------------------------

/** Noise every archive from a Mac or a Windows machine carries, and nobody ever meant to import. */
const IGNORED = [
  /(^|\/)__MACOSX\//,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
  /(^|\/)\._[^/]+$/,
]

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/** The base name with its extension removed: `Team notes 12ab.md` → `Team notes 12ab`. */
const stemOf = (key: string): string => {
  const name = basenameOf(key)
  const at = name.lastIndexOf('.')
  return at > 0 ? name.slice(0, at) : name
}

/**
 * A Notion name split into what it is called and the id Notion appended to it.
 *
 * `Team notes 1a2b3c4d5e6f7890abcdef1234567890` is one page; the same name with `_all` on the end is
 * the "all" view Notion writes beside a database's default one. Both halves matter: the id is what
 * makes two pages of the same name different, and the name is the fallback title for a file with no
 * heading in it.
 */
export function splitNotionName(stem: string): { name: string; id: string | null; all: boolean } {
  const match = /^(.*?)[\s_-]*([0-9a-f]{32})(_all)?$/i.exec(stem)
  if (!match) return { name: stem, id: null, all: false }
  return { name: match[1]!.trim() || stem, id: match[2]!.toLowerCase(), all: match[3] !== undefined }
}

interface Candidate {
  entry: ArchiveEntry
  key: string
  text: string
}

/**
 * Every path the archive lists, whatever became of it.
 *
 * Deliberately not filtered: a link naming a picture, an attachment, a second database view or a file
 * whose bytes are damaged names something that *is* in the upload, and each of those already has a row
 * of its own saying what happened to it. Only a path that appears nowhere in this set is something
 * somebody has to go and find.
 */
const archiveKeys = (entries: ArchiveEntry[]): Set<string> => new Set(entries.map((entry) => entry.key))

/**
 * Split the archive into the files worth reading and the rows for everything else.
 *
 * Every rejection is a row, and each says which of the three things happened: an entry the zip reader
 * could not produce bytes for is `failed`, a file Quire has no use for is `skipped`, and only what
 * survives goes on to become a page.
 */
function triage(
  entries: ArchiveEntry[],
  report: Report,
  wanted: (key: string) => boolean,
  ignore: (key: string) => string | null,
): Candidate[] {
  const out: Candidate[] = []
  for (const entry of entries) {
    if (IGNORED.some((pattern) => pattern.test(entry.key))) {
      report.skipped(entry.path, 'it is an operating system file, not part of the export')
      continue
    }
    if (entry.error !== null) {
      report.failed(entry.path, entry.error)
      continue
    }
    const reason = ignore(entry.key)
    if (reason) {
      report.skipped(entry.path, reason)
      continue
    }
    if (!wanted(entry.key)) {
      report.skipped(entry.path, unwantedReason(entry.key))
      continue
    }
    if (entry.data!.length > MAX_DOCUMENT_BYTES) {
      report.failed(
        entry.path,
        `it is ${Math.round(entry.data!.length / 1024)} KB, which is too large for a page`,
      )
      continue
    }
    const text = textOf(entry.data!)
    if (text === null) {
      report.failed(entry.path, 'it is not text, so it cannot be read as a document')
      continue
    }
    out.push({ entry, key: entry.key, text })
  }
  return out
}

/**
 * Why a file Quire will not read was left out, in the words somebody can act on.
 *
 * A picture gets its own sentence because it is the one people ask about, and because the answer is
 * a real limit rather than a decision: see the note in `resolveInline`.
 */
function unwantedReason(key: string): string {
  const extension = extensionOf(key)
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'].includes(extension))
    return 'Quire cannot yet attach a picture that arrives in an import, so it was left out of the page that used it'
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip'].includes(extension))
    return 'an attachment, which an import cannot yet carry into a page'
  // Not `a ${extension || 'file with no extension'} file`, which reads "a file with no extension file".
  if (extension === '') return 'a file with no extension, which an import has no way to read as a page'
  return `a ${extension} file, which an import has no way to read as a page`
}

// ------------------------------------------------------------------------------------------------
// Databases
// ------------------------------------------------------------------------------------------------

/**
 * One CSV as a database, with the guesses recorded.
 *
 * The **first column is the row's title** and does not become a property. That is Notion's own
 * convention and every other exporter's; a database whose first column is duplicated as a text
 * property is one where renaming a row leaves a stale copy of the old name in a cell nobody notices.
 */
function planDatabase(
  candidate: Candidate,
  name: string,
  hostPageId: string,
  report: Report,
): PlannedDatabase | null {
  const rows = parseCsv(candidate.text)
  const header = rows[0]
  if (!header || header.length === 0 || header.every((cell) => cell.trim() === '')) {
    report.failed(candidate.entry.path, 'the file has no header row, so its columns cannot be named')
    return null
  }
  const body = rows.slice(1, MAX_ROWS + 1)

  const titles = header[0]!.trim() || 'Name'
  const columns: GuessedColumn[] = []
  const notes: string[] = [`the first column, ${titles}, became each row's title`]
  // Said on the file's own row rather than on a second one, so that "a row per file" stays true —
  // and because a table that arrived with its first five thousand rows was still imported.
  if (rows.length - 1 > MAX_ROWS)
    notes.push(
      `only the first ${MAX_ROWS} of ${rows.length - 1} rows were imported; a table this size ` +
        'belongs in a spreadsheet',
    )
  for (let index = 1; index < header.length; index++) {
    const label = header[index]!.trim()
    if (label === '') continue
    const column = guessColumn(
      label,
      body.map((row) => row[index] ?? ''),
    )
    columns.push(column)
    notes.push(column.note)
  }

  const planned: PlannedDatabase = {
    hostPageId,
    name,
    columns,
    rows: body
      .filter((row) => row.some((cell) => cell.trim() !== ''))
      .map((row) => ({
        id: uuidv7(),
        title: (row[0] ?? '').trim() || 'Untitled',
        values: columns.map((column, index) => coerceValue(column, row[index + 1] ?? '')),
        doc: { type: 'doc', content: [] } as PageDoc,
      })),
  }

  /*
   * The one place an `imported` row carries a `reason`, and it is deliberate.
   *
   * A guess nobody is told about is indistinguishable from a mistake, so "what each column was read
   * as" has to reach the report — and both other shapes are worse. A second row for the same file
   * would have to claim an outcome the file did not have (it was imported, not skipped), and would
   * make `counts.skipped` count something that was not skipped. A row of its own for each column
   * would bury the files under a hundred rows of metadata. So the row for the CSV says what it became
   * and, uniquely, how. `ImportReportEntry.reason` is documented as null for an imported entry; that
   * sentence is one case too narrow, and this is the case.
   */
  report.imported(candidate.entry.path, hostPageId, notes.join('; '))
  return planned
}

// ------------------------------------------------------------------------------------------------
// The three sources
// ------------------------------------------------------------------------------------------------

interface Draft {
  key: string
  path: string
  title: string
  doc: PageDoc
  parentKey: string | null
  sourceId: string | null
  id: string
}

/**
 * A Notion export, or a folder of Markdown — the same reader, because they are the same shape.
 *
 * Notion writes `Page name <32 hex>.md` beside a folder of the same name holding its children, which
 * is exactly the tree a `folder/index.md` layout expresses, and exactly what Quire's own export
 * writes. The differences are two: Notion appends an id to every name, and a folder of Markdown puts
 * a folder's own page in `index.md` rather than beside it. Both are handled by the two lookups below,
 * so one reader covers both and neither drifts from the other.
 */
function planDocuments(entries: ArchiveEntry[], source: ImportSource, report: Report): ImportPlan {
  const candidates = triage(
    entries,
    report,
    (key) => MARKDOWN_EXTENSIONS.has(extensionOf(key)) || extensionOf(key) === '.csv',
    () => null,
  )

  const markdown = candidates.filter((c) => MARKDOWN_EXTENSIONS.has(extensionOf(c.key)))
  const csv = candidates.filter((c) => extensionOf(c.key) === '.csv')

  /** `folder/index.md` and `folder/README.md` are the folder's own page. */
  const indexOfFolder = new Map<string, Candidate>()
  for (const candidate of markdown) {
    const stem = stemOf(candidate.key).toLowerCase()
    if (stem === 'index' || stem === 'readme') indexOfFolder.set(dirnameOf(candidate.key), candidate)
  }

  /** `A/B.md` is the page whose children live in `A/B/`, which is Notion's whole tree convention. */
  const pageOfFolder = new Map<string, Candidate>()
  for (const candidate of markdown) {
    const folder = candidate.key.slice(0, candidate.key.length - extensionOf(candidate.key).length)
    if (!pageOfFolder.has(folder)) pageOfFolder.set(folder, candidate)
  }

  /**
   * Which CSV to import when Notion wrote two of them.
   *
   * `Tasks abc.csv` is the database's default view and `Tasks abc_all.csv` is the same rows under its
   * "all" view. Importing both would create the database twice, so the default wins and the other
   * gets a row saying which one was used — the alternative, picking whichever came first in the
   * archive, is a coin toss the report cannot explain.
   */
  const databaseCsv = new Map<string, Candidate>()
  for (const candidate of [...csv].sort((a, b) => a.key.localeCompare(b.key))) {
    const { id, all } = splitNotionName(stemOf(candidate.key))
    const group = id ? `${dirnameOf(candidate.key)}/${id}` : candidate.key
    const existing = databaseCsv.get(group)
    if (!existing) {
      databaseCsv.set(group, candidate)
      continue
    }
    const loser = all ? candidate : existing
    const winner = all ? existing : candidate
    databaseCsv.set(group, winner)
    report.skipped(
      loser.entry.path,
      `a second view of the same database; its rows came from ${winner.entry.path}`,
    )
  }

  /** The archive folder a database's row pages live in, so those pages become rows and not siblings. */
  const rowFolder = new Map<string, Candidate>()
  for (const candidate of databaseCsv.values()) {
    const stem = stemOf(candidate.key)
    const { name, id } = splitNotionName(stem)
    const folder = `${dirnameOf(candidate.key) ? `${dirnameOf(candidate.key)}/` : ''}${id ? `${name} ${id}` : name}`
    rowFolder.set(folder, candidate)
  }

  const drafts: Draft[] = []
  /** Markdown files inside a database's folder: each is one row's page, not a page of its own. */
  const rowPages: Array<{ candidate: Candidate; database: Candidate }> = []

  for (const candidate of markdown) {
    const folder = dirnameOf(candidate.key)
    const database = rowFolder.get(folder)
    if (database) {
      rowPages.push({ candidate, database })
      continue
    }
    const stem = stemOf(candidate.key)
    const { name, id } = source === 'notion' ? splitNotionName(stem) : { name: stem, id: null }
    const { title, body } = splitTitle(candidate.text)
    const isIndex = indexOfFolder.get(folder) === candidate
    drafts.push({
      id: uuidv7(),
      key: candidate.key,
      path: candidate.entry.path,
      // A folder's `index.md` with no heading is named after its folder rather than "index".
      title: title || (isIndex ? basenameOf(folder) || name : name) || 'Untitled',
      doc: markdownToPageDoc(body),
      parentKey: parentOf(candidate.key, isIndex, indexOfFolder, pageOfFolder),
      sourceId: id,
    })
  }

  return assemble(drafts, report, archiveKeys(entries), (pageByKey, pageBySourceId) => {
    const databases: PlannedDatabase[] = []
    const extraPages: PlannedPage[] = []
    /** Row pages already accounted for, so the sweep below cannot write a second row about one. */
    const settled = new Set<Candidate>()

    for (const candidate of databaseCsv.values()) {
      const stem = stemOf(candidate.key)
      const { name, id } = source === 'notion' ? splitNotionName(stem) : { name: stem, id: null }
      const hostPageId = uuidv7()
      const planned = planDatabase(candidate, name || 'Imported table', hostPageId, report)
      if (!planned) continue

      const parentKey = parentOf(candidate.key, false, indexOfFolder, pageOfFolder)
      extraPages.push({
        id: hostPageId,
        key: candidate.key,
        title: name || 'Imported table',
        parentId: parentKey ? (pageByKey.get(parentKey) ?? null) : null,
        doc: { type: 'doc', content: [] },
      })
      pageByKey.set(candidate.key, hostPageId)
      if (id) pageBySourceId.set(id, hostPageId)

      /*
       * A row's own page, matched to its row by title — Notion writes one `.md` per row inside the
       * database's folder, and a row with a body is the whole reason those files are in the archive.
       *
       * A **queue** per title rather than one row per title, because a database is perfectly entitled
       * to hold two rows called the same thing and Notion then writes two files called the same thing.
       * A plain map keeps the last of each, so both files matched one row: the first file's body was
       * silently thrown away, both were reported `imported`, and both rows carried the *same* page id —
       * a report saying a page arrived when its text is nowhere in the space. Taking each row once
       * pairs them off in archive order and leaves any genuine surplus to be reported as surplus.
       */
      const byTitle = new Map<string, PlannedRow[]>()
      for (const row of planned.rows) {
        const key = row.title.trim().toLowerCase()
        const queue = byTitle.get(key)
        if (queue) queue.push(row)
        else byTitle.set(key, [row])
      }
      /** Which file's body a row already took, so the surplus row can name it rather than guess. */
      const taken = new Map<string, string>()
      for (const { candidate: page, database } of rowPages) {
        if (database !== candidate) continue
        settled.add(page)
        const { title, body } = splitTitle(page.text)
        const stemName = source === 'notion' ? splitNotionName(stemOf(page.key)).name : stemOf(page.key)
        const rowTitle = (title || stemName).trim()
        const queue = byTitle.get(rowTitle.toLowerCase())
        const row = queue?.shift()
        if (!row) {
          const already = taken.get(rowTitle.toLowerCase())
          report.skipped(
            page.entry.path,
            already
              ? `every row of ${candidate.entry.path} called "${rowTitle}" already has a page; ` +
                  `the last one's body came from ${already}`
              : `no row of ${candidate.entry.path} is called "${rowTitle}", so this page has no row to belong to`,
          )
          continue
        }
        taken.set(rowTitle.toLowerCase(), page.entry.path)
        row.doc = markdownToPageDoc(body)
        // A row is a page, so a link to it resolves like a link to anything else.
        pageByKey.set(page.key, row.id)
        if (source === 'notion') {
          const rowId = splitNotionName(stemOf(page.key)).id
          if (rowId) pageBySourceId.set(rowId, row.id)
        }
        report.imported(page.entry.path, row.id)
      }
      databases.push(planned)
    }

    // A row page whose database could not be planned at all has nothing left to belong to.
    for (const { candidate: page, database } of rowPages)
      if (!settled.has(page))
        report.skipped(page.entry.path, `it is a row of ${database.entry.path}, which was not imported`)

    return { databases, extraPages }
  })
}

/** Which page a file's page hangs under, given the two conventions a folder can follow. */
function parentOf(
  key: string,
  isIndex: boolean,
  indexOfFolder: Map<string, Candidate>,
  pageOfFolder: Map<string, Candidate>,
): string | null {
  const folder = dirnameOf(key)
  // A folder's own index page hangs under the folder above it, not under itself.
  const search = isIndex ? dirnameOf(folder) : folder
  const index = indexOfFolder.get(search)
  if (index && index.key !== key) return index.key
  const beside = pageOfFolder.get(search)
  if (beside && beside.key !== key) return beside.key
  return null
}

/**
 * A Confluence space export: one rendered `.html` per page, with the tree in each page's breadcrumb.
 *
 * The breadcrumb is the only thing in the export that says what a page's parent is — the filenames
 * are flat and `index.html` lists everything in one alphabetical table. Reading it is what turns a
 * hundred loose pages into the space somebody actually had.
 */
function planConfluence(entries: ArchiveEntry[], report: Report): ImportPlan {
  const candidates = triage(
    entries,
    report,
    (key) => HTML_EXTENSIONS.has(extensionOf(key)) || extensionOf(key) === '.csv',
    (key) => {
      if (/(^|\/)(styles|images|js)\//i.test(key)) return 'part of the export’s own styling, not a page'
      if (/(^|\/)attachments\//i.test(key))
        return 'an attachment, which an import cannot yet carry into a page'
      if (basenameOf(key).toLowerCase() === 'index.html')
        return 'the export’s own index of pages; the pages themselves were imported instead'
      return null
    },
  )

  const drafts: Draft[] = []
  for (const candidate of candidates.filter((c) => HTML_EXTENSIONS.has(extensionOf(c.key)))) {
    const root = parseHtml(candidate.text)
    const main =
      findElement(root, (el) => el.attrs.id === 'main-content') ??
      findElement(root, (el) => classesOf(el).includes('wiki-content')) ??
      findElement(root, (el) => el.tag === 'body')
    if (!main) {
      report.failed(candidate.entry.path, 'the file has no page content in it')
      continue
    }

    const heading =
      findElement(root, (el) => el.attrs.id === 'title-text') ??
      findElement(root, (el) => el.attrs.id === 'title-heading')
    const titleTag = findElement(root, (el) => el.tag === 'title')
    // Confluence titles its files "Space name : Page name"; the page's own name is the second half.
    const fromTitleTag = titleTag ? (textContent(titleTag).split(' : ').at(-1) ?? '').trim() : ''
    const title = (heading ? textContent(heading).trim() : '') || fromTitleTag || stemOf(candidate.key)

    drafts.push({
      id: uuidv7(),
      key: candidate.key,
      path: candidate.entry.path,
      title: title || 'Untitled',
      doc: htmlToPageDoc(main),
      parentKey: confluenceParent(root, candidate.key),
      sourceId: null,
    })
  }

  return assemble(drafts, report, archiveKeys(entries), (pageByKey) => {
    const databases: PlannedDatabase[] = []
    const extraPages: PlannedPage[] = []
    for (const candidate of candidates.filter((c) => extensionOf(c.key) === '.csv')) {
      const hostPageId = uuidv7()
      const planned = planDatabase(candidate, stemOf(candidate.key) || 'Imported table', hostPageId, report)
      if (!planned) continue
      extraPages.push({
        id: hostPageId,
        key: candidate.key,
        title: stemOf(candidate.key) || 'Imported table',
        parentId: null,
        doc: { type: 'doc', content: [] },
      })
      pageByKey.set(candidate.key, hostPageId)
      databases.push(planned)
    }
    return { databases, extraPages }
  })
}

/** The last page named in a Confluence breadcrumb, which is this page's parent. */
function confluenceParent(root: ReturnType<typeof parseHtml>, key: string): string | null {
  const crumbs = findElement(root, (el) => el.attrs.id === 'breadcrumb-section')
  if (!crumbs) return null
  const hrefs: string[] = []
  const walk = (node: Parameters<typeof textContent>[0]): void => {
    if (!('tag' in node)) return
    if (node.tag === 'a' && node.attrs.href) hrefs.push(node.attrs.href)
    for (const child of node.children) walk(child)
  }
  walk(crumbs)
  for (const href of hrefs.reverse()) {
    if (!HTML_EXTENSIONS.has(extensionOf(href))) continue
    if (basenameOf(href).toLowerCase() === 'index.html') continue
    const target = archiveTarget(key, href)
    if (target && target !== key) return target
  }
  return null
}

// ------------------------------------------------------------------------------------------------
// Assembly
// ------------------------------------------------------------------------------------------------

/**
 * Drafts into a plan: parents wired, links resolved, and every page reported.
 *
 * The order is the only order that works. Ids exist first, so `pageByKey` is complete before a single
 * link is looked at; databases are planned next, because a link may point at a database's host page;
 * and only then is any document resolved. Doing it in one pass would silently turn every forward
 * link — which is most of them, in a tree written top down — into plain text.
 */
function assemble(
  drafts: Draft[],
  report: Report,
  keys: Set<string>,
  extras: (
    pageByKey: Map<string, string>,
    pageBySourceId: Map<string, string>,
  ) => { databases: PlannedDatabase[]; extraPages: PlannedPage[] },
): ImportPlan {
  const kept = drafts.slice(0, MAX_PAGES)
  for (const draft of drafts.slice(MAX_PAGES))
    report.skipped(draft.path, `this import already carries ${MAX_PAGES} pages, which is one job's limit`)

  const pageByKey = new Map(kept.map((draft) => [draft.key, draft.id]))
  const pageBySourceId = new Map(
    kept.filter((draft) => draft.sourceId).map((draft) => [draft.sourceId!, draft.id]),
  )

  const { databases, extraPages } = extras(pageByKey, pageBySourceId)

  const byId = new Map([...kept.map((d) => [d.id, d] as const)])
  const pages: PlannedPage[] = kept.map((draft) => {
    const parentId = draft.parentKey ? (pageByKey.get(draft.parentKey) ?? null) : null
    return {
      id: draft.id,
      key: draft.key,
      title: draft.title,
      // A parent that is its own descendant would be a tree with no root; the archive cannot express
      // one, but a hand-edited breadcrumb can, so the cycle is broken by hanging the page at the top.
      parentId: parentId && !isAncestor(draft.id, parentId, byId, pageByKey) ? parentId : null,
      doc: draft.doc,
    }
  })

  const all = [...pages, ...extraPages]
  const resolve = (page: PlannedPage) =>
    resolveDocument(page.doc, {
      fromKey: page.key,
      fromLabel: `"${page.title}"`,
      pageByKey,
      pageBySourceId,
      keys,
      report,
    })

  for (const page of all) page.doc = resolve(page)
  for (const database of databases)
    for (const row of database.rows)
      row.doc = resolveDocument(row.doc, {
        fromKey: `${database.name}/${row.title}`,
        fromLabel: `"${row.title}"`,
        pageByKey,
        pageBySourceId,
        keys,
        report,
      })

  for (const draft of kept) report.imported(draft.path, draft.id)

  return { pages: all, databases, report: report.finish() }
}

/** Whether following `parentId` upwards ever reaches `id`. */
function isAncestor(
  id: string,
  parentId: string,
  byId: Map<string, Draft>,
  pageByKey: Map<string, string>,
): boolean {
  const seen = new Set<string>()
  let at: string | null = parentId
  while (at !== null && !seen.has(at)) {
    if (at === id) return true
    seen.add(at)
    const draft: Draft | undefined = byId.get(at)
    at = draft?.parentKey ? (pageByKey.get(draft.parentKey) ?? null) : null
  }
  return false
}

/**
 * The whole archive, read.
 *
 * One entry point rather than three exported readers, so the service never has to know which shape a
 * source has — and so a fourth source is a case here rather than a branch in the job.
 */
export function planImport(entries: ArchiveEntry[], source: ImportSource): ImportPlan {
  const order = new Map(entries.map((entry, index) => [entry.path, index]))
  const report = new Report(order)
  return source === 'confluence' ? planConfluence(entries, report) : planDocuments(entries, source, report)
}
