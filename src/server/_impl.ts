import {
  defineModule,
  defineServerModule,
  KernError,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  requiresCapability,
  uuidv7,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { and, desc, eq } from 'drizzle-orm'
import { MODULE_ID, quireContract, quireEvents } from '../contract.js'
import { notes } from './schema.js'

/**
 * The router, kept apart from `index.ts` so `module.test.ts` can walk it without booting a kernel.
 *
 * Two middlewares on every procedure, and the test fails if either is missing:
 * `workspaceScoped` (a real membership, and the module switched on for that workspace) and
 * `requires` (the permission this particular call needs).
 *
 * A third, `requiresCapability`, goes on any procedure that belongs to a capability rather than to
 * the module as a whole. Order matters: `workspaceScoped` first, so a workspace with the module
 * switched off is refused before anything reveals which capabilities it would have had.
 */
export { defineModule, defineServerModule, packageVersion }

const os = implement(quireContract).$context<RequestContext>()

export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))

  return os.router({
    notes: {
      list: scoped.notes.list.use(requires('quire.note.view')).handler(({ input }) =>
        // Every tenant query runs inside `withWorkspace`, which sets `app.workspace_id` for the
        // transaction. Outside it, the RLS policy matches nothing and the query returns no rows.
        kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(notes)
            .where(eq(notes.workspaceId, input.workspaceId))
            .orderBy(desc(notes.createdAt))
            .limit(input.limit)
          return {
            items: rows.map((r) => ({
              ...r,
              createdAt: r.createdAt.toISOString(),
              archivedAt: r.archivedAt?.toISOString() ?? null,
            })),
            nextCursor: null,
          }
        }),
      ),

      create: scoped.notes.create
        .use(requires('quire.note.manage'))
        .handler(async ({ input, context }) => {
          const row = await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
            const [r] = await tx
              .insert(notes)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                title: input.title,
                body: input.body,
              })
              .returning()
            return r!
          })

          // Both, every time. The event is for anything that reacts later; the realtime change is
          // what redraws a screen somebody is looking at now. A mutation that does neither leaves
          // the rest of the product believing the old answer.
          await kernel.emit(
            quireEvents.noteCreated,
            { noteId: row.id, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await kernel.realtime.change(input.workspaceId, {
            module: MODULE_ID,
            entity: 'note',
            id: row.id,
            op: 'created',
          })

          return {
            ...row,
            createdAt: row.createdAt.toISOString(),
            archivedAt: row.archivedAt?.toISOString() ?? null,
          }
        }),

      remove: scoped.notes.remove
        .use(requires('quire.note.manage'))
        .handler(async ({ input, context }) => {
          await kernel.database.withWorkspace(input.workspaceId, (tx) =>
            tx.delete(notes).where(and(eq(notes.workspaceId, input.workspaceId), eq(notes.id, input.noteId))),
          )
          await kernel.emit(
            quireEvents.noteRemoved,
            { noteId: input.noteId, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await kernel.realtime.change(input.workspaceId, {
            module: MODULE_ID,
            entity: 'note',
            id: input.noteId,
            op: 'deleted',
          })
          return { ok: true as const }
        }),

      /**
       * A procedure behind a capability. Three middlewares, in this order:
       *
       * `workspaceScoped` first, so a workspace with the module switched off is refused before the
       * capability check can reveal which capabilities the module even has. Then
       * `requiresCapability`, which answers 404 for a workspace that has not switched `archive` on.
       * Then `requires`, the permission — because "does this workspace have the feature" is a
       * different question from "may this person use it", and the first one comes first.
       */
      archive: scoped.notes.archive
        .use(requiresCapability(MODULE_ID, 'archive'))
        .use(requires('quire.note.manage'))
        .handler(async ({ input }) => {
          const row = await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
            const [r] = await tx
              .update(notes)
              .set({ archivedAt: input.archived ? new Date() : null })
              .where(and(eq(notes.workspaceId, input.workspaceId), eq(notes.id, input.noteId)))
              .returning()
            if (!r) throw KernError.notFound('Note')
            return r
          })
          await kernel.realtime.change(input.workspaceId, {
            module: MODULE_ID,
            entity: 'note',
            id: row.id,
            op: 'updated',
          })
          return {
            ...row,
            createdAt: row.createdAt.toISOString(),
            archivedAt: row.archivedAt?.toISOString() ?? null,
          }
        }),
    },
  })
}
