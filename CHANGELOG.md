# @kernhq/module-quire

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
