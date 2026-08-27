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
 */
export interface ProcedureAuthz {
  check: 'page' | 'space' | 'workspace' | 'filter'
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

  'publishing.publish': { check: 'page', permission: 'quire.page.publish' },
  'publishing.revert': { check: 'page', permission: 'quire.page.edit' },
}
