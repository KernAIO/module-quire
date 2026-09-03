/**
 * The Quire permission matrix, blessed rather than assumed.
 *
 * Defaults are declared one permission at a time, which makes the whole picture — which built-in
 * role ends up holding what — impossible to read from any single line. This writes it out in full
 * and compares it against what the module declares. Rows list the *effective* grants, cascade
 * included: the kernel expands declared `defaultRoles` upward through guest ⊆ member ⊆ admin ⊆
 * owner, and `permissionMatrixDiff` applies the same expansion.
 *
 * Changing a default is meant to be deliberate: edit `defaultRoles` → this fails naming every row
 * that moved → confirm that is what you meant → update `BLESSED` in the same commit.
 */
import { permissionMatrixDiff } from '@kernhq/testing'
import { describe, expect, it } from 'vitest'
import { quirePermissions } from './permissions.js'

/** Every built-in role that holds the permission by default, lowest role first. */
const BLESSED: Record<string, readonly string[]> = {
  'quire.space.view': ['guest', 'member', 'admin', 'owner'],
  'quire.space.manage': ['admin', 'owner'],
  'quire.page.view': ['guest', 'member', 'admin', 'owner'],
  'quire.page.create': ['member', 'admin', 'owner'],
  'quire.page.edit': ['member', 'admin', 'owner'],
  'quire.page.comment': ['guest', 'member', 'admin', 'owner'],
  'quire.page.publish': ['member', 'admin', 'owner'],
  'quire.page.export': ['member', 'admin', 'owner'],
  'quire.page.import': ['admin', 'owner'],
  'quire.page.delete': ['admin', 'owner'],
}

/** Permissions whose misuse costs data: an import overwrites, a delete removes. */
const DANGEROUS = ['quire.page.import', 'quire.page.delete']

describe('quire permissions', () => {
  it('grants each permission to exactly the blessed roles', () => {
    expect(permissionMatrixDiff(quirePermissions, BLESSED)).toEqual([])
  })

  it('namespaces every key under the module id and declares it once', () => {
    const keys = quirePermissions.map((p) => p.key)
    expect(keys.filter((key) => !key.startsWith('quire.'))).toEqual([])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  })

  it('marks exactly the destructive permissions dangerous', () => {
    const flagged = quirePermissions.filter((p) => p.dangerous).map((p) => p.key)
    expect(flagged.toSorted()).toEqual(DANGEROUS.toSorted())
  })
})
