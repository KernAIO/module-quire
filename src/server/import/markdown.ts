/**
 * Markdown to a page document — the reader for `../export/markdown.ts`.
 *
 * The two files are a pair and the pairing is the requirement: everything the writer emits has to
 * come back as itself. That is what makes a Quire export a valid Quire import, and it is the only
 * check on the writer that is not somebody reading it. `import.int.test.ts` asserts the round trip
 * block by block.
 *
 * **This is not a CommonMark implementation and does not pretend to be.** It covers the dialect the
 * writer produces and the dialect Notion and Confluence produce, which is GitHub-flavoured Markdown
 * with a handful of HTML tags: ATX and setext headings, fenced code with an info string, blockquotes,
 * GitHub alerts (`> [!WARNING]`) as callouts, bullet, ordered and task lists with nesting, GFM
 * tables, thematic breaks, `<details>` toggles, `<u>`, `<mark>` and `<br>`, and inline emphasis, code
 * spans, links, autolinks and images. What it deliberately does not do — reference links, footnotes,
 * HTML blocks it has no node for — degrades to a paragraph of the text rather than being dropped,
 * because losing a paragraph silently is the failure this whole slice exists to prevent.
 *
 * **A hard line break is spelled `<br>`, including internally.** A paragraph's lines are joined
 * before its inline content is scanned, because an emphasis run or a link label may wrap across them
 * — and the join then has to remember which wraps were `two spaces` or a trailing backslash and
 * which were ordinary soft wraps. Rewriting the first kind as `<br>` rather than inventing a sentinel
 * character means the marker is a real thing the format already has: it is what the writer's own
 * table cells carry, what Confluence emits in prose, and something a reader can see in a diff.
 *
 * **Links and images keep their raw targets.** A `link` mark carries the href exactly as it was
 * written and an `image` node carries its `src`, because resolving them needs the whole archive —
 * which page is at `../Team%20notes/Onboarding%2012ab.md` is not a question one file can answer.
 * `plan.ts` walks the finished document and rewrites or degrades them, and that split is what keeps
 * this file pure and testable on a string.
 */
import type { PageDoc, PageDocMark, PageDocNode } from '@kernhq/ui/editor/page-doc'

const text = (value: string, marks?: PageDocMark[]): PageDocNode =>
  marks && marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value }

const element = (type: string, content: PageDocNode[], attrs?: Record<string, unknown>): PageDocNode =>
  attrs ? { type, attrs, content } : { type, content }

const paragraph = (content: PageDocNode[]): PageDocNode => ({ type: 'paragraph', content })

/** `info` | `note` | `success` | `warning` | `danger` — the writer's set, and the renderer's. */
const CALLOUT_TONES = new Set(['info', 'note', 'success', 'warning', 'danger'])

/**
 * GitHub's own five alert names, mapped onto Quire's tones.
 *
 * The writer emits Quire's names, so `[!SUCCESS]` round-trips exactly; these are the ones a file
 * written on GitHub carries, and mapping them is the difference between a coloured callout and a
 * blockquote with `[!TIP]` sitting at the top of it as literal text.
 */
const GITHUB_ALERTS: Record<string, string> = {
  note: 'note',
  tip: 'success',
  important: 'info',
  warning: 'warning',
  caution: 'danger',
}

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
/**
 * A heading's optional closing sequence, which **must be preceded by a space** — CommonMark 4.2.
 *
 * It used to be part of `RE_ATX` as a bare `#*[ \t]*$`, which ate a hash that was ordinary text:
 * `# Sharp C#` came back one character short, on any hand-written file. Two things follow from
 * getting it right. The first is that hash — text now, as the spec says. The second is that a
 * *deliberate* closing sequence is the only case left, so the writer can escape its way past it:
 * `# Roadmap \#` is not a closing sequence here — the run is preceded by a backslash rather than a
 * space — and `unescapePunctuation` hands the hash back. That is how a page called `Roadmap #`
 * keeps its name, and it does not work without this line. `markdownTitleLine` in
 * `services/export.ts` is the other half.
 */
const RE_ATX_CLOSING = /(^|[ \t])#+[ \t]*$/
const atxContent = (raw: string | undefined): string => (raw ?? '').replace(RE_ATX_CLOSING, '$1').trim()
const RE_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const RE_QUOTE = /^ {0,3}>[ \t]?/
const RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/
const RE_EMPTY_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]*$/
const RE_TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/
const RE_BREAK_TAG = /^<br\s*\/?>/i

/** Tabs are four columns here, which is what every writer in this repository emits and reads. */
function indentOf(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

function dedent(line: string, width: number): string {
  let seen = 0
  let at = 0
  while (at < line.length && seen < width) {
    const ch = line[at]
    if (ch === ' ') seen += 1
    else if (ch === '\t') seen += 4 - (seen % 4)
    else break
    at++
  }
  return line.slice(at)
}

const isBlank = (line: string): boolean => line.trim().length === 0

// ------------------------------------------------------------------------------------------------
// Inline
// ------------------------------------------------------------------------------------------------

/**
 * Where the next inline construct starts, scanning past anything backslash-escaped.
 *
 * One scan that finds the *earliest* opener rather than a pass per construct: passes compose badly
 * (a `*` inside a code span is not emphasis) and the earliest-opener rule is what CommonMark's
 * precedence amounts to over the subset here.
 */
interface Opener {
  at: number
  kind: 'code' | 'image' | 'link' | 'autolink' | 'tag' | 'break' | 'emphasis' | 'strike'
  run?: string
  tag?: string
}

const INLINE_TAGS: Record<string, string> = { u: 'underline', mark: 'highlight' }

function findOpener(source: string, from: number): Opener | null {
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') {
      let run = i
      while (run < source.length && source[run] === '`') run++
      return { at: i, kind: 'code', run: source.slice(i, run) }
    }
    if (ch === '!' && source[i + 1] === '[') return { at: i, kind: 'image' }
    if (ch === '[') return { at: i, kind: 'link' }
    if (ch === '<') {
      const rest = source.slice(i)
      if (RE_BREAK_TAG.test(rest)) return { at: i, kind: 'break' }
      const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.exec(rest)
      if (tag && tag[1] === '' && INLINE_TAGS[tag[2]!.toLowerCase()])
        return { at: i, kind: 'tag', tag: tag[2]!.toLowerCase() }
      if (/^<[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*>/.test(rest) || /^<[^\s<>@]+@[^\s<>]+>/.test(rest))
        return { at: i, kind: 'autolink' }
      continue
    }
    if (ch === '~' && source[i + 1] === '~') return { at: i, kind: 'strike' }
    if (ch === '*' || ch === '_') {
      let run = i
      while (run < source.length && source[run] === ch) run++
      // Three or more is bold-and-italic; the nesting falls out of parsing the inner run again.
      return { at: i, kind: 'emphasis', run: source.slice(i, Math.min(run, i + 3)) }
    }
  }
  return null
}

/** Undo `\x` for every punctuation character a writer may have escaped. */
const unescapePunctuation = (value: string): string =>
  value.replace(/\\([\\`*_[\]<>|~#+.!()\-{}"'$&/:;=?@^])/g, '$1')

/** The matching `]` for a `[` at `from`, honouring nesting and escapes. */
function closingBracket(source: string, from: number): number {
  let depth = 0
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** The `(target "title")` after a link or image label, or null when there is none. */
function linkTarget(
  source: string,
  from: number,
): { href: string; title: string | null; end: number } | null {
  if (source[from] !== '(') return null
  let depth = 0
  let end = -1
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const inner = source.slice(from + 1, end).trim()
  // `<a target with spaces>` is the angle form the writer uses whenever the target needs it.
  const angled = /^<([^>]*)>[ \t]*([\s\S]*)$/.exec(inner)
  const href = angled ? angled[1]! : (/^\S*/.exec(inner)?.[0] ?? '')
  const tail = (angled ? angled[2]! : inner.slice(href.length)).trim()
  const title = /^"([\s\S]*)"$|^'([\s\S]*)'$/.exec(tail)
  return {
    href: unescapePunctuation(href),
    title: title ? (title[1] ?? title[2] ?? null) : null,
    end: end + 1,
  }
}

function withMark(nodes: PageDocNode[], mark: PageDocMark): PageDocNode[] {
  return nodes.map((node) =>
    typeof node.text === 'string'
      ? // A mark already present wins: `**[a](b)**` must not carry two `link` marks.
        { ...node, marks: [...(node.marks ?? []).filter((m) => m.type !== mark.type), mark] }
      : node,
  )
}

/**
 * One paragraph (or one table cell) of prose as inline nodes.
 *
 * A `\n` still in `source` is a soft wrap and becomes the space a reader would have rendered; a hard
 * break arrived as `<br>`, which `findOpener` sees like any other inline construct.
 */
export function inlineNodes(source: string): PageDocNode[] {
  const out: PageDocNode[] = []

  const push = (nodes: PageDocNode[]) => {
    for (const node of nodes) {
      const last = out.at(-1)
      // Merge adjacent text carrying identical marks, so `a\*b` is one node rather than three.
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

  const plain = (value: string) => {
    const body = unescapePunctuation(value).replace(/\n/g, ' ')
    if (body.length > 0) push([text(body)])
  }

  let at = 0
  while (at < source.length) {
    const opener = findOpener(source, at)
    if (!opener) break
    const consumed = consume(source, opener)
    if (!consumed) {
      // Not a construct after all — `[` with no `]`, an unmatched `*`. Take the character as text.
      plain(source.slice(at, opener.at + 1))
      at = opener.at + 1
      continue
    }
    plain(source.slice(at, opener.at))
    push(consumed.nodes)
    at = consumed.end
  }
  plain(source.slice(at))
  return out
}

function consume(source: string, opener: Opener): { nodes: PageDocNode[]; end: number } | null {
  const { at, kind } = opener

  if (kind === 'break') {
    const match = RE_BREAK_TAG.exec(source.slice(at))
    if (!match) return null
    return { nodes: [{ type: 'hardBreak' }], end: at + match[0].length }
  }

  if (kind === 'code') {
    const fence = opener.run!
    const close = source.indexOf(fence, at + fence.length)
    if (close < 0) return null
    let body = source.slice(at + fence.length, close)
    // A code span padded with one space at both ends had it added so the content could start or end
    // with a backtick; the writer next door adds it for exactly that, and nothing else does.
    if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ')) body = body.slice(1, -1)
    // Code is literal, so a wrap inside one is a space rather than a break somebody asked for.
    return { nodes: [text(body.replace(/\n/g, ' '), [{ type: 'code' }])], end: close + fence.length }
  }

  if (kind === 'autolink') {
    const match = /^<([^\s<>]+)>/.exec(source.slice(at))
    if (!match) return null
    const href = match[1]!
    const target = href.includes('@') && !href.includes(':') ? `mailto:${href}` : href
    return { nodes: [text(href, [{ type: 'link', attrs: { href: target } }])], end: at + match[0].length }
  }

  if (kind === 'tag') {
    const name = opener.tag!
    const open = /^<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/.exec(source.slice(at))
    if (!open) return null
    const closeAt = source.toLowerCase().indexOf(`</${name}>`, at + open[0].length)
    if (closeAt < 0) return null
    const inner = source.slice(at + open[0].length, closeAt)
    return {
      nodes: withMark(inlineNodes(inner), { type: INLINE_TAGS[name]! }),
      end: closeAt + name.length + 3,
    }
  }

  if (kind === 'image' || kind === 'link') {
    const labelStart = kind === 'image' ? at + 1 : at
    const labelEnd = closingBracket(source, labelStart)
    if (labelEnd < 0) return null
    const target = linkTarget(source, labelEnd + 1)
    if (!target) return null
    const label = source.slice(labelStart + 1, labelEnd)
    if (kind === 'image') {
      const attrs: Record<string, unknown> = {
        src: target.href,
        alt: unescapePunctuation(label).replace(/\s+/g, ' '),
      }
      if (target.title) attrs.title = target.title
      return { nodes: [{ type: 'image', attrs }], end: target.end }
    }
    const mark: PageDocMark = { type: 'link', attrs: { href: target.href } }
    const inner = inlineNodes(label)
    return { nodes: withMark(inner.length > 0 ? inner : [text(label)], mark), end: target.end }
  }

  if (kind === 'strike') {
    const close = source.indexOf('~~', at + 2)
    if (close < 0) return null
    return { nodes: withMark(inlineNodes(source.slice(at + 2, close)), { type: 'strike' }), end: close + 2 }
  }

  // Emphasis. The run length decides which marks go on, and the closer is the same character.
  const run = opener.run!
  const ch = run[0]!
  for (let length = run.length; length >= 1; length--) {
    const close = findEmphasisClose(source, at + run.length, ch, length)
    if (close < 0) continue
    let nodes = inlineNodes(source.slice(at + length, close))
    if (length >= 2) nodes = withMark(nodes, { type: 'bold' })
    if (length === 1 || length === 3) nodes = withMark(nodes, { type: 'italic' })
    return { nodes, end: close + length }
  }
  return null
}

/** The next run of at least `length` of `ch` that is neither escaped nor inside a code span. */
function findEmphasisClose(source: string, from: number, ch: string, length: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
      continue
    }
    if (source[i] === '`') {
      let run = i
      while (run < source.length && source[run] === '`') run++
      const fence = source.slice(i, run)
      const close = source.indexOf(fence, run)
      i = close < 0 ? source.length : close + fence.length - 1
      continue
    }
    if (source[i] !== ch) continue
    let run = i
    while (run < source.length && source[run] === ch) run++
    if (run - i >= length) return i
    i = run - 1
  }
  return -1
}

// ------------------------------------------------------------------------------------------------
// Blocks
// ------------------------------------------------------------------------------------------------

/**
 * A paragraph's lines joined into one string, with every hard break spelled `<br>`.
 *
 * Joining first is what lets an emphasis run or a link label wrap across a line, which the writer
 * never does and a person writing by hand does constantly.
 */
function paragraphFrom(lines: string[]): PageDocNode | null {
  const joined = lines
    .map((line, index) => {
      const trimmed = line.replace(/[ \t]+$/, '')
      const last = index === lines.length - 1
      const hard = !last && (/ {2,}$/.test(line) || trimmed.endsWith('\\'))
      const body = hard && trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed
      return last ? body : `${body}${hard ? '<br>' : '\n'}`
    })
    .join('')
  const content = inlineNodes(joined)
  return content.length > 0 ? paragraph(content) : null
}

interface ListItemLines {
  kind: 'bullet' | 'ordered' | 'task'
  checked: boolean
  start: number
  lines: string[]
}

/**
 * A run of list items at one indent, grouped by the kind of marker they carry.
 *
 * Grouping rather than one kind per run is what makes the writer round-trip: a `taskList` is written
 * as `- [x] …` items, so a document holding a bullet list and a task list one after the other comes
 * back through the same run of lines and has to split into two nodes again.
 */
function parseListRun(lines: string[], from: number): { nodes: PageDocNode[]; next: number } {
  const items: ListItemLines[] = []
  const baseIndent = indentOf(lines[from]!)
  let at = from

  while (at < lines.length) {
    const line = lines[at]!
    if (isBlank(line)) {
      // A blank line ends the list unless what follows continues an item or starts the next one.
      let ahead = at
      while (ahead < lines.length && isBlank(lines[ahead]!)) ahead++
      if (ahead >= lines.length) break
      const nextIndent = indentOf(lines[ahead]!)
      const startsItem = RE_ITEM.test(lines[ahead]!) || RE_EMPTY_ITEM.test(lines[ahead]!)
      if (!(nextIndent > baseIndent || (startsItem && nextIndent === baseIndent))) break
      const current = items.at(-1)
      if (current) for (let i = at; i < ahead; i++) current.lines.push('')
      at = ahead
      continue
    }

    const match = RE_ITEM.exec(line) ?? RE_EMPTY_ITEM.exec(line)
    const indent = indentOf(line)
    if (match && indent === baseIndent) {
      const marker = match[2]!
      const rest = match[4] ?? ''
      const task = RE_TASK.exec(rest)
      const ordered = /^\d/.test(marker)
      items.push({
        kind: task ? 'task' : ordered ? 'ordered' : 'bullet',
        checked: task ? task[1]!.toLowerCase() === 'x' : false,
        start: ordered ? Number.parseInt(marker, 10) : 1,
        lines: [task ? task[2]! : rest],
      })
      at++
      continue
    }
    if (indent <= baseIndent) break

    // A continuation line: kept, dedented towards the item's own content column.
    const current = items.at(-1)
    if (!current) break
    current.lines.push(dedent(line, baseIndent + 2))
    at++
  }

  // Trailing blank lines belong to the document, not to the last item.
  const last = items.at(-1)
  while (last && last.lines.length > 0 && isBlank(last.lines.at(-1)!)) last.lines.pop()

  const nodes: PageDocNode[] = []
  let run: ListItemLines[] = []
  const flush = () => {
    if (run.length === 0) return
    const kind = run[0]!.kind
    if (kind === 'task')
      nodes.push(
        element(
          'taskList',
          run.map((item) => element('taskItem', blocksOf(item.lines), { checked: item.checked })),
        ),
      )
    else if (kind === 'ordered')
      nodes.push(
        element(
          'orderedList',
          run.map((item) => element('listItem', blocksOf(item.lines))),
          { start: run[0]!.start },
        ),
      )
    else
      nodes.push(
        element(
          'bulletList',
          run.map((item) => element('listItem', blocksOf(item.lines))),
        ),
      )
    run = []
  }
  for (const item of items) {
    if (run.length > 0 && run[0]!.kind !== item.kind) flush()
    run.push(item)
  }
  flush()

  return { nodes, next: at }
}

/** A GFM table: a header row, a delimiter row, and every row after them that still holds a pipe. */
function parseTable(lines: string[], from: number): { node: PageDocNode; next: number } {
  const cellsOf = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    const out: string[] = []
    let cell = ''
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]!
      if (ch === '\\' && trimmed[i + 1] === '|') {
        cell += '|'
        i++
        continue
      }
      if (ch === '\\' && trimmed[i + 1] !== undefined) {
        cell += ch + trimmed[i + 1]
        i++
        continue
      }
      if (ch === '|') {
        out.push(cell)
        cell = ''
        continue
      }
      cell += ch
    }
    out.push(cell)
    return out.map((value) => value.trim())
  }

  const header = cellsOf(lines[from]!)
  const width = header.length
  const bodyRows: string[][] = []
  let at = from + 2
  while (at < lines.length && !isBlank(lines[at]!) && lines[at]!.includes('|')) {
    bodyRows.push(cellsOf(lines[at]!))
    at++
  }

  // A cell holds inline content only — GFM cannot spell a second paragraph — so the `<br>` pairs the
  // writer put there come back as hard breaks, which `inlineNodes` already knows how to read.
  const cell = (type: string, value: string): PageDocNode => element(type, [paragraph(inlineNodes(value))])
  const row = (cells: string[], type: string): PageDocNode => {
    const padded = [...cells]
    while (padded.length < width) padded.push('')
    return element(
      'tableRow',
      padded.slice(0, width).map((value) => cell(type, value)),
    )
  }

  return {
    node: element('table', [row(header, 'tableHeader'), ...bodyRows.map((cells) => row(cells, 'tableCell'))]),
    next: at,
  }
}

/** `<details><summary>…</summary> … </details>`, which is how the writer spells a toggle. */
function parseDetails(lines: string[], from: number): { node: PageDocNode; next: number } {
  const body: string[] = []
  let depth = 0
  let at = from
  for (; at < lines.length; at++) {
    const line = lines[at]!
    depth += (line.match(/<details\b/gi) ?? []).length - (line.match(/<\/details>/gi) ?? []).length
    body.push(line)
    if (depth <= 0) {
      at++
      break
    }
  }
  const joined = body.join('\n')
  const inner = /<details\b[^>]*>([\s\S]*)<\/details>/i.exec(joined)?.[1] ?? ''
  const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner)
  const rest = summary ? inner.replace(summary[0], '') : inner
  const content = blocksOf(rest.split('\n'))
  return {
    node: element('details', [
      element('detailsSummary', inlineNodes((summary?.[1] ?? '').trim())),
      element('detailsContent', content.length > 0 ? content : [paragraph([])]),
    ]),
    next: at,
  }
}

/** A blockquote, or the callout a GitHub alert marker turns it into. */
function parseQuote(lines: string[], from: number): { node: PageDocNode; next: number } {
  const inner: string[] = []
  let at = from
  while (at < lines.length && (RE_QUOTE.test(lines[at]!) || (inner.length > 0 && !isBlank(lines[at]!)))) {
    // A lazy continuation — a wrapped line with no `>` — belongs to the quote it continues.
    inner.push(RE_QUOTE.test(lines[at]!) ? lines[at]!.replace(RE_QUOTE, '') : lines[at]!)
    at++
  }
  const alert = /^\[!([A-Za-z]+)\][ \t]*$/.exec(inner[0]?.trim() ?? '')
  if (alert) {
    const name = alert[1]!.toLowerCase()
    const tone = CALLOUT_TONES.has(name) ? name : (GITHUB_ALERTS[name] ?? 'info')
    const body = blocksOf(inner.slice(1))
    return { node: element('callout', body.length > 0 ? body : [paragraph([])], { tone }), next: at }
  }
  const body = blocksOf(inner)
  return { node: element('blockquote', body.length > 0 ? body : [paragraph([])]), next: at }
}

/**
 * Everything in one run of lines, as blocks.
 *
 * Recursive: a list item, a blockquote and a toggle each re-enter here with their own dedented lines,
 * which is what makes nesting work without a parser per depth.
 */
function blocksOf(lines: string[]): PageDocNode[] {
  const out: PageDocNode[] = []
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return
    const node = paragraphFrom(paragraphLines)
    if (node) out.push(node)
    paragraphLines = []
  }

  for (let at = 0; at < lines.length; ) {
    const line = lines[at]!

    if (isBlank(line)) {
      flushParagraph()
      at++
      continue
    }

    const fence = RE_FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1]!
      const info = fence[2]!.trim()
      const closer = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`)
      const body: string[] = []
      at++
      while (at < lines.length && !closer.test(lines[at]!)) {
        body.push(lines[at]!)
        at++
      }
      // A fence that never closes still holds a code block; the alternative is losing the snippet.
      if (at < lines.length) at++
      const language = /^[a-z0-9#+.-]{1,24}$/i.test(info) ? info : ''
      out.push(
        element(
          'codeBlock',
          body.length > 0 ? [text(body.join('\n'))] : [],
          language ? { language } : undefined,
        ),
      )
      continue
    }

    const atx = RE_ATX.exec(line)
    if (atx) {
      flushParagraph()
      out.push(element('heading', inlineNodes(atxContent(atx[2])), { level: atx[1]!.length }))
      at++
      continue
    }

    /*
     * A setext underline turns the paragraph above it into a heading, and `---` is a thematic rule
     * only when there is no paragraph above it. That is the one place where two block rules genuinely
     * overlap, and getting it the wrong way round turns `Heading\n---` into a rule and loses the
     * heading — plenty of hand-written Markdown is spelled that way, so it is not hypothetical.
     */
    const setext = RE_SETEXT.exec(line)
    if (setext && paragraphLines.length > 0) {
      const level = setext[1]!.startsWith('=') ? 1 : 2
      const heading = paragraphLines.join(' ').trim()
      paragraphLines = []
      out.push(element('heading', inlineNodes(heading), { level }))
      at++
      continue
    }

    if (RE_RULE.test(line)) {
      flushParagraph()
      out.push({ type: 'horizontalRule' })
      at++
      continue
    }

    if (RE_QUOTE.test(line)) {
      flushParagraph()
      const quote = parseQuote(lines, at)
      out.push(quote.node)
      at = quote.next
      continue
    }

    if (/^ {0,3}<details\b/i.test(line)) {
      flushParagraph()
      const details = parseDetails(lines, at)
      out.push(details.node)
      at = details.next
      continue
    }

    if (RE_ITEM.test(line) || RE_EMPTY_ITEM.test(line)) {
      flushParagraph()
      const list = parseListRun(lines, at)
      // A run that consumed nothing would loop for ever; taking the line as prose is the safe exit.
      if (list.next > at) {
        out.push(...list.nodes)
        at = list.next
        continue
      }
      paragraphLines.push(line)
      at++
      continue
    }

    if (line.includes('|') && at + 1 < lines.length && RE_TABLE_DELIMITER.test(lines[at + 1]!)) {
      flushParagraph()
      const table = parseTable(lines, at)
      out.push(table.node)
      at = table.next
      continue
    }

    paragraphLines.push(line)
    at++
  }

  flushParagraph()
  return out
}

/** Inline nodes flattened, for a title — where marks are meaningless and the characters are not. */
function plainText(nodes: PageDocNode[]): string {
  return nodes
    .map((node) => (typeof node.text === 'string' ? node.text : plainText(node.content ?? [])))
    .join('')
}

/**
 * A page's title and its body, split.
 *
 * A title is a **column** in Quire, not a node in its document, so the `# Title` the writer puts at
 * the top of every exported file has to come back off the top rather than becoming an H1 inside the
 * page. Notion writes the same shape, and Notion's is the one that matters: its filename has been
 * through a sanitiser that turns `Q3/Q4 Handover` into `Q3Q4 Handover`, while the heading still says
 * what the page is called. Taking the title from the heading is the difference between importing a
 * page under its own name and importing it under a name nobody chose.
 *
 * Only a level-1 heading, and only as the first non-blank line: a file that opens with prose keeps
 * its prose, and a file whose first heading is `##` is one whose author did not mean it as a title.
 */
export function splitTitle(source: string): { title: string | null; body: string } {
  const lines = source.split(/\r\n|\r|\n/)
  let at = 0
  while (at < lines.length && isBlank(lines[at]!)) at++

  const atx = RE_ATX.exec(lines[at] ?? '')
  if (atx && atx[1]!.length === 1) {
    const title = plainText(inlineNodes(atxContent(atx[2]))).trim()
    return { title: title || null, body: lines.slice(at + 1).join('\n') }
  }

  const underline = RE_SETEXT.exec(lines[at + 1] ?? '')
  if (underline?.[1]?.startsWith('=') && !isBlank(lines[at] ?? '')) {
    const title = plainText(inlineNodes(lines[at]!.trim())).trim()
    return { title: title || null, body: lines.slice(at + 2).join('\n') }
  }

  return { title: null, body: source }
}

/**
 * Markdown as a page document.
 *
 * Always a `doc`, never null: a file holding nothing but its own title is an empty page, and an empty
 * page is a correct import of an empty page.
 */
export function markdownToPageDoc(source: string): PageDoc {
  return { type: 'doc', content: blocksOf(source.replace(/\r\n|\r/g, '\n').split('\n')) }
}
