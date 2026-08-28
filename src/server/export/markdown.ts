/**
 * A page as Markdown, written from the page document rather than from HTML.
 *
 * Two writers, one source. `renderPageDoc` next door draws the same document as HTML; this one draws
 * it as Markdown, and both read the stored `PageDoc`. Converting the HTML instead would have been
 * less code and would have thrown away everything a heading, a task and a table know about
 * themselves — an `<h2>` is a heading, but a `<ul class="kern-tasks">` full of disabled checkboxes is
 * not a task list to anything that reads it back.
 *
 * **Round-tripping is the requirement, not prettiness.** A heading, a list, a table, a code block, a
 * callout and a task list have to come back as themselves when the file is imported again, so every
 * one of them is written in the dialect an importer can recognise without guessing:
 *
 *   - tables and task lists are GitHub-flavoured Markdown, because that is what every reader
 *     implements and what an import will parse;
 *   - a callout is a blockquote with a GitHub alert marker — `> [!WARNING]` — carrying Quire's own
 *     tone name, so it re-reads as the same callout here and degrades to an ordinary blockquote
 *     anywhere else. A `<div data-callout>` would round-trip too and would be a raw HTML block in
 *     every other reader;
 *   - underline and highlight have no Markdown at all and are written as `<u>` and `<mark>`, which
 *     is inline HTML a Markdown parser passes through rather than a syntax it will mangle.
 *
 * `PAGE_DOC_NODES` is the list this has to cover, the same list `render.ts` is held to, and
 * `export.int.test.ts` compares this file's table against it in both directions. A node with no
 * writer here does not degrade quietly — it would lose somebody's table.
 */
import type { PageDoc, PageDocMark, PageDocNode } from '@kernhq/ui/editor/page-doc'

export interface MarkdownOptions {
  /**
   * Where the picture with this id sits *relative to the file being written* — `media/diagram.png`.
   *
   * Never a signed storage URL. A presigned GET is the object's key, so it carries the tenant's
   * workspace uuid and the file's uuid, and it stops working an hour after it is minted: writing one
   * into a file somebody keeps is both a leak and a broken picture. A picture with no answer here is
   * dropped, exactly as the HTML renderer drops it.
   */
  fileSrc?: (fileId: string) => string | null
  /** Where another exported page sits relative to this one. Without one, a mention stays as text. */
  pageHref?: (pageId: string) => string | null
}

/**
 * What a Markdown reader would otherwise take as syntax.
 *
 * Deliberately not every character CommonMark lists. Escaping `.`, `+`, `(` and `)` everywhere turns
 * an ordinary sentence into a thicket of backslashes, and they are only meaningful at the start of a
 * line or inside a link — both of which are handled where they arise. What is escaped here is what
 * changes the meaning of a sentence wherever it appears.
 */
const escapeInline = (text: string): string => text.replace(/([\\`*_[\]<>|~])/g, '\\$1')

/**
 * A line that would start a block if it were left alone — a paragraph beginning `- ` or `# `.
 *
 * The ordered-list case is separate because the escape goes in a different place. `\1. ` is not an
 * escape at all: a backslash before anything that is not punctuation is a literal backslash, so it
 * would print one and still start a list. `1\. ` is the one that works.
 */
const escapeLineStart = (line: string): string =>
  line
    .replace(/^(\s*)(>|#{1,6}(?=\s)|[-*+](?=\s))/, '$1\\$2')
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s)/, '$1$2\\$3')

/** Every character in the node, ignoring marks. What a fence and a `<pre>` want. */
function textOf(node: PageDocNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(textOf).join('')
}

/**
 * The marks, applied so the result parses.
 *
 * Order matters and is not alphabetical. `code` goes on first because a code span's content is
 * literal — `**bold**` inside backticks is four asterisks and a word — and `link` goes on last
 * because a link's label may hold everything else and nothing may hold a link.
 */
function applyMarks(text: string, marks: PageDocMark[] | null | undefined): string {
  const has = (type: string) => (marks ?? []).some((m) => m?.type === type)
  let out = has('code') ? codeSpan(text) : escapeInline(text)
  if (has('highlight')) out = `<mark>${out}</mark>`
  if (has('strike')) out = `~~${out}~~`
  if (has('underline')) out = `<u>${out}</u>`
  if (has('italic')) out = `*${out}*`
  if (has('bold')) out = `**${out}**`
  const link = (marks ?? []).find((m) => m?.type === 'link')
  if (link) {
    const href = typeof link.attrs?.href === 'string' ? link.attrs.href : ''
    if (href) out = `[${out}](${encodeLinkTarget(href)})`
  }
  return out
}

/** A code span whose fence is longer than any run of backticks inside it, so it closes where it should. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** Parentheses and whitespace are what break an inline link target; angle brackets fix both. */
const encodeLinkTarget = (href: string): string =>
  /[\s()<>]/.test(href) ? `<${href.replaceAll('>', '%3E')}>` : href

function inline(nodes: PageDocNode[] | null | undefined, options: MarkdownOptions): string {
  return (nodes ?? [])
    .map((node) => {
      if (typeof node.text === 'string') return applyMarks(node.text, node.marks)
      const writer = INLINE_WRITERS[node.type ?? '']
      if (writer) return writer(node, options)
      // An inline node with no writer keeps its text rather than vanishing mid-sentence.
      return escapeInline(textOf(node))
    })
    .join('')
}

type InlineWriter = (node: PageDocNode, options: MarkdownOptions) => string

const INLINE_WRITERS: Record<string, InlineWriter> = {
  // Two trailing spaces is the line break every Markdown reader implements; a backslash is CommonMark
  // only, and an importer that is not CommonMark would keep the backslash as a character.
  hardBreak: () => '  \n',
  text: (node) => escapeInline(node.text ?? ''),
  /**
   * A person, as `@Ada` — **and this one does not come back.**
   *
   * Stated here because it is the one construct in the writer that is knowingly lossy, and a reader
   * of this table would otherwise assume the pairing with `import/markdown.ts` is total. A page
   * mention resolves against a path in the same archive, so the reader can rebuild it; a person
   * resolves against a *user id*, which is a fact about the instance the export came from. The two
   * spellings that would carry it are both worse than the loss: putting the id in the file makes an
   * export identify people, and importing it would mint a mention of a stranger's id in a workspace
   * that never had that person. So this writes what a mention reads as — the name — and it re-imports
   * as prose. There is no report row for it either, because by then it is a run of text and nothing
   * can tell it from one somebody typed.
   */
  mention: (node) => `@${escapeInline(String(node.attrs?.label ?? ''))}`,
  pageMention: (node, options) => {
    const label = escapeInline(String(node.attrs?.label ?? '') || 'Untitled')
    const id = typeof node.attrs?.id === 'string' ? node.attrs.id : ''
    const href = id ? (options.pageHref?.(id) ?? null) : null
    // A page that is not in this export cannot be linked to, and a dead link is worse than a name.
    return href ? `[${label}](${encodeLinkTarget(href)})` : label
  },
  image: (node, options) => {
    const fileId = typeof node.attrs?.fileId === 'string' ? node.attrs.fileId : null
    const resolved = fileId ? (options.fileSrc?.(fileId) ?? null) : null
    const src = resolved ?? (typeof node.attrs?.src === 'string' ? node.attrs.src : null)
    if (!src) return ''
    const alt = escapeInline(typeof node.attrs?.alt === 'string' ? node.attrs.alt : '')
    const title = typeof node.attrs?.title === 'string' && node.attrs.title ? node.attrs.title : null
    return `![${alt}](${encodeLinkTarget(src)}${title ? ` "${title.replaceAll('"', '\\"')}"` : ''})`
  },
}

type BlockWriter = (node: PageDocNode, options: MarkdownOptions) => string

/**
 * Prefix every line, including the blank ones — which is what makes a nested blockquote hold.
 *
 * A blank line gets the prefix trimmed (`>` rather than `> `) and a line with content does not, so
 * the two trailing spaces that mean "line break" survive. Trimming every line would delete them and
 * silently join two lines of an address.
 */
const prefixLines = (text: string, first: string, rest = first): string =>
  text
    .split('\n')
    .map((line, i) =>
      line.length === 0 ? (i === 0 ? first : rest).trimEnd() : `${i === 0 ? first : rest}${line}`,
    )
    .join('\n')

/** Blocks, separated by the blank line that keeps them separate blocks. */
function blocks(nodes: PageDocNode[] | null | undefined, options: MarkdownOptions): string {
  return (nodes ?? [])
    .map((node) => block(node, options))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function block(node: PageDocNode, options: MarkdownOptions): string {
  const writer = BLOCK_WRITERS[node.type ?? '']
  if (writer) return writer(node, options)
  // Unreachable while the test below holds, and correct if a newer image writes a node this one has
  // never heard of: keep the children rather than losing a paragraph to an unknown wrapper.
  return blocks(node.content, options)
}

/**
 * A list, whose marker depends on the list and whose continuation depends on the marker.
 *
 * Every line after the first is indented by the marker's own width, or the reader ends the item and
 * starts a paragraph — which is how a two-paragraph bullet becomes a bullet and an orphan.
 */
function list(node: PageDocNode, options: MarkdownOptions, markerFor: (index: number) => string): string {
  return (node.content ?? [])
    .map((item, index) => {
      const marker = markerFor(index)
      const body = blocks(item.content, options)
      // An empty bullet is still a bullet somebody typed, so the marker survives on its own.
      return body ? prefixLines(body, marker, ' '.repeat(marker.length)) : marker.trimEnd()
    })
    .join('\n')
}

/** `info` | `note` | `success` | `warning` | `danger`, upper-cased into a GitHub alert marker. */
const CALLOUT_TONES = new Set(['info', 'note', 'success', 'warning', 'danger'])

/**
 * Escape the pipes a cell still has, and only those.
 *
 * `escapeInline` already escaped every pipe in ordinary prose, so a blind `replaceAll` would double
 * them — `Pipe \| here` becomes `Pipe \\| here`, which renders as a backslash and *then* ends the
 * cell. What is left unescaped is a pipe inside a code span, where escaping is deliberately not
 * applied — and GFM says a table cell escapes those too, code span or not. So this walks the string,
 * steps over anything already escaped, and escapes what remains.
 */
function escapePipes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1]
      i++
      continue
    }
    out += ch === '|' ? '\\|' : ch
  }
  return out
}

/**
 * One cell of a GFM table.
 *
 * A cell is inline only — the format has no way to hold a second paragraph — so a paragraph break
 * becomes `<br><br>`. Losing the block structure inside a cell is the format's limit, and saying so
 * here is better than a table that stops being a table at the first newline.
 *
 * The whitespace before each newline goes with it, and that is not tidiness. A hard break is written
 * `  \n` — two spaces are what makes it a break in prose — so leaving them in front of the `<br>`
 * hands the importer a cell whose text ends in two spaces it never had. They are invisible in every
 * rendering and they *accumulate*: three export-import cycles turned `a` into `a` and six spaces.
 */
const tableCell = (cell: PageDocNode, options: MarkdownOptions): string =>
  escapePipes(
    (blocks(cell.content, options) || '')
      .replace(/[ \t]*\n{2,}/g, '<br><br>')
      .replace(/[ \t]*\n/g, '<br>')
      .trim(),
  )

function table(node: PageDocNode, options: MarkdownOptions): string {
  const rows = (node.content ?? []).filter((row) => (row.content ?? []).length > 0)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => (row.content ?? []).length))
  const cellsOf = (row: PageDocNode): string[] => {
    const cells = (row.content ?? []).map((cell) => tableCell(cell, options))
    while (cells.length < width) cells.push('')
    return cells
  }
  /*
   * GFM has no table without a header row, so a table whose first row is ordinary cells still
   * contributes one — its own first row. Emitting an empty header instead would put a blank band at
   * the top of every table Quire exports, and shift every row's meaning by one on the way back in.
   */
  const [head, ...body] = rows
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [
    line(cellsOf(head!)),
    line(Array.from({ length: width }, () => '---')),
    ...body.map((row) => line(cellsOf(row))),
  ].join('\n')
}

const BLOCK_WRITERS: Record<string, BlockWriter> = {
  paragraph: (node, options) => escapeLineStart(inline(node.content, options)),

  heading: (node, options) => {
    const raw = Number(node.attrs?.level)
    const level = Number.isInteger(raw) && raw >= 1 && raw <= 6 ? raw : 1
    return `${'#'.repeat(level)} ${inline(node.content, options)}`.trimEnd()
  },

  bulletList: (node, options) => list(node, options, () => '- '),

  orderedList: (node, options) => {
    const raw = Number(node.attrs?.start)
    const start = Number.isInteger(raw) && raw > 0 ? raw : 1
    return list(node, options, (index) => `${start + index}. `)
  },

  listItem: (node, options) => blocks(node.content, options),

  taskList: (node, options) =>
    (node.content ?? [])
      .map((item) => {
        const marker = `- [${item.attrs?.checked === true ? 'x' : ' '}] `
        const body = blocks(item.content, options)
        return body ? prefixLines(body, marker, ' '.repeat(marker.length)) : marker.trimEnd()
      })
      .join('\n'),

  taskItem: (node, options) => blocks(node.content, options),

  blockquote: (node, options) => prefixLines(blocks(node.content, options), '> '),

  /**
   * A GitHub alert: a blockquote whose first line names the tone.
   *
   * The tone is Quire's own word rather than GitHub's nearest equivalent, because the round trip
   * matters more than the rendering on one website. `[!SUCCESS]` is not one of GitHub's five, so it
   * renders there as a plain blockquote with a line of text at the top — which is a smaller loss
   * than mapping `success` onto `TIP` and importing it back as the wrong colour.
   */
  callout: (node, options) => {
    const tone = String(node.attrs?.tone ?? 'info')
    const marker = CALLOUT_TONES.has(tone) ? tone : 'info'
    return prefixLines(`[!${marker.toUpperCase()}]\n${blocks(node.content, options)}`, '> ')
  },

  codeBlock: (node) => {
    const language =
      typeof node.attrs?.language === 'string' && /^[a-z0-9#+.-]{1,24}$/i.test(node.attrs.language)
        ? node.attrs.language
        : ''
    const body = textOf(node)
    // Longer than any run of backticks in the body, or a snippet about Markdown closes its own fence.
    const longest = Math.max(2, ...[...body.matchAll(/^`{3,}/gm)].map((m) => m[0].length))
    const fence = '`'.repeat(longest + 1)
    return `${fence}${language}\n${body}\n${fence}`
  },

  horizontalRule: () => '---',

  table,
  // A row or a cell reached on its own is inside a table that has already written it; reaching one
  // here would mean a malformed document, and its text is better kept than dropped.
  tableRow: (node, options) => blocks(node.content, options),
  tableCell: (node, options) => blocks(node.content, options),
  tableHeader: (node, options) => blocks(node.content, options),

  /**
   * A toggle, as the HTML block Markdown has no syntax for.
   *
   * The blank lines around the body are load-bearing: without them a Markdown reader treats
   * everything between the tags as raw HTML and stops parsing the prose inside, so a bulleted list
   * inside a toggle arrives as literal hyphens.
   */
  details: (node, options) => {
    const summary = (node.content ?? []).find((child) => child.type === 'detailsSummary')
    const rest = (node.content ?? []).filter((child) => child.type !== 'detailsSummary')
    const title = summary ? inline(summary.content, options) : ''
    return `<details>\n<summary>${title}</summary>\n\n${blocks(rest, options)}\n\n</details>`
  },
  detailsSummary: (node, options) => inline(node.content, options),
  detailsContent: (node, options) => blocks(node.content, options),

  // Blocks in name only: both are inline nodes that can also stand alone as a whole block.
  image: (node, options) => INLINE_WRITERS.image!(node, options),
  hardBreak: () => '',
  mention: (node, options) => INLINE_WRITERS.mention!(node, options),
  pageMention: (node, options) => INLINE_WRITERS.pageMention!(node, options),
  text: (node) => escapeInline(node.text ?? ''),
}

/** Every node type this file can write, for the test that compares it against `PAGE_DOC_NODES`. */
export const MARKDOWN_NODES: readonly string[] = [
  ...new Set(['doc', ...Object.keys(BLOCK_WRITERS), ...Object.keys(INLINE_WRITERS)]),
]

/**
 * A stored page as Markdown. An empty or unreadable document is an empty string, never a throw.
 *
 * The title is not written here. A page's title is a column, not a node in its document, so whether
 * it becomes an `# H1` at the top is a decision about the file — and the file writer next door makes
 * it, once, for both formats.
 */
export function pageDocToMarkdown(doc: PageDoc | null | undefined, options: MarkdownOptions = {}): string {
  if (!doc || !Array.isArray(doc.content)) return ''
  return `${blocks(doc.content, options)
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}
