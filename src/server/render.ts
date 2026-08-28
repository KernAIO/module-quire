import { renderMermaid } from '@kernhq/ui/editor/mermaid'
import {
  DEFAULT_PAGE_DIAGRAM_KIND,
  PAGE_DIAGRAM_KINDS,
  PAGE_DIAGRAM_MAX_SOURCE,
  PAGE_DIAGRAM_MAX_TITLE,
  PAGE_EMBED_MAX_DESCRIPTION,
  PAGE_EMBED_MAX_SITE,
  PAGE_EMBED_MAX_TITLE,
  PAGE_EMBED_MAX_URL,
  type PageDoc,
  type PageDocMark,
  type PageDocNode,
} from '@kernhq/ui/editor/page-doc'

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

/**
 * A page a macro is allowed to name.
 *
 * Everything here has already passed the audience's filter — a resolver hands this back only for a
 * page the reader in question may be shown. Which is why there is no `visible` flag on it and no
 * way to express "this page exists but you may not have it": the whole point of the rule is that a
 * page a reader may not see does not reach the renderer at all, so it cannot be drawn as a title
 * with a dead link.
 *
 * `href` is separately nullable, for the ordinary case where a page may be *named* but the render
 * has no address to send anybody to — a Markdown export of one page that mentions another.
 */
export interface MacroPageRef {
  id: string
  title: string
  /** a Lucide icon name or an emoji, as the page carries it */
  icon: string | null
  /** where to send a reader, or null to draw the title as plain text */
  href: string | null
  /** already formatted for the reader's locale; the renderer does no date arithmetic */
  updated: string | null
  /** plain text, already trimmed — never markup */
  excerpt: string | null
  /** the pages under this one, when the macro asked for more than one level */
  children?: MacroPageRef[]
}

/** Somebody who has written on the page. Never carries an id into the output. */
export interface MacroPerson {
  name: string
}

/**
 * One of Kern's own objects, as a reader is allowed to see it.
 *
 * The same bargain `MacroPageRef` makes and for the same reason: everything here has already passed
 * the audience's filter, so there is no way to express "this issue exists and you may not have it".
 * `label` is the *type's* name — "Issue", "Page" — out of the module's own `objectTypes`, which is
 * why a card can say what kind of thing it points at without this file knowing any module but its
 * own. `services/objects.ts` is the only thing that builds one.
 */
export interface MacroObjectRef {
  /** what the owning module calls this type, already translated by whoever declared it */
  label: string
  title: string
  /** a Lucide icon name or an emoji; a name draws nothing here, exactly as on a page reference */
  icon: string | null
  href: string | null
  subtitle: string | null
}

/**
 * What a reading macro was told, if anything.
 *
 * A discriminated union rather than a bag of optional fields, so a resolver cannot hand a children
 * list to `includePage` and have it render as nothing while looking correct at the call site.
 *
 * `page.html` is the one field here that is HTML rather than data, and it is safe for exactly one
 * reason: **the only legal producer of it is `renderPageDoc` itself**, called by `macros.ts` on the
 * included page's stored document with the same escaping this file applies to everything else.
 * Anything else putting a string there is putting unescaped markup on somebody's page.
 */
export type MacroContent =
  | { kind: 'pages'; pages: MacroPageRef[] }
  | { kind: 'page'; page: MacroPageRef | null; html: string }
  | { kind: 'people'; people: MacroPerson[] }
  | { kind: 'object'; object: MacroObjectRef | null }

/**
 * The answer for one macro node, or null.
 *
 * Synchronous, because `renderPageDoc` is: a caller collects the macros with `macrosIn`, resolves
 * them all in one pass against one audience, and hands back a lookup. Resolving inside the renderer
 * would mean a database round trip per macro, in render order, on a request that is otherwise two
 * queries — the same arrangement `fileSrc` and `pageHref` already use, for the same reason.
 *
 * **Null is the fail-closed answer and it is the default.** No resolver at all, a resolver that has
 * nothing for this node, a macro whose page was deleted: all three render the macro's frame and
 * nothing else. To leak a title somebody has to construct an audience, and `macros.ts` offers
 * exactly two.
 */
export type MacroResolver = (node: PageDocNode) => MacroContent | null

/**
 * The handful of words a macro needs, in the reader's language.
 *
 * The renderer is a pure function and has no message runtime — `@kernhq/ui`'s `t()` is Svelte and
 * must never load in this process. So the caller, which knows who is reading, passes the words in;
 * the defaults below are English and are what a caller that has not thought about it gets, which is
 * the same bargain the `Untitled` fallback on a page mention already makes.
 */
export interface MacroStrings {
  /** shown in place of a macro that resolved to nothing */
  empty: string
  /** a page whose title is blank */
  untitled: string
  /** a Mermaid diagram with nothing in it yet */
  diagramEmpty: string
  /** valid Mermaid this renderer does not draw — a subgraph, an `alt` frame, a shape it has no polygon for */
  diagramUnsupported: string
  /** a source that is not Mermaid at all */
  diagramBroken: string
  /** an Excalidraw or Draw.io block whose editor saved no picture */
  diagramNoPicture: string
  /** the words on the link to a diagram that lives somewhere else */
  diagramOpen: string
}

export const DEFAULT_MACRO_STRINGS: MacroStrings = {
  empty: 'Nothing to show',
  untitled: 'Untitled',
  diagramEmpty: 'This diagram has no source yet',
  diagramUnsupported: 'This diagram uses something that cannot be drawn here',
  diagramBroken: 'This diagram could not be drawn',
  diagramNoPicture: 'No picture has been saved for this diagram',
  diagramOpen: 'Open the diagram',
}

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
  /**
   * What a macro that reads other pages was told about them, for this reader.
   *
   * Absent is the safe state and the one every caller written before macros existed already has.
   * See `MacroResolver`.
   */
  macros?: MacroResolver
  /** The words a macro needs, in the reader's language. English when nobody says otherwise. */
  macroStrings?: MacroStrings
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

/* ---------------------------------------------------------------------------------------------- */
/* Macros                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The lozenge colours, restated rather than imported.
 *
 * `@kernhq/ui` is a peer dependency and its editor half loads Tiptap and Svelte, neither of which
 * belongs in a backend process — so this file imports **types** from it and nothing else, exactly as
 * it already restates the callout tones and the table alignments. What keeps the two honest is
 * `render.test.ts`, which is a test and may import at runtime: it compares this list against
 * `STATUS_TONES` in the package, in both directions.
 */
export const STATUS_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
const DEFAULT_STATUS_TONE = 'neutral'
const statusTone = (value: unknown): string =>
  (STATUS_TONES as readonly string[]).includes(String(value)) ? String(value) : DEFAULT_STATUS_TONE

/**
 * The macro nodes that need an audience before they can draw anything.
 *
 * Exported for the same parity test: `PAGE_DOC_READING_MACROS` in `@kernhq/ui` is the writer's half
 * of this list, and a sixth reading macro added there without a fail-closed case here is exactly the
 * defect the whole arrangement exists to prevent.
 */
export const READING_MACROS = [
  'contributors',
  'excerptInclude',
  'includePage',
  /*
   * The sixth. An object embed names an issue, a page or a channel by reference and holds no title,
   * so what a reader may be told about it is a question rather than a stored answer — which is the
   * definition of a reading macro and the reason it is drawn through `macroFrame` like the rest.
   * `embed`, next door, is deliberately *not* one: it holds the unfurl of a public URL.
   */
  'objectEmbed',
  'pageChildren',
  'recentlyUpdated',
] as const

/**
 * The `data-macro` value each reading macro draws with, in one place.
 *
 * The node is named in the document's own vocabulary (`pageChildren`) and in the markup contract's
 * (`children`), and both halves have to agree with `nodes/macros.ts` in `@kernhq/ui`. Written as a
 * map the renderers read rather than as a literal in each case, because the second consumer of it
 * is `hasReadingMacro` — and a marker list that had drifted from the renderers would make that
 * function answer "no macros here" about a page that has one, which is a stored public render
 * nobody re-resolves. `render.test.ts` holds the keys to `READING_MACROS`.
 */
export const READING_MACRO_KINDS: Record<(typeof READING_MACROS)[number], string> = {
  contributors: 'contributors',
  excerptInclude: 'excerpt-include',
  includePage: 'include-page',
  objectEmbed: 'object',
  pageChildren: 'children',
  recentlyUpdated: 'recently-updated',
}

/**
 * Does this rendered HTML contain a macro that had to be resolved against a reader?
 *
 * The cheap question the public read path asks before deciding whether to re-render a page. Stored
 * publish-time HTML has reading macros as **empty frames** — resolving them at publish time would
 * freeze a set of titles into a row and keep serving them after the pages were unpublished, which
 * is precisely the leak this feature's rule exists to prevent. So the frames are drawn empty and
 * filled per read, and this is how a read finds out whether it has to do that work at all.
 *
 * A string search rather than a parse: the alternative is decoding a Y.Doc on every public page
 * view to discover that almost none of them have a macro.
 */
export const hasReadingMacro = (html: string): boolean =>
  Object.values(READING_MACRO_KINDS).some((kind) => html.includes(`data-macro="${kind}"`))

/** A boolean attribute out of a document, where `"true"` is what an HTML attribute carries. */
const macroFlag = (value: unknown): boolean => value === true || value === 'true'

/**
 * A page's icon, but only when the icon *is* the character.
 *
 * A page stores either an emoji or a Lucide icon name, and this renderer has no icon set — printing
 * `book` in front of a title because somebody chose the book icon is worse than printing nothing.
 * An emoji is outside ASCII, which is the whole test: the character carries itself. Counted by code
 * rather than matched by a regex, for the reason `stripUrlNoise` above gives.
 */
function emojiIcon(icon: string | null): string {
  if (!icon) return ''
  let outsideAscii = false
  for (let i = 0; i < icon.length; i++) if (icon.charCodeAt(i) > 127) outsideAscii = true
  return outsideAscii ? `<span class="kern-macro-icon">${escapeHtml(icon)}</span>` : ''
}

/** One page in a macro's answer: a link where there is an address, plain text where there is not. */
function pageLink(page: MacroPageRef, strings: MacroStrings): string {
  const body = `${emojiIcon(page.icon)}${escapeHtml(page.title || strings.untitled)}`
  const href = safeHref(page.href)
  return href ? `<a href="${escapeHtml(href)}">${body}</a>` : `<span>${body}</span>`
}

/** The same, introducing prose lifted from that page, so a reader can see where it came from. */
const pageSource = (page: MacroPageRef, strings: MacroStrings): string =>
  `<span class="kern-macro-source">${pageLink(page, strings)}</span>`

/**
 * A tree of pages, as nested lists.
 *
 * Recursive because a children macro may go several levels down, and depth is meaningful — a flat
 * list of everything under a page says nothing about which section a page is in. The recursion is
 * bounded by the resolver, which builds the tree; this function walks whatever it was handed.
 */
function pageList(pages: MacroPageRef[], strings: MacroStrings): string {
  if (pages.length === 0) return ''
  const rows = pages
    .map((page) => {
      const excerpt = page.excerpt ? `<p class="kern-macro-excerpt">${escapeHtml(page.excerpt)}</p>` : ''
      const updated = page.updated ? `<p class="kern-macro-meta">${escapeHtml(page.updated)}</p>` : ''
      const nested = page.children?.length ? pageList(page.children, strings) : ''
      return `<li>${pageLink(page, strings)}${excerpt}${updated}${nested}</li>`
    })
    .join('')
  return `<ul class="kern-macro-pages">${rows}</ul>`
}

/**
 * The frame every reading macro draws, and the one place the fail-closed rule is implemented.
 *
 * `options.macros` is consulted once; a null answer, a wrong-shaped answer and an empty answer are
 * all the same thing to a reader and all draw the "nothing to show" line. That is what makes the
 * absence of a resolver the *safe* state rather than a case somebody has to remember: there is no
 * branch here that reads a database, so no caller can accidentally get one.
 */
function macroFrame(
  kind: string,
  node: PageDocNode,
  options: RenderOptions,
  draw: (content: MacroContent | null, strings: MacroStrings) => string,
): string {
  const strings = options.macroStrings ?? DEFAULT_MACRO_STRINGS
  const body = draw(options.macros?.(node) ?? null, strings)
  const inner = body || `<p class="kern-macro-empty">${escapeHtml(strings.empty)}</p>`
  return `<div${idAttr(node)} class="kern-macro" data-macro="${escapeHtml(kind)}">${inner}</div>`
}

/* ---------------------------------------------------------------------------------------------- */
/* Diagrams and embeds                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The narrowing the diagram and embed nodes apply, restated.
 *
 * Restated rather than imported for the reason the lozenge tones are: those functions live beside
 * the Tiptap nodes, and this file must not load Tiptap. What keeps the two honest is the *ceilings*,
 * which come out of `page-doc.ts` — the one file in `@kernhq/ui` that imports nothing — plus
 * `render.test.ts`, which is a test and may import the extension at runtime to compare them.
 */
const diagramKind = (value: unknown): string =>
  (PAGE_DIAGRAM_KINDS as readonly string[]).includes(String(value))
    ? String(value)
    : DEFAULT_PAGE_DIAGRAM_KIND

const capped = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

const trimmedTo = (value: unknown, max: number): string | null => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return text || null
}

/**
 * A source nobody could draw, shown rather than hidden.
 *
 * This is the rule the whole diagram feature turns on: **a diagram never renders as a blank block.**
 * A writer whose Mermaid has a typo in it sees their own text and a sentence saying what went
 * wrong; a reader sees the same, which is what makes the writer find out. The alternative — an empty
 * figure — is a page that looks finished and is not, on a published site nobody re-reads.
 */
const diagramFallback = (message: string, source: string): string =>
  `<p class="kern-diagram-message">${escapeHtml(message)}</p>${
    source ? `<pre><code>${escapeHtml(source)}</code></pre>` : ''
  }`

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

  /* -------------------------------------------------------------------------------------------- */
  /* Diagrams                                                                                       */
  /* -------------------------------------------------------------------------------------------- */

  /**
   * A diagram, drawn as far as this process honestly can — and never as nothing.
   *
   * Three kinds, three different answers, and the difference is not arbitrary:
   *
   *   - **Mermaid is drawn.** `renderMermaid` is a real server-side render: it parses the source and
   *     emits an SVG, with no browser and no network, and it is the same function the editor's node
   *     view calls, so a writer sees what a reader will. A source it refuses shows the source and
   *     the reason.
   *   - **Excalidraw and Draw.io are shown, not drawn.** They are editors rather than notations, so
   *     the only faithful picture is the SVG their own editor exported — `svgFileId`, resolved
   *     through the same `fileSrc` a picture uses. With no saved picture the block falls back to the
   *     link the writer stored, and with neither it shows its source. It never renders empty.
   *
   * The SVG goes through unescaped, and it is the second string in this file that does. It is safe
   * for the same kind of reason `includePage`'s HTML is: the only producer of it is `renderMermaid`,
   * which escapes every character it takes from the source — asserted in its own tests, and asserted
   * again here.
   */
  diagram: (node, _children, options) => {
    const strings = options.macroStrings ?? DEFAULT_MACRO_STRINGS
    const kind = diagramKind(node.attrs?.kind)
    const source = capped(node.attrs?.source, PAGE_DIAGRAM_MAX_SOURCE)
    const title = trimmedTo(node.attrs?.title, PAGE_DIAGRAM_MAX_TITLE)
    const caption = title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ''
    const frame = (inner: string) =>
      `<figure${idAttr(node)} class="kern-diagram" data-diagram="${escapeHtml(kind)}">${inner}${caption}</figure>`

    if (kind === 'mermaid') {
      const drawn = renderMermaid(source)
      if (drawn.ok) return frame(drawn.svg)
      const why =
        drawn.reason === 'empty'
          ? strings.diagramEmpty
          : drawn.reason === 'unsupported'
            ? strings.diagramUnsupported
            : strings.diagramBroken
      return frame(diagramFallback(why, source))
    }

    const fileId = typeof node.attrs?.svgFileId === 'string' ? node.attrs.svgFileId : null
    const picture = fileId ? safeHref(options.fileSrc?.(fileId) ?? null) : null
    if (picture)
      return frame(`<img src="${escapeHtml(picture)}" alt="${escapeHtml(title ?? '')}" loading="lazy">`)

    const href = safeHref(node.attrs?.href)
    if (href)
      return frame(
        `<p class="kern-diagram-message">${escapeHtml(strings.diagramNoPicture)}</p>` +
          `<a class="kern-diagram-link" href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${escapeHtml(
            title ?? strings.diagramOpen,
          )}</a>`,
      )
    return frame(diagramFallback(strings.diagramNoPicture, source))
  },

  /* -------------------------------------------------------------------------------------------- */
  /* Embeds                                                                                         */
  /* -------------------------------------------------------------------------------------------- */

  /**
   * A public URL and what it said about itself, drawn from the document alone.
   *
   * **Nothing here makes a request.** The unfurl happened once, in `services/unfurl.ts`, when a
   * member inserted the block — so a page render, which happens on every read of every published
   * page, is a pure function of what is stored. That is not only a performance argument: a renderer
   * that fetched would be an SSRF reachable by anyone who can read a page, rather than by a member
   * who can write one.
   *
   * There is no remote picture in the card on purpose. An `<img>` pointing at a third party tells
   * that third party the address of everyone who reads the page, which is not a thing a wiki should
   * arrange on its writers' behalf.
   */
  embed: (node) => {
    const strings = DEFAULT_MACRO_STRINGS
    const url = capped(node.attrs?.url, PAGE_EMBED_MAX_URL).trim()
    const href = safeHref(url)
    const title = trimmedTo(node.attrs?.title, PAGE_EMBED_MAX_TITLE) ?? (url || null)
    const site = trimmedTo(node.attrs?.siteName, PAGE_EMBED_MAX_SITE)
    const description = trimmedTo(node.attrs?.description, PAGE_EMBED_MAX_DESCRIPTION)

    const label = `<span class="kern-embed-title">${escapeHtml(title ?? strings.untitled)}</span>`
    const where = site ? `<span class="kern-embed-site">${escapeHtml(site)}</span>` : ''
    // No `<a>` at all rather than a dead one, exactly as a rejected link mark degrades.
    const head = href
      ? `<a class="kern-embed-link" href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${label}${where}</a>`
      : `${label}${where}`
    const body = description ? `<p class="kern-embed-description">${escapeHtml(description)}</p>` : ''
    return `<div${idAttr(node)} class="kern-embed" data-embed="">${head}${body}</div>`
  },

  /* -------------------------------------------------------------------------------------------- */
  /* The eight macros                                                                               */
  /* -------------------------------------------------------------------------------------------- */

  /*
   * The three that resolve from the document, and are therefore safe on a page with no reader.
   *
   * An excerpt is a region of *this* page marked as quotable, so it draws its own prose — unless the
   * writer hid it, which is the case for a page whose only job is to be quoted somewhere else.
   * `data-hidden` rather than dropping the children here: the CSS hides it, so the same HTML serves
   * a print stylesheet that may reasonably decide to show it.
   */
  excerpt: (node, children) =>
    `<div${idAttr(node)} class="kern-excerpt" data-macro="excerpt"${
      macroFlag(node.attrs?.hidden) ? ' data-hidden="true"' : ''
    }>${children}</div>`,

  /*
   * The expand, byte-for-byte the arrangement `nodes/macros.ts` renders — see the note there for why
   * it and the toggle both exist. `open` is the writer's stored decision, which is the whole
   * difference: a toggle's open state belongs to the reader and is not in the document.
   */
  expand: (node, children) =>
    `<details${idAttr(node)} class="kern-expand" data-macro="expand"${
      macroFlag(node.attrs?.open) ? ' open' : ''
    }>${children}</details>`,

  /*
   * The lozenge. Inline, and the only macro with nothing to resolve at all: the word and the colour
   * are both in the document, which is why it is the one that works identically for a signed-in
   * reader, a published site, a PDF and a Markdown file.
   */
  statusLozenge: (node, children) =>
    `<span class="kern-status" data-status="${statusTone(node.attrs?.tone)}">${children}</span>`,

  /*
   * The five that read other pages. Each draws `options.macros`' answer or an empty frame, and the
   * empty frame is what a caller with no resolver gets — see `MacroResolver`.
   */
  pageChildren: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.pageChildren, node, options, (content, strings) =>
      content?.kind === 'pages' ? pageList(content.pages, strings) : '',
    ),

  recentlyUpdated: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.recentlyUpdated, node, options, (content, strings) =>
      content?.kind === 'pages' ? pageList(content.pages, strings) : '',
    ),

  /*
   * Another page's excerpt. The extract is plain text — `macros.ts` flattens it rather than lifting
   * markup out of one document into another, where a half-open tag would be the reader's problem.
   */
  excerptInclude: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.excerptInclude, node, options, (content, strings) => {
      if (content?.kind !== 'page' || !content.page) return ''
      const text = content.page.excerpt ?? ''
      if (!text) return ''
      const source = node.attrs?.showTitle === false ? '' : pageSource(content.page, strings)
      return `${source}<p>${escapeHtml(text)}</p>`
    }),

  /*
   * Another page's whole body.
   *
   * `content.html` goes through unescaped and is the only string in this file that does. It is safe
   * because `macros.ts` is the only thing that can produce it, and it produces it by calling this
   * very function on the included page's stored document — so every character in it has already been
   * escaped here. See the note on `MacroContent`.
   */
  includePage: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.includePage, node, options, (content, strings) => {
      if (content?.kind !== 'page' || !content.page || !content.html) return ''
      const source = node.attrs?.showTitle === false ? '' : pageSource(content.page, strings)
      return `${source}${content.html}`
    }),

  /**
   * One of Kern's own objects, resolved against this reader or not drawn at all.
   *
   * The fail-closed frame is the whole reason this is a reading macro rather than an embed: the
   * document holds `tracker:issue:<id>` and nothing else, so a renderer with no resolver has no
   * title to leak and no way to get one. `services/objects.ts` is the only thing that answers it,
   * through the module's own `resolvers`, and it answers nothing at all for a published site.
   */
  objectEmbed: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.objectEmbed, node, options, (content, strings) => {
      if (content?.kind !== 'object' || !content.object) return ''
      const object = content.object
      const body = `${emojiIcon(object.icon)}${escapeHtml(object.title || strings.untitled)}`
      const href = safeHref(object.href)
      const named = href ? `<a href="${escapeHtml(href)}">${body}</a>` : `<span>${body}</span>`
      const subtitle = object.subtitle
        ? `<span class="kern-object-subtitle">${escapeHtml(object.subtitle)}</span>`
        : ''
      return `<span class="kern-object"><span class="kern-object-kind">${escapeHtml(
        object.label,
      )}</span>${named}${subtitle}</span>`
    }),

  contributors: (node, _children, options) =>
    macroFrame(READING_MACRO_KINDS.contributors, node, options, (content) => {
      if (content?.kind !== 'people' || content.people.length === 0) return ''
      const names = content.people.map((p) => `<li>${escapeHtml(p.name)}</li>`).join('')
      return `<ul class="kern-macro-pages">${names}</ul>`
    }),
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
    /*
     * A diagram this process cannot draw is shown as the SVG its own editor exported, which is an
     * ordinary stored file — so it is collected here beside the pictures. Missing it would not have
     * failed anything: the render would simply have fallen through to the link, on every Excalidraw
     * drawing in the workspace, silently.
     */
    if (node.type === 'diagram' && typeof node.attrs?.svgFileId === 'string')
      fileIds.add(node.attrs.svgFileId)
    if (node.type === 'pageMention' && typeof node.attrs?.id === 'string') pageIds.add(node.attrs.id)
    for (const child of node.content ?? []) walk(child)
  }
  for (const node of doc?.content ?? []) walk(node)
  return { fileIds: [...fileIds], pageIds: [...pageIds] }
}

/**
 * A macro instance, named by what it asks for rather than by where it sits.
 *
 * Two identical macros on one page are one question and get one answer, which is what makes the key
 * the *attributes* rather than the node's `id` — and means the resolver works on a document written
 * by an importer that never stamped ids. `id` is excluded deliberately: including it would ask the
 * database the same question twice for two blocks that must draw the same thing.
 *
 * The keys are sorted, because `JSON.stringify` preserves insertion order and two clients writing
 * the same attributes in a different order would otherwise be two questions.
 */
export function macroKey(node: PageDocNode): string {
  const attrs = node.attrs ?? {}
  const parts = Object.keys(attrs)
    .filter((name) => name !== 'id')
    .sort()
    .map((name) => `${name}=${JSON.stringify(attrs[name] ?? null)}`)
  return `${node.type ?? ''}(${parts.join(',')})`
}

/**
 * Every reading macro in a document, de-duplicated — the `referencesIn` of the macro half.
 *
 * A caller resolves these against one audience in one pass and hands back a `MacroResolver`. The
 * three macros that resolve from the document itself are not here: they need nothing looked up, so
 * collecting them would only invite a caller to ask a database about a status lozenge.
 */
export function macrosIn(doc: PageDoc | null | undefined): PageDocNode[] {
  const reading = new Set<string>(READING_MACROS)
  const seen = new Set<string>()
  const found: PageDocNode[] = []
  const walk = (node: PageDocNode): void => {
    if (typeof node.type === 'string' && reading.has(node.type)) {
      const key = macroKey(node)
      if (!seen.has(key)) {
        seen.add(key)
        found.push(node)
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  for (const node of doc?.content ?? []) walk(node)
  return found
}

/** Nodes whose children are separate blocks, so their text needs a line between each. */
const BLOCK_PARENTS = new Set([
  'blockquote',
  'bulletList',
  'callout',
  'details',
  'detailsContent',
  'doc',
  'excerpt',
  'expand',
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
 *
 * **A macro contributes nothing.** The five that read other pages are atoms with no content, so they
 * fall out of this walk on their own — and that is the behaviour to keep rather than an omission to
 * fix. What a children macro would contribute is other pages' titles, resolved against nobody, into
 * a search index that is read by everybody: the same leak the render rule exists to prevent, one
 * layer further from where anybody would look for it.
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
      /*
       * A diagram contributes its **name and not its source**. A Mermaid source is `A-->B` and an
       * Excalidraw scene is a megabyte of JSON with a font name in it — putting either in the search
       * body would make every diagram in the workspace match a search for `flowchart`, which is the
       * same defect as the `noopener` one this function was written to fix.
       */
      case 'diagram':
        return trimmedTo(node.attrs?.title, PAGE_DIAGRAM_MAX_TITLE) ?? ''
      /*
       * An embed contributes what a person reads on the card: the headline and the sentence under
       * it. Not the URL — a search body full of addresses matches on `https` and on every hostname
       * anybody has ever linked to.
       */
      case 'embed':
        return [
          trimmedTo(node.attrs?.title, PAGE_EMBED_MAX_TITLE),
          trimmedTo(node.attrs?.description, PAGE_EMBED_MAX_DESCRIPTION),
        ]
          .filter(Boolean)
          .join('\n')
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
