import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

/**
 * Yjs bytes to the JSON the renderer reads.
 *
 * The server has never had a page's prose in a shape it could do anything with. `page_versions`
 * stores `Y.encodeStateAsUpdate` — a CRDT update, not a document — and the only thing that knew how
 * to turn that into blocks was the editor, in a browser. This is the bridge, and it is what makes
 * publishing, exporting and honest search snippets possible at all.
 *
 * It needs no ProseMirror schema, which is the part worth knowing: the Yjs tree already carries the
 * node names and attributes, so a service that has never loaded Tiptap can read a document written
 * by one that has.
 */

/**
 * The shared field the editor writes into.
 *
 * Not a guess: `collab.ts` in @kernhq/ui configures `Collaboration` with no `field`, and its default
 * is `default`. Change one and this stops returning anything — silently, as an empty document.
 */
const FIELD = 'default'

/**
 * Decode a stored state into a page document.
 *
 * Returns null rather than throwing when the bytes will not decode. Every caller is doing something
 * *alongside* its real job — taking a version, mirroring search text — and none of them should fail
 * because a document is unreadable. A version that records no HTML is a small loss; a version that
 * was never taken is somebody's afternoon.
 */
export function pageDocFromState(state: Uint8Array | Buffer | null | undefined): PageDoc | null {
  if (!state || state.length === 0) return null
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state instanceof Uint8Array ? state : new Uint8Array(state))
    const json = yDocToProsemirrorJSON(doc, FIELD) as PageDoc
    // An untouched document decodes to a doc with no content, which is not worth storing as one.
    return Array.isArray(json?.content) && json.content.length > 0 ? json : null
  } catch {
    return null
  } finally {
    doc.destroy()
  }
}

/** The same thing from what `collab.document.snapshot` and `.state` return, which is base64. */
export function pageDocFromBase64(state: string | null | undefined): PageDoc | null {
  if (!state) return null
  try {
    return pageDocFromState(Buffer.from(state, 'base64'))
  } catch {
    return null
  }
}
