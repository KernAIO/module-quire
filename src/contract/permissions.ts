import { definePermissions } from '@kernhq/contracts'

/**
 * `<module>.<resource>.<action>`, each at the narrowest scope that works.
 *
 * Almost everything here is bound at **space** scope rather than workspace scope. That scope kind has
 * existed in the permission model since before there was anything to use it, and this is what it was
 * for: "everyone may read the Handbook, the design team may write it, and the contractor may read one
 * page of it". Bindings resolve nearest-first, so a binding on a page beats one on its space, which
 * beats one on the workspace — and a deny beats an allow at the same level.
 */
export const quirePermissions = definePermissions([
  {
    key: 'quire.space.view',
    label: 'See a space',
    description: 'Find the space and read its name, whatever its pages allow',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'quire.space.manage',
    label: 'Create and configure spaces',
    description: 'Rename, set the home page, change who may read it, archive it',
    scope: 'space',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'quire.page.view',
    label: 'Read pages',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'quire.page.create',
    label: 'Create pages',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'quire.page.edit',
    label: 'Edit pages',
    description: 'Write in a page, rename it, and move it in the tree',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'quire.page.comment',
    label: 'Comment on pages',
    description: 'Leave a remark in the margin without being able to change the page',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'quire.page.publish',
    label: 'Publish pages',
    description: 'Decide which version readers and any public site are served',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  /**
   * Taking pages out of Kern as a file.
   *
   * A separate key from `quire.page.view` rather than a consequence of it, and the distinction is
   * one administrators actually make: reading a handbook a page at a time and walking out with the
   * whole thing in a zip are different acts, and the second is the one a leaver does on their last
   * afternoon. Every page in an export is still checked against `quire.page.view` as it is written,
   * so this grants nothing extra — it decides whether the bulk shape is available at all.
   *
   * Not `dangerous`, because it destroys nothing and every page in the result is one the exporter
   * could already open. The import side is the dangerous half: that one writes.
   *
   * A guest is deliberately not in the default set. A guest is somebody invited to read one thing,
   * and the difference between reading it and keeping a copy of the section around it is exactly
   * what a guest is a guest for.
   */
  {
    key: 'quire.page.export',
    label: 'Export pages',
    description: 'Take a page, a section or a space out as Markdown, HTML or PDF',
    scope: 'space',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  /**
   * Bringing pages in from somewhere else, in bulk.
   *
   * **`dangerous`, where the export half is not**, and the asymmetry is the whole reason this is a
   * separate key rather than `quire.page.create` applied a thousand times. An export reads pages the
   * exporter could already open; an import *writes* — hundreds of pages, a page tree, databases with
   * their columns — into a space, in one act, from a file nobody in the workspace has read. Undoing
   * it means finding every page it made and trashing them, which is not a button. The tracker marks
   * `tracker.import.run` the same way and for the same reason.
   *
   * Owner and admin only, and that is a deliberate step up from `quire.page.create`. Somebody who may
   * write in a space is not thereby somebody who may reshape it: an ordinary member creating pages
   * makes them one at a time, with the tree in front of them.
   *
   * It is not a substitute for the narrower keys. An import still writes only where the requester
   * holds this permission *on that space*, and the job re-asks when it runs rather than trusting the
   * answer from when it was queued — a permission taken away between the two is a job that fails.
   */
  {
    key: 'quire.page.import',
    label: 'Import pages',
    description: 'Bring a Notion, Confluence or Markdown export into a space as pages',
    scope: 'space',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },
  {
    key: 'quire.page.delete',
    label: 'Delete pages permanently',
    description: 'Empty the trash. A purged page and its history cannot be recovered.',
    scope: 'space',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },
])

/**
 * What each procedure has to ask *inside its handler*, beyond the workspace-level `requires()`.
 *
 * Declared as data rather than inferred, for the same reason `quireCapabilityProcedures` is: a
 * missing in-handler check is invisible. The procedure compiles, `requires()` is still on it, the
 * middleware count still passes, and the only symptom is that somebody a space has denied can read
 * and rewrite it anyway. Eight `databases.*` procedures shipped that way — a space-scoped DENY
 * binding stopped nobody from reading a database's schema or adding, renaming, reordering and
 * deleting its columns and views.
 *
 * Two tests read this and neither is satisfied by the declaration alone:
 *
 *   - `module.test.ts` fails when the contract and this map stop naming exactly the same
 *     procedures, so a new procedure cannot be added without deciding what it checks;
 *   - `authz.int.test.ts` calls every procedure named here against a real Postgres with the one
 *     permission below denied at space scope and nothing else, so a handler that does not ask —
 *     or asks for a different key than the one written here — fails.
 *
 * `check` is the scope the answer has to be resolved at, and it is not decoration:
 *
 *   - `page` — the page's own ancestor chain, so a restriction on a parent page reaches it. The
 *     scope of a database procedure is the database's host page; of a row procedure, the row.
 *   - `space` — the whole space, for something that has no one page (a tree, a trash list).
 *   - `workspace` — the `requires()` middleware is the only gate, because there is no narrower
 *     scope yet: `spaces.create` has no space to be scoped to.
 *   - `filter` — a list that omits what you may not see rather than refusing. "You may not open it"
 *     is a worse answer than not showing it, and `spaces.list` is deliberately the second.
 *   - `public` — there is no principal to ask about. See below.
 *
 * **`public` is the one that needs saying out loud.** Every other value here answers "which scope is
 * this permission resolved at"; `public` answers "this procedure asks nobody anything", which is a
 * different kind of statement and the only one in this module that can leak a customer's private
 * pages to the internet. It is spelled as a value rather than an omission so that adding one is a
 * line in a review instead of a missing entry nobody sees, and `authz.int.test.ts` treats it as its
 * own case: it calls the procedure once as a principal denied everything and once as a genuine
 * anonymous stranger, and fails unless the two answers are byte-for-byte identical. That is the
 * property that matters — a public surface that quietly shows an author more than it shows a
 * stranger is one whose author tests it and never sees what the world sees.
 *
 * `permission` is still required for a `public` entry, and it names the permission that had to be
 * held to *create the grant* — `quire.page.publish`, the one somebody used to make the publication.
 * It is not a check this procedure performs. `module.test.ts` holds every entry to a permission the
 * module declares, and there is no honest way to write "none" that keeps the rest of that check.
 */
export interface ProcedureAuthz {
  check: 'page' | 'space' | 'workspace' | 'filter' | 'public'
  permission: string
}

export const quireProcedureAuthz: Record<string, ProcedureAuthz> = {
  'spaces.list': { check: 'filter', permission: 'quire.space.view' },
  'spaces.get': { check: 'space', permission: 'quire.space.view' },
  'spaces.create': { check: 'workspace', permission: 'quire.space.manage' },
  'spaces.update': { check: 'space', permission: 'quire.space.manage' },
  'spaces.archive': { check: 'space', permission: 'quire.space.manage' },

  'pages.tree': { check: 'space', permission: 'quire.page.view' },
  'pages.get': { check: 'page', permission: 'quire.page.view' },
  'pages.trash': { check: 'space', permission: 'quire.page.edit' },
  'pages.create': { check: 'space', permission: 'quire.page.create' },
  'pages.update': { check: 'page', permission: 'quire.page.edit' },
  'pages.move': { check: 'page', permission: 'quire.page.edit' },
  'pages.archive': { check: 'page', permission: 'quire.page.edit' },
  'pages.trashPage': { check: 'page', permission: 'quire.page.edit' },
  'pages.restore': { check: 'page', permission: 'quire.page.edit' },
  'pages.purge': { check: 'page', permission: 'quire.page.delete' },
  'pages.setLabels': { check: 'page', permission: 'quire.page.edit' },

  // A label is the space's vocabulary, not one page's content: renaming "Draft" changes what it
  // means everywhere it is worn, so writing one is `space.manage` while reading is `space.view`.
  'labels.list': { check: 'space', permission: 'quire.space.view' },
  'labels.forPage': { check: 'page', permission: 'quire.page.view' },
  'labels.create': { check: 'space', permission: 'quire.space.manage' },
  'labels.update': { check: 'space', permission: 'quire.space.manage' },
  'labels.remove': { check: 'space', permission: 'quire.space.manage' },

  /*
   * Favourites, watches and recent views are one person's own, and that is a *filter inside the
   * query*, not a permission — RLS fences the workspace, which is the tenant boundary rather than a
   * privacy one, so `user_id` in each query is what keeps a sidebar personal.
   *
   * What the permission still decides is which pages may enter that list at all. Anything naming a
   * page checks the page: you have to be able to read a page to bookmark it, to watch it, or to
   * record having opened it — otherwise a page a space has closed to you is one you can still put
   * in your own sidebar and be told about.
   *
   * The three that name no page are `workspace`, honestly: "my whole list" has no narrower scope to
   * resolve. Each still drops the entries whose pages the caller may no longer read, and taking
   * your own bookmark back is deliberately not gated on the page — a shortcut you can no longer
   * open is exactly the one you want to be rid of, and needing read access to delete it would
   * strand it there for good.
   */
  'favorites.list': { check: 'workspace', permission: 'quire.page.view' },
  'favorites.add': { check: 'page', permission: 'quire.page.view' },
  'favorites.remove': { check: 'workspace', permission: 'quire.page.view' },
  'favorites.reorder': { check: 'workspace', permission: 'quire.page.view' },

  'watchers.get': { check: 'page', permission: 'quire.page.view' },
  'watchers.set': { check: 'page', permission: 'quire.page.view' },

  'recents.list': { check: 'workspace', permission: 'quire.page.view' },
  'recents.record': { check: 'page', permission: 'quire.page.view' },

  'versions.list': { check: 'page', permission: 'quire.page.view' },
  'versions.get': { check: 'page', permission: 'quire.page.view' },
  'versions.create': { check: 'page', permission: 'quire.page.edit' },
  'versions.restore': { check: 'page', permission: 'quire.page.edit' },

  'comments.list': { check: 'page', permission: 'quire.page.view' },
  'comments.create': { check: 'page', permission: 'quire.page.comment' },
  'comments.update': { check: 'page', permission: 'quire.page.comment' },
  'comments.remove': { check: 'page', permission: 'quire.page.comment' },
  'comments.resolve': { check: 'page', permission: 'quire.page.comment' },

  'databases.get': { check: 'page', permission: 'quire.page.view' },
  'databases.forPage': { check: 'page', permission: 'quire.page.view' },
  'databases.list': { check: 'space', permission: 'quire.space.view' },
  'databases.lookup': { check: 'page', permission: 'quire.page.view' },
  'databases.create': { check: 'page', permission: 'quire.page.edit' },
  'databases.rows': { check: 'page', permission: 'quire.page.view' },
  'databases.addRow': { check: 'page', permission: 'quire.page.create' },
  'databases.updateRow': { check: 'page', permission: 'quire.page.edit' },
  'databases.addProperty': { check: 'page', permission: 'quire.page.edit' },
  'databases.updateProperty': { check: 'page', permission: 'quire.page.edit' },
  'databases.moveProperty': { check: 'page', permission: 'quire.page.edit' },
  'databases.removeProperty': { check: 'page', permission: 'quire.page.edit' },
  'databases.addView': { check: 'page', permission: 'quire.page.edit' },
  'databases.updateView': { check: 'page', permission: 'quire.page.edit' },
  'databases.removeView': { check: 'page', permission: 'quire.page.edit' },
  'databases.setRelation': { check: 'page', permission: 'quire.page.edit' },

  /*
   * `start` is declared `page` because that is the branch that can be bound narrowly and therefore
   * the branch worth proving: a `page` or `subtree` export resolves the target page's own ancestor
   * chain and asks about it, so a page-scoped DENY of `quire.page.export` refuses the export of that
   * page and of any section containing it. A `space` export has no one page to resolve — it is the
   * whole space — so that branch asks the same permission at space scope, which is the narrowest
   * scope that exists for it. `export.int.test.ts` covers the space branch against a space-scoped
   * DENY, because the sweep in `authz.int.test.ts` only ever sends the page branch.
   *
   * `get` and `list` are `workspace` for the same reason `favorites.list` is: "my own exports" has
   * no narrower scope. What keeps them private is not a permission at all but the `requested_by`
   * filter in the query — row-level security fences the tenant, and a tenant is not a person.
   */
  'exports.start': { check: 'page', permission: 'quire.page.export' },
  'exports.get': { check: 'workspace', permission: 'quire.page.export' },
  'exports.list': { check: 'workspace', permission: 'quire.page.export' },

  /*
   * `start` is `space` where its export counterpart is `page`, and the difference is not an
   * oversight. An import has no page to be scoped to — it *creates* the pages — so the space it
   * writes into is the narrowest scope that exists for it, and a space-scoped DENY of
   * `quire.page.import` is what has to refuse it. The check is asked twice on purpose: once here,
   * before a row is recorded, and again inside the job as the person who asked, because a job runs
   * minutes later and a permission can be taken away in between.
   *
   * `get` and `list` are `workspace` for the same reason `exports.get` and `favorites.list` are:
   * "my own imports" has no narrower scope. What keeps them private is the `requested_by` filter in
   * the query rather than a permission — row-level security fences the tenant, and a tenant is not
   * a person.
   */
  'imports.start': { check: 'space', permission: 'quire.page.import' },
  'imports.get': { check: 'workspace', permission: 'quire.page.import' },
  'imports.list': { check: 'workspace', permission: 'quire.page.import' },

  /*
   * A template is a space's furniture, so it follows `labels.*` exactly: reading is
   * `quire.space.view` and writing is `quire.space.manage`. Changing one changes what everybody in
   * the space is offered the next time they make a page, which is not a thing somebody who may edit
   * one page should be able to do to everybody else's.
   *
   * Three of the five are `check: 'space'` although four of them take a *template* id, not a space
   * id. A template id carries no scope of its own, so the row is read first and the question is
   * asked about the space it belongs to — the same shape as `labels.update` next door. A
   * workspace-wide template (`space_id is null`) has no narrower scope than the workspace, and the
   * handlers say so out loud rather than silently falling back to the space of whoever asked.
   *
   * `createFromPage` is the one that is `check: 'page'`, and it is the interesting one: it *copies a
   * page's prose into a template*, so the question that actually protects anything is whether this
   * person may read that page. A page-scoped DENY of `quire.page.view` has to refuse it, or a
   * contractor allowed one page of a handbook could lift a page they cannot open into a template and
   * read it there. `quire.space.manage` is asked as well, in the same handler, and
   * `templates.int.test.ts` covers that half — this column names one permission, and the one worth
   * proving with a page-scoped binding is the read.
   *
   * `instantiate` asks `quire.page.create` and not `space.manage`: what it does is make a page.
   * Somebody who may write in a space may use its templates; only somebody who configures the space
   * may change them. Its `space` branch — which makes a *space* — asks `quire.space.manage` at
   * workspace scope on top, for the same reason `spaces.create` does; the sweep sends the page
   * branch, and `templates.int.test.ts` covers the other.
   */
  'templates.list': { check: 'space', permission: 'quire.space.view' },
  'templates.get': { check: 'space', permission: 'quire.space.view' },
  'templates.createFromPage': { check: 'page', permission: 'quire.page.view' },
  'templates.update': { check: 'space', permission: 'quire.space.manage' },
  'templates.remove': { check: 'space', permission: 'quire.space.manage' },
  'templates.instantiate': { check: 'space', permission: 'quire.page.create' },

  'publishing.publish': { check: 'page', permission: 'quire.page.publish' },
  'publishing.revert': { check: 'page', permission: 'quire.page.edit' },

  /*
   * A publication hands a page's whole subtree to the internet, so the question every one of these
   * asks is about the **root page** — not the space, and not the workspace. `quire.page.publish` is
   * already the permission that decides which version readers are served; deciding that the readers
   * include everybody is the same decision one step further.
   *
   * `list` is the exception and is space-scoped, because "what has this space published" has no one
   * page to resolve against. It filters as well: a publication whose root page the caller may not
   * read is not named in the answer, for the same reason `pages.trash` does not name a title.
   *
   * `optOut` is `quire.page.publish` rather than `quire.page.edit` on purpose. Marking a page
   * "never public" is a publishing decision about who may read it, not a change to what it says —
   * and the two permissions are held by different people in a space where writing is open and
   * publishing is not.
   */
  'publications.list': { check: 'space', permission: 'quire.page.publish' },
  'publications.get': { check: 'page', permission: 'quire.page.publish' },
  'publications.create': { check: 'page', permission: 'quire.page.publish' },
  'publications.update': { check: 'page', permission: 'quire.page.publish' },
  'publications.remove': { check: 'page', permission: 'quire.page.publish' },
  'publications.optOut': { check: 'page', permission: 'quire.page.publish' },

  /*
   * The signed-out surface. Nothing here asks a permission, because there is nobody to ask about —
   * see the note on `check: 'public'` above. What stands in for the permission check is that every
   * query is scoped by the **publication**: its root page, the descendants that survive the prune,
   * `excluded_from_public` false and a rendered published version. Workspace scope is what
   * row-level security gives, and workspace scope is not publication scope.
   */
  'public.site': { check: 'public', permission: 'quire.page.publish' },
  'public.page': { check: 'public', permission: 'quire.page.publish' },
  'public.search': { check: 'public', permission: 'quire.page.publish' },
  'public.sitemap': { check: 'public', permission: 'quire.page.publish' },
  'public.robots': { check: 'public', permission: 'quire.page.publish' },
  'public.asset': { check: 'public', permission: 'quire.page.publish' },
  'public.unlock': { check: 'public', permission: 'quire.page.publish' },
}
