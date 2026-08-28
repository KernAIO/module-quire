/**
 * HTML to PDF, through Gotenberg.
 *
 * Gotenberg is a Chromium in a container, and it is already in the stack: `selfhost/docker-compose.yml`
 * starts it under `--profile preview`, `dev/compose.yml` publishes it on 3500. Nothing in Kern had
 * ever called it, so this is the first caller and the first thing that has to answer the question
 * every optional dependency raises — **what happens when it is not there.**
 *
 * The answer is one sentence with three parts, and every one of them is load-bearing:
 *
 *   - it never produces a half file. The bytes are read in full, in memory, before anything is
 *     written anywhere; a refusal, a timeout or a closed port throws before the caller has an
 *     artefact to store, so an export job goes to `failed` with `file_id` still null rather than to
 *     `done` with a truncated PDF a reader would find out about by opening it;
 *   - the failure names the URL it tried and the variable that changes it, because the person who
 *     reads it is an operator looking at a stack, not a developer looking at a stack trace. "PDF
 *     export could not reach Gotenberg at http://gotenberg:3000" is actionable; `ECONNREFUSED` is
 *     not;
 *   - it is bounded. Chromium rendering a five-hundred-page handbook can take minutes or can hang,
 *     and a job that hangs holds a worker for ever. The request carries a timeout and gives up.
 *
 * The default points at the compose service name rather than at nothing, so an instance that has the
 * `preview` profile on needs no configuration at all and one that does not gets a refusal naming
 * `GOTENBERG_URL`.
 */
import { KernError } from '@kernhq/kernel'

/** Where the compose stack puts it. `dev/compose.yml` publishes 3500 on the host. */
export const DEFAULT_GOTENBERG_URL = 'http://gotenberg:3000'

export const gotenbergUrl = (): string => process.env.GOTENBERG_URL?.trim() || DEFAULT_GOTENBERG_URL

/** Long enough for a big handbook, short enough that a wedged Chromium is not a wedged worker. */
const DEFAULT_TIMEOUT_MS = 120_000

/** A refusal's body is a diagnostic, not a document: enough to act on, never a page of HTML in a log. */
const REASON_LIMIT = 400

export interface PdfOptions {
  /** overrides `GOTENBERG_URL`; the export job does not pass one, the test does */
  url?: string
  timeoutMs?: number
  /** what Chromium prints in the footer's page numbers, and nothing else */
  title?: string
}

/**
 * A complete PDF, or a throw.
 *
 * The HTML has to be self-contained. Gotenberg's Chromium fetches whatever the document references,
 * from inside its own container — so a presigned storage URL in an `<img src>` is both a network
 * dependency this has no business having and a workspace uuid handed to a process that did not need
 * it. Pictures reach here as `data:` URIs, put there by the caller.
 */
export async function htmlToPdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
  const base = (options.url ?? gotenbergUrl()).replace(/\/+$/, '')
  const endpoint = `${base}/forms/chromium/convert/html`

  const form = new FormData()
  // The part *must* be named `index.html`; Gotenberg renders that file and treats the rest as assets.
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
  form.append('paperWidth', '8.27')
  form.append('paperHeight', '11.7')
  form.append('marginTop', '0.6')
  form.append('marginBottom', '0.6')
  form.append('marginLeft', '0.6')
  form.append('marginRight', '0.6')
  form.append('printBackground', 'true')
  // Without this a callout's tint and a code block's ground are dropped and the page loses its shape.
  form.append('preferCssPageSize', 'false')
  if (options.title) form.append('metadata', JSON.stringify({ Title: options.title, Creator: 'Kern Quire' }))

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    const why =
      err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'is not reachable'
    throw new KernError(
      'UNAVAILABLE',
      `PDF export needs Gotenberg, and ${base} ${why}. Start it (the self-host stack has it under ` +
        '`--profile preview`) or point GOTENBERG_URL at one that is running.',
      { service: 'gotenberg', url: base },
    )
  }

  if (!response.ok) {
    const reason = await response.text().catch(() => '')
    throw new KernError(
      'UNAVAILABLE',
      `Gotenberg at ${base} refused to render this page (HTTP ${response.status}). ` +
        `${reason.slice(0, REASON_LIMIT) || 'It gave no reason.'}`,
      { service: 'gotenberg', url: base, status: response.status },
    )
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  /*
   * A zero-length 200 is a real Gotenberg failure mode when Chromium dies mid-render, and it is the
   * one that would otherwise be stored: an empty file, a job marked `done`, and a person who finds
   * out by double-clicking it. `%PDF` is four bytes and settles it.
   */
  if (bytes.length === 0 || bytes.subarray(0, 4).toString('latin1') !== '%PDF')
    throw new KernError('UNAVAILABLE', `Gotenberg at ${base} returned something that is not a PDF`, {
      service: 'gotenberg',
      url: base,
      bytes: bytes.length,
    })
  return bytes
}
