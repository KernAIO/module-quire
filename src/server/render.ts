import type { PageDoc, PageDocMark, PageDocNode } from '@kernhq/ui/editor/page-doc'

/**
 * A page, drawn outside the browser.
 *
 * Everything that is not the editor needs this: publishing a page to a reader, exporting it,
 * putting a snippet in a search result, mailing a digest. None of those has a DOM, so none of them
 * could see a page at all before — the prose lives in a Yjs document, and the only thing that knew
 * how to draw it was Tiptap.
 *
 * The rule this file exists to keep is the one in `@kernhq/ui`'s `schema.ts`: **the read side must
 * be able to draw everything the writer can produce.** A node the editor emits and this file has no
 * case for does not render as something plain — it vanishes, and the writer finds out from a reader.
 * `render.test.ts` compares the dispatch tables below against `PAGE_DOC_NODES` and `PAGE_DOC_MARKS`
 * in both directions, so a node with no renderer fails, and so does a renderer for a node that no
 * longer exists.
 *
 * The output is safe to hand to `{@html}` or to write into a response. Every piece of text and
 * every attribute value is escaped, anything that reaches a URL goes through `safeHref`, and
 * everything numeric is parsed as a number rather than interpolated.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Both quote characters, so an escaped value is safe in an attribute however it is quoted. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * The only hrefs that reach the page.
 *
 * Stricter than the tracker's client renderer, deliberately. That one is `/^(https?:|mailto:|\/)/i`,
 * which accepts `//evil.example` — a protocol-relative href inherits the page's scheme and leaves
 * the site entirely, so it is an off-site link wearing the costume of a local one.
 *
 * The cleaning step is not cosmetic either. A browser strips tab, newline and carriage return from
 * anywhere in a URL and trims leading control characters before deciding what protocol it is, so
 * `java&#9;script:alert(1)` navigates to `javascript:`. This has to reach the same verdict the
 * browser will, or the check is reading a different string from the one that runs.
 */
/**
 * What the URL parser throws away before it looks at a URL, done by hand.
 *
 * Character codes rather than a regex, because the characters in question are control characters:
 * a regex holding them is unreadable, and Biome refuses one on sight. Two rules, and they are not
 * the same rule — everything up to and including a space is stripped from *the ends*, and tab,
 * line feed and carriage return are removed from *anywhere*.
 */
function stripUrlNoise(raw: string): string {
  let start = 0
  let end = raw.length
  while (start < end && raw.charCodeAt(start) <= 0x20) start++
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--
  let out = ''
  for (let i = start; i < end; i++) {
    const code = raw.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    out += raw[i]
  }
  return out
}

/**
 * `\` is `/` before the query, and only there.
 *
 * For a special scheme — http and https are both special — the URL parser treats a backslash in the
 * scheme, authority or path exactly as a forward slash, so `/\evil.example` *is* `//evil.example`
 * and leaves the site. That is the same escape the `//` rule below rejects, spelled differently, and
 * a check that reads the unfolded string is reading a different URL from the one the browser will.
 *
 * After the first `?` or `#` a backslash is ordinary data and the parser leaves it alone, so this
 * stops there. Folding a query would rewrite a link that was never dangerous.
 */
function foldBackslashes(url: string): string {
  const cut = url.search(/[?#]/)
  const head = cut === -1 ? url : url.slice(0, cut)
  return cut === -1 ? head.replaceAll('\\', '/') : head.replaceAll('\\', '/') + url.slice(cut)
}

export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const cleaned = foldBackslashes(stripUrlNoise(href))
  if (!cleaned) return null
  // A fragment stays on this page — that is what a table of contents links to.
  if (cleaned.startsWith('#')) return cleaned
  if (cleaned.startsWith('//')) return null
  // A root-relative path is a link inside the app, e.g. `/quire/ENG/<id>`.
  if (cleaned.startsWith('/')) return cleaned
  try {
    return ALLOWED_PROTOCOLS.has(new URL(cleaned).protocol) ? cleaned : null
  } catch {
    // Anything that is not a URL at all, including a bare relative path we cannot resolve.
    return null
  }
}

/** An attribute we generated ourselves is still checked: it arrived as document JSON. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const LANGUAGE_PATTERN = /^[a-z0-9#+.-]{1,24}$/i

const safeId = (value: unknown): string | null =>
  typeof value === 'string' && ID_PATTERN.test(value) ? value : null

/** A whole number in a sane range, or nothing. Never the string that was in the document. */
function safeInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null
  return n
}

const attr = (name: string, value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : ` ${name}="${escapeHtml(String(value))}"`

/** `id` when the writer's editor stamped one, so a heading can be linked to. */
const idAttr = (node: PageDocNode): string => attr('id', safeId(node.attrs?.id))

export interface RenderOptions {
  /**
   * Turn a stored file id into something a reader's browser can fetch.
   *
   * Injected rather than resolved here, because there is no one right answer. The app signs a
   * short-lived URL per render; a page published to the public internet needs something that
   * outlives a session. A picture whose id cannot be resolved is dropped rather than rendered as
   * a broken image.
   */
  fileSrc?: (fileId: string) => string | null
  /**
   * Turn a page id into a link. The renderer does not know a page's space key, and a wrong link is
   * worse than none — without this a page mention degrades to a plain, still-readable label.
   */
  pageHref?: (pageId: string) => string | null
}

type NodeRenderer = (node: PageDocNode, children: string, options: RenderOptions) => string
type MarkRenderer = (html: string, attrs: Record<string, unknown> | null | undefined) => string

/** Every character in the node, ignoring marks. What a `<pre>` wants. */
function textOf(node: PageDocNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(textOf).join('')
}

/**
 * The mark table.
 *
 * A mark this does not know is dropped and its text kept, which is the correct failure: the
 * sentence still reads, it just is not bold.
 */
export const MARK_RENDERERS: Record<string, MarkRenderer> = {
  bold: (html) => `<strong>${html}</strong>`,
  italic: (html) => `<em>${html}</em>`,
  strike: (html) => `<s>${html}</s>`,
  underline: (html) => `<u>${html}</u>`,
  code: (html) => `<code>${html}</code>`,
  highlight: (html) => `<mark class="kern-highlight">${html}</mark>`,
  link: (html, attrs) => {
    const href = safeHref(attrs?.href)
    // No `<a>` at all rather than a dead one: a link that cannot navigate must not look like it can.
    if (!href) return html
    return `<a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${html}</a>`
  },
}

/**
 * A renderer this table actually declares, or nothing.
 *
 * A node's type is an XmlElement name out of the Y.Doc, which is to say a string the client picked.
 * These tables are object literals, so `__proto__`, `constructor` and `toString` all answer with
 * something inherited and truthy that is not a renderer — and the caller, having only checked that
 * it got *something*, calls it and throws. An unknown node is supposed to degrade to its children;
 * a `TypeError` escaping as a 500 from `versions.get` is the opposite of that.
 */
function own<T>(table: Record<string, T>, type: string | null | undefined): T | undefined {
  return typeof type === 'string' && Object.hasOwn(table, type) ? table[type] : undefined
}

function renderMarks(html: string, marks: PageDocMark[] | null | undefined): string {
  let out = html
  for (const mark of marks ?? []) {
    const render = own(MARK_RENDERERS, mark?.type)
    if (render) out = render(out, mark.attrs)
  }
  return out
}

/** `<td>` and `<th>` differ only in the tag, so the attributes are written once. */
function cell(tag: 'td' | 'th', node: PageDocNode, children: string): string {
  const colspan = safeInt(node.attrs?.colspan, 1, 1000)
  const rowspan = safeInt(node.attrs?.rowspan, 1, 1000)
  const widths = Array.isArray(node.attrs?.colwidth)
    ? (node.attrs.colwidth as unknown[]).map((w) => safeInt(w, 1, 10000)).filter((w) => w !== null)
    : []
  const align = ['start', 'center', 'end'].includes(String(node.attrs?.align))
    ? String(node.attrs?.align)
    : null
  return [
    `<${tag}`,
    idAttr(node),
    colspan && colspan > 1 ? attr('colspan', colspan) : '',
    rowspan && rowspan > 1 ? attr('rowspan', rowspan) : '',
    widths.length ? attr('data-colwidth', widths.join(',')) : '',
    attr('data-align', align),
    `>${children}</${tag}>`,
  ].join('')
}

/**
 * The node table.
 *
 * A `Record` rather than a `switch`, so the test can compare *this object* against the schema's
 * node list. A switch would force the test to restate its cases, and a test that restates what it
 * checks is a second copy that drifts rather than a check.
 *
 * `doc` and `text` are not here; they are the two the walker handles itself.
 */
export const NODE_RENDERERS: Record<string, NodeRenderer> = {
  // An empty paragraph is a deliberate blank line, and `<p></p>` collapses to nothing.
  paragraph: (node, children) => `<p${idAttr(node)}>${children || '<br>'}</p>`,

  heading: (node, children) => {
    const level = safeInt(node.attrs?.level, 1, 6) ?? 1
    return `<h${level}${idAttr(node)}>${children}</h${level}>`
  },

  bulletList: (node, children) => `<ul${idAttr(node)}>${children}</ul>`,

  // `start` and `type`, or a list that begins at 5 silently restarts at 1.
  orderedList: (node, children) => {
    const start = safeInt(node.attrs?.start, 1, 1_000_000)
    const type = ['a', 'A', 'i', 'I', '1'].includes(String(node.attrs?.type))
      ? String(node.attrs?.type)
      : null
    return `<ol${idAttr(node)}${start && start !== 1 ? attr('start', start) : ''}${attr('type', type)}>${children}</ol>`
  },

  listItem: (node, children) => `<li${idAttr(node)}>${children}</li>`,

  taskList: (node, children) => `<ul${idAttr(node)} class="kern-tasks" data-type="taskList">${children}</ul>`,

  /*
   * Mirrors what Tiptap's own TaskItem renders, so a page does not shift between the editor and the
   * published copy — with `disabled` added. A checkbox a reader can click that changes nothing is
   * worse than one that plainly cannot be clicked.
   */
  taskItem: (node, children) => {
    const checked = node.attrs?.checked === true
    return [
      `<li${idAttr(node)} data-checked="${checked}" data-type="taskItem">`,
      `<label><input type="checkbox" disabled${checked ? ' checked' : ''}><span></span></label>`,
      `<div>${children}</div></li>`,
    ].join('')
  },

  blockquote: (node, children) => `<blockquote${idAttr(node)}>${children}</blockquote>`,

  /*
   * The text, not the rendered children. A code block's content is text and nothing else, and
   * rendering its children would let a `code` mark inside it emit a nested `<code>`.
   */
  codeBlock: (node) => {
    const language =
      typeof node.attrs?.language === 'string' && LANGUAGE_PATTERN.test(node.attrs.language)
        ? node.attrs.language
        : null
    const className = language ? ` class="language-${escapeHtml(language)}"` : ''
    return `<pre${idAttr(node)}><code${className}>${escapeHtml(textOf(node))}</code></pre>`
  },

  horizontalRule: (node) => `<hr${idAttr(node)}>`,

  hardBreak: () => '<br>',

  /*
   * A picture is stored by file id — see the note on the node in `page-schema.ts`. Without a
   * resolver there is nothing honest to emit, so nothing is: a broken-image icon tells a reader the
   * page is damaged when it is the render that is under-configured.
   */
  image: (node, _children, options) => {
    const fileId = typeof node.attrs?.fileId === 'string' ? node.attrs.fileId : null
    const resolved = fileId ? (options.fileSrc?.(fileId) ?? null) : null
    const src = safeHref(resolved ?? node.attrs?.src)
    if (!src) return ''
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
    return [
      `<img${idAttr(node)} src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`,
      attr('title', typeof node.attrs?.title === 'string' ? node.attrs.title : null),
      attr('width', safeInt(node.attrs?.width, 1, 20000)),
      attr('height', safeInt(node.attrs?.height, 1, 20000)),
      ' loading="lazy">',
    ].join('')
  },

  /*
   * The wrapper is not decoration. A table is the one block that cannot be made narrower, so it
   * gets its own scroller — otherwise a wide one pushes the whole page sideways, which is exactly
   * the defect shell's e2e sweep exists to catch, and it is worst in Persian.
   */
  table: (node, children) =>
    `<div class="kern-table-wrap"><table${idAttr(node)} class="kern-table"><tbody>${children}</tbody></table></div>`,
  tableRow: (node, children) => `<tr${idAttr(node)}>${children}</tr>`,
  tableCell: (node, children) => cell('td', node, children),
  tableHeader: (node, children) => cell('th', node, children),

  details: (node, children) => `<details${idAttr(node)} class="kern-toggle">${children}</details>`,
  detailsSummary: (node, children) => `<summary${idAttr(node)}>${children}</summary>`,
  detailsContent: (node, children) => `<div${idAttr(node)}>${children}</div>`,

  /*
   * Byte-identical to what the Callout node renders in the editor — that pairing is written down in
   * `nodes/callout.ts` and this is the other half of it. The tone is narrowed to the closed set
   * rather than trusted, because it ends up inside an attribute selector.
   */
  callout: (node, children) => {
    const tone = ['info', 'note', 'success', 'warning', 'danger'].includes(String(node.attrs?.tone))
      ? String(node.attrs?.tone)
      : 'info'
    return `<aside${idAttr(node)} class="kern-callout" data-callout="${tone}">${children}</aside>`
  },

  /*
   * A mention is an inline leaf: it has no children, so a case that rendered `children` would render
   * nothing and the mention would simply disappear.
   */
  mention: (node) => {
    const label = String(node.attrs?.label ?? '')
    const id = String(node.attrs?.id ?? '')
    return `<span class="kern-mention" data-type="mention" data-id="${escapeHtml(id)}">@${escapeHtml(label)}</span>`
  },

  pageMention: (node, _children, options) => {
    const label = String(node.attrs?.label ?? '')
    const id = String(node.attrs?.id ?? '')
    const href = id ? safeHref(options.pageHref?.(id)) : null
    const body = escapeHtml(label || 'Untitled')
    const data = ` data-type="pageMention" data-id="${escapeHtml(id)}"`
    // No resolver, or a page we cannot address: still readable, just not clickable.
    if (!href) return `<span class="kern-page-mention"${data}>${body}</span>`
    return `<a class="kern-page-mention" href="${escapeHtml(href)}"${data}>${body}</a>`
  },
}

function renderNode(node: PageDocNode, options: RenderOptions): string {
  if (node.type === 'text') return renderMarks(escapeHtml(node.text ?? ''), node.marks)
  const render = own(NODE_RENDERERS, node.type)
  const children = (node.content ?? []).map((child) => renderNode(child, options)).join('')
  /*
   * An unknown node keeps its children rather than dropping them. This should be unreachable — the
   * test makes sure every node in the schema has a case — but a document written by a newer image
   * and read by an older one is a real situation during a rolling deploy, and losing a paragraph
   * because its wrapper is from next week is not an acceptable way to handle it.
   */
  return render ? render(node, children, options) : children
}

/** Sanitised HTML for a stored page. An empty or missing document renders as an empty string. */
export function renderPageDoc(doc: PageDoc | null | undefined, options: RenderOptions = {}): string {
  if (!doc || !Array.isArray(doc.content)) return ''
  return doc.content.map((node) => renderNode(node, options)).join('')
}

/**
 * Everything in a document that has to be looked up before it can be drawn.
 *
 * `renderPageDoc` is synchronous on purpose — a pure function of a document and two lookup tables —
 * so a caller that needs a database row or a signed URL collects the ids here, resolves them all in
 * one pass, and hands the answers back as `RenderOptions`. Resolving inside the renderer would mean
 * one round trip per picture, in render order, on a request that is otherwise two queries.
 *
 * Both lists are de-duplicated: the same picture used twice is one signature, not two.
 */
export function referencesIn(doc: PageDoc | null | undefined): { fileIds: string[]; pageIds: string[] } {
  const fileIds = new Set<string>()
  const pageIds = new Set<string>()
  const walk = (node: PageDocNode): void => {
    if (node.type === 'image' && typeof node.attrs?.fileId === 'string') fileIds.add(node.attrs.fileId)
    if (node.type === 'pageMention' && typeof node.attrs?.id === 'string') pageIds.add(node.attrs.id)
    for (const child of node.content ?? []) walk(child)
  }
  for (const node of doc?.content ?? []) walk(node)
  return { fileIds: [...fileIds], pageIds: [...pageIds] }
}

/** Nodes whose children are separate blocks, so their text needs a line between each. */
const BLOCK_PARENTS = new Set([
  'blockquote',
  'bulletList',
  'callout',
  'details',
  'detailsContent',
  'doc',
  'listItem',
  'orderedList',
  'table',
  'taskItem',
  'taskList',
])

/** What `collab`'s own flatten caps at; the same number, so the two agree about a very long page. */
const TEXT_LIMIT = 100_000

/**
 * The same document as plain text, for the search index and for previews.
 *
 * This exists because the flatten it replaces is wrong in a way nobody could see. `collab`'s
 * `extractText` walks the Yjs tree and calls `toString()` on each `Y.XmlText`, which renders marks
 * *as markup* — so a page containing one link put
 * `<link class="null" href="…" rel="noreferrer noopener" target="_blank">` into the search body,
 * and every page in the workspace matched a search for "noopener".
 */
export function textFromPageDoc(doc: PageDoc | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return ''

  const walk = (node: PageDocNode): string => {
    if (typeof node.text === 'string') return node.text
    switch (node.type) {
      case 'hardBreak':
        return '\n'
      // The literal that produced it, so an edit round-trips instead of deleting who was mentioned.
      case 'mention':
        return `@${String(node.attrs?.label ?? '')}`
      case 'pageMention':
        return String(node.attrs?.label ?? '')
      // A picture contributes its alt text, the only part of it anybody can search for.
      case 'image':
        return typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
      // Cells are joined with a tab, or two columns run together into one nonsense word.
      case 'tableRow':
        return (node.content ?? []).map(walk).join('\t')
      default:
        break
    }
    /*
     * A toggle contributes its summary *and* what it hides, and a code block contributes its
     * commands. Collapsed is a display choice, and a runbook's commands are exactly the thing
     * people search for — so neither is skipped.
     */
    const separator = BLOCK_PARENTS.has(node.type ?? '') ? '\n' : ''
    return (node.content ?? []).map(walk).join(separator)
  }

  return (doc.content ?? [])
    .map(walk)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, TEXT_LIMIT)
}
