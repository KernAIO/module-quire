---
'@kernhq/module-quire': patch
---

Three things the interface was not saying.

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
