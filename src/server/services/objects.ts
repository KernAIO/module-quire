/**
 * One of Kern's own things, embedded in a page — resolved rather than fetched.
 *
 * An issue, a page, a channel: the document holds `<module>:<type>:<id>` and **no title**, and this
 * file turns that into something a reader can see, through the machinery every module already
 * declares for exactly this. `objectTypes` on a module definition says what a `tracker:issue` is
 * called and which icon it wears; `resolvers` turns a handful of ids into titles and URLs. Nothing
 * new was invented for embeds, which is the point: a module that already renders in a notification
 * and in a search result renders in a page for free, and a module that has not declared a resolver
 * draws an empty frame rather than a broken card.
 *
 * **Why not unfurl our own URLs.** It would be less code: paste a link to an issue, fetch it, read
 * the title. It is also two mistakes at once. It points the unfurl fetcher — the thing whose whole
 * job is to stay off this network — at core on :4000. And it freezes a permission question into an
 * answer stored in a document, where it is drawn for ever by a renderer that never asked anybody.
 *
 * **What a resolved object is worth, stated plainly.** Every `ObjectResolver` in Kern today is
 * *workspace*-scoped: it takes a principal and none of them reads it. So resolving through them
 * proves the reader is a member of the workspace that owns the object, and no more than that. This
 * file therefore does two things about it rather than assume otherwise:
 *
 *   1. **A publication resolves nothing.** A published site has no reader, so there is nobody whose
 *      membership could be the guarantee — and an object embed on a public page draws its frame and
 *      stops. That is a decision made by having no branch for it, so a later edit cannot switch it
 *      on by accident.
 *   2. **Quire's own pages are asked about properly**, with the same page-scoped `quire.page.view`
 *      every other macro in this module uses. This module can do that for its own objects and
 *      cannot do it for anybody else's, so it does it where it can rather than nowhere.
 */
import type { Principal } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { PAGE_OBJECT_REF } from '@kernhq/ui/editor/page-doc'
import type { MacroObjectRef } from '../render.js'
import type { QuireAccess } from './access.js'

/** How many distinct objects one page may name. A document decides how much work a render does. */
const MAX_OBJECTS = 40

export interface ParsedRef {
  ref: string
  module: string
  type: string
  id: string
}

/**
 * `quire:page:0192…` in three parts, or nothing.
 *
 * The same pattern the editor narrows with, checked again here for the reason every attribute in
 * this module is: what arrives is JSON out of a CRDT, which is to say a string a client picked.
 */
export function parseRef(value: unknown): ParsedRef | null {
  if (typeof value !== 'string' || !PAGE_OBJECT_REF.test(value)) return null
  const [module, type, id] = value.split(':') as [string, string, string]
  return { ref: value, module, type, id }
}

export function quireObjects(kernel: Kernel, access: QuireAccess) {
  /**
   * The module hosting a type, but only if this process hosts it.
   *
   * `kernel.registry` is local, which is the honest limit and the safe one: a module hosted by
   * another service answers nothing here, so the embed draws an empty frame. Reaching across with
   * `kernel.call` would need a procedure every module agreed to expose, and inventing one is a
   * change to the module contract rather than to this module.
   */
  function hostOf(module: string, type: string) {
    const mod = kernel.registry.get(module)
    if (!mod) return null
    const resolver = mod.resolvers?.find((r) => r.type === type)
    if (!resolver) return null
    const declared = mod.definition.objectTypes?.find((o) => o.type === type)
    return { resolver, label: declared?.label ?? type, icon: declared?.icon ?? null }
  }

  return {
    /**
     * Resolve a set of references for one reader, in one pass.
     *
     * Grouped by module and type so a page naming twelve issues is one call into tracker rather
     * than twelve — the same arrangement `macrosIn` and `referencesIn` exist for, and for the same
     * reason: a document must not decide how many round trips a render makes.
     *
     * Anything that cannot be answered is simply absent from the map, and an absent answer is the
     * empty frame. There is no path here that returns an object nobody was asked about.
     */
    async resolve(
      tx: Tx,
      workspaceId: string,
      refs: readonly string[],
      principal: Principal,
      href?: (parsed: ParsedRef, url: string) => string | null,
    ): Promise<Map<string, MacroObjectRef>> {
      const answers = new Map<string, MacroObjectRef>()
      const parsed = refs
        .map(parseRef)
        .filter((r): r is ParsedRef => r !== null)
        .slice(0, MAX_OBJECTS)
      if (parsed.length === 0) return answers

      const groups = new Map<string, ParsedRef[]>()
      for (const ref of parsed) {
        const key = `${ref.module}:${ref.type}`
        const bucket = groups.get(key)
        if (bucket) bucket.push(ref)
        else groups.set(key, [ref])
      }

      for (const [key, bucket] of groups) {
        const [module, type] = key.split(':') as [string, string]
        const host = hostOf(module, type)
        if (!host) continue
        /*
         * A workspace that has switched a module off has switched off everything it named. Asked
         * here rather than left to the resolver, because a resolver reads its own tables and knows
         * nothing about whether the customer still has the feature.
         */
        const enabled = await kernel.isModuleEnabled(workspaceId, module).catch(() => false)
        if (!enabled) continue

        const rows = await host.resolver
          .resolve(
            workspaceId,
            bucket.map((r) => r.id),
            principal,
            kernel,
          )
          .catch(() => null)
        if (!rows) continue

        for (const [index, row] of rows.entries()) {
          const ref = bucket[index]
          if (!row || !ref) continue
          // This module's own pages get this module's own rule; see the note at the top.
          if (
            module === 'quire' &&
            type === 'page' &&
            !(await visiblePage(tx, workspaceId, principal, row.id))
          )
            continue
          answers.set(ref.ref, {
            label: host.label,
            title: row.title,
            icon: row.icon ?? host.icon,
            href: href?.(ref, row.url) ?? row.url,
            subtitle: row.subtitle ?? null,
          })
        }
      }
      return answers
    },
  }

  /** `quire.page.view` at page scope, with the ancestor chain a restriction on a section needs. */
  async function visiblePage(
    tx: Tx,
    workspaceId: string,
    principal: Principal,
    pageId: string,
  ): Promise<boolean> {
    const scope = await access.scopeOf(tx, workspaceId, pageId).catch(() => null)
    if (!scope) return false
    return access.canPage(principal, 'quire.page.view', workspaceId, scope)
  }
}

export type QuireObjects = ReturnType<typeof quireObjects>
