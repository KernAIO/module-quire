# @kernhq/module-quire

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
