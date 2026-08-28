import { ANONYMOUS } from '@kernhq/contracts'
import {
  defineModule,
  defineServerModule,
  KernError,
  type Kernel,
  o,
  packageVersion,
  type RequestContext,
  requires,
  type Tx,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import type { Publication, PublicBreadcrumb } from '../contract/index.js'
import { MODULE_ID, quireContract, quireEvents } from '../contract/index.js'
import { toComment } from './services/comments.js'
import { quireServices, resolveWorkspaceSegment } from './services/index.js'
import { createNotify } from './services/notify.js'
import { documentNameOf, toPage } from './services/pages.js'
import { type PublicNode, toPublication } from './services/publications.js'
import { toTemplate } from './services/templates.js'
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

/**
 * The anonymous counterpart of `workspaceScoped`, for the `public.*` surface and nothing else.
 *
 * `workspaceScoped` rejects an anonymous principal outright, which is exactly right for every other
 * procedure in this module and impossible for these six. What is still worth keeping from it is the
 * module switch: a workspace that has turned Quire off must not keep serving its published sites,
 * and the answer is **404 rather than `MODULE_DISABLED`**, because a signed-out stranger asking for
 * a URL is owed "there is nothing here" and not "there is something here that this customer has
 * switched off". The one thing it must not do is `requireMember`.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const publicSurface = o.middleware(async ({ context, next }, input) => {
  const { workspaceId } = input as { workspaceId?: unknown }
  /*
   * A middleware runs *before* the contract validates its input, so this is the first and only
   * thing that sees the workspace segment — and it used to hand whatever arrived to
   * `kernel.isModuleEnabled`, whose own schema is `z.uuid()`. So `/api/quire/public/not-a-uuid/x`
   * came back as a ZodError this module has no case for: **HTTP 500** on the one surface that
   * promises everything unresolvable is a 404, and a stack trace written at error level for every
   * such request, on an endpoint anyone on the internet can reach as fast as they like.
   *
   * The shape is checked here instead. Anything that is not a workspace id is the same "there is
   * nothing here" as a workspace that has switched Quire off — which is the right answer, because a
   * signed-out stranger is owed no more than that. `.catch` covers the rest for the same reason: a
   * settings lookup that fails must not become a 500 either.
   */
  if (typeof workspaceId !== 'string')
    throw new KernError('NOT_FOUND', 'There is no published site at this address')
  /*
   * A public URL names its workspace by **slug**, because the address the share dialog copies is
   * meant to be sent to somebody — and a uuid in a link is a receipt, not an address. This
   * middleware is the first thing that sees the segment, so it is also the first thing that used to
   * refuse it: a `UUID.test` here answered 404 for the module's own published URLs while the same
   * site served perfectly under its id. Resolving happens here so that `isModuleEnabled` below is
   * asked about a workspace rather than about a slug, whose schema is `z.uuid()` and would 500.
   *
   * A slug that names no workspace, and a slug that names one with no such publication, both reach
   * the same 404 as a workspace nobody has — so this resolves an address without answering "does
   * this workspace exist" for anyone who asks.
   */
  const resolved = await resolveWorkspaceSegment(context.kernel, workspaceId).catch(() => null)
  if (!resolved) throw new KernError('NOT_FOUND', 'There is no published site at this address')
  const enabled = await context.kernel.isModuleEnabled(resolved, MODULE_ID).catch(() => false)
  if (!enabled) throw new KernError('NOT_FOUND', 'There is no published site at this address')
  return next()
})

/**
 * Serve a public procedure to its author exactly as it is served to a stranger.
 *
 * The principal is replaced, not merely ignored. A signed-in author opening their own published URL
 * is the *only* person who ever checks whether a public site works, so a handler that could quietly
 * consult `context.principal` would show them a site nobody else can see — and the failure is
 * invisible in exactly the situation where somebody is looking for it. With the principal gone
 * there is nothing to consult: `userId` is null, there are no memberships, and any permission
 * question a future handler asked would be answered for a stranger.
 *
 * `authz.int.test.ts` asserts the consequence rather than the mechanism — every `check: 'public'`
 * procedure must answer a denied administrator and an anonymous request identically.
 */
const anonymousOnly = o.middleware(({ context, next }) =>
  next({ context: { ...context, principal: ANONYMOUS } }),
)

/**
 * The one refusal every unservable publication shares, in one place so it cannot drift.
 *
 * It drifted. A publication whose root page had since been trashed was 404 from `site` and `page`,
 * **200 with an empty body** from `search` and `sitemap`, and `indexable: true` from `robots` — so
 * four procedures written to be indistinguishable from "no such slug" were, between them, an
 * existence oracle for a fifth state nobody had enumerated. And `page` said "page" where the others
 * said "site", which separated a locked publication from a missing one on the endpoint least able
 * to afford it.
 *
 * The rule the wording now follows: **a refusal about the publication says "site", and a refusal
 * about a path inside a servable one says "page".** A reader who mistypes a page of a real handbook
 * is the only person who ever sees the second sentence.
 */
const noSite = () => new KernError('NOT_FOUND', 'There is no published site at this address')

export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))
  const open = os.use(publicSurface).use(anonymousOnly)
  const svc = quireServices(kernel)
  const notify = createNotify(kernel)

  /**
   * A publication that can actually be served, and its whole tree, or `noSite`.
   *
   * Every anonymous read but `site` and `robots` starts here, so the four ways of not being
   * servable — no such slug, expired, still locked, nothing left under the root — are one answer
   * written once rather than four handlers agreeing by hand. `site` needs its own shape because
   * `locked` is a state it reports rather than refuses, and `robots` because it never refuses at
   * all.
   */
  const servable = async (tx: Tx, workspaceId: string, slug: string, token: string | null) => {
    const pub = await svc.publications.bySlug(tx, workspaceId, slug)
    if (!(await svc.publications.unlocked(pub, token))) throw noSite()
    const nodes = await svc.publications.tree(tx, workspaceId, pub)
    if (!nodes[0]) throw noSite()
    return { pub, nodes }
  }

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

  /**
   * The caller as a person, for the procedures that only make sense as one.
   *
   * `principal.userId` is null for a service principal, and a favourite, a watch and a recent view
   * all belong to somebody: a service is a caller with no sidebar, not one whose sidebar is empty.
   * The two shortcuts around this both end badly — `?? ''` fails the insert on a uuid column, and a
   * nil-uuid sentinel silently pools every service that ever calls into one shared person's list,
   * which is a privacy bug wearing a default value. So it refuses instead.
   */
  const asPerson = (context: RequestContext): string => {
    const userId = context.principal.userId
    if (!userId) throw new KernError('FORBIDDEN', 'These belong to a person, and this caller is a service')
    return userId
  }

  /** Both, every time: the event for anything that reacts later, the change for a screen open now. */
  const announce = (
    workspaceId: string,
    entity: string,
    id: string,
    op: 'created' | 'updated' | 'deleted',
    scope?: Record<string, string>,
  ) => kernel.realtime.change(workspaceId, { module: MODULE_ID, entity, id, op, scope })

  /**
   * The same, for the one entity a workspace-wide broadcast should not carry.
   *
   * A transfer is fenced to the person who asked for it everywhere else — `list` returns only their
   * rows, `get` answers NOT_FOUND rather than FORBIDDEN for anyone else's id — and announcing it on
   * the workspace channel handed every member the id and the moment it was created, which is the
   * fact the NOT_FOUND exists to withhold. `services/export.ts` carries the long version.
   */
  const announceToRequester = (
    workspaceId: string,
    userId: string,
    entity: 'export' | 'import',
    id: string,
    op: 'created' | 'updated' | 'deleted',
  ) =>
    kernel.realtime.toUser(userId, {
      t: 'change',
      workspaceId: workspaceId as Publication['workspaceId'],
      change: { module: MODULE_ID, entity, id, op },
    })

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
          return svc.pages.trash(
            tx,
            context.principal,
            input.workspaceId,
            input.spaceId,
            input.limit,
            input.cursor ?? null,
          )
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

      setLabels: scoped.pages.setLabels
        .use(requires('quire.page.edit'))
        .handler(async ({ input, context }) => {
          const { labels, spaceId } = await run(context, input.workspaceId, async (tx) => {
            const scope = await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.edit')
            return {
              labels: await svc.organisation.setLabels(
                tx,
                input.workspaceId,
                input.pageId,
                scope.spaceId,
                input.labelIds,
              ),
              spaceId: scope.spaceId,
            }
          })
          await announce(input.workspaceId, 'page', input.pageId, 'updated', { spaceId })
          return labels
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

    labels: {
      list: scoped.labels.list.use(requires('quire.space.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.space.view',
            input.workspaceId,
            input.spaceId,
          )
          return svc.organisation.listLabels(tx, input.workspaceId, input.spaceId)
        }),
      ),

      forPage: scoped.labels.forPage.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          return svc.organisation.labelsForPage(tx, input.workspaceId, input.pageId)
        }),
      ),

      create: scoped.labels.create.use(requires('quire.space.manage')).handler(async ({ input, context }) => {
        const label = await run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.space.manage',
            input.workspaceId,
            input.spaceId,
          )
          return svc.organisation.createLabel(tx, input.workspaceId, input.spaceId, input)
        })
        await announce(input.workspaceId, 'label', label.id, 'created', { spaceId: input.spaceId })
        return label
      }),

      /**
       * A label id carries no scope of its own, so the row is read first and the space it belongs to
       * is what the permission question is asked about — the same shape as a `databases.*` procedure
       * resolving its host page, and for the same reason: eight of those asked nothing at all.
       */
      update: scoped.labels.update.use(requires('quire.space.manage')).handler(async ({ input, context }) => {
        const label = await run(context, input.workspaceId, async (tx) => {
          const existing = await svc.organisation.labelRow(tx, input.workspaceId, input.labelId)
          await svc.access.requireSpace(
            context.principal,
            'quire.space.manage',
            input.workspaceId,
            existing.spaceId,
          )
          return svc.organisation.updateLabel(tx, input.workspaceId, input.labelId, input)
        })
        await announce(input.workspaceId, 'label', label.id, 'updated', { spaceId: label.spaceId })
        return label
      }),

      remove: scoped.labels.remove.use(requires('quire.space.manage')).handler(async ({ input, context }) => {
        const spaceId = await run(context, input.workspaceId, async (tx) => {
          const existing = await svc.organisation.labelRow(tx, input.workspaceId, input.labelId)
          await svc.access.requireSpace(
            context.principal,
            'quire.space.manage',
            input.workspaceId,
            existing.spaceId,
          )
          await svc.organisation.removeLabel(tx, input.workspaceId, input.labelId)
          return existing.spaceId
        })
        await announce(input.workspaceId, 'label', input.labelId, 'deleted', { spaceId })
        return { ok: true as const }
      }),
    },

    /**
     * Favourites, watches and recents are one person's own, so every one of these takes the caller's
     * id from the principal rather than from the input — an input a client fills in is an input a
     * client can fill in with somebody else's id.
     *
     * Nothing here announces a realtime change. A `change` is broadcast to the whole workspace, and
     * one person starring a page is not news to anybody else's open tab — announcing it would wake
     * every session in the workspace to redraw a sidebar that has not moved. The one thing here that
     * *is* shared, the watcher list, is read when the page is opened.
     */
    favorites: {
      list: scoped.favorites.list
        .use(requires('quire.page.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.organisation.listFavorites(tx, context.principal, input.workspaceId, asPerson(context)),
          ),
        ),

      add: scoped.favorites.add.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          // You have to be able to read a page to put it in your own sidebar.
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          await svc.organisation.addFavorite(tx, input.workspaceId, asPerson(context), input.pageId)
          return svc.organisation.listFavorites(tx, context.principal, input.workspaceId, asPerson(context))
        }),
      ),

      /**
       * Deliberately not page-checked. A shortcut to a page you may no longer open is precisely the
       * one you want to be rid of, and gating its removal on reading the page would strand it in
       * the sidebar for good.
       */
      remove: scoped.favorites.remove.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.organisation.removeFavorite(tx, input.workspaceId, asPerson(context), input.pageId)
          return svc.organisation.listFavorites(tx, context.principal, input.workspaceId, asPerson(context))
        }),
      ),

      reorder: scoped.favorites.reorder.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.organisation.reorderFavorite(
            tx,
            input.workspaceId,
            asPerson(context),
            input.pageId,
            input.afterId,
          )
          return svc.organisation.listFavorites(tx, context.principal, input.workspaceId, asPerson(context))
        }),
      ),
    },

    watchers: {
      get: scoped.watchers.get.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          return svc.organisation.watchState(tx, input.workspaceId, input.pageId, asPerson(context))
        }),
      ),

      set: scoped.watchers.set.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          return svc.organisation.setWatching(
            tx,
            input.workspaceId,
            input.pageId,
            asPerson(context),
            input.watching,
          )
        }),
      ),
    },

    recents: {
      list: scoped.recents.list
        .use(requires('quire.page.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.organisation.listRecents(
              tx,
              context.principal,
              input.workspaceId,
              asPerson(context),
              input.limit,
            ),
          ),
        ),

      record: scoped.recents.record.use(requires('quire.page.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.view')
          await svc.organisation.recordRecent(tx, input.workspaceId, asPerson(context), input.pageId)
          return { ok: true as const }
        }),
      ),
    },

    /**
     * Taking work out.
     *
     * The handler is deliberately thin, because nothing about an export can be decided here: which
     * pages go in is a per-page permission question asked as the requester against a tree that may
     * be five hundred deep, and rendering one is a round trip to storage and possibly to Chromium.
     * All three of those outlive an HTTP request, so this records a row, hands it to a worker, and
     * answers with something to watch.
     *
     * The one thing it *does* decide is whether this person may ask at all, and that is asked twice
     * over: `requires` puts the workspace-level gate on the procedure, and the handler resolves the
     * target — a page's own ancestor chain, or the space — and asks again at the narrow scope. The
     * second check is the one a page-scoped DENY can reach.
     */
    exports: {
      start: scoped.exports.start.use(requires('quire.page.export')).handler(async ({ input, context }) => {
        const row = await run(context, input.workspaceId, async (tx) => {
          if (input.scope === 'space') {
            await svc.access.spaceRow(tx, input.workspaceId, input.targetId)
            await svc.access.requireSpace(
              context.principal,
              'quire.page.export',
              input.workspaceId,
              input.targetId,
            )
          } else {
            await requirePage(tx, context, input.workspaceId, input.targetId, 'quire.page.export')
          }
          // Expired artefacts go now, and jobs that lost their worker are failed now, in the
          // workspace whose transaction is already open — see the notes on `sweep` and `reap` for
          // why neither is a cron job. Neither may take a request down, hence the catch.
          await svc.exports.sweep(tx, input.workspaceId).catch(() => 0)
          await svc.exports.reap(tx, input.workspaceId).catch(() => 0)
          return svc.exports.start(tx, context.principal, input.workspaceId, input)
        })

        /*
         * Sent after the row is committed, so the worker cannot reach for a row that is not there
         * yet. If the queue refuses the job the row would otherwise sit `queued` for ever, looking
         * like work in progress — so it is failed here, with the reason, rather than left hanging.
         */
        try {
          await kernel.jobs.send('quire.export', { workspaceId: input.workspaceId, jobId: row.id })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          kernel.log.error({ err: message, jobId: row.id }, 'quire: an export could not be queued')
          await run(context, input.workspaceId, (tx) =>
            svc.exports.fail(tx, input.workspaceId, row.id, message),
          )
          throw new KernError('UNAVAILABLE', 'The export could not be queued. Try again in a moment.')
        }
        await announceToRequester(input.workspaceId, row.requestedBy, 'export', row.id, 'created')
        return { ...svc.exports.toExportJob(row), downloadUrl: null }
      }),

      get: scoped.exports.get.use(requires('quire.page.export')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const row = await svc.exports.get(tx, input.workspaceId, input.jobId, context.principal)
          return {
            ...svc.exports.toExportJob(row),
            downloadUrl: await svc.exports.downloadUrl(tx, input.workspaceId, row),
          }
        }),
      ),

      list: scoped.exports.list.use(requires('quire.page.export')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.exports.sweep(tx, input.workspaceId).catch(() => 0)
          // This list is polled every two seconds while anything on it is running, so it is the
          // thing that ends a job whose worker went away rather than drawing its spinner for ever.
          await svc.exports.reap(tx, input.workspaceId).catch(() => 0)
          const rows = await svc.exports.list(tx, input.workspaceId, context.principal, input.limit)
          return rows.map(svc.exports.toExportJob)
        }),
      ),
    },

    imports: {
      /**
       * Queue one.
       *
       * The permission is checked here **and** again inside the job, and the two are not the same
       * check. This one refuses a request before a row exists; the one in the job refuses to write
       * after the queue has held the work for a minute, which is where a permission taken away in
       * the meantime would otherwise be missed. `services/import.ts` does both, so the order they
       * happen in cannot drift between the router and the worker.
       */
      start: scoped.imports.start.use(requires('quire.page.import')).handler(async ({ input, context }) => {
        const row = await run(context, input.workspaceId, async (tx) => {
          // Jobs that lost their worker are failed now, in the workspace whose transaction is
          // already open — see `reap` for why this is not a cron job, and why it marks rather than
          // deletes. It must not take the request down, hence the catch.
          await svc.imports.reap(tx, input.workspaceId).catch(() => 0)
          return svc.imports.start(tx, context.principal, input.workspaceId, input)
        })

        /*
         * Sent after the row is committed, so the worker cannot reach for a row that is not there
         * yet. If the queue refuses the job the row would otherwise sit `queued` for ever, looking
         * like an import in progress to somebody waiting to see whether their pages arrived — so it
         * is failed here, with the reason, rather than left hanging.
         */
        try {
          await kernel.jobs.send('quire.import', { workspaceId: input.workspaceId, jobId: row.id })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          kernel.log.error({ err: message, jobId: row.id }, 'quire: an import could not be queued')
          await run(context, input.workspaceId, (tx) =>
            svc.imports.fail(tx, input.workspaceId, row.id, message),
          )
          throw new KernError('UNAVAILABLE', 'The import could not be queued. Try again in a moment.')
        }
        await announceToRequester(input.workspaceId, row.requestedBy, 'import', row.id, 'created')
        return svc.imports.toImportJob(row)
      }),

      get: scoped.imports.get
        .use(requires('quire.page.import'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) =>
            svc.imports.toImportJob(
              await svc.imports.get(tx, input.workspaceId, input.jobId, context.principal),
            ),
          ),
        ),

      /** Without the reports — a list of thousands-of-rows reports is megabytes to draw a table. */
      list: scoped.imports.list.use(requires('quire.page.import')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          // Polled every two seconds while anything on it is running, so it is the thing that ends
          // a job whose worker went away rather than drawing its spinner for ever.
          await svc.imports.reap(tx, input.workspaceId).catch(() => 0)
          const rows = await svc.imports.list(tx, input.workspaceId, context.principal, input.limit)
          return rows.map((row) => {
            const { report, ...summary } = svc.imports.toImportJob(row)
            return summary
          })
        }),
      ),
    },

    /**
     * What somebody writes with.
     *
     * Two permissions and a rule for telling them apart: **using** a template is `quire.page.create`,
     * because what it does is make a page; **changing** one is `quire.space.manage`, because it
     * changes what everybody in the space is offered the next time they make one. That is exactly
     * how `labels.*` above is split, and for the same reason.
     *
     * A template id carries no scope of its own, so every procedure here that takes one reads the
     * row first and asks about the space it belongs to. A **workspace-wide** template
     * (`space_id is null`) has no narrower scope than the workspace, and the workspace-level
     * `requires()` is the whole answer for it — said out loud here rather than left as a space check
     * that silently falls back to the space of whoever happened to ask.
     */
    templates: {
      list: scoped.templates.list.use(requires('quire.space.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          /*
           * A space named is a space checked. Without one the question is "what is offered
           * everywhere", which the "New space" picker asks before there is a space to ask about —
           * and `requires()` is the only scope that exists for it.
           */
          if (input.spaceId) {
            await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
            await svc.access.requireSpace(
              context.principal,
              'quire.space.view',
              input.workspaceId,
              input.spaceId,
            )
          }
          return svc.templates.list(
            tx,
            input.workspaceId,
            input.kind,
            input.spaceId,
            context.principal.locale,
          )
        }),
      ),

      get: scoped.templates.get.use(requires('quire.space.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const row = await svc.templates.row(tx, input.workspaceId, input.templateId)
          if (row.spaceId) {
            await svc.access.spaceRow(tx, input.workspaceId, row.spaceId)
            await svc.access.requireSpace(
              context.principal,
              'quire.space.view',
              input.workspaceId,
              row.spaceId,
            )
          }
          return toTemplate(row)
        }),
      ),

      /**
       * Two questions, not one, and the first is the one that protects anything.
       *
       * This copies a page's prose into something everybody who may create a page can then read, so
       * **may you read what you are copying** is asked against the page's own ancestor chain — a
       * contractor allowed one page of a handbook must not be able to lift a neighbouring page into
       * a template and read it there. Only then is "may you configure where it is offered" asked.
       */
      createFromPage: scoped.templates.createFromPage
        .use(requires('quire.space.manage'))
        .handler(async ({ input, context }) => {
          const template = await run(context, input.workspaceId, async (tx) => {
            if (input.kind === 'space') {
              await svc.access.spaceRow(tx, input.workspaceId, input.sourceId)
              await svc.access.requireSpace(
                context.principal,
                'quire.space.manage',
                input.workspaceId,
                input.sourceId,
              )
            } else {
              await requirePage(tx, context, input.workspaceId, input.sourceId, 'quire.page.view')
              if (input.spaceId)
                await svc.access.requireSpace(
                  context.principal,
                  'quire.space.manage',
                  input.workspaceId,
                  input.spaceId,
                )
            }
            return svc.templates.createFromPage(tx, context.principal, input.workspaceId, input)
          })
          await announce(input.workspaceId, 'template', template.id, 'created')
          return template
        }),

      update: scoped.templates.update
        .use(requires('quire.space.manage'))
        .handler(async ({ input, context }) => {
          const { workspaceId, templateId, ...patch } = input
          const template = await run(context, workspaceId, async (tx) => {
            const existing = await svc.templates.row(tx, workspaceId, templateId)
            if (existing.spaceId)
              await svc.access.requireSpace(
                context.principal,
                'quire.space.manage',
                workspaceId,
                existing.spaceId,
              )
            // Moving it into a space needs the same permission on the space it is moving into, or
            // "offered everywhere" would be a way to put a template in a space you may not configure.
            if (patch.spaceId)
              await svc.access.requireSpace(
                context.principal,
                'quire.space.manage',
                workspaceId,
                patch.spaceId,
              )
            /*
             * Replacing the body re-reads a page or a space, so the read is checked again exactly as
             * it is in `createFromPage`. The same act needs the same permission whichever door it
             * comes in by, and this is the door that is easy to forget: `update` looks like a rename.
             */
            if (patch.sourceId !== undefined) {
              if (existing.kind === 'space') {
                await svc.access.spaceRow(tx, workspaceId, patch.sourceId)
                await svc.access.requireSpace(
                  context.principal,
                  'quire.space.manage',
                  workspaceId,
                  patch.sourceId,
                )
              } else {
                await requirePage(tx, context, workspaceId, patch.sourceId, 'quire.page.view')
              }
            }
            return svc.templates.update(tx, context.principal, workspaceId, templateId, patch)
          })
          await announce(workspaceId, 'template', template.id, 'updated')
          return template
        }),

      remove: scoped.templates.remove
        .use(requires('quire.space.manage'))
        .handler(async ({ input, context }) => {
          await run(context, input.workspaceId, async (tx) => {
            const existing = await svc.templates.row(tx, input.workspaceId, input.templateId)
            if (existing.spaceId)
              await svc.access.requireSpace(
                context.principal,
                'quire.space.manage',
                input.workspaceId,
                existing.spaceId,
              )
            await svc.templates.remove(tx, input.workspaceId, input.templateId)
          })
          await announce(input.workspaceId, 'template', input.templateId, 'deleted')
          return { ok: true as const }
        }),

      /**
       * Make the thing.
       *
       * The kind decides which permission is asked, and the template decides the kind — so the
       * template is resolved before anything is checked. A page template asks `quire.page.create` on
       * the space it writes into; a space template *creates* a space, so it asks
       * `quire.space.manage` at workspace scope, which is the same question `spaces.create` asks and
       * the only scope that exists before a space does.
       */
      instantiate: scoped.templates.instantiate
        .use(requires('quire.page.create'))
        .handler(async ({ input, context }) => {
          /*
           * Which branch ran, recorded rather than inferred from the answer.
           *
           * `TemplateResult` is one shape for both kinds on purpose, so nothing in it says "a space
           * was made" — and guessing from `pageCount` would be wrong for the two cases that matter:
           * a space template whose tree is one page, and one whose tree is empty.
           */
          let madeSpace = false
          const result = await run(context, input.workspaceId, async (tx) => {
            const resolved = await svc.templates.resolve(
              tx,
              input.workspaceId,
              context.principal.locale,
              input.templateId,
              input.starterKey,
            )

            if (resolved.kind === 'space') {
              madeSpace = true
              if (!input.key || !input.name)
                throw KernError.badRequest('A space template needs a name and an address for the space')
              await kernel.authz.require(context.principal, 'quire.space.manage', {
                kind: 'workspace',
                id: input.workspaceId,
                workspaceId: input.workspaceId,
              })
              return svc.templates.instantiateSpace(tx, context.principal, input.workspaceId, resolved, {
                key: input.key,
                name: input.name,
                values: input.values,
              })
            }

            if (!input.spaceId) throw KernError.badRequest('A page template needs a space to be made in')
            await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
            await svc.access.requireSpace(
              context.principal,
              'quire.page.create',
              input.workspaceId,
              input.spaceId,
            )
            return svc.templates.instantiatePage(tx, context.principal, input.workspaceId, resolved, {
              spaceId: input.spaceId,
              parentId: input.parentId,
              afterId: input.afterId,
              title: input.title,
              values: input.values,
            })
          })

          /*
           * A space template makes a space *and* a tree, so both are announced — the space list and
           * one space's tree are different screens, and announcing only the pages would leave the
           * space list empty until somebody reloaded.
           */
          if (madeSpace) {
            await announce(input.workspaceId, 'space', result.spaceId, 'created')
            await kernel.emit(
              quireEvents.spaceCreated,
              { spaceId: result.spaceId, workspaceId: input.workspaceId },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
          }
          /*
           * One event, for the page somebody is about to be taken to.
           *
           * A space template that made eleven pages emits one `pageCreated` and not eleven: an event
           * is what something *reacts* to, and eleven notifications for one act is the shape that
           * teaches people to mute a feed. `pageCount` in the answer is how a screen says how many.
           * A tree with no pages emits nothing rather than an event carrying an empty page id.
           */
          if (result.pageId) {
            await announce(input.workspaceId, 'page', result.pageId, 'created', {
              spaceId: result.spaceId,
            })
            await kernel.emit(
              quireEvents.pageCreated,
              { pageId: result.pageId, spaceId: result.spaceId, workspaceId: input.workspaceId },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
          }
          return result
        }),
    },

    publishing: {
      publish: scoped.publishing.publish
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.pageId)
            await svc.access.requirePage(context.principal, 'quire.page.publish', input.workspaceId, scope)
            const updated = await svc.versions.publish(
              tx,
              context.principal,
              input.workspaceId,
              input.pageId,
              input.label,
            )
            /*
             * Draw the version now, while there is a principal and a writable transaction.
             *
             * A version is immutable, so every rendering of it is identical — and the public path
             * is read-only and has nobody to sign a picture on behalf of. Doing it here is what
             * makes an anonymous read a single indexed row read instead of a CRDT decode, and it is
             * why `page_versions.html` exists at all.
             */
            if (updated.publishedVersionId)
              await svc.publications.renderVersion(tx, input.workspaceId, updated.publishedVersionId)
            return updated
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

    /**
     * Publishing to the internet, from the inside.
     *
     * Every one of these asks `quire.page.publish` about the publication's **root page**, because
     * the root is the page whose whole subtree is being handed out. A publication id carries no
     * scope of its own, so the row is read first and the question is asked about what it points at
     * — the same shape as a `databases.*` procedure resolving its host page.
     */
    publications: {
      list: scoped.publications.list.use(requires('quire.page.publish')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          await svc.access.spaceRow(tx, input.workspaceId, input.spaceId)
          await svc.access.requireSpace(
            context.principal,
            'quire.page.publish',
            input.workspaceId,
            input.spaceId,
          )
          /*
           * Filtered as well as gated, for the reason `pages.trash` is: the procedure is reached by
           * being allowed to publish *somewhere* in the space, and a publication names a root page
           * — so an unfiltered row would hand its slug and its root's existence to somebody a
           * page-scoped DENY has closed that page to.
           */
          const rows = await svc.publications.list(tx, input.workspaceId, input.spaceId)
          const kept: Publication[] = []
          for (const row of rows) {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, row.rootPageId).catch(() => null)
            if (!scope) continue
            if (await svc.access.canPage(context.principal, 'quire.page.publish', input.workspaceId, scope))
              kept.push(toPublication(row))
          }
          return kept
        }),
      ),

      get: scoped.publications.get.use(requires('quire.page.publish')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          const row = await svc.publications.row(tx, input.workspaceId, input.publicationId)
          await requirePage(tx, context, input.workspaceId, row.rootPageId, 'quire.page.publish')
          return toPublication(row)
        }),
      ),

      create: scoped.publications.create
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, async (tx) => {
            await requirePage(tx, context, input.workspaceId, input.rootPageId, 'quire.page.publish')
            const created = await svc.publications.create(tx, context.principal, input.workspaceId, input)
            // Only ever does anything for pages published before this feature existed; a publish
            // since then rendered its own HTML. Bounded, and a shortfall is a log line rather than a
            // failed request — see `backfill`.
            await svc.publications.backfill(tx, input.workspaceId, created)
            return created
          })
          await announce(input.workspaceId, 'publication', row.id, 'created')
          return toPublication(row)
        }),

      update: scoped.publications.update
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          const { workspaceId, publicationId, ...patch } = input
          const row = await run(context, workspaceId, async (tx) => {
            const existing = await svc.publications.row(tx, workspaceId, publicationId)
            await requirePage(tx, context, workspaceId, existing.rootPageId, 'quire.page.publish')
            const updated = await svc.publications.update(tx, workspaceId, publicationId, patch)
            await svc.publications.backfill(tx, workspaceId, updated)
            return updated
          })
          await announce(workspaceId, 'publication', row.id, 'updated')
          return toPublication(row)
        }),

      remove: scoped.publications.remove
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          await run(context, input.workspaceId, async (tx) => {
            const existing = await svc.publications.row(tx, input.workspaceId, input.publicationId)
            await requirePage(tx, context, input.workspaceId, existing.rootPageId, 'quire.page.publish')
            await svc.publications.remove(tx, input.workspaceId, input.publicationId)
          })
          await announce(input.workspaceId, 'publication', input.publicationId, 'deleted')
          return { ok: true as const }
        }),

      optOut: scoped.publications.optOut
        .use(requires('quire.page.publish'))
        .handler(async ({ input, context }) => {
          const excluded = await run(context, input.workspaceId, async (tx) => {
            await requirePage(tx, context, input.workspaceId, input.pageId, 'quire.page.publish')
            return svc.publications.setExcluded(tx, input.workspaceId, input.pageId, input.excluded)
          })
          await announce(input.workspaceId, 'page', input.pageId, 'updated')
          return { pageId: input.pageId, excluded }
        }),
    },

    /**
     * The signed-out surface.
     *
     * Every handler here has the same three lines at the top and they are the whole security model:
     * resolve the **publication** from the slug (which fails closed on a slug nobody has taken and
     * on one that has expired), check the door, and then walk the tree *from the publication's
     * root*. Nothing is looked up by an id a caller supplied, because nothing here takes one — so
     * "guessing a sibling id" is not a request this API can express.
     *
     * `open` is `publicSurface` + `anonymousOnly`: no membership check, no permission check, and no
     * principal to accidentally consult. Reads run in `svc.publications.read`, which is a read-only
     * transaction, so a write that slipped in here fails in Postgres rather than in a review.
     */
    public: {
      site: open.public.site.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const pub = await svc.publications.bySlug(tx, ws, input.slug)
          const theme = pub.theme as Publication['theme']
          if (!(await svc.publications.unlocked(pub, input.token)))
            return { slug: pub.slug, theme, locked: true, site: null }

          const nodes = await svc.publications.tree(tx, ws, pub)
          // No root means the root page is archived, trashed, opted out, unpublished or not a page.
          // The publication row survives that; the site does not.
          const root = nodes[0]
          if (!root) throw noSite()
          const newest = nodes.reduce(
            (at, node) => Math.max(at, node.published_at.getTime()),
            root.published_at.getTime(),
          )
          return {
            slug: pub.slug,
            theme,
            locked: false,
            site: {
              title: pub.seoTitle || root.title || 'Untitled',
              description: pub.seoDescription,
              ogImageUrl: pub.ogImageUrl,
              indexable: pub.indexable,
              updatedAt: new Date(newest).toISOString(),
              nav: nodes.map((node) => ({
                path: node.path,
                parentPath: node.parentPath,
                title: node.title || 'Untitled',
                icon: node.icon,
              })),
            },
          }
        }),
      ),

      page: open.public.page.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const { nodes } = await servable(tx, ws, input.slug, input.token)
          const node = svc.publications.find(nodes, input.path)
          return {
            path: node.path,
            title: node.title || 'Untitled',
            icon: node.icon,
            coverUrl: node.cover_url,
            html: await svc.publications.html(tx, ws, node, nodes, input.basePath),
            /*
             * The version's timestamp, not the page's. `pages.updated_at` moves every time somebody
             * types in the draft, so publishing it would tell the internet when an unpublished
             * change was being worked on.
             */
            publishedAt: node.published_at.toISOString(),
            etag: svc.publications.etagFor(node.version_id),
            breadcrumbs: trailTo(nodes, node),
          }
        }),
      ),

      search: open.public.search.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const { nodes } = await servable(tx, ws, input.slug, input.token)
          const hits = await svc.publications.search(tx, ws, nodes, input.q, input.limit)
          return {
            items: hits.map((hit) => ({
              path: hit.node.path,
              title: hit.node.title || 'Untitled',
              snippet: hit.snippet,
            })),
          }
        }),
      ),

      sitemap: open.public.sitemap.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const pub = await svc.publications.bySlug(tx, ws, input.slug)
          // A sitemap exists for crawlers, so a site nobody is meant to crawl has an empty one
          // rather than a private one. Answering with the tree here would put every path of a
          // password-protected handbook in a file whose whole purpose is to be fetched by robots.
          if (pub.passwordHash || !pub.indexable) return { entries: [] }
          const nodes = await svc.publications.tree(tx, ws, pub)
          // A publication whose root has since been trashed serves nothing, so it is the same 404
          // as a slug nobody took — an empty sitemap here would say "this address is a site" to a
          // crawler that has just been told the opposite by every other procedure.
          if (!nodes[0]) throw noSite()
          return {
            entries: nodes.map((node) => ({
              path: node.path,
              lastModified: node.published_at.toISOString(),
            })),
          }
        }),
      ),

      robots: open.public.robots.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          /*
           * The one place a missing publication is not an error: a crawler asking about a slug
           * nobody has taken, one that has expired, and one behind a password have to get the same
           * answer, or this becomes the oracle every other procedure refuses to be.
           *
           * There is a **fourth** state and this comment used to list three. A publication whose
           * root page has since been trashed, archived, opted out or unpublished still has its row:
           * `site`, `page`, `search` and `sitemap` all answer 404 for it, and robots answered
           * `indexable: true` with a sitemap path — so the one procedure written to never
           * distinguish anything was the only one admitting that the slug existed. It is the walk
           * rather than the row that decides, which is why the tree is read here.
           */
          const pub = await svc.publications.bySlug(tx, ws, input.slug).catch(() => null)
          if (!pub || pub.passwordHash || !pub.indexable) return { indexable: false, sitemapPath: null }
          const nodes = await svc.publications.tree(tx, ws, pub)
          if (!nodes[0]) return { indexable: false, sitemapPath: null }
          // Relative to whatever prefix the route layer serves this site under; the module has no
          // way to know that, and guessing would put a wrong absolute URL in a robots file.
          return { indexable: true, sitemapPath: 'sitemap.xml' }
        }),
      ),

      /**
       * The bytes of one picture on a published page.
       *
       * It goes through `servable` like every other read, so a picture is behind the same door, the
       * same expiry and the same walk as the prose it sits in — and `svc.publications.asset` then
       * insists the file is referenced by a version *in this tree* before it fetches anything. That
       * second check is what stops a reference lifted out of one published site from resolving
       * against another in the same workspace.
       */
      asset: open.public.asset.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const { nodes } = await servable(tx, ws, input.slug, input.token)
          return svc.publications.asset(tx, ws, nodes, input.asset)
        }),
      ),

      unlock: open.public.unlock.handler(({ input }) =>
        svc.publications.read(input.workspaceId, async (tx, ws) => {
          const pub = await svc.publications.bySlug(tx, ws, input.slug)
          // A site with no password has no door to open, and saying so would confirm the slug
          // exists to somebody who has not been told anything else about it.
          if (!pub.passwordHash)
            throw new KernError('NOT_FOUND', 'There is no published site at this address')
          if (!(await svc.publications.checkPassword(pub, input.password)))
            throw new KernError('UNAUTHORIZED', 'That password does not open this site')
          return svc.publications.mintToken(pub)
        }),
      ),
    },
  })
}

/** The path from the front page down to this page's parent, for a breadcrumb trail. */
function trailTo(nodes: PublicNode[], node: PublicNode): PublicBreadcrumb[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const trail: PublicBreadcrumb[] = []
  const seen = new Set([node.id])
  let at = node.parent_id === null ? null : (byId.get(node.parent_id) ?? null)
  while (at && !seen.has(at.id)) {
    seen.add(at.id)
    trail.push({ path: at.path, title: at.title || 'Untitled' })
    at = at.parent_id === null ? null : (byId.get(at.parent_id) ?? null)
  }
  return trail.reverse()
}
