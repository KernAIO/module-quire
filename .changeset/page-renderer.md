---
'@kernhq/module-quire': minor
---

Render a page outside the browser.

`renderPageDoc()` turns a page's ProseMirror JSON into sanitised HTML with no DOM, and
`textFromPageDoc()` flattens the same document to plain text. `pageDocFromState()` is what gives
them their input: it decodes the Yjs bytes a version already stores, so the server can finally read
a document it previously could only pass around.

Every node and mark the wiki editor can produce has a case, and `render.test.ts` asserts that by
comparing the dispatch tables against `PAGE_DOC_NODES` and `PAGE_DOC_MARKS` from `@kernhq/ui` —
in both directions, so a block with no renderer fails and so does a renderer for a block that no
longer exists. Text is escaped, link protocols are limited to http/https/mailto, and a
protocol-relative `//host` href is rejected rather than treated as local.

This also fixes the search body. `collab` flattens a document by calling `toString()` on each
`Y.XmlText`, which renders marks as markup — so a page holding one link indexed
`rel="noopener noreferrer nofollow"` along with its prose, and every page in the workspace matched
a search for "noopener". Page rows and version previews now use the real flatten, and fall back to
what collab published if the document cannot be read.

A page is written in the wide wiki schema (`page` on `CollaborativeEditor`); comments keep the
narrow one.
