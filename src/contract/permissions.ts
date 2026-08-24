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
