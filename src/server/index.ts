import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CollabAccess, CollabAccessInput, type core, type Principal } from '@kernhq/contracts'
import { KernError } from '@kernhq/kernel'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import {
  MODULE_ID,
  quireCapabilities,
  quireContract,
  quireEvents,
  quireNotificationTypes,
  quirePermissions,
} from '../contract/index.js'
import { defineModule, defineServerModule, implement_, packageVersion } from './_impl.js'
import { pages, schema, spaces } from './schema.js'
import { quireServices } from './services/index.js'
import { createNotify } from './services/notify.js'

/**
 * How long a page may go without an automatic version while somebody is writing in it.
 *
 * The collab service already throttles how often it publishes a snapshot event, so this is the
 * second gate rather than the first: it decides how much work a restore can lose, not how much
 * traffic the module sees.
 */
const AUTO_VERSION_INTERVAL_MS = 5 * 60_000

/**
 * A page as the search index sees it, or null when it should not be indexed at all.
 *
 * An archived or trashed page is dropped rather than indexed: a search result that opens the trash
 * is worse than no result. So is a page in a space that is not `open` — see the note on `search`.
 */
function searchDocument(
  workspaceId: string,
  page: typeof pages.$inferSelect,
  spaceKey: string,
  visibility: string,
): core.SearchDocument | null {
  if (page.deletedAt || page.archivedAt) return null
  if (visibility !== 'open') return null
  return {
    workspaceId: workspaceId as core.SearchDocument['workspaceId'],
    object: { module: MODULE_ID, type: 'page', id: page.id },
    title: page.title || 'Untitled',
    body: page.text,
    url: `/quire/${spaceKey}/${page.id}`,
    icon: 'file-text',
    acl: null,
    updatedAt: page.updatedAt.toISOString(),
    attributes: { spaceId: page.spaceId, kind: page.kind },
  }
}

/** These procedures are reachable only from another Kern service, never from a browser. */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

export const quireModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Quire',
    version: packageVersion(import.meta.url),
    description: 'Spaces, nested pages and documents a team writes together',
    icon: 'scroll-text',
    permissions: quirePermissions,
    capabilities: quireCapabilities,
    notificationTypes: quireNotificationTypes,
    events: quireEvents,
    /**
     * A page is a first-class object elsewhere in Kern: it can be mentioned, linked, searched and —
     * `channelable` — given its own conversation in chat.
     */
    objectTypes: [
      { type: 'page', label: 'Page', icon: 'file-text', channelable: true },
      { type: 'space', label: 'Space', icon: 'scroll-text' },
    ],
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: quireContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: implement_,

  /**
   * `quire:page:<id>` documents for the workspace-wide search index.
   *
   * **Only pages in an `open` space are indexed, and that is a deliberate gap rather than an
   * oversight.** `SearchDocument.acl` is matched against `[userId, …groupIds, 'role:<role>']`, so
   * indexing a restricted or private space correctly means knowing *which subjects may read this
   * page* — and core can answer "may this person read this object" but has no way to enumerate who
   * can. Guessing produces one of two bad outcomes: a private page in a stranger's search results,
   * or a page its own author cannot find. Neither is worth having, so the restricted case waits for
   * a core procedure that can answer it.
   */
  search: [
    {
      types: ['page'],
      load: async (workspaceId, id, kernel): Promise<core.SearchDocument | null> =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const [row] = await tx
            .select({ page: pages, spaceKey: spaces.key, visibility: spaces.visibility })
            .from(pages)
            .innerJoin(spaces, eq(spaces.id, pages.spaceId))
            .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, id)))
            .limit(1)
          if (!row) return null
          return searchDocument(workspaceId, row.page, row.spaceKey, row.visibility)
        }),
      scan: async function* (workspaceId, kernel) {
        let after: string | null = null
        for (;;) {
          const batch: Array<{
            page: typeof pages.$inferSelect
            spaceKey: string
            visibility: string
          }> = await kernel.database.withWorkspace(workspaceId, (tx) =>
            tx
              .select({ page: pages, spaceKey: spaces.key, visibility: spaces.visibility })
              .from(pages)
              .innerJoin(spaces, eq(spaces.id, pages.spaceId))
              .where(
                and(
                  eq(pages.workspaceId, workspaceId),
                  isNull(pages.deletedAt),
                  after ? gt(pages.id, after) : undefined,
                ),
              )
              .orderBy(asc(pages.id))
              .limit(500),
          )
          if (batch.length === 0) return
          for (const r of batch) {
            const doc = searchDocument(workspaceId, r.page, r.spaceKey, r.visibility)
            if (doc) yield doc
          }
          after = batch.at(-1)?.page.id ?? null
          if (batch.length < 500) return
        }
      },
    },
  ],

  /** How a page and a space render wherever another module links to one. */
  resolvers: [
    {
      type: 'page',
      resolve: async (workspaceId, ids, _principal, kernel) =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select({ id: pages.id, title: pages.title, spaceKey: spaces.key })
            .from(pages)
            .innerJoin(spaces, eq(spaces.id, pages.spaceId))
            .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, ids)))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((id) => {
            const row = byId.get(id)
            return row
              ? {
                  id: row.id,
                  title: row.title || 'Untitled',
                  url: `/quire/${row.spaceKey}/${row.id}`,
                  icon: 'file-text',
                  subtitle: null,
                }
              : null
          })
        }),
    },
    {
      type: 'space',
      resolve: async (workspaceId, ids, _principal, kernel) =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select({ id: spaces.id, name: spaces.name, key: spaces.key })
            .from(spaces)
            .where(and(eq(spaces.workspaceId, workspaceId), inArray(spaces.id, ids)))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((id) => {
            const row = byId.get(id)
            return row
              ? { id: row.id, title: row.name, url: `/quire/${row.key}`, icon: 'scroll-text', subtitle: null }
              : null
          })
        }),
    },
  ],

  subscriptions: {
    /**
     * A document was edited. Three things follow from that, and none of them can be done from the
     * browser.
     *
     * The flattened prose is mirrored onto the row, so the tree and search can read a page without
     * decoding a CRDT. A `page` whose draft has moved on from what readers are served is marked as
     * having unpublished changes — which is the whole difference between a page and a live doc. And
     * a version is taken if the last one is old enough, so history accumulates while somebody
     * writes rather than only when they remember to press something.
     */
    'collab.document.updated': async (event, kernel) => {
      const payload = event.payload as {
        workspaceId: string
        module: string
        type: string
        objectId: string
        text: string
      }
      if (payload.module !== MODULE_ID || payload.type !== 'page') return

      const svc = quireServices(kernel)
      await kernel.database.withWorkspace(payload.workspaceId, async (tx) => {
        const [page] = await tx
          .select()
          .from(pages)
          .where(and(eq(pages.workspaceId, payload.workspaceId), eq(pages.id, payload.objectId)))
          .limit(1)
        // A document for a page that has been purged; the row is gone and so should the document be.
        if (!page) return

        await tx
          .update(pages)
          .set({
            text: payload.text,
            // A `page` diverges from what readers see; a `live` doc has nothing to diverge from.
            hasUnpublishedChanges:
              page.kind === 'page' && page.publishedVersionId !== null ? true : page.hasUnpublishedChanges,
            updatedAt: new Date(),
          })
          .where(and(eq(pages.workspaceId, payload.workspaceId), eq(pages.id, payload.objectId)))

        const last = await svc.versions.lastCapturedAt(tx, payload.workspaceId, payload.objectId)
        if (!last || Date.now() - last.getTime() > AUTO_VERSION_INTERVAL_MS) {
          await svc.versions.capture(tx, payload.workspaceId, payload.objectId, {
            kind: 'auto',
            label: null,
            authorId: null,
          })
        }
      })

      // The prose changed, so the index is stale. Best effort: a page must not fail to save
      // because search is briefly unavailable.
      const doc = await kernel.database.withWorkspace(payload.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ page: pages, spaceKey: spaces.key, visibility: spaces.visibility })
          .from(pages)
          .innerJoin(spaces, eq(spaces.id, pages.spaceId))
          .where(and(eq(pages.workspaceId, payload.workspaceId), eq(pages.id, payload.objectId)))
          .limit(1)
        return row ? searchDocument(payload.workspaceId, row.page, row.spaceKey, row.visibility) : null
      })
      if (doc) await createNotify(kernel).index([doc])

      await kernel.realtime.change(payload.workspaceId, {
        module: MODULE_ID,
        entity: 'page',
        id: payload.objectId,
        op: 'updated',
      })
    },
  },

  procedures: {
    /**
     * Whether a user may open a page's collaborative document.
     *
     * This is what the collab gateway calls before it accepts a WebSocket. The shapes come from
     * `@kernhq/contracts` rather than being spelled out here: the gateway falls back to plain
     * workspace membership when a module does not answer, so a signature that does not match fails
     * silently and looks exactly like a module that works.
     */
    'collab.access': {
      input: CollabAccessInput,
      output: CollabAccess,
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        if (input.type !== 'page') return { canRead: false, canWrite: false }
        const svc = quireServices(kernel)
        return kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          try {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.id)
            // The gateway is a service acting for somebody else, so the subject's own memberships
            // have to come from core rather than from the caller.
            const subject =
              principal.userId === input.userId
                ? principal
                : ((await kernel
                    .call<Principal | null>('core.users.principal', { userId: input.userId })
                    .catch(() => null)) ?? {
                    ...principal,
                    userId: input.userId,
                    instanceAdmin: false,
                    kind: 'user' as const,
                  })

            const canRead = await svc.access.canPage(subject, 'quire.page.view', input.workspaceId, scope)
            const canWrite =
              canRead && (await svc.access.canPage(subject, 'quire.page.edit', input.workspaceId, scope))
            return { canRead, canWrite }
          } catch (err) {
            // A page that is missing or forbidden means "no access"; anything else is a real failure
            // and must not be flattened into a silent denial.
            if (err instanceof KernError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN'))
              return { canRead: false, canWrite: false }
            throw err
          }
        })
      },
    },
  },
})

export default quireModule
