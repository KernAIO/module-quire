---
'@kernhq/module-quire': minor
---

Show what an old version of a page actually said.

`renderPageDoc` — the only thing outside a browser that can draw a Kern page — was reachable from
nowhere. It was not re-exported from `src/server/index.ts`, so `@kernhq/module-quire/server` did not
carry it, and the whole repository mentioned it only in its own definition and its own test.
Meanwhile version history showed 160 characters of flattened text, which tells you a version exists
and nothing about the heading, the table or the paragraph you are looking for — although the bytes
to draw it have been in `page_versions.state` since the first migration.

`versions.get` now returns `html` beside `text`: the version as it looked, with its pictures signed
and its page mentions linked, escaped by the same renderer the tests exercise. Version history has a
**Preview** on each row that draws it. `renderPageDoc`, `textFromPageDoc`, `referencesIn`,
`safeHref`, `escapeHtml` and `pageDocFromState` are exported from the `./server` subpath, so
anything else that has to publish, export or mail a page can reach them too.
