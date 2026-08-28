import type { ExportFormat, ExportScope, ImportSource, TransferState } from '../contract/index.js'
import { t } from './i18n.js'

/**
 * The bits of the transfer screens that are not a screen.
 *
 * Two dialogs and a page draw the same four vocabularies — a scope, a format, a source and a state
 * — and the same download. Written out once here because the alternative is four copies of a
 * `switch` that has to agree with the contract's enums: a `TransferState` gaining a fifth member
 * would then be four silent gaps rather than one type error.
 *
 * Every label is a function rather than a constant. A module is defined once at import time while
 * the interface language can change afterwards, so a map built at module scope would be frozen in
 * whatever language happened to be loaded first — the same reason `module.ts` writes its nav labels
 * as getters.
 */

/** The four states, as a person reads them rather than as the column stores them. */
export function stateLabel(state: TransferState): string {
  return state === 'queued'
    ? t('transfer_queued')
    : state === 'running'
      ? t('transfer_running')
      : state === 'done'
        ? t('transfer_done')
        : t('transfer_failed')
}

/**
 * What a state looks like at a glance.
 *
 * `queued` and `running` share the spinner deliberately: the difference between "a worker has not
 * picked this up" and "a worker is on it" is the sentence beside the icon, not the icon — two
 * different in-progress glyphs would be two things to learn for one meaning.
 */
export function stateIcon(state: TransferState): string {
  return state === 'done' ? 'circle-check' : state === 'failed' ? 'triangle-alert' : 'loader'
}

/** Where the export took its pages from. */
export function scopeLabel(scope: ExportScope): string {
  return scope === 'page'
    ? t('export_scope_page')
    : scope === 'subtree'
      ? t('export_scope_subtree')
      : t('export_scope_space')
}

/**
 * The formats a person may actually pick.
 *
 * `docx` is in `ExportFormat` and is not here, because the server refuses it at `exports.start` —
 * see `services/export.ts` for why a Word file nothing in this repository can open is worse than a
 * refusal. Offering a control whose only outcome is an error is the shape this list exists to
 * prevent; the dialog says the same thing in a sentence instead, which answers the question
 * ("where is Word?") without pretending to have an answer it does not have.
 */
export const EXPORT_FORMATS: readonly Exclude<ExportFormat, 'docx'>[] = ['markdown', 'html', 'pdf']

export function formatLabel(format: ExportFormat): string {
  return format === 'markdown'
    ? t('export_format_markdown')
    : format === 'html'
      ? t('export_format_html')
      : format === 'pdf'
        ? t('export_format_pdf')
        : t('export_format_docx')
}

export function formatDescription(format: Exclude<ExportFormat, 'docx'>): string {
  return format === 'markdown'
    ? t('export_format_markdown_desc')
    : format === 'html'
      ? t('export_format_html_desc')
      : t('export_format_pdf_desc')
}

export const IMPORT_SOURCES: readonly ImportSource[] = ['notion', 'confluence', 'markdown']

export function sourceLabel(source: ImportSource): string {
  return source === 'notion'
    ? t('import_source_notion')
    : source === 'confluence'
      ? t('import_source_confluence')
      : t('import_source_markdown')
}

export function sourceDescription(source: ImportSource): string {
  return source === 'notion'
    ? t('import_source_notion_desc')
    : source === 'confluence'
      ? t('import_source_confluence_desc')
      : t('import_source_markdown_desc')
}

/** Neither `done` nor `failed`, so something is still going to happen to it. */
export const isRunning = (state: TransferState): boolean => state === 'queued' || state === 'running'

/**
 * How far along a job is, as a fraction, or `null` while there is nothing honest to draw.
 *
 * `total` is 0 until the job has finished counting what it is about to do, and a bar sitting at 0%
 * for the first few seconds of every export reads as a job that is stuck. Null means "say it is
 * running, in words" — which is true — rather than drawing a measurement nobody has taken.
 */
export function progressRatio(counts: {
  total: number
  done: number
  skipped: number
  failed: number
}): number | null {
  if (counts.total <= 0) return null
  const seen = counts.done + counts.skipped + counts.failed
  return Math.max(0, Math.min(1, seen / counts.total))
}

/**
 * Fetch an artefact the browser has just been given a link to.
 *
 * A hidden anchor rather than `location.href`, and rather than `window.open`: `open` is what a
 * pop-up blocker stops when it happens after an `await`, and assigning `location` sends the whole
 * document at a URL that only *usually* comes back as a download. A click on an `<a>` is the one
 * gesture every browser treats as "fetch this file", and the page it happened on is untouched.
 *
 * `filename` is honoured for a same-origin address only — the `download` attribute is ignored
 * cross-origin, which is every real instance, where the name comes from the `Content-Disposition`
 * the presigned URL was signed with. It is passed anyway because `dev:mock` hands back a `data:`
 * URL, and there the attribute is the only thing that names the file.
 */
export function startDownload(url: string, filename?: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noreferrer noopener'
  if (filename) anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** An error as a line of text, whatever was thrown. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
