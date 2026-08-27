/**
 * The ways a page is reached that are not the tree: labels, favourites, watchers, recent views.
 *
 * One service rather than four, because they share the thing that makes them easy to get wrong.
 * Three of these four tables are keyed by a **person**, and row-level security is not: the policy on
 * every table in this module fences `workspace_id`, which is the tenant boundary and says nothing
 * about who inside a tenant may read a row. A colleague's favourites are as visible to the policy as
 * your own. So the `user_id` predicate written into each query below is the *entire* privacy
 * mechanism for a sidebar, and a query here that forgets it does not fail, does not warn, and shows
 * one person another person's bookmarks.
 *
 * The second shared concern is that none of these tables has a foreign key to `pages` — a purge
 * leaves rows behind. Every read therefore joins to `pages` and drops what has been deleted or
 * trashed, so an orphan is invisible rather than a broken row; and every list re-asks the permission
 * question per page, because a page a space closed to you after you bookmarked it must leave your
 * sidebar rather than sit there refusing to open.
 */
import type { Principal } from '@kernhq/contracts'
import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { rankBetween } from '../../client/rank.js'
import type { FavoriteEntry, Label, RecentEntry, WatchState } from '../../contract/index.js'
import { LabelColour } from '../../contract/index.js'
import { favorites, labels, pageLabels, pages, recentViews, watchers } from '../schema.js'
import type { QuireAccess } from './access.js'

type LabelRow = typeof labels.$inferSelect

/**
 * `colour` is `text` in the database and a closed enum in the contract, so a value the enum does not
 * know would fail *output* validation — a 500 on a read, for a row that is merely odd. Grey is the
 * same fallback `toneFor` renders, which is the one the client would draw anyway.
 */
export function toLabel(row: LabelRow): Label {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Label['workspaceId'],
    spaceId: row.spaceId,
    name: row.name,
    colour: LabelColour.safeParse(row.colour).success ? (row.colour as Label['colour']) : 'grey',
    createdAt: row.createdAt.toISOString(),
  }
}

/** The columns a shortcut row draws, joined from the page it points at. */
const pageBits = {
  spaceId: pages.spaceId,
  title: pages.title,
  icon: pages.icon,
  kind: pages.kind,
}

export function quireOrganisation(access: QuireAccess) {
  /**
   * Keep only the rows whose page this person may still read.
   *
   * Per page rather than per space, because a page-scoped DENY is the narrow case the whole
   * permission model exists for — a space check would let exactly the page somebody was shut out of
   * stay in their sidebar. `scopeOf` throws for a page that no longer exists; the join already
   * excludes those, and the `catch` is what stops a race between the two turning a sidebar into an
   * error.
   */
  async function readable<T extends { pageId: string }>(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    rows: T[],
  ): Promise<T[]> {
    const kept: Array<T | null> = await Promise.all(
      rows.map(async (row): Promise<T | null> => {
        const scope = await access.scopeOf(tx, workspaceId, row.pageId).catch(() => null)
        if (!scope) return null
        return (await access.canPage(principal, 'quire.page.view', workspaceId, scope)) ? row : null
      }),
    )
    return kept.filter((row): row is T => row !== null)
  }

  /** The ranks of this person's favourites, in order, optionally without the one being moved. */
  async function ordered(tx: Tx, workspaceId: string, userId: string, movingId?: string) {
    const rows = await tx
      .select({ pageId: favorites.pageId, position: favorites.position })
      .from(favorites)
      .where(and(eq(favorites.workspaceId, workspaceId), eq(favorites.userId, userId)))
      .orderBy(asc(favorites.position))
    return rows.filter((row) => row.pageId !== movingId)
  }

  return {
    /** Every label in the space, by name — what a picker draws. */
    async listLabels(tx: Tx, workspaceId: string, spaceId: string): Promise<Label[]> {
      const rows = await tx
        .select()
        .from(labels)
        .where(and(eq(labels.workspaceId, workspaceId), eq(labels.spaceId, spaceId)))
        .orderBy(asc(labels.name))
      return rows.map(toLabel)
    },

    /** The label row, or `notFound` — a label id carries no scope, so this is what resolves one. */
    async labelRow(tx: Tx, workspaceId: string, labelId: string) {
      const [row] = await tx
        .select()
        .from(labels)
        .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, labelId)))
        .limit(1)
      if (!row) throw KernError.notFound('Label')
      return row
    },

    async createLabel(
      tx: Tx,
      workspaceId: string,
      spaceId: string,
      input: { name: string; colour: Label['colour'] },
    ): Promise<Label> {
      const name = input.name.trim()
      if (!name) throw KernError.badRequest('A label needs a name')
      await this.refuseDuplicate(tx, workspaceId, spaceId, name, null)
      const [row] = await tx
        .insert(labels)
        .values({ id: uuidv7(), workspaceId, spaceId, name, colour: input.colour })
        .returning()
      return toLabel(row!)
    },

    async updateLabel(
      tx: Tx,
      workspaceId: string,
      labelId: string,
      patch: { name?: string; colour?: Label['colour'] },
    ): Promise<Label> {
      const existing = await this.labelRow(tx, workspaceId, labelId)
      const name = patch.name?.trim()
      if (patch.name !== undefined && !name) throw KernError.badRequest('A label needs a name')
      if (name) await this.refuseDuplicate(tx, workspaceId, existing.spaceId, name, labelId)
      const [row] = await tx
        .update(labels)
        .set({ ...(name ? { name } : {}), ...(patch.colour ? { colour: patch.colour } : {}) })
        .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, labelId)))
        .returning()
      if (!row) throw KernError.notFound('Label')
      return toLabel(row)
    },

    /**
     * Gone, and off every page that wore it.
     *
     * There is no foreign key to cascade through, so leaving the join rows would leave every page
     * that wore this label carrying a tag nothing can name — invisible in a picker, undeletable, and
     * ready to reappear the day a new label is minted with the same id, which uuidv7 will not do but
     * is the wrong thing to be relying on.
     */
    async removeLabel(tx: Tx, workspaceId: string, labelId: string): Promise<void> {
      await this.labelRow(tx, workspaceId, labelId)
      await tx
        .delete(pageLabels)
        .where(and(eq(pageLabels.workspaceId, workspaceId), eq(pageLabels.labelId, labelId)))
      await tx.delete(labels).where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, labelId)))
    },

    /**
     * The unique index is on `lower(name)`, so this asks the same question the index would answer.
     *
     * Checked here as well as enforced there because the index's answer is a raw `23505` — a 500 to
     * whoever typed the name, rather than "there is already one of those".
     */
    async refuseDuplicate(
      tx: Tx,
      workspaceId: string,
      spaceId: string,
      name: string,
      exceptId: string | null,
    ): Promise<void> {
      const [clash] = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(
          and(
            eq(labels.workspaceId, workspaceId),
            eq(labels.spaceId, spaceId),
            sql`lower(${labels.name}) = lower(${name})`,
            exceptId ? ne(labels.id, exceptId) : undefined,
          ),
        )
        .limit(1)
      if (clash) throw KernError.conflict(`This space already has a label called "${name}"`)
    },

    async labelsForPage(tx: Tx, workspaceId: string, pageId: string): Promise<Label[]> {
      const rows = await tx
        .select({
          id: labels.id,
          workspaceId: labels.workspaceId,
          spaceId: labels.spaceId,
          name: labels.name,
          colour: labels.colour,
          createdAt: labels.createdAt,
        })
        .from(pageLabels)
        .innerJoin(
          labels,
          and(eq(labels.workspaceId, pageLabels.workspaceId), eq(labels.id, pageLabels.labelId)),
        )
        .where(and(eq(pageLabels.workspaceId, workspaceId), eq(pageLabels.pageId, pageId)))
        .orderBy(asc(labels.name))
      return rows.map(toLabel)
    },

    /**
     * Replace what the page wears with exactly this set.
     *
     * Delete-then-insert inside the caller's transaction, rather than working out a difference: the
     * set is at most fifty ids and the difference is the part that gets a duplicate wrong. Every id
     * has to name a label of *this page's own space* — a label belongs to a space, so accepting one
     * from elsewhere would put another team's vocabulary on this page and leave a picker showing a
     * tag it has no entry for.
     */
    async setLabels(
      tx: Tx,
      workspaceId: string,
      pageId: string,
      spaceId: string,
      labelIds: string[],
    ): Promise<Label[]> {
      const wanted = [...new Set(labelIds)]
      if (wanted.length > 0) {
        const found = await tx
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(eq(labels.workspaceId, workspaceId), eq(labels.spaceId, spaceId), inArray(labels.id, wanted)),
          )
        if (found.length !== wanted.length)
          throw KernError.badRequest('Every label has to be one this space declares')
      }
      await tx
        .delete(pageLabels)
        .where(and(eq(pageLabels.workspaceId, workspaceId), eq(pageLabels.pageId, pageId)))
      if (wanted.length > 0)
        await tx
          .insert(pageLabels)
          .values(wanted.map((labelId) => ({ workspaceId, pageId, labelId })))
          .onConflictDoNothing()
      return this.labelsForPage(tx, workspaceId, pageId)
    },

    /**
     * This person's favourites, in the order they arranged them.
     *
     * `eq(favorites.userId, userId)` is the privacy boundary — see the note at the top of the file.
     */
    async listFavorites(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      userId: string,
    ): Promise<FavoriteEntry[]> {
      const rows = await tx
        .select({
          workspaceId: favorites.workspaceId,
          userId: favorites.userId,
          pageId: favorites.pageId,
          position: favorites.position,
          createdAt: favorites.createdAt,
          ...pageBits,
        })
        .from(favorites)
        .innerJoin(pages, and(eq(pages.workspaceId, favorites.workspaceId), eq(pages.id, favorites.pageId)))
        .where(
          and(eq(favorites.workspaceId, workspaceId), eq(favorites.userId, userId), isNull(pages.deletedAt)),
        )
        .orderBy(asc(favorites.position))
      return (await readable(tx, principal, workspaceId, rows)).map((row) => ({
        workspaceId: row.workspaceId as FavoriteEntry['workspaceId'],
        userId: row.userId as FavoriteEntry['userId'],
        pageId: row.pageId,
        position: row.position,
        createdAt: row.createdAt.toISOString(),
        spaceId: row.spaceId,
        title: row.title,
        icon: row.icon,
        kind: row.kind as FavoriteEntry['kind'],
      }))
    },

    /**
     * Star a page. Lands at the end of the list, and starring one twice is the same star.
     *
     * Idempotent on purpose: `disabled={mutation.isPending}` reaches the button a render late, so
     * two quick clicks are two requests, and the second one must not be an error the person sees.
     */
    async addFavorite(tx: Tx, workspaceId: string, userId: string, pageId: string): Promise<void> {
      const existing = await ordered(tx, workspaceId, userId)
      if (existing.some((row) => row.pageId === pageId)) return
      const position = rankBetween(existing.at(-1)?.position ?? null, null)
      await tx.insert(favorites).values({ workspaceId, userId, pageId, position }).onConflictDoNothing()
    },

    /** Only ever your own: without `userId` this deletes whoever else starred the same page. */
    async removeFavorite(tx: Tx, workspaceId: string, userId: string, pageId: string): Promise<void> {
      await tx
        .delete(favorites)
        .where(
          and(
            eq(favorites.workspaceId, workspaceId),
            eq(favorites.userId, userId),
            eq(favorites.pageId, pageId),
          ),
        )
    },

    /** `afterId` is the favourite to land behind; null means first. Only this person's list moves. */
    async reorderFavorite(
      tx: Tx,
      workspaceId: string,
      userId: string,
      pageId: string,
      afterId: string | null,
    ): Promise<void> {
      const all = await ordered(tx, workspaceId, userId)
      if (!all.some((row) => row.pageId === pageId)) throw KernError.notFound('Favourite')
      const rest = all.filter((row) => row.pageId !== pageId)
      let position: string
      if (afterId === null) position = rankBetween(null, rest[0]?.position ?? null)
      else {
        const at = rest.findIndex((row) => row.pageId === afterId)
        if (at < 0) throw KernError.badRequest('afterId is not one of your favourites')
        position = rankBetween(rest[at]!.position, rest[at + 1]?.position ?? null)
      }
      await tx
        .update(favorites)
        .set({ position })
        .where(
          and(
            eq(favorites.workspaceId, workspaceId),
            eq(favorites.userId, userId),
            eq(favorites.pageId, pageId),
          ),
        )
    },

    /**
     * Who is watching this page, and whether you are among them.
     *
     * The list is not filtered to the caller: unlike a favourite, a watch is a fact about the page
     * that everyone who can read the page can see — it is what a "3 people are watching" line beside
     * the button is drawn from.
     */
    async watchState(tx: Tx, workspaceId: string, pageId: string, userId: string): Promise<WatchState> {
      const rows = await tx
        .select({ userId: watchers.userId })
        .from(watchers)
        .where(and(eq(watchers.workspaceId, workspaceId), eq(watchers.pageId, pageId)))
        .orderBy(asc(watchers.userId))
      return {
        watching: rows.some((row) => row.userId === userId),
        watchers: rows.map((row) => row.userId as WatchState['watchers'][number]),
      }
    },

    async setWatching(
      tx: Tx,
      workspaceId: string,
      pageId: string,
      userId: string,
      watching: boolean,
    ): Promise<WatchState> {
      if (watching) await tx.insert(watchers).values({ workspaceId, userId, pageId }).onConflictDoNothing()
      else
        await tx
          .delete(watchers)
          .where(
            and(
              eq(watchers.workspaceId, workspaceId),
              eq(watchers.userId, userId),
              eq(watchers.pageId, pageId),
            ),
          )
      return this.watchState(tx, workspaceId, pageId, userId)
    },

    /**
     * Where this person has just been, newest first.
     *
     * Over-fetched before the permission filter and sliced after it: filtering a page of exactly
     * `limit` rows would hand back four entries when six of the ten most recent are pages somebody
     * has since been shut out of, and the older ones they can still read would never appear. The
     * over-fetch is bounded so a denied stretch costs one wider query rather than a scan.
     */
    async listRecents(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      userId: string,
      limit: number,
    ): Promise<RecentEntry[]> {
      const rows = await tx
        .select({
          workspaceId: recentViews.workspaceId,
          userId: recentViews.userId,
          pageId: recentViews.pageId,
          viewedAt: recentViews.viewedAt,
          ...pageBits,
        })
        .from(recentViews)
        .innerJoin(
          pages,
          and(eq(pages.workspaceId, recentViews.workspaceId), eq(pages.id, recentViews.pageId)),
        )
        .where(
          and(
            eq(recentViews.workspaceId, workspaceId),
            eq(recentViews.userId, userId),
            isNull(pages.deletedAt),
          ),
        )
        .orderBy(desc(recentViews.viewedAt))
        .limit(Math.min(limit * 3, 150))
      return (await readable(tx, principal, workspaceId, rows)).slice(0, limit).map((row) => ({
        workspaceId: row.workspaceId as RecentEntry['workspaceId'],
        userId: row.userId as RecentEntry['userId'],
        pageId: row.pageId,
        viewedAt: row.viewedAt.toISOString(),
        spaceId: row.spaceId,
        title: row.title,
        icon: row.icon,
        kind: row.kind as RecentEntry['kind'],
      }))
    },

    /** One row per person per page, bumped rather than appended — re-opening moves it up the list. */
    async recordRecent(tx: Tx, workspaceId: string, userId: string, pageId: string): Promise<void> {
      const viewedAt = new Date()
      await tx
        .insert(recentViews)
        .values({ workspaceId, userId, pageId, viewedAt })
        .onConflictDoUpdate({ target: [recentViews.userId, recentViews.pageId], set: { viewedAt } })
    },
  }
}
export type QuireOrganisation = ReturnType<typeof quireOrganisation>
