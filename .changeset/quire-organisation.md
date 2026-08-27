---
'@kernhq/module-quire': minor
---

Give a wiki the things that make one findable: favourites, recents, labels, watchers and a trash
you can look in.

**The trash screen.** "Move to trash" took a page and every page under it, with no confirmation and
nowhere to look afterwards — deleting "Working here" silently took "Your first week" and "Time off"
with it, and the only trace was that they had stopped being in the sidebar. `pages.trash` had always
listed what was taken; nothing drew it. The screen groups the flat listing back into subtrees,
because restore and purge both act on a subtree and offering to restore three rows separately is the
same confusion pointed the other way. The confirmation before it counts what is about to go, and the
toast after it offers the way back.

**Favourites and recents** are one person's own list, which is a `user_id` in each query rather than
a permission — RLS fences the workspace, and the workspace is the tenant boundary, not a privacy
one. Favourites are ordered by a fractional rank so they can be moved without renumbering the list,
and the column is `COLLATE "C"` for the reason `0006` gave: a base-62 rank sorted by language puts
the second entry in front of the first.

**Labels** belong to a space, not to a page — renaming "Draft" changes what it means everywhere it
is worn, so writing one is `space.manage` while reading is `space.view`. `pages.setLabels` replaces
the set rather than adding to it, because a picker with one label ticked means the other two are
gone, and an additive procedure cannot say that without a second one to disagree with.

**Watchers** answer "am I watching" and "who else is" in one call, because the control draws both
and asking twice within a keystroke is two requests for one button.

Twelve new procedures, five new tables in `0007` — each with `workspace_id`, forced RLS and a policy
— and every string in all five locales.

**What review found, and this ships fixed.**

- The trash confirmation stated a **stale** page count while its query was in flight, and the danger
  button was live the whole time: trash a page, press Undo, reopen the dialog and it offered the
  singular sentence for a three-page subtree. `refreshAfterMoving` poisons that cache itself, by
  refetching the tree while the subtree is still in the trash. The count now refuses to read a
  fetch in flight, and the confirm is `aria-busy` and guarded until it has one — never `disabled`,
  which would throw the focus of whoever is standing on it.
- `pages.trash` named every trashed page to anybody who could reach the screen. The procedure is
  space-scoped, so a page-scoped DENY — the narrow case the permission model exists for — still had
  its title read out. The row was inert as well as private: `pages.get`, `pages.restore` and
  `pages.purge` all refuse it. The listing filters per page now, the same rule `favorites.list`
  follows, and `authz.int.test.ts` holds it there.
- The trash row's "deleted" tooltip hung a raw `2026-08-25T19:45:47.634Z` off a cell that had just
  said پریروز — through `formatDateTime` now, the same defect the date column had one layer up.
- The label-filter banner used a physical `padding: 6px 6px 6px 10px`, so in Persian and Arabic the
  room meant for the sentence went to the button beside it.
- At 390px the trash table's page column collapsed to nothing: `minmax(0, …)` shrinks to zero rather
  than overflowing, so the row drew an icon and "with 1 page inside it" and no title, and the scroll
  box had nothing to scroll. The two text columns have a floor now.
- `TENANT_TABLES` was read by nothing, and the migration suite could not see a tenant table with no
  policy at all — a `group by` over `pg_policies` simply omits it. Both directions are checked now,
  along with the journal's timestamps, which drizzle silently skips a migration for when they go
  backwards.
