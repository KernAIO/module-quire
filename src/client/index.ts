import { formatCollabDocument } from '@kernhq/contracts'
import { createModuleClient, type KernClientOptions } from '@kernhq/sdk'
import type { ContractRouterClient } from '@orpc/contract'
import { MODULE_ID, type Page, type PageNode, type QuireContract } from '../contract/index.js'

/**
 * The client half.
 *
 * Published as **source**, not compiled: the consumer builds the TypeScript and Svelte with its own
 * toolchain, which is what lets `$state` in a module store stay reactive inside the app. Two
 * consequences worth knowing before you edit anything here — nothing in this package compiles it,
 * so `pnpm build` passes over a syntax error and only the app finds it; and `files` in package.json
 * must cover every directory this entry reaches, contract source included.
 *
 * What lives here: the typed API client, and any logic that is about this module but not about a
 * screen (formatting, grouping, parsing). What does not: the `defineClientModule` manifest and the
 * Svelte components, which live in the app so their labels can go through its message catalogue.
 * `pnpm new-module` generates both halves.
 */
export type QuireApi = ContractRouterClient<QuireContract>

export function createQuireClient(opts: KernClientOptions): QuireApi {
  return createModuleClient<QuireApi>(opts, 'quire')
}

export {
  MODULE_ID,
  type Page,
  type PageKind,
  type PageNode,
  quirePermissions,
  type Space,
  type SpaceVisibility,
} from '../contract/index.js'
export * from './rank.js'

/**
 * The name this page's prose is synchronised under, on the collab service.
 *
 * Exported here rather than left to the caller because the gateway parses it with the matching
 * function from `@kernhq/contracts`, and a name it cannot parse is a rejected connection with no
 * useful error. The module owns the naming of its own objects.
 */
export function pageDocumentName(page: { workspaceId: Page['workspaceId']; id: string }): string {
  return formatCollabDocument({
    workspaceId: page.workspaceId,
    module: MODULE_ID,
    type: 'page',
    objectId: page.id,
  })
}

/** The permission keys, so the app gates on a constant rather than a string it retyped. */
export const QUIRE_PERMISSIONS = {
  spaceView: 'quire.space.view',
  spaceManage: 'quire.space.manage',
  pageView: 'quire.page.view',
  pageCreate: 'quire.page.create',
  pageEdit: 'quire.page.edit',
  pageDelete: 'quire.page.delete',
} as const

/**
 * Build the sidebar tree from the flat, position-ordered list `pages.tree` returns.
 *
 * Isomorphic on purpose: the app draws it and the published-site renderer will need the same shape,
 * and neither should re-derive it. Rows whose parent is missing — because it was archived and this
 * caller asked for the live tree — are lifted to the top rather than dropped, so a page is never
 * invisible because of where it happens to sit.
 */
export interface PageTreeNode extends PageNode {
  children: PageTreeNode[]
}

export function buildPageTree(nodes: readonly PageNode[]): PageTreeNode[] {
  const byId = new Map<string, PageTreeNode>(nodes.map((n) => [n.id, { ...n, children: [] }]))
  const roots: PageTreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
