---
'@kernhq/module-quire': minor
---

Templates, and the eight reading macros.

**Templates.** A page or a whole space can be saved as one and made again from it, with variables
filled at creation. Five starters ship with the module — meeting notes, decision record,
requirements, retrospective, how-to — written as documents somebody would actually use. "New page"
opens the picker with **Blank page** already focused, so a blank page is still one keystroke away.

Variables are substituted by walking the document and replacing in text nodes. Never by
string-replacing the JSON: a value containing a quote would corrupt the page, and that is asserted
with a value carrying `"`, `{{`, a newline and an emoji.

**Macros.** `children`, `excerpt`, `excerpt-include`, `include-page`, `recently-updated`,
`contributors`, `status lozenge` and `expand`, each a node in the page schema *and* a case in
`renderPageDoc` — a node the renderer cannot draw is a page that exports, publishes and prints
blank, and `render.test.ts` holds both halves together.

Four of the eight read other pages, so they resolve at render time against whoever is reading. On a
published site there is no reader, so `publications` is given the macro service and resolves them
against the publication instead — a page outside it, or one with no published version, is not drawn
rather than drawn as a title.

Diagrams and embeds are **not** in this change.
