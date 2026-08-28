import {
  PAGE_DOC_MARKS,
  PAGE_DOC_NODES,
  PAGE_DOC_READING_MACROS,
  PAGE_STATUS_TONES,
  type PageDoc,
} from '@kernhq/ui/editor/page-doc'
import { describe, expect, it } from 'vitest'
import {
  hasReadingMacro,
  MARK_RENDERERS,
  type MacroContent,
  macroKey,
  macrosIn,
  NODE_RENDERERS,
  READING_MACRO_KINDS,
  READING_MACROS,
  renderPageDoc,
  STATUS_TONES,
  safeHref,
  textFromPageDoc,
} from './render.js'

/** A one-block document, so a case can be stated without four lines of scaffolding. */
const doc = (
  ...content: PageDoc['content'] extends (infer T)[] | null | undefined ? T[] : never[]
): PageDoc => ({
  type: 'doc',
  content,
})
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

describe('the renderer covers the schema', () => {
  /**
   * The assertion this whole area exists to support.
   *
   * Set equality, in both directions and on purpose: a node the editor can produce with no case
   * here fails, and so does a case for a node the schema no longer has — the second is how a
   * renderer slowly fills with markup for blocks nobody can write any more.
   *
   * `doc` and `text` are named inside the assertion rather than filtered out beforehand, so a third
   * exception cannot be added quietly later.
   */
  it('has a case for every node in PAGE_DOC_NODES', () => {
    expect(new Set([...Object.keys(NODE_RENDERERS), 'doc', 'text'])).toEqual(new Set(PAGE_DOC_NODES))
  })

  it('has a case for every mark in PAGE_DOC_MARKS', () => {
    expect(new Set(Object.keys(MARK_RENDERERS))).toEqual(new Set(PAGE_DOC_MARKS))
  })

  /**
   * The macro half of the same claim, and the one that decides whether a page leaks.
   *
   * `PAGE_DOC_READING_MACROS` is the writer's list of nodes that draw something the document does
   * not contain. This file's `READING_MACROS` is the reader's, and it is what `macroFrame` — the
   * one place the fail-closed rule lives — is applied to. A sixth reading macro added in
   * @kernhq/ui and rendered here as an ordinary node would draw whatever it was handed, for
   * whoever asked, with nobody having decided they may see it.
   */
  it('treats exactly the nodes @kernhq/ui calls reading macros as reading macros', () => {
    expect(new Set(READING_MACROS)).toEqual(new Set(PAGE_DOC_READING_MACROS))
  })

  /** The lozenge's colours are restated in the renderer rather than imported; they must agree. */
  it('knows the same status tones the extension can produce', () => {
    expect([...STATUS_TONES].sort()).toEqual([...PAGE_STATUS_TONES].sort())
  })

  /**
   * Every reading macro has a marker, and `hasReadingMacro` finds it.
   *
   * This is the check that keeps the *public* path honest. Stored publish-time HTML draws reading
   * macros as empty frames and the public read re-resolves them, but only for a page
   * `hasReadingMacro` says has one. A macro whose `data-macro` value was missing from the map would
   * be skipped by that check for ever — the page would keep serving the empty frame, which is safe,
   * and would silently never show the macro, which nobody would notice until a customer asked.
   */
  it('can recognise every reading macro in its own output', () => {
    expect(Object.keys(READING_MACRO_KINDS).sort()).toEqual([...READING_MACROS].sort())
    for (const type of READING_MACROS) {
      const html = renderPageDoc(doc({ type, attrs: { pageId: null, limit: 5, depth: 1 } }))
      expect(hasReadingMacro(html), `${type} draws no marker hasReadingMacro can find`).toBe(true)
    }
  })

  /** And says no to a page that has none, or the public path re-renders every page for nothing. */
  it('does not mistake the three self-contained macros for reading ones', () => {
    for (const node of [
      { type: 'statusLozenge', attrs: { tone: 'warning' }, content: [{ type: 'text', text: 'Blocked' }] },
      { type: 'excerpt', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'ordinary prose' }] },
    ]) {
      expect(hasReadingMacro(renderPageDoc(doc(node)))).toBe(false)
    }
  })
})

describe('renderPageDoc', () => {
  it('renders nothing for an empty or missing document', () => {
    expect(renderPageDoc(null)).toBe('')
    expect(renderPageDoc(undefined)).toBe('')
    expect(renderPageDoc({ type: 'doc', content: [] })).toBe('')
  })

  it('escapes text rather than trusting it', () => {
    expect(renderPageDoc(doc(para('<script>alert(1)</script>')))).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  /*
   * Both quotes, not just the double one — the escaper in module-chat omits `'`, which is only
   * safe for as long as every attribute in the output happens to be double-quoted. The words
   * survive as inert text; what must not survive is a quote character able to close an attribute.
   */
  it('escapes both quote characters, so an attribute cannot be broken out of', () => {
    const html = renderPageDoc(doc(para(`" onmouseover="x' onfocus='y`)))
    expect(html).toBe('<p>&quot; onmouseover=&quot;x&#39; onfocus=&#39;y</p>')
    expect(html.slice('<p>'.length, -'</p>'.length)).not.toMatch(/["']/)
  })

  // An empty paragraph is a deliberate blank line; `<p></p>` collapses and the line disappears.
  it('keeps an empty paragraph visible', () => {
    expect(renderPageDoc(doc({ type: 'paragraph' }))).toBe('<p><br></p>')
  })

  it('renders all six heading levels and clamps anything else', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(
        renderPageDoc(doc({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'H' }] })),
      ).toBe(`<h${level}>H</h${level}>`)
    }
    expect(
      renderPageDoc(doc({ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'H' }] })),
    ).toBe('<h1>H</h1>')
  })

  it('carries a block id through, and drops one that is not id-shaped', () => {
    expect(renderPageDoc(doc({ ...para('x'), attrs: { id: 'abc-123' } }))).toBe('<p id="abc-123">x</p>')
    expect(renderPageDoc(doc({ ...para('x'), attrs: { id: '" onload="1' } }))).toBe('<p>x</p>')
  })

  // Without `start` a list that begins at 5 silently restarts at 1, which changes what it says.
  it('keeps an ordered list start and type', () => {
    const list = {
      type: 'orderedList',
      attrs: { start: 5, type: 'a' },
      content: [{ type: 'listItem', content: [para('x')] }],
    }
    expect(renderPageDoc(doc(list))).toBe('<ol start="5" type="a"><li><p>x</p></li></ol>')
  })

  it('renders a task item the reader cannot click', () => {
    const html = renderPageDoc(
      doc({
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('done')] }],
      }),
    )
    expect(html).toBe(
      '<ul class="kern-tasks" data-type="taskList">' +
        '<li data-checked="true" data-type="taskItem">' +
        '<label><input type="checkbox" disabled checked><span></span></label>' +
        '<div><p>done</p></div></li></ul>',
    )
  })

  it('renders a callout with its tone, and falls back for an unknown one', () => {
    expect(
      renderPageDoc(doc({ type: 'callout', attrs: { tone: 'warning' }, content: [para('Careful')] })),
    ).toBe('<aside class="kern-callout" data-callout="warning"><p>Careful</p></aside>')
    expect(renderPageDoc(doc({ type: 'callout', attrs: { tone: 'evil"' }, content: [para('x')] }))).toBe(
      '<aside class="kern-callout" data-callout="info"><p>x</p></aside>',
    )
  })

  it('renders a toggle', () => {
    const html = renderPageDoc(
      doc({
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
          { type: 'detailsContent', content: [para('Hidden')] },
        ],
      }),
    )
    expect(html).toBe(
      '<details class="kern-toggle"><summary>More</summary><div><p>Hidden</p></div></details>',
    )
  })

  it('wraps a table in its own scroller and validates every numeric attribute', () => {
    const html = renderPageDoc(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', attrs: { colspan: 2, align: 'center' }, content: [para('H')] },
              { type: 'tableCell', attrs: { colspan: '2" onload="x' }, content: [para('C')] },
            ],
          },
        ],
      }),
    )
    expect(html).toContain('<div class="kern-table-wrap">')
    expect(html).toContain('<th colspan="2" data-align="center">')
    // The attacker's string parsed as the number 2 or not at all — never reached the output.
    expect(html).not.toMatch(/onload/)
  })

  it('labels a code block language it recognises and drops one it does not', () => {
    expect(
      renderPageDoc(
        doc({ type: 'codeBlock', attrs: { language: 'bash' }, content: [{ type: 'text', text: 'ls -l' }] }),
      ),
    ).toBe('<pre><code class="language-bash">ls -l</code></pre>')
    expect(
      renderPageDoc(
        doc({ type: 'codeBlock', attrs: { language: '"><script>' }, content: [{ type: 'text', text: 'x' }] }),
      ),
    ).toBe('<pre><code>x</code></pre>')
  })

  // A `code` mark inside a code block would otherwise emit a nested `<code>`.
  it('renders a code block as text, ignoring marks inside it', () => {
    const block = {
      type: 'codeBlock',
      content: [{ type: 'text', marks: [{ type: 'code' }, { type: 'bold' }], text: 'a < b' }],
    }
    expect(renderPageDoc(doc(block))).toBe('<pre><code>a &lt; b</code></pre>')
  })

  it('renders a mention as a labelled span rather than dropping it', () => {
    expect(
      renderPageDoc(
        doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'u1', label: 'Sara' } }] }),
      ),
    ).toBe('<p><span class="kern-mention" data-type="mention" data-id="u1">@Sara</span></p>')
  })

  it('links a page mention only when it is given a way to address the page', () => {
    const node = {
      type: 'paragraph',
      content: [{ type: 'pageMention', attrs: { id: 'p1', label: 'Runbook' } }],
    }
    expect(renderPageDoc(doc(node))).toContain('<span class="kern-page-mention"')
    const linked = renderPageDoc(doc(node), { pageHref: (id) => `/quire/ENG/${id}` })
    expect(linked).toContain('<a class="kern-page-mention" href="/quire/ENG/p1"')
  })

  it('drops a picture it cannot resolve rather than rendering a broken one', () => {
    const image = { type: 'image', attrs: { fileId: 'f1', alt: 'A chart' } }
    expect(renderPageDoc(doc(image))).toBe('')
    expect(renderPageDoc(doc(image), { fileSrc: () => 'https://cdn.example/f1.png' })).toBe(
      '<img src="https://cdn.example/f1.png" alt="A chart" loading="lazy">',
    )
  })
})

/**
 * The macros, from the renderer's side.
 *
 * The permission rule itself is proved in `macros.int.test.ts`, against a real database and a real
 * DENY binding — this file cannot, because it has neither. What it proves is the property that rule
 * *rests* on: with nothing handed to it, this file draws no title, no link and no prose, whatever
 * the document asks for. Every existing caller — the exporters, the publish-time render, a search
 * preview — is in exactly that state, so this is what they all do today.
 */
describe('the macros that read other pages', () => {
  const readingDoc = (type: string) =>
    doc({ type, attrs: { pageId: '01920000-0000-7000-8000-00000000000a', limit: 5, depth: 2 } })

  it.each([...READING_MACROS])('draws %s as an empty frame when nothing was resolved', (type) => {
    const html = renderPageDoc(readingDoc(type))
    expect(html).toContain('class="kern-macro"')
    expect(html).toContain('Nothing to show')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<ul')
  })

  it('says so in the reader’s own language when the caller supplies the words', () => {
    const html = renderPageDoc(readingDoc('pageChildren'), {
      macroStrings: { empty: 'Nichts anzuzeigen', untitled: 'Ohne Titel' },
    })
    expect(html).toContain('Nichts anzuzeigen')
    expect(html).not.toContain('Nothing to show')
  })

  const ref = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    title: 'Rollback runbook',
    icon: null,
    href: '/quire/ENG/p1',
    updated: null,
    excerpt: null,
    ...over,
  })

  it('draws a children list as nested lists, linked where there is an address', () => {
    const content: MacroContent = {
      kind: 'pages',
      pages: [{ ...ref(), children: [ref({ id: 'p2', title: 'Step two', href: null })] }],
    }
    const html = renderPageDoc(readingDoc('pageChildren'), { macros: () => content })
    expect(html).toContain('<a href="/quire/ENG/p1">Rollback runbook</a>')
    // No address for the child, so its title is text — never an anchor that goes nowhere.
    expect(html).toContain('<span>Step two</span>')
    expect(html).toContain('<ul class="kern-macro-pages"><li>')
  })

  it('escapes a title, an excerpt and a name rather than trusting any of them', () => {
    const html = renderPageDoc(readingDoc('pageChildren'), {
      macros: () => ({
        kind: 'pages',
        pages: [ref({ title: '<script>x</script>', excerpt: '" onload="y', href: 'javascript:evil()' })],
      }),
    })
    expect(html).toContain('&lt;script&gt;')
    // The words survive as inert text; what must not survive is a quote able to close an attribute.
    expect(html).toContain('&quot; onload=&quot;y')
    expect(html).not.toContain('" onload="')
    // A rejected href leaves the title as plain text, exactly as a rejected link mark does.
    expect(html).not.toContain('<a ')
  })

  /**
   * An icon is drawn only when the icon *is* the character.
   *
   * A page stores an emoji or a Lucide icon name, and this renderer has no icon set — printing
   * `book` in front of a title because somebody picked the book icon is worse than printing nothing.
   */
  it('draws an emoji icon and drops an icon name it cannot draw', () => {
    const emoji = renderPageDoc(readingDoc('pageChildren'), {
      macros: () => ({ kind: 'pages', pages: [ref({ icon: '📕' })] }),
    })
    expect(emoji).toContain('📕')
    const named = renderPageDoc(readingDoc('pageChildren'), {
      macros: () => ({ kind: 'pages', pages: [ref({ icon: 'sticky-note', title: 'Notes' })] }),
    })
    expect(named).not.toContain('sticky-note')
    expect(named).not.toContain('kern-macro-icon')
  })

  it('draws an included page under a link to where it came from, and honours showTitle', () => {
    const content: MacroContent = { kind: 'page', page: ref(), html: '<p>the steps</p>' }
    const shown = renderPageDoc(doc({ type: 'includePage', attrs: { pageId: 'p1' } }), {
      macros: () => content,
    })
    expect(shown).toContain('<span class="kern-macro-source"><a href="/quire/ENG/p1">')
    expect(shown).toContain('<p>the steps</p>')
    const bare = renderPageDoc(doc({ type: 'includePage', attrs: { pageId: 'p1', showTitle: false } }), {
      macros: () => content,
    })
    expect(bare).not.toContain('kern-macro-source')
    expect(bare).toContain('<p>the steps</p>')
  })

  /** A resolver that answers with the wrong shape is the same as one that answered nothing. */
  it('ignores an answer of the wrong kind rather than drawing something misleading', () => {
    const html = renderPageDoc(doc({ type: 'includePage', attrs: { pageId: 'p1' } }), {
      macros: () => ({ kind: 'pages', pages: [ref()] }),
    })
    expect(html).toContain('Nothing to show')
    expect(html).not.toContain('Rollback runbook')
  })

  it('lists contributors by name and never by id', () => {
    const html = renderPageDoc(doc({ type: 'contributors', attrs: { limit: 5 } }), {
      macros: () => ({ kind: 'people', people: [{ name: 'Ada Lovelace' }] }),
    })
    expect(html).toContain('<li>Ada Lovelace</li>')
    expect(html).not.toMatch(/data-id/)
  })
})

describe('the macros that resolve from the document', () => {
  it('draws an excerpt as its own prose, and marks a hidden one rather than dropping it', () => {
    const open = renderPageDoc(doc({ type: 'excerpt', content: [para('quotable')] }))
    expect(open).toBe('<div class="kern-excerpt" data-macro="excerpt"><p>quotable</p></div>')
    const hidden = renderPageDoc(doc({ type: 'excerpt', attrs: { hidden: true }, content: [para('q')] }))
    expect(hidden).toContain('data-hidden="true"')
    // The prose is still in the HTML: a print stylesheet may reasonably decide to show it.
    expect(hidden).toContain('<p>q</p>')
  })

  it('draws an expand, open when the writer stored that decision', () => {
    const body = [
      { type: 'detailsSummary', content: [{ type: 'text', text: 'Rollback' }] },
      { type: 'detailsContent', content: [para('the steps')] },
    ]
    expect(renderPageDoc(doc({ type: 'expand', content: body }))).toBe(
      '<details class="kern-expand" data-macro="expand"><summary>Rollback</summary>' +
        '<div><p>the steps</p></div></details>',
    )
    expect(renderPageDoc(doc({ type: 'expand', attrs: { open: true }, content: body }))).toContain(
      '<details class="kern-expand" data-macro="expand" open>',
    )
  })

  it('draws a lozenge with its tone, and falls back for one it does not know', () => {
    const lozenge = (tone: unknown) => ({
      type: 'paragraph',
      content: [{ type: 'statusLozenge', attrs: { tone }, content: [{ type: 'text', text: 'Blocked' }] }],
    })
    expect(renderPageDoc(doc(lozenge('warning')))).toBe(
      '<p><span class="kern-status" data-status="warning">Blocked</span></p>',
    )
    expect(renderPageDoc(doc(lozenge('evil" onload="x')))).toContain('data-status="neutral"')
  })
})

describe('macrosIn and macroKey', () => {
  it('collects only the macros that need an audience', () => {
    const found = macrosIn({
      type: 'doc',
      content: [
        { type: 'pageChildren', attrs: { pageId: null, depth: 1 } },
        { type: 'excerpt', content: [para('not a question')] },
        { type: 'paragraph', content: [{ type: 'statusLozenge', attrs: { tone: 'info' } }] },
        { type: 'callout', content: [{ type: 'includePage', attrs: { pageId: 'p1' } }] },
      ],
    })
    expect(found.map((n) => n.type)).toEqual(['pageChildren', 'includePage'])
  })

  /** Two identical macros are one question, so the resolver asks the database once. */
  it('de-duplicates two macros that ask the same thing', () => {
    const node = { type: 'pageChildren', attrs: { pageId: 'p1', depth: 2 } }
    expect(macrosIn({ type: 'doc', content: [node, { ...node }] })).toHaveLength(1)
  })

  it('keys on the attributes rather than the block id, and ignores their order', () => {
    expect(macroKey({ type: 'pageChildren', attrs: { id: 'block-1', pageId: 'p1' } })).toBe(
      macroKey({ type: 'pageChildren', attrs: { id: 'block-2', pageId: 'p1' } }),
    )
    expect(macroKey({ type: 'pageChildren', attrs: { depth: 2, pageId: 'p1' } })).toBe(
      macroKey({ type: 'pageChildren', attrs: { pageId: 'p1', depth: 2 } }),
    )
    expect(macroKey({ type: 'pageChildren', attrs: { pageId: 'p1' } })).not.toBe(
      macroKey({ type: 'pageChildren', attrs: { pageId: 'p2' } }),
    )
  })
})

describe('safeHref', () => {
  it.each([
    ['javascript:evil()', 'a script URL'],
    ['//evil.example', 'a protocol-relative href, which leaves the site'],
    [' \t JaVaScRiPt:alert(1)', 'whitespace and case around a script URL'],
    ['java\tscript:alert(1)', 'a tab inside the scheme, which a browser strips'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'a data URL'],
    ['vbscript:msgbox(1)', 'another script scheme'],
    ['', 'nothing at all'],
    ['/\\evil.example', 'a backslash a browser folds into the second slash of `//`'],
    ['\\\\evil.example', 'a UNC-looking href, which is `//` once folded'],
    ['/\\evil.example/docs', 'a backslash escape wearing a plausible path'],
  ])('rejects %s (%s)', (href) => {
    expect(safeHref(href)).toBeNull()
  })

  /*
   * A browser folds `\` to `/` before the authority, so `/\evil.example` is `//evil.example` and
   * leaves the site — the same escape the `//` rule exists to stop, spelled differently. It must
   * reach the same verdict the browser will, which is the whole premise of this function.
   */
  it('agrees with the browser about what a backslash href resolves to', () => {
    const base = 'https://app.kernaio.com/quire/k/x'
    for (const href of ['/\\evil.example', '\\\\evil.example', '/\\evil.example/docs']) {
      expect(new URL(href, base).origin).toBe('https://evil.example')
      expect(safeHref(href)).toBeNull()
    }
  })

  /* A backslash after the path is ordinary data — the browser does not fold it either. */
  it('keeps a backslash that is only in the query or the fragment', () => {
    expect(new URL('/search?q=a\\b', 'https://app.kernaio.com').origin).toBe('https://app.kernaio.com')
    expect(safeHref('/search?q=a\\b')).toBe('/search?q=a\\b')
    expect(safeHref('#a\\b')).toBe('#a\\b')
  })

  it.each([
    'https://example.com/a',
    'http://example.com',
    'mailto:someone@example.com',
    '/quire/ENG/abc',
    '#a-heading',
  ])('allows %s', (href) => {
    expect(safeHref(href)).toBe(href)
  })

  it('renders a rejected link as its plain text, with no anchor at all', () => {
    const html = renderPageDoc(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', marks: [{ type: 'link', attrs: { href: 'javascript:evil()' } }], text: 'click' },
        ],
      }),
    )
    expect(html).toBe('<p>click</p>')
  })

  it('renders an allowed link with the same rel the editor writes', () => {
    const html = renderPageDoc(
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            marks: [{ type: 'link', attrs: { href: 'https://x.example/r' } }],
            text: 'runbook',
          },
        ],
      }),
    )
    expect(html).toBe(
      '<p><a href="https://x.example/r" rel="noreferrer noopener" target="_blank">runbook</a></p>',
    )
  })
})

describe('textFromPageDoc', () => {
  const rich: PageDoc = doc(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Runbook' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Restart the ' },
        { type: 'text', marks: [{ type: 'code' }], text: 'core' },
        { type: 'text', text: ' service, see ' },
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'https://x.example/r' } }],
          text: 'the runbook',
        },
        { type: 'text', text: '.' },
      ],
    },
  )

  /**
   * The regression test for the defect this replaces.
   *
   * `collab`'s `extractText` calls `toString()` on each `Y.XmlText`, which renders marks as markup —
   * so this exact document used to flatten to
   * `Restart the <code>core</code> service, see <link class="null" href="…" rel="noopener noreferrer
   * nofollow" target="_blank">the runbook</link>.` and every page holding one link matched a search
   * for "noopener".
   */
  it('never puts markup into the search body', () => {
    const text = textFromPageDoc(rich)
    expect(text).not.toMatch(/[<>]/)
    expect(text).not.toContain('noopener')
    expect(text).toBe('Runbook\nRestart the core service, see the runbook.')
  })

  it('keeps a mention as the literal that produced it', () => {
    const text = textFromPageDoc(
      doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { label: 'Sara' } }] }),
    )
    expect(text).toBe('@Sara')
  })

  it('separates table cells with a tab so columns do not run together', () => {
    const text = textFromPageDoc(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para('Region')] },
              { type: 'tableCell', content: [para('EMEA')] },
            ],
          },
        ],
      }),
    )
    expect(text).toBe('Region\tEMEA')
  })

  it('includes what a toggle hides and what a code block holds', () => {
    const text = textFromPageDoc(
      doc({
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: 'Rollback' }] },
          {
            type: 'detailsContent',
            content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'kern rollback' }] }],
          },
        ],
      }),
    )
    expect(text).toContain('Rollback')
    expect(text).toContain('kern rollback')
  })

  it('contributes a picture through its alt text', () => {
    expect(textFromPageDoc(doc({ type: 'image', attrs: { fileId: 'f1', alt: 'Latency by region' } }))).toBe(
      'Latency by region',
    )
  })

  it('renders nothing for an empty document', () => {
    expect(textFromPageDoc(null)).toBe('')
    expect(textFromPageDoc({ type: 'doc', content: [] })).toBe('')
  })
})

/*
 * Node and mark types come out of Yjs XmlElement names, which a client picks. A plain object
 * literal answers `__proto__` (and `constructor`, and `toString`) with something inherited and
 * truthy that is not a renderer, so a lookup that only tests truthiness calls it and throws.
 * The unknown-node rule is that the document degrades; a 500 out of `versions.get` is not that.
 */
describe('a node type that is a property of Object.prototype', () => {
  it.each(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'treats a %s node as unknown and keeps its children',
    (type) => {
      const html = renderPageDoc(doc({ type, content: [{ type: 'text', text: 'kept' }] }))
      expect(html).toContain('kept')
    },
  )

  it.each(['__proto__', 'constructor', 'toString'])('treats a %s mark as unknown', (type) => {
    const html = renderPageDoc(
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'plain', marks: [{ type }] }] }),
    )
    expect(html).toBe('<p>plain</p>')
  })

  it('still draws the rest of a document that contains one', () => {
    const html = renderPageDoc({
      type: 'doc',
      content: [
        { type: '__proto__', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    })
    expect(html).toContain('first')
    expect(html).toContain('<p>second</p>')
  })

  it('contributes its text to the search string rather than throwing', () => {
    expect(textFromPageDoc(doc({ type: '__proto__', content: [{ type: 'text', text: 'kept' }] }))).toBe(
      'kept',
    )
  })
})
