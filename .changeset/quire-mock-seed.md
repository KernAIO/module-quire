---
'@kernhq/module-quire': patch
---

Seed the mock with versions, comments and a page carrying an unpublished draft.

Version history and the comment margin are two of the three things a page screen is for, and the
demo interface had neither: the history sheet answered "The history could not be loaded" and no
margin was ever drawn. That is the environment used for demos *and* for the shell's end-to-end
tests, so nineteen of them were failing against the published module for want of data rather than
for want of behaviour.

Two pages differ on purpose, so a page with a margin and a page without one are both reachable, and
one page carries `hasUnpublishedChanges` so the banner above the body can be seen at all. The author
ids are written out rather than derived — this package cannot see the shell's mock, and a comment
with nobody's id on it silently loses the delete control that only its author is offered.
