import {
  defineModule,
  defineServerModule,
  KernError,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  type Tx,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { MODULE_ID, quireContract, quireEvents } from '../contract/index.js'
import { toComment } from './services/comments.js'
import { quireServices } from './services/index.js'
import { createNotify } from './services/notify.js'
import { documentNameOf, toPage } from './services/pages.js'
import { toVersion } from './services/versions.js'

/**
 * The router, kept apart from `index.ts` so `module.test.ts` can walk it without booting a kernel.
 *
 * It is deliberately thin: open the workspace-bound transaction, check the space- or page-scoped
 * permission, hand over to a service. `requires` on each procedure is the workspace-level gate — the
 * narrower question ("may you read *this* page") needs the page's ancestor chain, which only exists
 * inside the transaction, so it is asked in the handler through `svc.access`.
 */
export { defineModule, defineServerModule, packageVersion }

const os = implement(quireContract).$context<RequestContext>()

export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))
  const svc = quireServices(kernel)
  const notify = createNotify(kernel)

  const run = <T>(
    context: RequestContext,
    workspaceId: string,
    fn: Parameters<typeof kernel.database.withWorkspace<T>>[1],
  ) => kernel.database.withWorkspace(workspaceId, fn, { userId: context.principal.userId })

  /**
   * "May you do this to *that* page", answered through the page's ancestor chain.
   *
   * `requires()` on the procedure asks the workspace-level question, and a wiki's real question is
   * never workspace-level: a space- or page-scoped binding is what expresses "everyone may read the
   * Handbook, the design team may write it, this contractor may read one page of it", and
   * `requires()` does not look at one. So every page-touching handler asks again, here, with the
   * chain that only exists inside the transaction.
   *
   * A database has no scope of its own — it belongs to a page — so a `databases.*` procedure
   * resolves its host page (or the row's own page) and asks exactly this. Eight of them did not,
   * and `quireProcedureAuthz` plus `authz.int.test.ts` are what stop the ninth.
   */
  const requirePage = async (
    tx: Tx,
    context: RequestContext,
    workspaceId: string,
    pageId: string,
    permission: string,
  ) => {
    const scope = await svc.access.scopeOf(tx, workspaceId, pageId)
    await svc.access.requirePage(context.principal, permission, workspaceId, scope)
    return scope
  }

  /** Both, every time: the event for anything that reacts later, the change for a screen open now. */
  const announce = (
    workspaceId: string,
    entity: string,
    id: string,
    op: 'created' | 'updated' | 'deleted',
    scope?: Record<string, string>,
  ) => kernel.realtime.change(workspaceId, { module: MODULE_ID, entity, id, op, scope })

  return os.router({
    spaces: {
      list: scoped.spaces.list
        .use(requires('quire.space.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.spaces.list(tx, context.principal, input.workspaceId, input.includeArchived),
          ),
        ),

      get: scoped.spaces.get
        .use(requires('quire.space.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.spaces.get(tx, context.principal, input.workspaceId, input.spaceId),
          ),
        ),

      create: scoped.spaces.create.use(requires('quire.space.manage')).handler(async ({ input, context }) => {
        const space = await run(context, input.workspaceId, (tx) =>
          svc.spaces.create(tx, context.principal, input.workspaceId, input),
        )
        await kernel.emit(
          quireEvents.spaceCreated,
          { spaceId: space.id, workspaceId: input.workspaceId },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await announce(input.workspaceId, 'space', space.id, 'created')
        return space
      }),

      update: scoped.spaces.update.use(requires('quire.space.manage')).handler(async ({ input, context }) => {
        const { workspaceId, spaceId, ...patch } = input
        const space = await run(context, workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, workspaceId, spaceId)
          await svc.access.requireSpace(context.principal, 'quire.space.manage', workspaceId, spaceId)
          return svc.spaces.update(tx, workspaceId, spaceId, patch)
        })
        await kernel.emit(
          quireEvents.spaceUpdated,
          { spaceId, workspaceId },
          { workspaceId, actorId: context.principal.userId },
        )
        await announce(workspaceId, 'space', spaceId, 'updated')
        return space
      }),

      archive: scoped.spaces.archive
        .use(requires('quire.space.manage'))
        .handler(async ({ input, context }) => {
          const space = await run(context, input.workspaceId, async (tx) => {
            await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
            await svc.access.requireSpace(
              context.principal,
              'quire.space.manage',
              input.workspaceId,
              input.spaceId,
            )
            return svc.spaces.archive(tx, input.workspaceId, input.spaceId, input.archived)
          })
          await kernel.emit(
            quireEvents.spaceArchived,
            { spaceId: input.spaceId, workspaceId: input.workspaceId, archived: input.archived },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await announce(input.workspaceId, 'space', input.spaceId, 'updated')
          return space
        }),
    },

    pages: {
      tree: scoped.pages.tree.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.page.view',
            input.workspaceId,
            input.spaceId,
          )
          return svc.pages.tree(tx, input.workspaceId, input.spaceId, input.includeArchived)
        }),
      ),

      get: scoped.pages.get.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.view', input.workspaceId, scope)
          return svc.pages.get(tx, input.workspaceId, input.pageId)
        }),
      ),

      trash: scoped.pages.trash.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.page.edit',
            input.workspaceId,
            input.spaceId,
          )
          return svc.pages.trash(tx, input.workspaceId, input.spaceId, input.limit, input.cursor ?? null)
        }),
      ),

      create: scoped.pages.create.use(requires('quire.page.create')).handler(async ({ input, context }) => {
        const page = await run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.page.create',
            input.workspaceId,
            input.spaceId,
          )
          return svc.pages.create(tx, context.principal, input.workspaceId, input)
        })
        await kernel.emit(
          quireEvents.pageCreated,
          { pageId: page.id, spaceId: page.spaceId, workspaceId: input.workspaceId },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await announce(input.workspaceId, 'page', page.id, 'created', {
          spaceId: page.spaceId,
        })
        return page
      }),

      update: scoped.pages.update.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const { workspaceId, pageId, ...patch } = input
        const page = await run(context, workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, workspaceId, pageId)
          await svc.access.requirePage(context.principal, 'quire.page.edit', workspaceId, scope)
          return svc.pages.update(tx, context.principal, workspaceId, pageId, patch)
        })
        await kernel.emit(
          quireEvents.pageUpdated,
          { pageId, spaceId: page.spaceId, workspaceId },
          { workspaceId, actorId: context.principal.userId },
        )
        await announce(workspaceId, 'page', pageId, 'updated', {
          spaceId: page.spaceId,
        })
        return page
      }),

      move: scoped.pages.move.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const page = await run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
          return svc.pages.move(
            tx,
            context.principal,
            input.workspaceId,
            input.pageId,
            input.parentId,
            input.afterId,
          )
        })
        await kernel.emit(
          quireEvents.pageMoved,
          {
            pageId: page.id,
            spaceId: page.spaceId,
            workspaceId: input.workspaceId,
            parentId: page.parentId,
          },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await announce(input.workspaceId, 'page', page.id, 'updated', {
          spaceId: page.spaceId,
        })
        return page
      }),

      archive: scoped.pages.archive.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const page = await run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
          return svc.pages.archive(tx, context.principal, input.workspaceId, input.pageId, input.archived)
        })
        await kernel.emit(
          quireEvents.pageArchived,
          {
            pageId: page.id,
            spaceId: page.spaceId,
            workspaceId: input.workspaceId,
            archived: input.archived,
          },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await announce(input.workspaceId, 'page', page.id, 'updated', {
          spaceId: page.spaceId,
        })
        return page
      }),

      trashPage: scoped.pages.trashPage
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const { ids, spaceId } = await run(context, input.workspaceId, async (tx) => {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
            const res = await svc.pages.trashPage(tx, input.workspaceId, input.pageId)
            return { ...res, spaceId: scope.spaceId }
          })
          await kernel.emit(
            quireEvents.pageTrashed,
            { pageId: input.pageId, spaceId, workspaceId: input.workspaceId, count: ids.length },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          for (const id of ids) await announce(input.workspaceId, 'page', id, 'updated', { spaceId })
          return { ok: true as const, count: ids.length }
        }),

      restore: scoped.pages.restore.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const page = await run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
          return svc.pages.restore(tx, input.workspaceId, input.pageId)
        })
        await kernel.emit(
          quireEvents.pageRestored,
          { pageId: page.id, spaceId: page.spaceId, workspaceId: input.workspaceId },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await announce(input.workspaceId, 'page', page.id, 'updated', {
          spaceId: page.spaceId,
        })
        return page
      }),

      purge: scoped.pages.purge.use(requires('quire.page.delete')).handler(async ({ input, context }) => {
        const { ids, spaceId } = await run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.delete', input.workspaceId, scope)
          const res = await svc.pages.purge(tx, input.workspaceId, input.pageId)
          return { ...res, spaceId: scope.spaceId }
        })

        // Nothing else removes a collaborative document, so a purged page would otherwise keep its
        // prose for ever. Best-effort: the rows are already gone, and a collab service that is
        // briefly down must not turn a successful delete into an error.
        for (const id of ids) {
          await kernel
            .call('collab.document.delete', {
              name: documentNameOf({ workspaceId: input.workspaceId, id }),
            })
            .catch((err) =>
              kernel.log.warn({ err: String(err), pageId: id }, 'could not forget the collab document'),
            )
        }

        await kernel.emit(
          quireEvents.pageDeleted,
          { pageId: input.pageId, spaceId, workspaceId: input.workspaceId, pageIds: ids },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        for (const id of ids) await announce(input.workspaceId, 'page', id, 'deleted', { spaceId })
        return { ok: true as const, count: ids.length }
      }),
    },

    versions: {
      list: scoped.versions.list.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.view', input.workspaceId, scope)
          return svc.versions.list(tx, input.workspaceId, input.pageId, input.limit, input.cursor ?? null)
        }),
      ),

      get: scoped.versions.get.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const row = await svc.versions.row(tx, input.workspaceId, input.versionId)
          const scope = await svc.access.scopeOf(tx, input.workspaceId, row.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.view', input.workspaceId, scope)
          const page = await svc.access.pageRow(tx, input.workspaceId, row.pageId)
          return {
            ...toVersion(row, page.publishedVersionId),
            text: row.text,
            html: await svc.versions.html(tx, input.workspaceId, row.state),
          }
        }),
      ),

      create: scoped.versions.create.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const version = await run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
          const row = await svc.versions.capture(tx, input.workspaceId, input.pageId, {
            kind: 'auto',
            label: input.label,
            authorId: context.principal.userId,
          })
          if (!row) throw KernError.badRequest('There is nothing written to save a version of')
          const page = await svc.access.pageRow(tx, input.workspaceId, input.pageId)
          return toVersion(row, page.publishedVersionId)
        })
        await announce(input.workspaceId, 'page', input.pageId, 'updated')
        return version
      }),

      restore: scoped.versions.restore
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const { version, pageId } = await run(context, input.workspaceId, async (tx) => {
            const row = await svc.versions.row(tx, input.workspaceId, input.versionId)
            const scope = await svc.access.scopeOf(tx, input.workspaceId, row.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
            const restored = await svc.versions.restore(
              tx,
              context.principal,
              input.workspaceId,
              input.versionId,
            )
            const page = await svc.access.pageRow(tx, input.workspaceId, row.pageId)
            return { version: toVersion(restored, page.publishedVersionId), pageId: row.pageId }
          })
          await kernel.emit(
            quireEvents.pageRestoredVersion,
            { pageId, workspaceId: input.workspaceId, versionId: input.versionId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await announce(input.workspaceId, 'page', pageId, 'updated')
          return version
        }),
    },

    comments: {
      list: scoped.comments.list.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
          await svc.access.requirePage(context.principal, 'quire.page.view', input.workspaceId, scope)
          return svc.comments.list(tx, input.workspaceId, input.pageId, input.includeResolved)
        }),
      ),

      create: scoped.comments.create
        .use(requires('quire.page.comment'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.comment', input.workspaceId, scope)
            return svc.comments.create(tx, context.principal, input.workspaceId, input)
          })

          // Everyone named in the body, except whoever wrote it — telling somebody they mentioned
          // themselves is noise, and it is the commonest way a notification inbox loses trust.
          await notify.mentions(input.workspaceId, row, context.principal.userId)
          await kernel.emit(
            quireEvents.commentCreated,
            { commentId: row.id, pageId: input.pageId, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await announce(input.workspaceId, 'comment', row.id, 'created', { pageId: input.pageId })
          return toComment(row)
        }),

      /**
       * A remark is on a page, so a space that has been closed to somebody closes its margins too.
       *
       * These three worked from a comment id alone and never resolved the page behind it, so a
       * space-scoped DENY stopped nobody from settling a thread — or from editing and deleting
       * their own words on a page they had been shut out of. The author rule inside the service is
       * a *second* question ("are these your words"), not a substitute for this one.
       */
      update: scoped.comments.update
        .use(requires('quire.page.comment'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const target = await svc.comments.row(tx, input.workspaceId, input.commentId)
            await requirePage(tx, context, input.workspaceId, target.pageId, 'quire.page.comment')
            return svc.comments.update(tx, context.principal, input.workspaceId, input.commentId, input.body)
          })
          await announce(input.workspaceId, 'comment', row.id, 'updated', { pageId: row.pageId })
          return toComment(row)
        }),

      remove: scoped.comments.remove
        .use(requires('quire.page.comment'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const target = await svc.comments.row(tx, input.workspaceId, input.commentId)
            await requirePage(tx, context, input.workspaceId, target.pageId, 'quire.page.comment')
            return svc.comments.remove(tx, context.principal, input.workspaceId, input.commentId)
          })
          await announce(input.workspaceId, 'comment', row.id, 'deleted', { pageId: row.pageId })
          return { ok: true as const }
        }),

      resolve: scoped.comments.resolve
        .use(requires('quire.page.comment'))
        .handler(async ({ input, context }) => {
          const threads = await run(context, input.workspaceId, async (tx) => {
            const target = await svc.comments.row(tx, input.workspaceId, input.commentId)
            await requirePage(tx, context, input.workspaceId, target.pageId, 'quire.page.comment')
            const row = await svc.comments.resolve(
              tx,
              context.principal,
              input.workspaceId,
              input.commentId,
              input.resolved,
            )
            const all = await svc.comments.list(tx, input.workspaceId, row.pageId, true)
            const thread = all.find((t) => t.id === row.threadId)
            if (!thread) throw KernError.notFound('Comment')
            return { thread, pageId: row.pageId }
          })
          await announce(input.workspaceId, 'comment', threads.thread.id, 'updated', {
            pageId: threads.pageId,
          })
          return threads.thread
        }),
    },

    databases: {
      get: scoped.databases.get.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const db = await svc.databases.get(tx, input.workspaceId, input.databaseId)
          await requirePage(tx, context, input.workspaceId, db.pageId, 'quire.page.view')
          return db
        }),
      ),

      list: scoped.databases.list.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.space.view',
            input.workspaceId,
            input.spaceId,
          )
          return svc.databases.list(tx, input.workspaceId, input.spaceId)
        }),
      ),

      forPage: scoped.databases.forPage.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          return svc.databases.forPage(tx, input.workspaceId, input.pageId)
        }),
      ),

      lookup: scoped.databases.lookup.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const pageId = await svc.databases.pageOfDatabase(tx, input.workspaceId, input.databaseId)
          await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.view')
          return svc.databases.lookup(tx, input.workspaceId, input.databaseId, {
            query: input.query,
            ids: input.ids,
            limit: input.limit,
          })
        }),
      ),

      create: scoped.databases.create.use(requires('quire.page.edit')).handler(async ({ input, context }) => {
        const db = await run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.edit')
          return svc.databases.create(tx, context.principal, input.workspaceId, input)
        })
        await announce(input.workspaceId, 'page', input.pageId, 'updated', { spaceId: input.spaceId })
        return db
      }),

      rows: scoped.databases.rows.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const db = await svc.databases.get(tx, input.workspaceId, input.databaseId)
          await requirePage(tx, context, input.workspaceId, db.pageId, 'quire.page.view')
          const view = input.viewId
            ? (db.views.find((v) => v.id === input.viewId) ?? null)
            : (db.views.find((v) => v.isDefault) ?? db.views[0] ?? null)
          return svc.databases.rows(tx, input.workspaceId, input.databaseId, {
            view,
            limit: input.limit,
            cursor: input.cursor ?? null,
          })
        }),
      ),

      addRow: scoped.databases.addRow
        .use(requires('quire.page.create'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const db = await svc.databases.get(tx, input.workspaceId, input.databaseId)
            await requirePage(tx, context, input.workspaceId, db.pageId, 'quire.page.create')
            // A row is a page: created in the same space, parented to the database's own page, so it
            // is reachable, versioned and commentable like anything else.
            const created = await svc.pages.create(tx, context.principal, input.workspaceId, {
              spaceId: db.spaceId,
              parentId: db.pageId,
              title: input.title,
              kind: 'page',
              icon: null,
              afterId: null,
            })
            await svc.databases.setRowFields(tx, input.workspaceId, created.id, input.databaseId, input.props)
            await svc.databases.recompute(tx, input.workspaceId, created.id)
            return svc.databases.rowById(tx, input.workspaceId, created.id)
          })
          await announce(input.workspaceId, 'row', row.id, 'created', { databaseId: input.databaseId })
          return row
        }),

      updateRow: scoped.databases.updateRow
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            await requirePage(tx, context, input.workspaceId, input.rowId, 'quire.page.edit')
            if (input.title !== undefined)
              await svc.pages.update(tx, context.principal, input.workspaceId, input.rowId, {
                title: input.title,
              })
            /**
             * A relation cell edited from a table arrives in `props` like any other, and writing it
             * there would leave the join table — which is what a rollup walks and what the other
             * side reads — untouched. Split those keys out and route them through `setRelation`, so
             * the two stores cannot diverge whichever surface did the editing.
             */
            if (input.props) {
              const row = await svc.databases.rowById(tx, input.workspaceId, input.rowId)
              const db = row.databaseId
                ? await svc.databases.get(tx, input.workspaceId, row.databaseId)
                : null
              const relationProps = (db?.properties ?? []).filter((p) => p.type === 'relation')
              const plain: Record<string, unknown> = {}
              for (const [key, value] of Object.entries(input.props)) {
                const relation = relationProps.find((p) => p.key === key)
                if (relation)
                  await svc.databases.setRelation(
                    tx,
                    input.workspaceId,
                    relation.id,
                    input.rowId,
                    (Array.isArray(value) ? value : value == null ? [] : [value]).map(String),
                  )
                else plain[key] = value
              }
              if (Object.keys(plain).length > 0)
                await svc.databases.setRowFields(tx, input.workspaceId, input.rowId, null, plain)
            }
            await svc.databases.recompute(tx, input.workspaceId, input.rowId)
            // Anything rolling this row up is now stale.
            for (const id of await svc.databases.dependentsOf(tx, input.workspaceId, input.rowId))
              await svc.databases.recompute(tx, input.workspaceId, id)
            return svc.databases.rowById(tx, input.workspaceId, input.rowId)
          })
          await announce(input.workspaceId, 'row', row.id, 'updated', { databaseId: row.databaseId })
          return row
        }),

      /**
       * Every schema change announces `database`.
       *
       * Adding a column, hiding one, or adding a view changes what *every* open tab of this
       * database is drawing, and none of these announced anything — so a second person's table kept
       * the old columns until they reloaded, which reads as their edit having been lost.
       *
       * And every one of them resolves the database's host page first. A column id and a view id
       * are the only things these procedures are given, and neither carries a scope — so without
       * `pageOfProperty`/`pageOfView` there is nothing to ask the permission question about, which
       * is precisely why the question went unasked here and nowhere else.
       */
      addProperty: scoped.databases.addProperty
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const property = await run(context, input.workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfDatabase(tx, input.workspaceId, input.databaseId)
            await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.edit')
            return svc.databases.addProperty(tx, input.workspaceId, input.databaseId, input)
          })
          await announce(input.workspaceId, 'database', input.databaseId, 'updated')
          return property
        }),

      updateProperty: scoped.databases.updateProperty
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const { workspaceId, propertyId, ...patch } = input
          const property = await run(context, workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfProperty(tx, workspaceId, propertyId)
            await requirePage(tx, context, workspaceId, pageId, 'quire.page.edit')
            return svc.databases.updateProperty(tx, workspaceId, propertyId, patch as never)
          })
          await announce(workspaceId, 'database', property.databaseId, 'updated')
          return property
        }),

      moveProperty: scoped.databases.moveProperty
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const property = await run(context, input.workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfProperty(tx, input.workspaceId, input.propertyId)
            await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.edit')
            return svc.databases.moveProperty(tx, input.workspaceId, input.propertyId, input.afterId)
          })
          await announce(input.workspaceId, 'database', property.databaseId, 'updated')
          return property
        }),

      removeProperty: scoped.databases.removeProperty
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const property = await run(context, input.workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfProperty(tx, input.workspaceId, input.propertyId)
            await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.edit')
            return svc.databases.removeProperty(tx, input.workspaceId, input.propertyId)
          })
          await announce(input.workspaceId, 'database', property.databaseId, 'updated')
          return { ok: true as const }
        }),

      addView: scoped.databases.addView
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const view = await run(context, input.workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfDatabase(tx, input.workspaceId, input.databaseId)
            await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.edit')
            return svc.databases.addView(tx, input.workspaceId, input.databaseId, input as never)
          })
          await announce(input.workspaceId, 'database', input.databaseId, 'updated')
          return view
        }),

      updateView: scoped.databases.updateView
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const { workspaceId, viewId, ...patch } = input
          const view = await run(context, workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfView(tx, workspaceId, viewId)
            await requirePage(tx, context, workspaceId, pageId, 'quire.page.edit')
            return svc.databases.updateView(tx, workspaceId, viewId, patch as never)
          })
          await announce(workspaceId, 'database', view.databaseId, 'updated')
          return view
        }),

      removeView: scoped.databases.removeView
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const view = await run(context, input.workspaceId, async (tx) => {
            const pageId = await svc.databases.pageOfView(tx, input.workspaceId, input.viewId)
            await requirePage(tx, context, input.workspaceId, pageId, 'quire.page.edit')
            return svc.databases.removeView(tx, input.workspaceId, input.viewId)
          })
          await announce(input.workspaceId, 'database', view.databaseId, 'updated')
          return { ok: true as const }
        }),

      setRelation: scoped.databases.setRelation
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          await run(context, input.workspaceId, async (tx) => {
            await requirePage(tx, context, input.workspaceId, input.rowId, 'quire.page.edit')
            await svc.databases.setRelation(
              tx,
              input.workspaceId,
              input.propertyId,
              input.rowId,
              input.toPageIds,
            )
          })
          await announce(input.workspaceId, 'row', input.rowId, 'updated')
          return { ok: true as const }
        }),
    },

    publishing: {
      publish: scoped.publishing.publish
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.publish', input.workspaceId, scope)
            return svc.versions.publish(tx, context.principal, input.workspaceId, input.pageId, input.label)
          })
          await kernel.emit(
            quireEvents.pagePublished,
            {
              pageId: input.pageId,
              spaceId: row.spaceId,
              workspaceId: input.workspaceId,
              versionId: row.publishedVersionId ?? '',
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await announce(input.workspaceId, 'page', input.pageId, 'updated', { spaceId: row.spaceId })
          return toPage(row)
        }),

      revert: scoped.publishing.revert
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.edit', input.workspaceId, scope)
            return svc.versions.revert(tx, context.principal, input.workspaceId, input.pageId)
          })
          await announce(input.workspaceId, 'page', input.pageId, 'updated', { spaceId: row.spaceId })
          return toPage(row)
        }),
    },
  })
}
