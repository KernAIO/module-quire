import { session } from '@kernhq/ui'
import { quirePermissions } from '../contract/permissions.js'

/**
 * What quire lets somebody do.
 *
 * Derived from the contract rather than re-typed, and `key()` throws at import when a name does not
 * exist. There were two hand-written copies of this before — one in the package and one in the app —
 * and they had drifted: the package's was missing `page.comment` and `page.publish` entirely, so any
 * screen gating on them through that copy silently had no key at all. Nothing reported it, because
 * a wrong permission string is a perfectly valid string.
 *
 * Every key is declared at **space** scope on the server, so a person may be able to edit one space
 * and only read another. `session.can` answers for the workspace, which is the right answer for
 * "should this appear in the rail at all" and the wrong one for "may I edit this page" — the page
 * asks the server for that, and the server is what refuses.
 */
const key = (suffix: string) => {
  const found = quirePermissions.find((p) => p.key === `quire.${suffix}`)
  if (!found) throw new Error(`quire: no permission declared for quire.${suffix}`)
  return found.key
}

export const QUIRE_PERMISSIONS = {
  spaceView: key('space.view'),
  spaceManage: key('space.manage'),
  pageView: key('page.view'),
  pageCreate: key('page.create'),
  pageComment: key('page.comment'),
  pageEdit: key('page.edit'),
  pagePublish: key('page.publish'),
  pageDelete: key('page.delete'),
} as const

export type QuirePermission = keyof typeof QUIRE_PERMISSIONS

export function canQuire(permission: QuirePermission): boolean {
  return session.can(QUIRE_PERMISSIONS[permission])
}
