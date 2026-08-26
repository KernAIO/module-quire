# @kernhq/module-quire

## 0.10.7

### Patch Changes

- 632238a: A disclosure the sidebar opened for you can be closed again.

  The effect that opens an open page's ancestors read `expanded` and wrote it, so it was its own
  trigger: collapsing an ancestor removed it from the set, the effect put it straight back, and the
  control was inert to click and to Enter alike. `expanded` is read through `untrack` now — what
  selects the effect is which page is open and what the tree holds; whether a disclosure is open is
  the result, and a result must not be an input.

  Latent until `navigation.params.page` started arriving (`@kernhq/ui` 0.12 and shell's
  `setRouteParams`). With `activePageId` permanently null the loop never ran, so the fix that told the
  sidebar where it was is what made this reachable — which is the ordinary shape of a regression:
  nothing here changed, something upstream stopped lying.

## 0.10.6

### Patch Changes

- 8def0df: Stop drawing a nameless avatar on a page whose author cannot be resolved, and give the demo's pages
  an author so the byline's named wording is the one it renders.

## 0.10.5

### Patch Changes

- 4b45917: Seed the mock with versions, comments and a page carrying an unpublished draft.

  Version history and the comment margin are two of the three things a page screen is for, and the
  demo interface had neither: the history sheet answered "The history could not be loaded" and no
  margin was ever drawn. That is the environment used for demos _and_ for the shell's end-to-end
  tests, so nineteen of them were failing against the published module for want of data rather than
  for want of behaviour.

  Two pages differ on purpose, so a page with a margin and a page without one are both reachable, and
  one page carries `hasUnpublishedChanges` so the banner above the body can be seen at all. The author
  ids are written out rather than derived — this package cannot see the shell's mock, and a comment
  with nobody's id on it silently loses the delete control that only its author is offered.

## 0.10.4

### Patch Changes

- 6eb986d: Three things the interface was not saying.

  **The main writing surface had no name.** `CollaborativeEditor` carries `role="textbox"`, and a
  textbox with no accessible name is announced as nothing at all — the wiki's editor read as "edit
  text, multi-line". It takes the page's title now (`@kernhq/ui` 0.12 added the prop).

  **The byline never said who.** It drew `<Avatar id={doc.updatedBy} />` with no name — a "?" square
  with an empty accessible name — over the words "Edited 1h ago", so the one line whose job is to say
  who touched this page said everything except that.

  **A space with no home page was called empty.** `SpacePage` branched on `homepageId` alone, so
  opening a space that had never had one showed "This space has no pages — create the first page"
  while the sidebar beside it listed them. It opens the first top-level page instead, and the empty
  state is kept for the space that is actually empty.

## 0.10.3

### Patch Changes

- 1a694a6: Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

  `^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
  module from the registry would be told it needs a contracts two releases behind the one every
  service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
  only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
  first and compiling second compiles against the old copy and proves nothing.

  The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
  a range edit alone fails install before anything is built.

## 0.10.2

### Patch Changes

- fix(quire): make every screen operable by a screen reader

## 0.10.1

### Patch Changes

- 278e061: Close two holes in the static renderer, now that something calls it.

  `safeHref` rejected `//evil.example` and accepted `/\evil.example`, which is the same URL: for a
  special scheme the URL parser folds a backslash into a forward slash before the authority, so the
  second one resolves to `https://evil.example` too. Backslashes are now folded before the check —
  up to the first `?` or `#`, which is exactly as far as a browser folds them — so the check reads the
  URL the browser will act on. A backslash in a query or a fragment is left alone.

  `renderNode` and `renderMarks` indexed an object literal with a type name out of the document, so a
  node called `__proto__` (or `constructor`, or `toString`) found something inherited and truthy that
  was not a renderer, and calling it threw `TypeError: render is not a function` — a 500 out of
  `versions.get`, where the rule is that an unrecognised node degrades to its children. Both lookups
  now require an own property.

  Neither was reachable until the version preview gave `renderPageDoc` its first caller.

  The authz sweep also gained a second pass. The first denies at space scope, which a space check and
  a page check both catch, so it proved each procedure's permission key and nothing about its `check`
  column — downgrading the page check to a space check left it green. The new pass denies at object
  scope on the pages themselves, which only a page-level check can see, and covers all 34 procedures
  declaring `check: 'page'`.

- 253f36a: Reach the published framework, and refresh the lockfile that the range edit invalidated.

  `^0.9.0` cannot install `@kernhq/ui@0.10.0` — a caret on 0.x never crosses a minor — so a consumer
  installing this module from the registry resolved a framework it was not built against. Raising the
  range then leaves the committed `pnpm-lock.yaml` out of date with the manifest, and
  `--frozen-lockfile` compares specifiers, so the next publish dies at install having built nothing.
  Both halves are here because one without the other is not a fix.

  `scripts/check-ranges.mjs` now checks the lockfile as well, so the second half cannot be forgotten
  again — and checks this package's hosts against its peers, which `pnpm install` does not: pnpm 10
  resolved a `^0.6.1` peer against `contracts@0.5.2` and exited 0 without a warning.

## 0.10.0

### Minor Changes

- 41208ea: Show what an old version of a page actually said.

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

### Patch Changes

- 06a6b54: Check the page-scoped permission on every `databases.*` and `comments.*` procedure.

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

- c6c4feb: Make every migration survive being applied twice.

  `create policy`, `create table` and `create index` have no `if not exists`, so a replay throws —
  and a module migration that throws takes down the **whole host service**, not just its own module.
  `core` hosts five. A replay is not hypothetical: drizzle keys applied migrations by content hash, so
  regenerating the journal makes every file run again against a schema that already has its objects.

  0001 created its two policies unguarded and 0000 created its tables and indexes unguarded. Both are
  guarded now, and `src/server/migrations.test.ts` applies the whole set twice and asserts one policy
  per table — the existing idempotence assertion could not catch this, because it calls
  `migrateModule` twice and the second call reads `__migrations`, sees the work is done and returns.

## 0.9.3

### Patch Changes

- fix(quire): say why a rollup cannot pick a column yet

## 0.9.2

### Patch Changes

- 26417b7: Stop using `t('common.*')` in this module's screens.

  `@kernhq/ui` declares `sideEffects: ["**/*.css"]`, so a bundler drops
  `common-messages.js` — whose only job is a top-level `registerMessages` call — out of every
  production build. `t('common.cancel')` therefore renders the literal key in a built app and the
  right word in dev, which is why it survived: the confirmation dialog that deletes a view shipped
  with buttons reading `common.cancel` and `common.delete`.

  Quire now carries its own eight shared words. Collapse them back into `common.*` once the framework
  marks that module as having side effects.

## 0.9.1

### Patch Changes

- test(quire): anchor the database views for the end-to-end sweep

## 0.9.0

### Minor Changes

- ea7b381: Give the database engine an interface, and fix six things it could not have been built on.

  **The interface.** A `database` page now renders view tabs, a toolbar and the view itself instead of
  the editor. Table with inline editing per property type, column resize and reorder, row hover
  actions and a row inspector panel; board grouped by a select, status or tick column with drag
  between lanes and a keyboard equivalent on every card; gallery, list and calendar. A property editor
  (add, rename, retype, configure, hide, delete) and a view editor (filters, sorts, grouping, date
  column, visible columns, card size). Every string in all five locales, RTL-safe and dark-mode-safe.

  **New procedures.** `databases.forPage` — a page carries no field pointing at the database it _is_,
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

## 0.8.0

### Minor Changes

- 739b736: Render a page outside the browser.

  `renderPageDoc()` turns a page's ProseMirror JSON into sanitised HTML with no DOM, and
  `textFromPageDoc()` flattens the same document to plain text. `pageDocFromState()` is what gives
  them their input: it decodes the Yjs bytes a version already stores, so the server can finally read
  a document it previously could only pass around.

  Every node and mark the wiki editor can produce has a case, and `render.test.ts` asserts that by
  comparing the dispatch tables against `PAGE_DOC_NODES` and `PAGE_DOC_MARKS` from `@kernhq/ui` —
  in both directions, so a block with no renderer fails and so does a renderer for a block that no
  longer exists. Text is escaped, link protocols are limited to http/https/mailto, and a
  protocol-relative `//host` href is rejected rather than treated as local.

  This also fixes the search body. `collab` flattens a document by calling `toString()` on each
  `Y.XmlText`, which renders marks as markup — so a page holding one link indexed
  `rel="noopener noreferrer nofollow"` along with its prose, and every page in the workspace matched
  a search for "noopener". Page rows and version previews now use the real flatten, and fall back to
  what collab published if the document cannot be read.

  A page is written in the wide wiki schema (`page` on `CollaborativeEditor`); comments keep the
  narrow one.

## 0.7.4

### Patch Changes

- fix: declare @kernhq/kernel and @kernhq/contracts as peerDependencies

## 0.7.3

### Patch Changes

- Merge remote-tracking branch 'origin/main'

## 0.7.2

### Patch Changes

- chore: refresh the lockfile for the changesets dependency

## 0.7.1

### Patch Changes

- fix(deps): reach the framework that was just published

## 0.7.0

### Minor Changes

- ea2002d: Quire ships its own screens.

  All three pages, seven components, 75 strings in five locales, the mock and the API instance move
  into this package. The routes are declarations now — `/quire`, `/quire/:space`, `/quire/:space/:page`
  — matched by the shell, which hands the component its `params`. A wiki page's URL is this module's
  business rather than something the app mirrors in its route tree.

  **Two `QUIRE_PERMISSIONS` existed and they disagreed.** This package declared six keys; the app
  declared eight, adding `page.comment` and `page.publish`. Any screen gating through the package's
  copy was reading a key that did not exist there — and a wrong permission string is a perfectly valid
  string, so nothing reported it. There is one now, derived from the contract, and `key()` throws at
  import if a name is not declared.

  Components read the shell's `navigation` singleton instead of `$app/navigation` and `$app/state`,
  and the collaborative editor takes its endpoint from the host instead of naming port 4300.

## 0.6.1

### Patch Changes

- 099995e: Stop the formula AST's `if` node being thenable.

  An object with a `then` property is a thenable: `await` and `Promise.resolve()` call it as a
  promise. The node's `then` was an AST node rather than a function, so the moment one was returned
  from an `async` function the runtime would stop treating it as data — silently, with no error at the
  point of the mistake. Renamed to `consequent`/`alternate`, which is the standard naming anyway.

## 0.6.0

### Minor Changes

- 56a8216: Databases: rows, typed columns, views, relations and rollups.

  A row **is** a page — created in the same space, parented to the database's own page — so it is
  openable, commentable, versioned and searchable without any of that being built twice. Cells live in
  `props`, keyed by a stable `key` rather than by name, so renaming a column keeps its data.

  Filtering and sorting happen in SQL over `jsonb`, not in memory: a page of fifty rows filtered down
  to three is not a page of three, and the caller has no way to ask for the rest. Sorts are typed, so
  10 does not come before 9. An untouched checkbox filters as `false`, because most rows are ones
  nobody has touched. A filter naming a property that does not exist is refused rather than
  interpolated — the key arrives in the request and `props->>'…'` is query text, not a parameter.

  Formulas and rollups are computed on write into `computed`, so a view can sort and filter by one
  like any other column. A broken formula shows an error in its own cell rather than failing the write
  that triggered it.

  Three bugs the tests caught, each of which would have read as "the data is wrong" rather than as a
  bug: the database's own page appeared as the first row of itself, a rollup looked for its target
  column in the database holding the rollup rather than the one across the relation, and every
  camelCase formula function was unreachable.

## 0.5.0

### Minor Changes

- f9849bb: The database foundations: schema, property types and the formula language.

  A database is not a second kind of object beside a page — it _is_ a page whose body renders a view,
  and each of its rows is a page too. That is what makes a row openable, commentable, versioned and
  searchable without building any of it again.

  The formula language is a hand-written Pratt parser to a typed AST, evaluated by walking it.
  **Never `eval`, never `new Function`**: a formula is text a workspace member types and the server
  evaluates, and handing that to the JavaScript engine is arbitrary code execution with the database
  connection already open. The first tests assert what it refuses.

  `&&` and `||` short-circuit, so `false && prop("x")` never reads `x`. Dividing by nothing gives a
  blank cell rather than `Infinity`. Function names are matched case-insensitively — keying the table
  by the lowercased name instead would have made every camelCase function silently unreachable, which
  it did until a test caught it.

## 0.4.1

### Patch Changes

- 3f6b975: Export the comment types from the client, so a margin panel can be typed without reaching into
  `./contract`.

## 0.4.0

### Minor Changes

- 6980c0e: Comments, mentions and search.

  Comments are anchored with **Yjs relative positions**, not character offsets. An offset names a
  place that only exists while nobody else is typing — two words inserted above and the remark is
  attached to something it was never about. `quotedText` is kept alongside so a thread whose text has
  since been deleted still reads as being about something.

  Replying to a reply joins the thread rather than nesting deeper, and resolving settles the
  conversation rather than one remark in it. A thread whose opening comment is deleted keeps its
  replies: they are still somebody's words.

  Mentions notify everyone named except the author, through a best-effort `NotifyService` — a comment
  must not fail to post because core is briefly unavailable.

  Pages are indexed for workspace search, and `resolvers` render a page or space wherever another
  module links to one. **Only pages in an `open` space are indexed**, deliberately:
  `SearchDocument.acl` matches against `[userId, …groupIds, 'role:<role>']`, so indexing a restricted
  space correctly means knowing which subjects may read a page — and core can answer "may this person
  read this object" but cannot enumerate who can. Guessing yields either a private page in a
  stranger's results or a page its author cannot find. The restricted case waits for a core procedure
  that can answer it.

## 0.3.1

### Patch Changes

- 59f0ab4: Export `PageVersion` and `VersionKind` from the client, so a version list can be typed without
  reaching into `./contract`.

## 0.3.0

### Minor Changes

- e76476c: Drafts, publishing and version history.

  `page_versions` is the backbone of both halves of the draft model rather than a feature beside it: a
  **page** serves `published_version_id` to a reader, and a **live doc** serves the document itself —
  one mechanism, two behaviours.

  - `versions.list` / `get` / `create` — history, with the version a reader is being served marked.
  - `versions.restore` — puts an older version back. The state it replaces is captured _first_, so
    restoring is never itself the thing that loses work.
  - `publishing.publish` / `revert` — decide what readers see, or throw the draft away and go back.
    Reverting also keeps what it discarded.

  Restoring and reverting go through `collab.document.replace`, not `apply`: applying an update merges
  it, so an older state would produce the union of old and new and bring every deleted paragraph back
  alongside the ones that replaced it.

  Subscribing to `collab.document.updated` mirrors the flattened prose onto the row, marks a page
  whose draft has moved on from what readers see, and takes an automatic version when the last one is
  old enough — so history accumulates while somebody writes rather than only when they remember to
  press something.

  New permission `quire.page.publish`: deciding what readers and any public site are served is a
  different question from being allowed to write a draft.

## 0.2.1

### Patch Changes

- 7d9765e: Export `pageDocumentName(page)` from the client.

  The name a page's prose is synchronised under is the module's to decide, and the collab gateway
  parses it with the matching function in `@kernhq/contracts`. Leaving the caller to assemble the
  string means a name the gateway cannot parse, which is a rejected WebSocket with no useful error.

## 0.2.0

### Minor Changes

- c4adc88: Quire: spaces and the page tree.

  The first half of the module the collab service has been waiting for. Spaces with a key, an icon and
  a visibility; pages nested to any depth, ordered by a fractional index so two people reordering at
  once never renumber the same rows; move with a cycle guard; archive; a trash that takes the whole
  subtree and brings it all back; and a purge that also tells the collab service to forget the
  document, which nothing else does.

  Permissions are declared at **space** scope, so a binding on a page beats one on its space, which
  beats one on the workspace — which is what makes "everyone may read the Handbook, the design team
  may write it, and this contractor may read one page of it" expressible.

  `quire.collab.access` is implemented against the shapes in `@kernhq/contracts`, so the collab
  gateway's question and this module's answer are the same shape by construction.
