---
'@kernhq/module-quire': patch
---

A public URL resolves the workspace slug it is actually written with.

The share dialog copies `/p/<workspace-slug>/<publication-slug>/` — a uuid in a link somebody sends
a colleague is a receipt, not an address — but every `public.*` procedure took a `z.uuid()` and the
anonymous middleware rejected anything else before a handler ran. So the module answered **404 for
its own published URLs**, while the identical site served perfectly under the workspace id. Measured
signed-out against a live stack: id 200, slug 404.

The segment is resolved at the anonymous entry point, and resolving it here rather than in `core` is
what stops it becoming an oracle: core could only answer "is there a workspace called this", which
is a fact about private workspaces too. Here a slug naming a workspace with no such publication
reaches exactly the same `NOT_FOUND` as a slug nobody has taken — verified for both.
