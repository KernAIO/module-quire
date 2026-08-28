/**
 * HTML to a page document, for the one source that has no Markdown: a Confluence space export.
 *
 * Confluence's "Export space → HTML" writes one already-rendered `.html` per page, an `index.html`
 * listing them, and an `attachments/` tree. There is no storage format to read — the wiki markup and
 * the `<ac:…>` macros are gone by the time the export is written — so the rendered HTML *is* the
 * document, and reading it is the only route in that does not ask a customer to install a plugin.
 *
 * **A tag soup parser, deliberately, and not a DOM.** No `jsdom`, no `parse5`: this reads one
 * bounded, machine-written dialect, and the whole job is a tokeniser plus a stack that closes
 * implied tags. Nothing here is executed, nothing is fetched, and no attribute reaches a page
 * unfiltered — a `src` and an `href` come out as raw strings for `plan.ts` to resolve and everything
 * else is dropped, so a `<script>`, an `onclick` or a `javascript:` href has nowhere to land. That is
 * the property that matters, because the input is a file somebody uploaded.
 *
 * Confluence's own furniture is recognised where it maps onto something Quire has — an information
 * macro is a callout, a `syntaxhighlighter` block is a code block, an inline task list is a task list
 * — and ignored where it does not. What it cannot map, it keeps as prose rather than dropping, which
 * is the same rule the Markdown reader follows and for the same reason.
 */
import type { PageDoc, PageDocMark, PageDocNode } from '@kernhq/ui/editor/page-doc'

// ------------------------------------------------------------------------------------------------
// Tokenising
// ------------------------------------------------------------------------------------------------

export interface HtmlElement {
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
}
export type HtmlNode = HtmlElement | { text: string }

const isElement = (node: HtmlNode): node is HtmlElement => 'tag' in node

/** Tags that never have children, so a missing `/` is not a document with everything inside a `<br>`. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/**
 * Tags whose content is text rather than markup.
 *
 * `<script>` and `<style>` are here so that a `<` inside them cannot open an element — and their
 * content is then thrown away, because neither has any meaning in a page document. Reading them as
 * markup is how `if (a < b)` inside a script becomes an element called `b`.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

/**
 * Which open tags a new one implicitly closes.
 *
 * Confluence writes well-formed HTML, so this is for the exports that are not — hand-edited files,
 * and older Confluence versions that leave `<li>` and `<p>` unclosed. Without it one unclosed `<li>`
 * nests every following item inside it and a page arrives as a staircase.
 */
const IMPLIED_CLOSE: Record<string, string[]> = {
  li: ['li'],
  p: ['p'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['td', 'th', 'tr'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  laquo: '«',
  raquo: '»',
  check: '✓',
}

/** `&amp;`, `&#8212;`, `&#x2014;` — everything else is left exactly as it was written. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      // A surrogate half or an out-of-range code point would throw; the source text is the honest
      // fallback, because a mangled character is easier to explain than a failed import.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return whole
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** The attributes of one start tag. Values are decoded; names are lower-cased. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * A document as a tree.
 *
 * Comments, doctypes and processing instructions are skipped rather than kept: none of them can
 * become a node, and a comment holding `<div>` would otherwise open one.
 */
export function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [] }
  const stack: HtmlElement[] = [root]
  const top = () => stack[stack.length - 1]!
  const pushText = (value: string) => {
    if (value.length > 0) top().children.push({ text: decodeEntities(value) })
  }

  let at = 0
  while (at < source.length) {
    const lt = source.indexOf('<', at)
    if (lt < 0) {
      pushText(source.slice(at))
      break
    }
    pushText(source.slice(at, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      at = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt)
      at = end < 0 ? source.length : end + 1
      continue
    }

    const close = /^<\/\s*([a-zA-Z][^\s>]*)\s*>/.exec(source.slice(lt))
    if (close) {
      const tag = close[1]!.toLowerCase()
      // Close the nearest matching element, discarding anything left open inside it.
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i]!.tag === tag) {
          stack.length = i
          break
        }
      at = lt + close[0].length
      continue
    }

    const open = /^<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(source.slice(lt))
    if (!open) {
      // A bare `<` that opens nothing is a character somebody typed.
      pushText('<')
      at = lt + 1
      continue
    }
    const tag = open[1]!.toLowerCase()
    const attrs = parseAttributes(open[2] ?? '')
    at = lt + open[0].length

    if (RAW_TEXT_TAGS.has(tag)) {
      const end = source.toLowerCase().indexOf(`</${tag}`, at)
      const body = source.slice(at, end < 0 ? source.length : end)
      // `<title>` is the only one whose text is worth anything, and the page reader asks for it.
      if (tag === 'title') top().children.push({ tag, attrs, children: [{ text: decodeEntities(body) }] })
      at = end < 0 ? source.length : source.indexOf('>', end) + 1
      continue
    }

    for (const closes of IMPLIED_CLOSE[tag] ?? [])
      if (top().tag === closes) {
        stack.pop()
        break
      }

    const element: HtmlElement = { tag, attrs, children: [] }
    top().children.push(element)
    if (!VOID_TAGS.has(tag) && open[3] !== '/') stack.push(element)
  }

  return root
}

/** The first element matching a predicate, depth first. */
export function findElement(node: HtmlNode, match: (el: HtmlElement) => boolean): HtmlElement | null {
  if (!isElement(node)) return null
  if (node.tag !== '#root' && match(node)) return node
  for (const child of node.children) {
    const found = findElement(child, match)
    if (found) return found
  }
  return null
}

/** Every class on an element, lower-cased — Confluence's markup is identified entirely by class. */
export const classesOf = (el: HtmlElement): string[] => (el.attrs.class ?? '').toLowerCase().split(/\s+/)

/** All the text under a node, with runs of whitespace collapsed. What a title needs and no more. */
export function textContent(node: HtmlNode): string {
  if (!isElement(node)) return node.text
  return node.children.map(textContent).join('')
}

// ------------------------------------------------------------------------------------------------
// To a page document
// ------------------------------------------------------------------------------------------------

const MARKS: Record<string, string> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  mark: 'highlight',
  code: 'code',
}

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

/** Confluence names its five information macros by class; these are the ones with a Quire tone. */
const MACRO_TONES: Record<string, string> = {
  'confluence-information-macro-information': 'info',
  'confluence-information-macro-note': 'note',
  'confluence-information-macro-tip': 'success',
  'confluence-information-macro-warning': 'warning',
  'confluence-information-macro-problem': 'danger',
}

const isBlockTag = (tag: string): boolean =>
  tag in HEADINGS ||
  [
    'p',
    'div',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'pre',
    'blockquote',
    'hr',
  ].includes(tag)

/** Collapse the whitespace HTML treats as insignificant, keeping the single spaces between words. */
const collapse = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ')

function withMark(nodes: PageDocNode[], mark: PageDocMark): PageDocNode[] {
  return nodes.map((node) =>
    typeof node.text === 'string'
      ? { ...node, marks: [...(node.marks ?? []).filter((m) => m.type !== mark.type), mark] }
      : node,
  )
}

/** Inline content, for anything that cannot hold a block. */
function inlineOf(nodes: HtmlNode[]): PageDocNode[] {
  const out: PageDocNode[] = []
  const push = (values: PageDocNode[]) => {
    for (const node of values) {
      const last = out.at(-1)
      if (
        last &&
        typeof last.text === 'string' &&
        typeof node.text === 'string' &&
        JSON.stringify(last.marks ?? null) === JSON.stringify(node.marks ?? null)
      )
        last.text += node.text
      else out.push(node)
    }
  }

  for (const node of nodes) {
    if (!isElement(node)) {
      const value = collapse(node.text)
      if (value.length > 0) push([{ type: 'text', text: value }])
      continue
    }
    if (node.tag === 'br') {
      push([{ type: 'hardBreak' }])
      continue
    }
    if (node.tag === 'img') {
      const src = node.attrs.src ?? ''
      if (src) push([{ type: 'image', attrs: { src, alt: node.attrs.alt ?? '' } }])
      continue
    }
    if (node.tag === 'a') {
      const href = node.attrs.href ?? ''
      const inner = inlineOf(node.children)
      // A link with no target is not a link; keeping its label is better than dropping the words.
      push(href ? withMark(inner, { type: 'link', attrs: { href } }) : inner)
      continue
    }
    const mark = MARKS[node.tag]
    if (mark) {
      push(withMark(inlineOf(node.children), { type: mark }))
      continue
    }
    // Anything else — a `<span>`, a `<time>`, a Confluence wrapper — contributes its content.
    push(inlineOf(node.children))
  }
  return out
}

/** A paragraph from inline content, or nothing when the content was only whitespace. */
function paragraphOf(nodes: HtmlNode[]): PageDocNode | null {
  const content = trimInline(inlineOf(nodes))
  return content.length > 0 ? { type: 'paragraph', content } : null
}

/** Drop the leading and trailing whitespace HTML puts between tags. */
function trimInline(nodes: PageDocNode[]): PageDocNode[] {
  const out = [...nodes]
  while (out.length > 0 && typeof out[0]!.text === 'string' && out[0]!.text!.trim() === '') out.shift()
  while (out.length > 0 && typeof out.at(-1)!.text === 'string' && out.at(-1)!.text!.trim() === '') out.pop()
  if (out.length > 0 && typeof out[0]!.text === 'string')
    out[0] = { ...out[0]!, text: out[0]!.text!.replace(/^ +/, '') }
  const last = out.at(-1)
  if (last && typeof last.text === 'string')
    out[out.length - 1] = { ...last, text: last.text!.replace(/ +$/, '') }
  return out.filter((node) => typeof node.text !== 'string' || node.text.length > 0)
}

/**
 * A list item's content, as blocks.
 *
 * An item holding nothing but inline content becomes one paragraph, which is what every other writer
 * in this module produces; an item holding a nested list keeps both.
 */
function itemContent(children: HtmlNode[]): PageDocNode[] {
  const blocks = blocksOf(children)
  return blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }]
}

/** A `<ul>` or `<ol>`, as the list — or the task list — it is. */
function listOf(el: HtmlElement): PageDocNode {
  const items = el.children.filter((child): child is HtmlElement => isElement(child) && child.tag === 'li')
  // Confluence writes a task list as `<ul class="inline-task-list"><li class="checked">`.
  const isTasks = classesOf(el).includes('inline-task-list')
  if (isTasks)
    return {
      type: 'taskList',
      content: items.map((item) => ({
        type: 'taskItem',
        attrs: { checked: classesOf(item).includes('checked') },
        content: itemContent(item.children),
      })),
    }
  if (el.tag === 'ol') {
    const start = Number(el.attrs.start)
    return {
      type: 'orderedList',
      attrs: { start: Number.isInteger(start) && start > 0 ? start : 1 },
      content: items.map((item) => ({ type: 'listItem', content: itemContent(item.children) })),
    }
  }
  return {
    type: 'bulletList',
    content: items.map((item) => ({ type: 'listItem', content: itemContent(item.children) })),
  }
}

/** A `<table>`, flattened past `<thead>`/`<tbody>` — Quire's table is rows all the way down. */
function tableOf(el: HtmlElement): PageDocNode | null {
  const rows: HtmlElement[] = []
  const collect = (node: HtmlNode) => {
    if (!isElement(node)) return
    if (node.tag === 'tr') {
      rows.push(node)
      return
    }
    for (const child of node.children) collect(child)
  }
  collect(el)
  if (rows.length === 0) return null

  const content = rows.map((row) => ({
    type: 'tableRow',
    content: row.children
      .filter((cell): cell is HtmlElement => isElement(cell) && (cell.tag === 'td' || cell.tag === 'th'))
      .map((cell) => ({
        type: cell.tag === 'th' ? 'tableHeader' : 'tableCell',
        content: itemContent(cell.children),
      })),
  }))
  return { type: 'table', content }
}

/**
 * A `<pre>` as a code block, with the language Confluence puts in the class if there is one.
 *
 * The text is taken raw rather than collapsed: whitespace is the whole point of a code block, and a
 * collapsed one is a snippet nobody can run.
 */
function codeOf(el: HtmlElement): PageDocNode {
  const language = classesOf(el)
    .map((name) => /^(?:language|brush|lang)[-:]([a-z0-9#+.-]{1,24})$/i.exec(name)?.[1])
    .find((found): found is string => found !== undefined)
  const body = textContent(el)
    .replace(/\r\n|\r/g, '\n')
    .replace(/^\n+|\n+$/g, '')
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    content: body.length > 0 ? [{ type: 'text', text: body }] : [],
  }
}

/**
 * The blocks under one element.
 *
 * A run of inline content between block children becomes a paragraph of its own, which is what makes
 * `<div>text<ul>…</ul>more text</div>` — the shape Confluence's macros produce — come out as three
 * blocks rather than as one paragraph with a list hidden inside it.
 */
function blocksOf(children: HtmlNode[]): PageDocNode[] {
  const out: PageDocNode[] = []
  let inline: HtmlNode[] = []
  const flush = () => {
    const node = paragraphOf(inline)
    if (node) out.push(node)
    inline = []
  }

  for (const child of children) {
    if (!isElement(child) || !isBlockTag(child.tag)) {
      inline.push(child)
      continue
    }
    flush()
    out.push(...blockOf(child))
  }
  flush()
  return out
}

function blockOf(el: HtmlElement): PageDocNode[] {
  const level = HEADINGS[el.tag]
  if (level !== undefined) {
    const content = trimInline(inlineOf(el.children))
    return content.length > 0 ? [{ type: 'heading', attrs: { level }, content }] : []
  }

  switch (el.tag) {
    case 'p': {
      const node = paragraphOf(el.children)
      return node ? [node] : []
    }
    case 'hr':
      return [{ type: 'horizontalRule' }]
    case 'pre':
      return [codeOf(el)]
    case 'ul':
    case 'ol':
      return [listOf(el)]
    case 'table': {
      const node = tableOf(el)
      return node ? [node] : []
    }
    case 'blockquote': {
      const body = blocksOf(el.children)
      return [{ type: 'blockquote', content: body.length > 0 ? body : [{ type: 'paragraph', content: [] }] }]
    }
    default: {
      // A `<div>`. Confluence's information macros are the one kind worth recognising: each is a
      // `<div>` whose class names the tone, holding the body in a nested `<div>`.
      const tone = classesOf(el)
        .map((name) => MACRO_TONES[name])
        .find((found): found is string => found !== undefined)
      const body = blocksOf(el.children)
      if (tone)
        return [
          {
            type: 'callout',
            attrs: { tone },
            content: body.length > 0 ? body : [{ type: 'paragraph', content: [] }],
          },
        ]
      return body
    }
  }
}

/**
 * An HTML fragment as a page document.
 *
 * Always a `doc`: an element holding nothing is an empty page, which is a correct reading of an empty
 * page rather than a failure.
 */
export function htmlToPageDoc(node: HtmlNode): PageDoc {
  return { type: 'doc', content: isElement(node) ? blocksOf(node.children) : blocksOf([node]) }
}
