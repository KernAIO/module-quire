import type { Principal } from '@kernhq/contracts'
import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Comment, CommentThread } from '../../contract/index.js'
import { comments } from '../schema.js'
import type { QuireAccess } from './access.js'

type CommentRow = typeof comments.$inferSelect

export function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Comment['workspaceId'],
    pageId: row.pageId,
    parentId: row.parentId,
    threadId: row.threadId,
    authorId: row.authorId as Comment['authorId'],
    body: row.body as Comment['body'],
    bodyText: row.bodyText,
    mentionIds: row.mentionIds as Comment['mentionIds'],
    anchor: row.anchor as Comment['anchor'],
    quotedText: row.quotedText,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy as Comment['resolvedBy'],
    editedAt: row.editedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Flatten a comment body to text, for search and for a notification's one-line preview.
 *
 * Deliberately dumb: it walks whatever the editor produced and takes the `text` leaves. A renderer
 * that understood every node would have to be kept in step with the editor's schema, and the only
 * thing this is used for is a line of plain prose.
 */
export function flattenBody(body: unknown): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; content?: unknown[] }
    if (typeof n.text === 'string') out.push(n.text)
    if (Array.isArray(n.content)) for (const child of n.content) walk(child)
  }
  walk(body)
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

/** Every user id mentioned in the body, so they can be notified without a second parse. */
export function mentionsIn(body: unknown): string[] {
  const ids = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; attrs?: { id?: unknown }; content?: unknown[] }
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') ids.add(n.attrs.id)
    if (Array.isArray(n.content)) for (const child of n.content) walk(child)
  }
  walk(body)
  return [...ids]
}

export function quireComments(access: QuireAccess) {
  return {
    async list(tx: Tx, workspaceId: string, pageId: string, includeResolved: boolean) {
      await access.pageRow(tx, workspaceId, pageId)
      const rows = await tx
        .select()
        .from(comments)
        .where(
          and(eq(comments.workspaceId, workspaceId), eq(comments.pageId, pageId), isNull(comments.deletedAt)),
        )
        .orderBy(asc(comments.createdAt))

      const byThread = new Map<string, CommentRow[]>()
      for (const row of rows) {
        const list = byThread.get(row.threadId) ?? []
        list.push(row)
        byThread.set(row.threadId, list)
      }

      const threads: CommentThread[] = []
      for (const [threadId, list] of byThread) {
        const root = list.find((r) => r.id === threadId)
        // A thread whose root was deleted while replies remain: the replies are still somebody's
        // words, so the thread is kept and the oldest remaining comment leads it.
        const lead = root ?? list[0]
        if (!lead) continue
        const resolved = Boolean(lead.resolvedAt)
        if (resolved && !includeResolved) continue
        threads.push({
          id: threadId,
          root: toComment(lead),
          replies: list.filter((r) => r.id !== lead.id).map(toComment),
          resolved,
        })
      }
      return threads
    },

    async row(tx: Tx, workspaceId: string, commentId: string) {
      const [row] = await tx
        .select()
        .from(comments)
        .where(
          and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId), isNull(comments.deletedAt)),
        )
        .limit(1)
      if (!row) throw KernError.notFound('Comment')
      return row
    },

    async create(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: {
        pageId: string
        body: Record<string, unknown>
        anchor: { from: string; to: string } | null
        quotedText: string
        parentId: string | null
      },
    ) {
      await access.pageRow(tx, workspaceId, input.pageId)

      let threadId = uuidv7()
      if (input.parentId) {
        const parent = await this.row(tx, workspaceId, input.parentId)
        if (parent.pageId !== input.pageId) throw KernError.badRequest('That comment is on a different page')
        // Replying to a reply joins the thread rather than nesting further: a margin note is a
        // conversation, and arbitrary depth in a 320px column is unreadable.
        threadId = parent.threadId
      }

      const id = uuidv7()
      const [row] = await tx
        .insert(comments)
        .values({
          id,
          workspaceId,
          pageId: input.pageId,
          parentId: input.parentId,
          threadId: input.parentId ? threadId : id,
          authorId: principal.userId,
          body: input.body,
          bodyText: flattenBody(input.body),
          mentionIds: mentionsIn(input.body),
          anchor: input.anchor,
          quotedText: input.quotedText,
        })
        .returning()
      return row!
    },

    async update(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      commentId: string,
      body: Record<string, unknown>,
    ) {
      const row = await this.row(tx, workspaceId, commentId)
      // Editing somebody else's words is not a permission anybody should hold.
      if (row.authorId !== principal.userId) throw KernError.forbidden('quire.page.comment')
      const [updated] = await tx
        .update(comments)
        .set({
          body,
          bodyText: flattenBody(body),
          mentionIds: mentionsIn(body),
          editedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)))
        .returning()
      return updated!
    },

    /** Soft, so a thread does not lose its shape when one remark in the middle goes. */
    async remove(tx: Tx, principal: Principal, workspaceId: string, commentId: string) {
      const row = await this.row(tx, workspaceId, commentId)
      if (row.authorId !== principal.userId && !principal.instanceAdmin) {
        const scope = await access.scopeOf(tx, workspaceId, row.pageId)
        await access.requirePage(principal, 'quire.page.manage', workspaceId, scope)
      }
      await tx
        .update(comments)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)))
      return row
    },

    /** Resolving is a property of the thread, so it is written on the root. */
    async resolve(tx: Tx, principal: Principal, workspaceId: string, commentId: string, resolved: boolean) {
      const row = await this.row(tx, workspaceId, commentId)
      await tx
        .update(comments)
        .set({
          resolvedAt: resolved ? new Date() : null,
          resolvedBy: resolved ? principal.userId : null,
          updatedAt: new Date(),
        })
        .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, row.threadId)))
      return row
    },
  }
}
export type QuireComments = ReturnType<typeof quireComments>
