# @kernhq/module-quire

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
