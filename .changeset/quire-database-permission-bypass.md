---
'@kernhq/module-quire': patch
---

Check the page-scoped permission on every `databases.*` and `comments.*` procedure.

Eight `databases.*` procedures — `get`, `addProperty`, `updateProperty`, `moveProperty`,
`removeProperty`, `addView`, `updateView`, `removeView` — and three `comments.*` ones — `update`,
`remove`, `resolve` — asked only the workspace-level question that `requires()` asks. Quire's
permissions are declared at **space** scope, so the answer that matters comes from a space- or
page-scoped binding, and `requires()` never looks at one: an ordinary member carrying a space-scoped
DENY for `quire.page.view|edit` could still read a database's schema and add, rename, reorder and
delete its columns and views, and settle any thread in the space.

Each of them now resolves the page it is really acting on — a database's host page, a row's own
page, a comment's page — and asks `requirePage` with the permission the work needs. Nothing about
what a permitted caller can do changes.

`quireProcedureAuthz` in the contract declares, per procedure, what that in-handler check must be,
because counting middlewares is what let this through: `requires()` was present on all eleven.
`module.test.ts` holds that map to the contract in both directions, and `authz.int.test.ts` calls
every procedure against a real Postgres with one permission denied at space scope and asserts each
refuses — so a procedure added later without a check fails the day it is declared.
