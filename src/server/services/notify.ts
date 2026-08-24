import type { core } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import type { comments } from '../schema.js'

/**
 * Everything Quire tells the rest of the platform about, and nothing it needs an answer from.
 *
 * Every call here is best effort. A page must not fail to save, and a comment must not fail to
 * post, because core is briefly unavailable — the module's own row is the authoritative record and
 * a missing notification is a smaller loss than a refused write. Failures are logged, not raised.
 */
export function createNotify(kernel: Kernel) {
  const best = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch (err) {
      kernel.log.warn({ err: String(err), what }, 'quire side effect failed')
      return null
    }
  }

  return {
    /**
     * Tell everyone named in a comment, except whoever wrote it.
     *
     * Notifying somebody that they mentioned themselves is noise, and it is the commonest way an
     * inbox stops being read.
     */
    async mentions(workspaceId: string, comment: typeof comments.$inferSelect, actorId: string | null) {
      const targets = (comment.mentionIds as string[]).filter((id) => id !== actorId)
      if (targets.length === 0) return
      await best('notifications.create', () =>
        Promise.all(
          targets.map((userId) =>
            kernel.call('core.notifications.create', {
              workspaceId,
              userId,
              type: 'quire.mention',
              actorId,
              object: { module: 'quire', type: 'page', id: comment.pageId },
              title: comment.bodyText.slice(0, 140),
              body: comment.quotedText.slice(0, 200) || null,
            }),
          ),
        ),
      )
    },

    /** Put a page in the workspace search index. */
    async index(documents: core.SearchDocument[]) {
      if (documents.length === 0) return
      await best('search.index', () => kernel.call('core.search.index', { documents }))
    },

    async unindex(workspaceId: string, type: string, ids: string[]) {
      if (ids.length === 0) return
      await best('search.remove', () =>
        kernel.call('core.search.remove', {
          refs: ids.map((id) => ({ workspaceId, module: 'quire', type, id })),
        }),
      )
    },
  }
}
export type QuireNotify = ReturnType<typeof createNotify>
