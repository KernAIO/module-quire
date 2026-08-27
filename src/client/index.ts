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
  type Comment,
  type CommentAnchor,
  type CommentThread,
  type Favorite,
  type FavoriteEntry,
  type Label,
  type LabelColour,
  MODULE_ID,
  type Page,
  type PageKind,
  type PageNode,
  type PageVersion,
  quirePermissions,
  type RecentEntry,
  type RecentView,
  type Space,
  type SpaceVisibility,
  type VersionKind,
  type Watcher,
  type WatchState,
} from '../contract/index.js'
export type { CoreMember, Person } from './core-api.js'
export { OPTION_COLOURS, toneFor } from './database/colours.js'
export {
  CREATABLE_TYPES,
  descriptorFor,
  isReadOnly,
  operatorsFor,
  PROPERTY_TYPES,
  type PropertyDescriptor,
  VIEW_KINDS,
  viewIcon,
} from './database/property-types.js'
export {
  columnTemplate,
  EMPTY_GROUP,
  groupsOf,
  groupValue,
  type Lane,
  mergeConfig,
  orderedProperties,
  visiblePropertiesOf,
} from './database/view-config.js'
export type { Ast, FormulaValue } from './formula.js'
/**
 * The formula parser, for the property editor.
 *
 * Only the parser: `evaluateFormula` stays a server concern, because a formula is evaluated against
 * a row and the server is the only thing holding one. What a client needs is to tell somebody their
 * expression is wrong while they are typing it, and which columns it reads.
 */
export { FormulaError, formulaDependencies, parseFormula } from './formula.js'
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
export { __setQuireApi, getQuireApi } from './api-instance.js'
export { type QuireMessageKey, quireMessageBundles, t } from './i18n.js'
export { quireClientModule, quireClientModule as default } from './module.js'
export { canQuire, QUIRE_PERMISSIONS, type QuirePermission } from './permissions.js'
