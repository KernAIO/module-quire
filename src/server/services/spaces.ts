import type { Principal } from '@kernhq/contracts'
import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Space } from '../../contract/index.js'
import { pages, spaces } from '../schema.js'
import type { QuireAccess } from './access.js'

type SpaceRow = typeof spaces.$inferSelect

export function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Space['workspaceId'],
    key: row.key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    visibility: row.visibility as Space['visibility'],
    homepageId: row.homepageId,
    createdBy: row.createdBy as Space['createdBy'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

export function quireSpaces(access: QuireAccess) {
  return {
    /**
     * Only the spaces this person may see.
     *
     * The filter is per row rather than a single workspace-level check, because visibility is the
     * whole point of a space: a `private` one should not appear in a list to someone with no
     * binding, and "you may not open it" is a different, worse answer than not showing it at all.
     */
    async list(tx: Tx, principal: Principal, workspaceId: string, includeArchived: boolean) {
      const rows = await tx
        .select()
        .from(spaces)
        .where(
          includeArchived
            ? eq(spaces.workspaceId, workspaceId)
            : and(eq(spaces.workspaceId, workspaceId), isNull(spaces.archivedAt)),
        )
        .orderBy(asc(spaces.name))
      const visible = await Promise.all(
        rows.map(async (r) =>
          (await access.canSpace(principal, 'quire.space.view', workspaceId, r.id)) ? r : null,
        ),
      )
      return visible.filter((r): r is SpaceRow => r !== null).map(toSpace)
    },

    async get(tx: Tx, principal: Principal, workspaceId: string, spaceId: string) {
      const row = await access.spaceRow(tx, workspaceId, spaceId)
      await access.requireSpace(principal, 'quire.space.view', workspaceId, spaceId)
      return toSpace(row)
    },

    async create(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: { key: string; name: string; description: string; icon: string | null; visibility: string },
    ) {
      const [existing] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.key, input.key)))
        .limit(1)
      if (existing) throw KernError.conflict(`A space with the key "${input.key}" already exists`)

      const [row] = await tx
        .insert(spaces)
        .values({
          id: uuidv7(),
          workspaceId,
          key: input.key,
          name: input.name,
          description: input.description,
          icon: input.icon,
          visibility: input.visibility,
          createdBy: principal.userId,
        })
        .returning()
      return toSpace(row!)
    },

    async update(
      tx: Tx,
      workspaceId: string,
      spaceId: string,
      patch: Partial<Pick<SpaceRow, 'name' | 'description' | 'icon' | 'visibility' | 'homepageId'>>,
    ) {
      // A home page that is not in this space would make the space open to a page nobody expected.
      if (patch.homepageId) {
        const [home] = await tx
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              eq(pages.id, patch.homepageId),
              eq(pages.spaceId, spaceId),
              isNull(pages.deletedAt),
            ),
          )
          .limit(1)
        if (!home) throw KernError.badRequest('The home page must be a page in this space')
      }
      const [row] = await tx
        .update(spaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, spaceId)))
        .returning()
      if (!row) throw KernError.notFound('Space')
      return toSpace(row)
    },

    async archive(tx: Tx, workspaceId: string, spaceId: string, archived: boolean) {
      const [row] = await tx
        .update(spaces)
        .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, spaceId)))
        .returning()
      if (!row) throw KernError.notFound('Space')
      return toSpace(row)
    },
  }
}
export type QuireSpaces = ReturnType<typeof quireSpaces>
