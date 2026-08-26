/**
 * This module's guard rails. Keep this file: it is what stops the contract and the router drifting.
 *
 * It needs no database and no running service: it walks the contract and the router as data and
 * checks the two things that are easy to forget and impossible for `tsc` to see.
 *
 *   1. every procedure the contract promises is actually implemented — a contract entry with no
 *      router entry type-checks perfectly and 404s at runtime;
 *   2. every implemented procedure is behind `workspaceScoped()` *and* a `requires()` — a procedure
 *      that forgets the second one is readable by any member of any workspace with the module on;
 *   3. every procedure the contract says belongs to a capability is behind `requiresCapability()` —
 *      forgetting that one is invisible, because the procedure compiles, the other tests pass, and
 *      the only symptom is a workspace calling a feature it switched off;
 *   4. every procedure has an entry in `quireProcedureAuthz` saying what it checks *inside* the
 *      handler, which is what `authz.int.test.ts` then proves against a real database.
 *
 * The fourth one is here because the second was not enough, and said so out loud. Counting
 * middlewares told us `requires()` was present; it cannot tell us the narrower question was asked,
 * because that question is a line inside the handler and not a middleware at all. Eight
 * `databases.*` procedures carried `requires('quire.page.edit')` and never resolved the page, so a
 * space-scoped DENY binding stopped nobody — and every assertion in this file passed the whole
 * time. Anything that could be checked here would be checking the same shape from a different
 * angle: a handler is an opaque function, and "did it call `requirePage`" is not a property of an
 * opaque function.
 *
 * So the check that bites lives where the behaviour is observable — `authz.int.test.ts` calls every
 * procedure with the permission denied and asserts it refuses — and what this file contributes is
 * the thing that makes that loop complete: the map and the contract must name exactly the same
 * procedures. A procedure added without an entry fails here, and an entry with no input fixture
 * fails there, so a new procedure cannot reach `main` without somebody deciding what it checks and
 * a real database agreeing that it does. Declaring `check: 'workspace'` is still an escape hatch,
 * and deliberately a visible one: it is a line in a review, not an omission nobody can see.
 *
 * Add your module's real tests next to it; this one keeps working as the contract grows.
 */
import type { Kernel } from '@kernhq/kernel'
import { describe, expect, it } from 'vitest'
import {
  MODULE_ID,
  quireCapabilities,
  quireCapabilityProcedures,
  quireContract,
  quireEvents,
  quirePermissions,
  quireProcedureAuthz,
} from './contract/index.js'
import { implement_ } from './server/_impl.js'
import { quireModule } from './server/index.js'

/** An oRPC procedure (contract or implementation) carries `~orpc`; a router group does not. */
interface Leaf {
  '~orpc': {
    route?: { method?: string; path?: string }
    middlewares?: unknown[]
  }
}
const isLeaf = (node: unknown): node is Leaf => typeof node === 'object' && node !== null && '~orpc' in node

/** `{ widgets: { list, create } }` → `{ 'widgets.list': leaf, 'widgets.create': leaf }` */
function leaves(node: unknown, path: string[] = []): Record<string, Leaf> {
  if (isLeaf(node)) return { [path.join('.')]: node }
  if (typeof node !== 'object' || node === null) return {}
  return Object.entries(node).reduce<Record<string, Leaf>>(
    (acc, [key, value]) => Object.assign(acc, leaves(value, [...path, key])),
    {},
  )
}

// The router is only inspected, never called, so it needs no real kernel behind it.
const declared = leaves(quireContract)
const implemented = leaves(implement_({} as Kernel))

describe('the contract and the router agree', () => {
  it('implements every declared procedure, and nothing that was never declared', () => {
    expect(Object.keys(implemented).sort()).toEqual(Object.keys(declared).sort())
  })

  it('keeps the REST route the contract published', () => {
    for (const [name, leaf] of Object.entries(implemented)) {
      const contractRoute = declared[name]?.['~orpc'].route
      expect(leaf['~orpc'].route?.method, `${name} method`).toBe(contractRoute?.method)
      expect(leaf['~orpc'].route?.path, `${name} path`).toBe(contractRoute?.path)
    }
  })
})

/** Procedure names the contract says sit behind some capability. */
const gated = new Set(Object.values(quireCapabilityProcedures).flat())

describe('every procedure is authorised', () => {
  it('carries both the workspace/module gate and a permission check', () => {
    for (const [name, leaf] of Object.entries(implemented)) {
      // `workspaceScoped(MODULE_ID)` + `requires('<permission>')`. Necessary and, on its own, not
      // sufficient — see the note at the top of this file and the next assertion.
      expect(leaf['~orpc'].middlewares?.length ?? 0, `${name} middlewares`).toBeGreaterThanOrEqual(2)
    }
  })

  it('declares the narrower check every procedure makes inside its handler', () => {
    // Exact, in both directions. A procedure with no entry would never be called by the sweep in
    // `authz.int.test.ts`, and an entry naming a procedure that no longer exists would make the
    // sweep quietly smaller than it looks.
    expect(Object.keys(quireProcedureAuthz).sort()).toEqual(Object.keys(declared).sort())
  })

  it('names a permission this module actually declares, in every one of those entries', () => {
    const known = new Set(quirePermissions.map((p) => p.key))
    for (const [name, authz] of Object.entries(quireProcedureAuthz))
      expect(known.has(authz.permission), `${name} wants undeclared "${authz.permission}"`).toBe(true)
  })

  it('puts a third middleware on every procedure that belongs to a capability', () => {
    // The middlewares are opaque functions, so this counts rather than identifies them: an ungated
    // procedure carries two, a gated one carries `requiresCapability` as well.
    for (const name of gated) {
      const leaf = implemented[name]
      expect(leaf, `${name} is named in quireCapabilityProcedures but not implemented`).toBeDefined()
      expect(
        leaf?.['~orpc'].middlewares?.length ?? 0,
        `${name} is declared under a capability, so it needs requiresCapability()`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('names only capabilities the module actually declares', () => {
    const known = new Set(quireCapabilities.map((c) => c.id))
    for (const id of Object.keys(quireCapabilityProcedures))
      expect(known.has(id), `quireCapabilityProcedures names unknown capability "${id}"`).toBe(true)
  })

  it('names only procedures the contract actually has', () => {
    for (const name of gated) expect(Object.keys(declared)).toContain(name)
  })
})

describe('the module declares what it uses', () => {
  it('names its permissions and events under its own module id', () => {
    for (const p of quirePermissions) expect(p.key.startsWith(`${MODULE_ID}.`), p.key).toBe(true)
    for (const e of Object.values(quireEvents)) expect(e.name.startsWith(`${MODULE_ID}.`), e.name).toBe(true)
  })

  it('registers those permissions and events on the server module', () => {
    expect(quireModule.definition.id).toBe(MODULE_ID)
    expect(quireModule.definition.permissions).toBe(quirePermissions)
    expect(quireModule.definition.capabilities).toBe(quireCapabilities)
    expect(quireModule.definition.events).toBe(quireEvents)
    expect(quireModule.router, 'a module with a contract has to mount a router').toBeTypeOf('function')
  })
})
