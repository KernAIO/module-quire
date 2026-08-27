---
'@kernhq/module-quire': patch
---

A page title saves as you type, not only when you leave the field.

It saved on `blur` and nothing else, so typing a name and then going somewhere without blurring
first — a keyboard shortcut, ⌘K, closing the tab, any programmatic navigation — threw the name away
and left the page called "Untitled" for ever. Measured against a live stack: fifteen seconds after
typing, `mod_quire.pages.title` was still `''`, and became the typed value only on blur. Every page
in the test workspace was called "Untitled" for this reason.

The body never had the problem, because it is a Y.Doc the collab service persists on its own
schedule; the title is a plain column behind `pages.update`, so the schedule had to be written.
`docs/adr/0006` says the title belongs in the Y.Doc beside the body — for this reason and because
two people renaming at once still clobber each other — and this is not a substitute for that.
