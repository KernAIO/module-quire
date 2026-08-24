/**
 * Who may do what to a space or a page.
 *
 * The permission engine resolves bindings nearest-scope-first, so this file's only job is to hand it
 * the right scope chain: a page is scoped to itself, with its space and then the workspace as
 * parents. That is what makes "everyone may read the Handbook, the design team may write it, and
 * this one contractor may read exactly one page of it" expressible without a second permission
 * system — and what makes a restriction on a parent page apply to its children, because the chain
 * carries every ancestor.
 */
import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { pages, spaces } from '../schema.js'

export interface PageScope {
  pageId: string
  spaceId: string
  /** every ancestor, nearest first — a restriction on a parent has to reach its children */
  ancestorIds: string[]
}

export function quireAccess(kernel: Kernel) {
  const spaceScope = (workspaceId: string, spaceId: string) => ({
    kind: 'space' as const,
    id: spaceId,
    parents: [{ kind: 'workspace' as const, id: workspaceId }],
    workspaceId,
  })

  return {
    /** May this user do `permission` anywhere in the space? */
    canSpace(principal: Principal, permission: string, workspaceId: string, spaceId: string) {
      return kernel.authz.can(principal, permission, spaceScope(workspaceId, spaceId))
    },

    requireSpace(principal: Principal, permission: string, workspaceId: string, spaceId: string) {
      return kernel.authz.require(principal, permission, spaceScope(workspaceId, spaceId))
    },

    /**
     * The same question about one page. The page is the narrowest scope, and every ancestor page is
     * in the chain above it so a restriction set higher up is inherited rather than having to be
     * copied down.
     */
    canPage(principal: Principal, permission: string, workspaceId: string, scope: PageScope) {
      return kernel.authz.can(principal, permission, {
        kind: 'object',
        id: scope.pageId,
        parents: [
          ...scope.ancestorIds.map((id) => ({ kind: 'object' as const, id })),
          { kind: 'space' as const, id: scope.spaceId },
          { kind: 'workspace' as const, id: workspaceId },
        ],
        workspaceId,
      })
    },

    async requirePage(
      principal: Principal,
      permission: string,
      workspaceId: string,
      scope: PageScope,
    ): Promise<void> {
      if (!(await this.canPage(principal, permission, workspaceId, scope)))
        throw KernError.forbidden(permission)
    },

    /**
     * The scope of a page, walked up through its parents.
     *
     * Recursive rather than one query per level: a deep tree would otherwise cost a round trip per
     * ancestor on every read. The `cycle` clause is not paranoia — a move that made a page its own
     * ancestor would otherwise hang the connection rather than fail.
     */
    async scopeOf(tx: Tx, workspaceId: string, pageId: string): Promise<PageScope> {
      const rows = await tx.execute<{ id: string; space_id: string; depth: number }>(sql`
        with recursive chain as (
          select id, space_id, parent_id, 0 as depth
            from mod_quire.pages
           where workspace_id = ${workspaceId}::uuid and id = ${pageId}::uuid
          union all
          select p.id, p.space_id, p.parent_id, chain.depth + 1
            from mod_quire.pages p
            join chain on p.id = chain.parent_id
           where p.workspace_id = ${workspaceId}::uuid
        ) cycle id set looped using path
        select id, space_id, depth from chain order by depth
      `)
      const self = rows.rows[0]
      if (!self) throw KernError.notFound('Page')
      return {
        pageId: self.id,
        spaceId: self.space_id,
        ancestorIds: rows.rows.slice(1).map((r) => r.id),
      }
    },

    /** The space row, or `notFound` — used before every space-scoped check so it cannot be skipped. */
    async spaceRow(tx: Tx, workspaceId: string, spaceId: string) {
      const [row] = await tx
        .select()
        .from(spaces)
        .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, spaceId)))
        .limit(1)
      if (!row) throw KernError.notFound('Space')
      return row
    },

    /** The page row, excluding anything in the trash unless asked for. */
    async pageRow(tx: Tx, workspaceId: string, pageId: string, opts: { includeTrashed?: boolean } = {}) {
      const [row] = await tx
        .select()
        .from(pages)
        .where(
          opts.includeTrashed
            ? and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId))
            : and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId), isNull(pages.deletedAt)),
        )
        .limit(1)
      if (!row) throw KernError.notFound('Page')
      return row
    },
  }
}
export type QuireAccess = ReturnType<typeof quireAccess>
