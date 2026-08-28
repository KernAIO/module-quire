/**
 * A Quire export, re-imported.
 *
 * The export writes "a folder of Markdown, one `index.md` per page with its media beside it" and the
 * import reads exactly that shape, so the two are a closed loop and the loop is the only check on
 * either half that is not somebody reading it. `import.int.test.ts` asserts the round trip *block by
 * block* on one document; what it cannot see is everything that only exists once there is more than
 * one file — the folder tree, and the relative links between them.
 *
 * **This file exists because of the links.** A relative link is written from the page that carries it,
 * so only a link pointing *down* the tree is free of `..` — every other one, a child naming its
 * parent or its sibling, is `../something/index.md`. `import.int.test.ts`'s fixture builds its links
 * with a helper that strips a shared prefix and never emits a `..`, so the downward case was the only
 * one any test had ever run, and it is the only one that worked: `normaliseArchivePath` refused every
 * path containing `..`, so those links arrived as plain text and the report said the target was not in
 * the archive when it was. The four directions below are the regression.
 *
 * Nothing here needs a database. The loop under test is `PageDoc → Markdown → zip → Markdown → PageDoc`
 * and every part of it is a pure function; putting it behind Postgres would only make it slower to
 * run and easier to skip.
 */
import type { PageDoc, PageDocNode } from '@kernhq/ui/editor/page-doc'
import { describe, expect, it } from 'vitest'
import { pageDocToMarkdown } from './export/markdown.js'
import { writeZip, type ZipEntry } from './export/zip.js'
import { planImport } from './import/plan.js'
import { normaliseArchivePath, readZip } from './import/zip.js'
import { markdownTitleLine, prepareFolders, relativeFolder } from './services/export.js'

const ROOT = '01890000-0000-7000-8000-00000000000a'
const STARTED = '01890000-0000-7000-8000-00000000000b'
const POLICIES = '01890000-0000-7000-8000-00000000000c'
const LEAVE = '01890000-0000-7000-8000-00000000000d'

const mentioning = (id: string, label: string): PageDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'pageMention', attrs: { id, label } }] }],
})

/**
 * A three-level export, written the way `services/export.ts` writes one.
 *
 * The folder names and the hrefs come from `prepareFolders` and `relativeFolder` — the functions the
 * job itself uses — rather than from literals, so a change to either is a change to this fixture and
 * the test keeps testing the shipped shape.
 */
function exportTree(docs: Map<string, PageDoc>, withMedia: ReadonlySet<string> = new Set()): Buffer {
  const selected = [
    { id: ROOT, parentId: null, title: 'Handbook', state: null },
    { id: STARTED, parentId: ROOT, title: 'Getting started', state: null },
    { id: POLICIES, parentId: ROOT, title: 'Policies', state: null },
    { id: LEAVE, parentId: POLICIES, title: 'Leave', state: null },
  ]
  const prepared = prepareFolders(selected)
  const folderOf = new Map(prepared.map((page) => [page.id, page.folder]))
  const entries: ZipEntry[] = []
  for (const page of prepared) {
    const media = new Map<string, string>()
    if (withMedia.has(page.id)) {
      entries.push({ path: `${page.folder}/media/shot.png`, data: Buffer.from('PNG') })
      media.set('file-of-this-page', 'media/shot.png')
    }
    const body = `# ${page.title}\n\n${pageDocToMarkdown(docs.get(page.id) ?? { type: 'doc', content: [] }, {
      fileSrc: (id) => media.get(id) ?? null,
      pageHref: (id) => {
        const to = folderOf.get(id)
        return to === undefined ? null : relativeFolder(page.folder, to, 'index.md')
      },
    })}`
    entries.push({ path: `${page.folder}/index.md`, data: Buffer.from(body, 'utf8') })
  }
  return writeZip(entries)
}

describe('an archive path that climbs', () => {
  it('resolves a `..` that stays inside the archive', () => {
    expect(normaliseArchivePath('a/../b.md')).toBe('b.md')
    expect(normaliseArchivePath('a/b/../../c.md')).toBe('c.md')
    expect(normaliseArchivePath('a/b/../c/./d.md')).toBe('a/c/d.md')
  })

  it('still refuses one that would climb out of it', () => {
    expect(normaliseArchivePath('../escape.md')).toBeNull()
    expect(normaliseArchivePath('a/../../escape.md')).toBeNull()
    expect(normaliseArchivePath('../../secrets/keys.md')).toBeNull()
  })
})

describe('a Quire export, re-imported', () => {
  it('keeps every internal link, in all four directions', () => {
    const plan = planImport(
      readZip(
        exportTree(
          new Map([
            [ROOT, mentioning(LEAVE, 'Leave')], // down two
            [STARTED, mentioning(POLICIES, 'Policies')], // sideways
            [POLICIES, mentioning(ROOT, 'Handbook')], // up one
            [LEAVE, mentioning(STARTED, 'Getting started')], // up two and down one
          ]),
        ),
      ),
      'markdown',
    )

    const titleOf = new Map(plan.pages.map((page) => [page.id, page.title]))
    const linkFrom = (key: string): string => {
      const node = plan.pages.find((page) => page.key === key)?.doc.content?.[0]?.content?.[0] as
        | PageDocNode
        | undefined
      // A link that did not resolve arrives as a bare text node, which is the failure being guarded.
      if (node?.type !== 'pageMention') return `not a mention: ${JSON.stringify(node)}`
      return titleOf.get(String(node.attrs?.id)) ?? 'a page that is not in this import'
    }

    expect(linkFrom('handbook/index.md')).toBe('Leave')
    expect(linkFrom('handbook/getting-started/index.md')).toBe('Policies')
    expect(linkFrom('handbook/policies/index.md')).toBe('Handbook')
    expect(linkFrom('handbook/policies/leave/index.md')).toBe('Getting started')
  })

  it('does not report a page that is in the archive as missing from it', () => {
    const plan = planImport(
      readZip(exportTree(new Map([[POLICIES, mentioning(ROOT, 'Handbook')]]))),
      'markdown',
    )
    expect(plan.report.filter((row) => (row.reason ?? '').includes('nothing in the archive'))).toEqual([])
  })

  it('rebuilds the tree, and puts each page under the page it was under', () => {
    const plan = planImport(readZip(exportTree(new Map())), 'markdown')
    const byId = new Map(plan.pages.map((page) => [page.id, page.title]))
    const parents = Object.fromEntries(
      plan.pages.map((page) => [page.title, page.parentId === null ? null : byId.get(page.parentId)]),
    )
    expect(parents).toEqual({
      Handbook: null,
      'Getting started': 'Handbook',
      Policies: 'Handbook',
      Leave: 'Policies',
    })
  })

  it('finds each page’s attachments beside it, and says why each was left out', () => {
    const archive = exportTree(new Map(), new Set([ROOT, LEAVE]))
    expect(readZip(archive).map((entry) => entry.key)).toEqual([
      'handbook/media/shot.png',
      'handbook/index.md',
      'handbook/getting-started/index.md',
      'handbook/policies/index.md',
      'handbook/policies/leave/media/shot.png',
      'handbook/policies/leave/index.md',
    ])
    const pictures = planImport(readZip(archive), 'markdown').report.filter((row) =>
      row.path.endsWith('.png'),
    )
    expect(pictures.map((row) => row.outcome)).toEqual(['skipped', 'skipped'])
    for (const row of pictures) expect(row.reason).toContain('picture')
  })
})

describe('a table cell that holds a line break', () => {
  it('comes back the same however many times it goes round', () => {
    const cell = (content: PageDocNode[]): PageDocNode => ({ type: 'tableCell', content })
    const original: PageDoc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                cell([
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'a' },
                      { type: 'hardBreak' },
                      { type: 'text', text: 'b' },
                    ],
                  },
                ]),
              ],
            },
          ],
        },
      ],
    }

    // Once is not enough: the drift this guards is two spaces per cycle, which one round trip hides.
    let round = original
    for (let n = 0; n < 3; n++) round = markdownRoundTrip(round)
    expect(round.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ])
  })
})

/** Written here rather than imported so the import side is exercised through its own entry point. */
function markdownRoundTrip(doc: PageDoc): PageDoc {
  const entries: ZipEntry[] = [
    { path: 'page/index.md', data: Buffer.from(`# Page\n\n${pageDocToMarkdown(doc)}`, 'utf8') },
  ]
  return planImport(readZip(writeZip(entries)), 'markdown').pages[0]!.doc
}

describe('a page title that ends in a hash', () => {
  /**
   * The loss this guards, and where it actually lived.
   *
   * `Roadmap #` is written `# Roadmap #` — correct Markdown, and the exporter cannot escape its way
   * out of it — and the reader's ATX pattern ended `#*[ \t]*$`, so it swallowed the hash and the page
   * came back under a different name. CommonMark 4.2 requires a space before a closing sequence, so
   * the pattern was wrong for hand-written files too: `# Sharp C#` lost its hash the same way.
   *
   * The title goes through `markdownTitleLine`, which is the line the export job writes.
   */
  const titleRoundTrip = (title: string): string | null =>
    planImport(
      readZip(
        writeZip([{ path: 'page/index.md', data: Buffer.from(`${markdownTitleLine(title)}\n`, 'utf8') }]),
      ),
      'markdown',
    ).pages[0]?.title ?? null

  it('comes back under the name it went in with', () => {
    expect(titleRoundTrip('Roadmap #')).toBe('Roadmap #')
    expect(titleRoundTrip('Trailing hash ##')).toBe('Trailing hash ##')
    expect(titleRoundTrip('Sharp C#')).toBe('Sharp C#')
  })

  it('still reads a closing sequence as a closing sequence, which is what it is for', () => {
    const written = (line: string): string | null =>
      planImport(
        readZip(writeZip([{ path: 'page/index.md', data: Buffer.from(`${line}\n`, 'utf8') }])),
        'markdown',
      ).pages[0]?.title ?? null
    // The spelling half the world's Markdown uses, and it must keep meaning an empty closing run.
    expect(written('# Closed ###')).toBe('Closed')
    expect(written('#   Padded   ')).toBe('Padded')
  })

  it('keeps a hash inside a heading in the body too, not only in the title', () => {
    const doc = markdownRoundTrip({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Sharp C#' }] }],
    })
    expect(doc.content?.[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Sharp C#' }],
    })
  })
})

describe('a picture the import cannot attach', () => {
  /**
   * What is left where the picture was.
   *
   * The node itself is dropped by design — a background job cannot mint a file, so there is no
   * `fileId` for an `image` to carry — and the file's own report row says so. What was wrong was the
   * *shape* left behind: the wrapping paragraph survived with no children, so the page carried a
   * blank block, and the alt text — the one thing about the picture the archive can still carry, and
   * the thing written to be read when the image is missing — was thrown away.
   */
  const withPicture = (markdown: string): PageDoc =>
    planImport(
      readZip(
        writeZip([
          { path: 'page/index.md', data: Buffer.from(`# Page\n\n${markdown}\n`, 'utf8') },
          { path: 'page/media/diagram.png', data: Buffer.from('PNG') },
        ]),
      ),
      'markdown',
    ).pages[0]!.doc

  it('leaves its description in the page rather than an empty block', () => {
    expect(withPicture('![a diagram of the pipeline](media/diagram.png)').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a diagram of the pipeline' }] },
    ])
  })

  it('leaves nothing at all when the picture had no description to leave', () => {
    expect(withPicture('![](media/diagram.png)').content).toEqual([])
  })

  it('does not take the words around it with it', () => {
    expect(withPicture('Before ![](media/diagram.png) after').content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Before ' },
          { type: 'text', text: ' after' },
        ],
      },
    ])
  })
})
