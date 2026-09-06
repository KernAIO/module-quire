---
'@kernhq/module-quire': minor
---

Fill a workspace created with example content: three spaces (handbook, engineering, product) with a
nested page tree, real prose in every page, and a roadmap database with its own properties and rows.

A page's body is a CRDT the collab service holds, not a column here, so each one is encoded as a Y
update, handed to `collab.document.replace` and mirrored onto `pages.text` — the same three steps
`templates.ts` performs, so a seeded page is findable before anybody opens it.
