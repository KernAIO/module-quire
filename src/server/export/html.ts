/**
 * A page as an HTML file somebody can open with no Kern behind it.
 *
 * The body comes from `renderPageDoc` — the same static renderer the public site uses — so an export
 * and a published page are the same drawing of the same stored version. What this file adds is
 * everything a *file* needs and a page inside an application does not: a document element, a
 * character set, a title, and the styles, inlined.
 *
 * **The stylesheet is written here rather than taken from `@kernhq/ui`, and that is deliberate.**
 * `prose.css` in that package is 480 lines referencing 31 `--kern-*` tokens defined in a second
 * stylesheet that itself references a palette — so "inline the prose styles" is really "inline the
 * whole design system", and an exported file would carry a copy of it that goes stale the moment the
 * palette moves. What a reader of an exported page needs is smaller and does not change: the ink and
 * paper colours, a measure they can read, and a rule for every block the renderer can emit. It is
 * written flat, with no custom properties to resolve, because a file that is opened in a mail client
 * or pasted into a wiki is not guaranteed a cascade.
 *
 * It has to answer for the same things a Kern screen answers for. Dark mode is `prefers-color-scheme`
 * rather than a class, because a file has no shell to set one. `dir` comes from the document element
 * so a Persian or Arabic page reads right-to-left, and every rule that could have been `left` or
 * `right` is a logical property — `margin-inline-start`, `border-inline-start`, `text-align: start` —
 * so nothing has to be mirrored. A table is the one block that cannot be made narrower, so it keeps
 * the same `overflow-x` scroller the application gives it rather than pushing the page sideways.
 */
import { escapeHtml } from '../render.js'

/**
 * What an exported page is dressed in.
 *
 * Deliberately not a copy of `prose.css`: the same shapes, in the values a standalone file can rely
 * on. Every colour pair here was chosen against the surface it sits on — body ink on paper is
 * #2c2a26 on #fdfcfa in light and #e8e4dc on #171614 in dark, and the muted ink is a colour rather
 * than an opacity, because `opacity` fades text against whatever is behind it and a "muted" row at
 * 0.5 is a row nobody can read.
 *
 * The contrast is arithmetic and was computed rather than judged: every foreground below was
 * measured against the surface it actually sits on — including each callout tint, the highlight and
 * the code ground, in both themes — and the worst pair is the muted trail at **5.33:1**, which
 * clears AA for body text. Re-measure before changing a value rather than adjusting it by eye.
 */
export const EXPORT_STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 40px 24px 96px;
  background: #fdfcfa;
  color: #2c2a26;
  font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
}
main { margin: 0 auto; max-width: 74ch; }
.kern-page + .kern-page { margin-top: 72px; border-top: 1px solid #e5e0d6; padding-top: 40px; }
.kern-page-title { margin: 0 0 4px; font-size: 32px; line-height: 1.25; font-weight: 650; }
.kern-page-trail { margin: 0 0 28px; font-size: 13px; color: #6f6959; }
.kern-prose > :first-child { margin-top: 0; }
.kern-prose > :last-child { margin-bottom: 0; }
.kern-prose p { margin: 0 0 16px; }
.kern-prose h1, .kern-prose h2, .kern-prose h3,
.kern-prose h4, .kern-prose h5, .kern-prose h6 {
  margin: 32px 0 12px; line-height: 1.3; font-weight: 650; scroll-margin-top: 16px;
}
.kern-prose h1 { font-size: 28px; }
.kern-prose h2 { font-size: 23px; }
.kern-prose h3 { font-size: 19px; }
.kern-prose h4 { font-size: 17px; }
.kern-prose h5 { font-size: 15px; }
.kern-prose h6 { font-size: 14px; color: #6f6959; text-transform: uppercase; letter-spacing: 0.04em; }
.kern-prose a { color: #1c5f7a; text-underline-offset: 2px; }
.kern-prose ul, .kern-prose ol { margin: 0 0 16px; padding-inline-start: 26px; }
.kern-prose li { margin: 4px 0; }
.kern-prose li > p { margin: 0; }
.kern-prose blockquote {
  margin: 0 0 16px; padding-block: 2px; padding-inline: 16px 0;
  border-inline-start: 3px solid #d8d2c4; color: #4a463d;
}
.kern-prose code {
  font: 0.9em/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  background: #f1eee6; border: 1px solid #e5e0d6; border-radius: 4px; padding: 1px 4px;
}
.kern-prose pre {
  margin: 0 0 16px; padding: 14px 16px; overflow-x: auto;
  background: #f6f3ec; border: 1px solid #e5e0d6; border-radius: 8px;
}
.kern-prose pre code { background: none; border: 0; padding: 0; font-size: 13px; }
.kern-prose hr { margin: 28px 0; border: 0; border-top: 1px solid #e5e0d6; }
.kern-prose img { max-width: 100%; height: auto; border-radius: 6px; }
.kern-prose mark.kern-highlight { background: #fbeaa8; color: inherit; padding: 0 2px; border-radius: 3px; }
.kern-table-wrap { margin: 0 0 16px; overflow-x: auto; }
.kern-prose table.kern-table { border-collapse: collapse; width: 100%; font-size: 15px; }
.kern-prose table.kern-table td, .kern-prose table.kern-table th {
  border: 1px solid #e5e0d6; padding: 7px 10px; text-align: start; vertical-align: top;
}
.kern-prose table.kern-table th { background: #f6f3ec; font-weight: 620; }
.kern-prose table.kern-table [data-align="center"] { text-align: center; }
.kern-prose table.kern-table [data-align="end"] { text-align: end; }
.kern-prose ul.kern-tasks { list-style: none; padding-inline-start: 2px; }
.kern-prose ul.kern-tasks li { display: flex; gap: 8px; align-items: baseline; }
.kern-prose ul.kern-tasks li > div { flex: 1; min-width: 0; }
.kern-prose ul.kern-tasks li > div > p { margin: 0; }
.kern-prose aside.kern-callout {
  margin: 0 0 16px; padding: 12px 16px; border-radius: 8px;
  border: 1px solid #d8d2c4; border-inline-start-width: 3px; background: #f6f3ec;
}
.kern-prose aside.kern-callout > :last-child { margin-bottom: 0; }
.kern-prose aside.kern-callout[data-callout="info"] { border-color: #a9cbd8; background: #eef6f9; }
.kern-prose aside.kern-callout[data-callout="success"] { border-color: #a9d3b4; background: #eef8f1; }
.kern-prose aside.kern-callout[data-callout="warning"] { border-color: #e0cb96; background: #fbf5e6; }
.kern-prose aside.kern-callout[data-callout="danger"] { border-color: #e0aaa4; background: #fbefee; }
.kern-prose details.kern-toggle {
  margin: 0 0 16px; padding: 10px 14px; border: 1px solid #e5e0d6; border-radius: 8px;
}
.kern-prose details.kern-toggle > summary { cursor: pointer; font-weight: 600; }
.kern-prose .kern-mention, .kern-prose .kern-page-mention {
  border-radius: 4px; padding: 0 3px; background: #eef2f7; color: #2b4a63;
}
@media print {
  body { padding: 0; background: #fff; color: #000; }
  .kern-page { break-after: page; }
  .kern-page:last-child { break-after: auto; }
  .kern-page + .kern-page { margin-top: 0; border-top: 0; padding-top: 0; }
  .kern-prose a { color: inherit; }
  .kern-table-wrap { overflow-x: visible; }
}
@media (prefers-color-scheme: dark) {
  body { background: #171614; color: #e8e4dc; }
  .kern-page + .kern-page { border-top-color: #35322c; }
  .kern-page-trail, .kern-prose h6 { color: #9a9384; }
  .kern-prose a { color: #7fc2dd; }
  .kern-prose blockquote { border-inline-start-color: #3f3b33; color: #c6c1b6; }
  .kern-prose code { background: #23211d; border-color: #35322c; }
  .kern-prose pre { background: #1e1d1a; border-color: #35322c; }
  .kern-prose hr { border-top-color: #35322c; }
  .kern-prose mark.kern-highlight { background: #6a5a1e; color: #f4efdd; }
  .kern-prose table.kern-table td, .kern-prose table.kern-table th { border-color: #35322c; }
  .kern-prose table.kern-table th { background: #1e1d1a; }
  .kern-prose aside.kern-callout { border-color: #3f3b33; background: #1e1d1a; }
  .kern-prose aside.kern-callout[data-callout="info"] { border-color: #2d5a6d; background: #16232a; }
  .kern-prose aside.kern-callout[data-callout="success"] { border-color: #2f5c3d; background: #16241b; }
  .kern-prose aside.kern-callout[data-callout="warning"] { border-color: #6a5622; background: #241f13; }
  .kern-prose aside.kern-callout[data-callout="danger"] { border-color: #6d3a34; background: #261917; }
  .kern-prose details.kern-toggle { border-color: #35322c; }
  .kern-prose .kern-mention, .kern-prose .kern-page-mention { background: #22303a; color: #b7d4e4; }
}
`.trim()

/**
 * A stand-in for an address `renderPageDoc` would otherwise refuse, swapped back afterwards.
 *
 * This exists because of a rule in `render.ts` that is right and inconvenient. `safeHref` accepts a
 * fragment, a root-relative path, and `http`/`https`/`mailto` — and **nothing else**, deliberately:
 * a bare relative path is something it cannot resolve, and `data:` is a document that can carry
 * script. An exported file needs exactly the two it refuses. `media/diagram.png` and
 * `../getting-started/index.html` are what makes an archive open on a laptop with nothing running,
 * and a `data:` URI is what puts a picture into a PDF without handing Chromium a URL into our
 * storage.
 *
 * The wrong fix would be to loosen `safeHref`, which is consulted by the published-site renderer on
 * behalf of anonymous readers. So the renderer is given an `https` URL it accepts, and the exporter
 * swaps it for the real one after the HTML is drawn. Two things make that safe rather than clever:
 * the token is exact and unique, so the replacement is a string swap and not a regular expression
 * over markup; and the host is under `.invalid`, the TLD RFC 2606 reserves as permanently
 * unresolvable — so a token that somehow escaped the swap is a picture that cannot load rather than
 * a request to somebody's server.
 */
export interface ExportLinks {
  /** A token `safeHref` accepts, standing for `target`. The same target always gets the same token. */
  to(target: string): string
  /** The drawn HTML with every token swapped back. */
  resolve(html: string): string
}

export function exportLinks(): ExportLinks {
  const byTarget = new Map<string, string>()
  const byToken = new Map<string, string>()
  return {
    to(target) {
      const existing = byTarget.get(target)
      if (existing) return existing
      const token = `https://asset.invalid/${byToken.size}`
      byTarget.set(target, token)
      byToken.set(token, target)
      return token
    },
    resolve(html) {
      let out = html
      for (const [token, target] of byToken) out = out.replaceAll(token, target)
      return out
    },
  }
}

export interface ExportedPage {
  /** the page's own id, so a mention of it inside this export can be an anchor */
  id: string
  title: string
  /** the titles above it, outermost first — drawn as a trail so a loose file says where it came from */
  trail: string[]
  /** already rendered and escaped by `renderPageDoc`; never raw prose */
  html: string
}

const section = (page: ExportedPage): string =>
  [
    `<article class="kern-page" id="p-${escapeHtml(page.id)}">`,
    `<h1 class="kern-page-title">${escapeHtml(page.title || 'Untitled')}</h1>`,
    page.trail.length > 0
      ? `<p class="kern-page-trail">${page.trail.map((part) => escapeHtml(part)).join(' / ')}</p>`
      : '',
    `<div class="kern-prose">${page.html}</div>`,
    '</article>',
  ].join('\n')

/**
 * One HTML file holding one page or many.
 *
 * `pages` is a list rather than a page because the PDF path needs every page of a subtree in one
 * document — Chromium is handed a document and produces a PDF, so one round trip per page would be
 * one PDF per page and nothing to join them with. The zip path passes a list of one.
 *
 * `dir` is the writing direction of the *content*, not of the reader's locale: an exported Persian
 * handbook is right-to-left wherever it is opened.
 */
export function exportedHtmlDocument(opts: {
  title: string
  pages: ExportedPage[]
  dir?: 'ltr' | 'rtl' | 'auto'
  lang?: string
}): string {
  const dir = opts.dir ?? 'auto'
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang ?? 'en')}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Kern Quire">
<title>${escapeHtml(opts.title || 'Untitled')}</title>
<style>
${EXPORT_STYLES}
</style>
</head>
<body>
<main>
${opts.pages.map(section).join('\n')}
</main>
</body>
</html>
`
}
