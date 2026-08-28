---
'@kernhq/module-quire': minor
---

Diagrams and embeds, and the fetch that fills them.

A `diagram` block holds Mermaid, Excalidraw or Draw.io **source**, so the page carries it into an
export, a published site and a print. Mermaid renders server-side; the other two draw their stored
image and fall back to a link, and a source that will not parse shows the source and the error
rather than a blank block.

An `embed` is an unfurl: the server fetching a URL somebody typed, which is the whole reason its
defences come before its features. Hosts are checked **after** DNS resolution rather than before,
private, loopback, link-local and unique-local space is refused in v4 and v6, redirects are followed
by hand and re-checked at every hop, and the body and the clock are both capped. Kern's own objects
are resolved through `objectTypes`/`resolvers` instead of being fetched at all.

The Markdown exporter learned all three in the same change. It had cases for neither, and
`export.int.test.ts` fails when a node the schema can hold has no writer — so a diagram would have
been dropped silently from every exported file. A diagram writes as a fenced ` ```mermaid ` block,
which our own importer reads back; an embed and an object write as links, and an object is
deliberately not resolved, because resolving it would put today's data into yesterday's file with
the exporter's permissions rather than the reader's.
