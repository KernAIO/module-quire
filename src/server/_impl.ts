import {
  defineModule,
  defineServerModule,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { MODULE_ID, quireContract, quireEvents } from '../contract/index.js'
import { quireServices } from './services/index.js'
import { documentNameOf } from './services/pages.js'

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

  const run = <T>(
    context: RequestContext,
    workspaceId: string,
    fn: Parameters<typeof kernel.database.withWorkspace<T>>[1],
  ) => kernel.database.withWorkspace(workspaceId, fn, { userId: context.principal.userId })

  /** Both, every time: the event for anything that reacts later, the change for a screen open now. */
  const announce = async (
    workspaceId: string,
    actorId: string | null,
    entity: string,
    id: string,
    op: 'created' | 'updated' | 'deleted',
    scope?: Record<string, string>,
  ) => {
    await kernel.realtime.change(workspaceId, { module: MODULE_ID, entity, id, op, scope })
    void actorId
  }

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
        await announce(input.workspaceId, context.principal.userId, 'space', space.id, 'created')
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
        await announce(workspaceId, context.principal.userId, 'space', spaceId, 'updated')
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
          await announce(input.workspaceId, context.principal.userId, 'space', input.spaceId, 'updated')
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
        await announce(input.workspaceId, context.principal.userId, 'page', page.id, 'created', {
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
        await announce(workspaceId, context.principal.userId, 'page', pageId, 'updated', {
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
        await announce(input.workspaceId, context.principal.userId, 'page', page.id, 'updated', {
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
        await announce(input.workspaceId, context.principal.userId, 'page', page.id, 'updated', {
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
          for (const id of ids)
            await announce(input.workspaceId, context.principal.userId, 'page', id, 'updated', { spaceId })
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
        await announce(input.workspaceId, context.principal.userId, 'page', page.id, 'updated', {
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
        for (const id of ids)
          await announce(input.workspaceId, context.principal.userId, 'page', id, 'deleted', { spaceId })
        return { ok: true as const, count: ids.length }
      }),
    },
  })
}
