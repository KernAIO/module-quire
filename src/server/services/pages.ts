import { formatCollabDocument, type Principal } from '@kernhq/contracts'
import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { initialRank, rankBetween } from '../../client/rank.js'
import type { Page, PageNode } from '../../contract/index.js'
import { MODULE_ID } from '../../contract/index.js'
import { pages } from '../schema.js'
import type { QuireAccess } from './access.js'

type PageRow = typeof pages.$inferSelect

/** The name this page's prose is synchronised under, on the collab service. */
export function documentNameOf(row: { workspaceId: string; id: string }): string {
  return formatCollabDocument({
    workspaceId: row.workspaceId as never,
    module: MODULE_ID,
    type: 'page',
    objectId: row.id,
  })
}

export function toPage(row: PageRow): Page {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Page['workspaceId'],
    spaceId: row.spaceId,
    parentId: row.parentId,
    position: row.position,
    kind: row.kind as Page['kind'],
    title: row.title,
    icon: row.icon,
    coverUrl: row.coverUrl,
    publishedVersionId: row.publishedVersionId,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    createdBy: row.createdBy as Page['createdBy'],
    updatedBy: row.updatedBy as Page['updatedBy'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  }
}

export function quirePages(access: QuireAccess) {
  /** The position for a new or moved page landing behind `afterId` among `parentId`'s children. */
  async function positionAfter(
    tx: Tx,
    workspaceId: string,
    spaceId: string,
    parentId: string | null,
    afterId: string | null,
    movingId?: string,
  ): Promise<string> {
    const siblings = await tx
      .select({ id: pages.id, position: pages.position })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.spaceId, spaceId),
          parentId === null ? isNull(pages.parentId) : eq(pages.parentId, parentId),
          isNull(pages.deletedAt),
        ),
      )
      .orderBy(asc(pages.position))
    const ordered = siblings.filter((s) => s.id !== movingId)
    if (afterId === null) return rankBetween(null, ordered[0]?.position ?? null)
    const at = ordered.findIndex((s) => s.id === afterId)
    if (at < 0) throw KernError.badRequest('afterId is not a sibling at this position')
    return rankBetween(ordered[at]!.position, ordered[at + 1]?.position ?? null)
  }

  return {
    /**
     * Every page in the space, flat, ordered so the caller can build the tree without sorting.
     *
     * One query for the whole space rather than one per expanded level: a wiki sidebar shows every
     * level at once, and paging by level turns opening a space into a request per node.
     */
    async tree(tx: Tx, workspaceId: string, spaceId: string, includeArchived: boolean): Promise<PageNode[]> {
      const rows = await tx
        .select({
          id: pages.id,
          parentId: pages.parentId,
          position: pages.position,
          kind: pages.kind,
          title: pages.title,
          icon: pages.icon,
          archivedAt: pages.archivedAt,
        })
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            eq(pages.spaceId, spaceId),
            isNull(pages.deletedAt),
            /**
             * Rows are not in the tree.
             *
             * A row *is* a page parented to the database's own page, which is what makes it
             * openable and commentable for free — but it also means a database of five hundred rows
             * puts five hundred entries in the sidebar, under one node, in whatever order their
             * ranks happen to give. The database's page is there; the rows are reached through it,
             * by URL and by search.
             */
            isNull(pages.databaseId),
            includeArchived ? undefined : isNull(pages.archivedAt),
          ),
        )
        .orderBy(asc(pages.position))

      const withChildren = new Set(rows.map((r) => r.parentId).filter((id): id is string => id !== null))
      return rows.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        position: r.position,
        kind: r.kind as PageNode['kind'],
        title: r.title,
        icon: r.icon,
        hasChildren: withChildren.has(r.id),
        archivedAt: r.archivedAt?.toISOString() ?? null,
      }))
    },

    async get(tx: Tx, workspaceId: string, pageId: string) {
      return toPage(await access.pageRow(tx, workspaceId, pageId))
    },

    async trash(tx: Tx, workspaceId: string, spaceId: string, limit: number, cursor: string | null) {
      const rows = await tx
        .select()
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            eq(pages.spaceId, spaceId),
            isNotNull(pages.deletedAt),
            cursor ? lt(pages.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(pages.id))
        .limit(limit + 1)
      const items = rows.slice(0, limit).map(toPage)
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null }
    },

    async create(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: {
        spaceId: string
        parentId: string | null
        title: string
        kind: string
        icon: string | null
        afterId: string | null
      },
    ) {
      if (input.parentId) {
        const parent = await access.pageRow(tx, workspaceId, input.parentId)
        if (parent.spaceId !== input.spaceId)
          throw KernError.badRequest('The parent page is in a different space')
      }
      const position = await positionAfter(tx, workspaceId, input.spaceId, input.parentId, input.afterId)
      const [row] = await tx
        .insert(pages)
        .values({
          id: uuidv7(),
          workspaceId,
          spaceId: input.spaceId,
          parentId: input.parentId,
          position,
          kind: input.kind,
          title: input.title,
          icon: input.icon,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
      return toPage(row!)
    },

    async update(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      pageId: string,
      patch: Partial<Pick<PageRow, 'title' | 'icon' | 'coverUrl' | 'kind'>>,
    ) {
      const [row] = await tx
        .update(pages)
        .set({ ...patch, updatedBy: principal.userId, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId), isNull(pages.deletedAt)))
        .returning()
      if (!row) throw KernError.notFound('Page')
      return toPage(row)
    },

    /**
     * Reparent and reorder in one step.
     *
     * The cycle guard is the part worth reading: dragging a page onto one of its own descendants
     * would otherwise produce a subtree with no root, invisible in every query that walks down from
     * the top and impossible to reach or delete.
     */
    async move(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      pageId: string,
      parentId: string | null,
      afterId: string | null,
    ) {
      const row = await access.pageRow(tx, workspaceId, pageId)
      if (parentId === pageId) throw KernError.badRequest('A page cannot be its own parent')
      if (parentId) {
        const parent = await access.pageRow(tx, workspaceId, parentId)
        if (parent.spaceId !== row.spaceId)
          throw KernError.badRequest('A page can only move within its own space')
        const parentScope = await access.scopeOf(tx, workspaceId, parentId)
        if (parentScope.ancestorIds.includes(pageId))
          throw KernError.badRequest('A page cannot move inside one of its own descendants')
      }
      const position = await positionAfter(tx, workspaceId, row.spaceId, parentId, afterId, pageId)
      const [moved] = await tx
        .update(pages)
        .set({ parentId, position, updatedBy: principal.userId, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .returning()
      return toPage(moved!)
    },

    async archive(tx: Tx, principal: Principal, workspaceId: string, pageId: string, archived: boolean) {
      const [row] = await tx
        .update(pages)
        .set({
          archivedAt: archived ? new Date() : null,
          updatedBy: principal.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId), isNull(pages.deletedAt)))
        .returning()
      if (!row) throw KernError.notFound('Page')
      return toPage(row)
    },

    /** Every page in the subtree rooted at `pageId`, including it, nearest first. */
    async subtreeIds(tx: Tx, workspaceId: string, pageId: string): Promise<string[]> {
      const res = await tx.execute<{ id: string }>(sql`
        with recursive subtree as (
          select id from mod_quire.pages
           where workspace_id = ${workspaceId}::uuid and id = ${pageId}::uuid
          union all
          select p.id from mod_quire.pages p
            join subtree on p.parent_id = subtree.id
           where p.workspace_id = ${workspaceId}::uuid
        ) cycle id set looped using path
        select id from subtree
      `)
      return res.rows.map((r) => r.id)
    },

    /** Into the trash, with every descendant — a page whose parent is gone is unreachable. */
    async trashPage(tx: Tx, workspaceId: string, pageId: string) {
      const ids = await this.subtreeIds(tx, workspaceId, pageId)
      if (ids.length === 0) throw KernError.notFound('Page')
      await tx
        .update(pages)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, ids)))
      return { ids }
    },

    /**
     * Back out of the trash. Only the page asked for and its descendants come back, and only if its
     * parent is still there — restoring under a deleted parent would put it somewhere unreachable.
     */
    async restore(tx: Tx, workspaceId: string, pageId: string) {
      const row = await access.pageRow(tx, workspaceId, pageId, { includeTrashed: true })
      if (!row.deletedAt) return toPage(row)
      if (row.parentId) {
        const [parent] = await tx
          .select({ deletedAt: pages.deletedAt })
          .from(pages)
          .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, row.parentId)))
          .limit(1)
        // Restoring to the top of the space beats restoring into nothing.
        if (!parent || parent.deletedAt) {
          const position = await positionAfter(tx, workspaceId, row.spaceId, null, null, pageId)
          await tx
            .update(pages)
            .set({ parentId: null, position })
            .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        }
      }
      const ids = await this.subtreeIds(tx, workspaceId, pageId)
      await tx
        .update(pages)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, ids)))
      return toPage(await access.pageRow(tx, workspaceId, pageId))
    },

    /** Gone. The caller is responsible for telling collab to forget the documents. */
    async purge(tx: Tx, workspaceId: string, pageId: string) {
      const ids = await this.subtreeIds(tx, workspaceId, pageId)
      if (ids.length === 0) throw KernError.notFound('Page')
      await tx.delete(pages).where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, ids)))
      return { ids }
    },

    /** The first page of a brand new space, so a space is never an empty screen. */
    firstPosition: () => initialRank(),
  }
}
export type QuirePages = ReturnType<typeof quirePages>
