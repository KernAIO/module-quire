import { PAGE_DOC_MARKS, PAGE_DOC_NODES, type PageDoc } from '@kernhq/ui/editor/page-doc'
import { describe, expect, it } from 'vitest'
import { MARK_RENDERERS, NODE_RENDERERS, renderPageDoc, safeHref, textFromPageDoc } from './render.js'

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

describe('safeHref', () => {
  it.each([
    ['javascript:evil()', 'a script URL'],
    ['//evil.example', 'a protocol-relative href, which leaves the site'],
    [' \t JaVaScRiPt:alert(1)', 'whitespace and case around a script URL'],
    ['java\tscript:alert(1)', 'a tab inside the scheme, which a browser strips'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'a data URL'],
    ['vbscript:msgbox(1)', 'another script scheme'],
    ['', 'nothing at all'],
  ])('rejects %s (%s)', (href) => {
    expect(safeHref(href)).toBeNull()
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
