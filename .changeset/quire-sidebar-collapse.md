---
'@kernhq/module-quire': patch
---

A disclosure the sidebar opened for you can be closed again.

The effect that opens an open page's ancestors read `expanded` and wrote it, so it was its own
trigger: collapsing an ancestor removed it from the set, the effect put it straight back, and the
control was inert to click and to Enter alike. `expanded` is read through `untrack` now — what
selects the effect is which page is open and what the tree holds; whether a disclosure is open is
the result, and a result must not be an input.

Latent until `navigation.params.page` started arriving (`@kernhq/ui` 0.12 and shell's
`setRouteParams`). With `activePageId` permanently null the loop never ran, so the fix that told the
sidebar where it was is what made this reachable — which is the ordinary shape of a regression:
nothing here changed, something upstream stopped lying.
