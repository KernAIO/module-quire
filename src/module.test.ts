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
 *      the only symptom is a workspace calling a feature it switched off.
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
} from './contract.js'
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
      // `workspaceScoped(MODULE_ID)` + `requires('<permission>')`
      expect(leaf['~orpc'].middlewares?.length ?? 0, `${name} middlewares`).toBeGreaterThanOrEqual(2)
    }
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
    for (const e of Object.values(quireEvents))
      expect(e.name.startsWith(`${MODULE_ID}.`), e.name).toBe(true)
  })

  it('registers those permissions and events on the server module', () => {
    expect(quireModule.definition.id).toBe(MODULE_ID)
    expect(quireModule.definition.permissions).toBe(quirePermissions)
    expect(quireModule.definition.capabilities).toBe(quireCapabilities)
    expect(quireModule.definition.events).toBe(quireEvents)
    expect(quireModule.router, 'a module with a contract has to mount a router').toBeTypeOf('function')
  })
})
