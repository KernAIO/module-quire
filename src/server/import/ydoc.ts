/**
 * A page document as Yjs bytes — the exact inverse of `../document.ts`.
 *
 * `document.ts` reads a stored page *out* of Yjs without a ProseMirror schema, because the Yjs tree
 * already carries the node names and attributes. Writing has the same property and it is what makes
 * an import possible at all: `prosemirrorJSONToYDoc` in `@tiptap/y-tiptap` needs a schema, the schema
 * is `@kernhq/ui`'s `page-schema.ts`, and that is a dozen Tiptap extensions of browser code this
 * server has deliberately never loaded. (It is the same wall the Word export ran into — see
 * `services/export.ts`. The difference is that the Yjs shape is small and fully determined, and a
 * `.docx` is not.)
 *
 * **The shape is not guessed; it is the one y-prosemirror writes and the one the reader expects.**
 *
 *   - a block node is a `Y.XmlElement` whose `nodeName` is the ProseMirror type;
 *   - its attributes are set as-is — **not stringified**. `Y.XmlElement.setAttribute` is *typed* as
 *     taking a string and stores whatever it is handed, and y-prosemirror hands it the node's real
 *     attributes, so `heading.level` is the number 2 and `taskItem.checked` is the boolean `true`. A
 *     document written with `'true'` looks right and renders as unchecked in both the HTML renderer
 *     and the Markdown writer;
 *   - a run of adjacent text nodes is **one** `Y.XmlText` carrying a delta, not one per node, which
 *     is what `createTypeFromTextNodes` does. Marks are the delta's attributes, keyed by mark name
 *     with the mark's own attributes as the value — `{ bold: {} }`, `{ link: { href } }`.
 *
 * The round trip is the test: anything this writes, `pageDocFromState` has to read back as the same
 * document, and `import.int.test.ts` asserts exactly that rather than asserting the byte layout.
 */
import type { PageDoc, PageDocNode } from '@kernhq/ui/editor/page-doc'
import * as Y from 'yjs'

/** Marks as a delta's attributes: `[{ type: 'bold' }, { type: 'link', attrs }]` → `{ bold: {}, link: attrs }`. */
function attributesOf(node: PageDocNode): Record<string, unknown> | undefined {
  const marks = node.marks ?? []
  if (marks.length === 0) return undefined
  const attributes: Record<string, unknown> = {}
  for (const mark of marks) {
    if (!mark || typeof mark.type !== 'string') continue
    attributes[mark.type] = mark.attrs ?? {}
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined
}

const isTextNode = (node: PageDocNode): boolean => typeof node.text === 'string'

/**
 * Children as Yjs types, with contiguous text folded into single `Y.XmlText` runs.
 *
 * The folding is not an optimisation. Two adjacent `Y.XmlText` siblings are what y-prosemirror's own
 * reader goes out of its way to merge (its issue #160, character duplication), and a document that
 * arrives with them is a document no editor would have produced — which is the definition of a
 * fixture that proves nothing.
 */
function childrenOf(nodes: PageDocNode[] | null | undefined): Array<Y.XmlElement | Y.XmlText> {
  const out: Array<Y.XmlElement | Y.XmlText> = []
  let run: PageDocNode[] = []

  const flush = () => {
    if (run.length === 0) return
    const text = new Y.XmlText()
    text.applyDelta(run.map((node) => ({ insert: node.text ?? '', attributes: attributesOf(node) })))
    out.push(text)
    run = []
  }

  for (const node of nodes ?? []) {
    if (!node || typeof node !== 'object') continue
    if (isTextNode(node)) {
      // An empty string contributes nothing to a delta and would leave an empty run behind.
      if ((node.text ?? '').length > 0) run.push(node)
      continue
    }
    flush()
    out.push(elementOf(node))
  }
  flush()
  return out
}

function elementOf(node: PageDocNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type ?? 'paragraph')
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    // A null attribute is how ProseMirror spells "not set"; y-prosemirror skips those, and setting
    // one would put `null` where the renderer expects an absent attribute.
    if (value === null || value === undefined || key === 'ychange') continue
    element.setAttribute(key, value as string)
  }
  const children = childrenOf(node.content)
  if (children.length > 0) element.insert(0, children as never[])
  return element
}

/**
 * The shared field the editor writes into.
 *
 * The same constant as `document.ts`, and for the same reason: `collab.ts` in `@kernhq/ui` configures
 * `Collaboration` with no `field`, whose default is `default`. Writing into any other name produces
 * bytes that decode to an empty document, silently — a whole import of blank pages.
 */
const FIELD = 'default'

/**
 * A page document as the update bytes `page_versions.state` holds and `collab.document.replace` takes.
 *
 * A document with no content still produces a valid, empty update rather than throwing: an imported
 * file that turned out to hold nothing but its own title is an empty page, which is what it was.
 */
export function pageDocToYState(doc: PageDoc | null | undefined): Buffer {
  const ydoc = new Y.Doc()
  try {
    const fragment = ydoc.getXmlFragment(FIELD)
    const children = childrenOf(doc?.content)
    if (children.length > 0) fragment.insert(0, children as never[])
    return Buffer.from(Y.encodeStateAsUpdate(ydoc))
  } finally {
    ydoc.destroy()
  }
}
