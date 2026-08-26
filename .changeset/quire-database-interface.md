---
'@kernhq/module-quire': minor
---

Give the database engine an interface, and fix six things it could not have been built on.

**The interface.** A `database` page now renders view tabs, a toolbar and the view itself instead of
the editor. Table with inline editing per property type, column resize and reorder, row hover
actions and a row inspector panel; board grouped by a select, status or tick column with drag
between lanes and a keyboard equivalent on every card; gallery, list and calendar. A property editor
(add, rename, retype, configure, hide, delete) and a view editor (filters, sorts, grouping, date
column, visible columns, card size). Every string in all five locales, RTL-safe and dark-mode-safe.

**New procedures.** `databases.forPage` — a page carries no field pointing at the database it *is*,
because `pages.database_id` already means "row of". `databases.list` — a relation column has to name
another database, and nothing listed them. `databases.lookup` — a relation cell holds page ids, so
without it the column draws uuids. `databases.moveProperty` — the service accepted a position and
the contract never exposed one, so a column could not be reordered through the published API.

**Fixes.**

- Filters and sorts on `formula`, `rollup`, `created_time`, `created_by`, `edited_time` and
  `edited_by` read `props`, where none of those values is ever written. Sorting by a formula
  silently did nothing. There is now one `valueExpr` that knows where each type lives, and its casts
  are guarded — a number column holding pasted text no longer 500s the whole view.
- `setRelation` wrote only the join table while `Row` exposes only `props`, so a relation column was
  permanently blank and a relation filter never matched. The ids are mirrored into `props` on both
  sides, and `updateRow` routes relation keys through `setRelation` so the two cannot diverge.
- `rows()` filtered its cursor with `pages.id > cursor` while ordering by the view's sorts, which is
  only a valid keyset when id is the whole ordering — every sorted view dropped and repeated rows.
  It pages by offset now.
- `removeView` refused to delete a **default** view rather than the **last** one, so the first tab of
  every database could never be deleted. It refuses the last one and promotes a new default.
- `toView` cast `config` instead of parsing it, so `view.config.filterMode` was `undefined` at
  runtime while its type promised a value.
- `properties.position` and `views.position` were not `COLLATE "C"`, so the fractional ranks sorted
  by language rather than by code point — a database's second view sorted in front of its first, and
  moving a column put it somewhere nobody asked for. Migration `0006` fixes both; it is additive and
  an older image reads the same rows.

Rows are also excluded from `pages.tree`: a row is a page parented to its database's page, so a
database of five hundred rows put five hundred entries in the sidebar. And the seven schema
mutations that announced nothing now announce `database`, so adding a column reaches a second tab.

`formula.ts` moved from `src/server` to `src/client` — unchanged, and still imported by the server —
so the property editor can validate an expression as it is typed. The client only parses; the server
is still the only thing that evaluates one.
