---
'@kernhq/module-quire': patch
---

The page title draws no focus ring.

It is the page's heading, not a form field — the caret says where you are. `outline: none` was not
enough on its own, because the design system's global `:focus-visible` rule draws a `box-shadow`,
which is a different property: clicking into the title put a box around it.
