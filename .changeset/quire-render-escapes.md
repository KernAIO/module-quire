---
'@kernhq/module-quire': patch
---

Close two holes in the static renderer, now that something calls it.

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
