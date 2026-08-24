import type { CollabDocumentState, Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { PageVersion } from '../../contract/index.js'
import { pages, pageVersions } from '../schema.js'
import type { QuireAccess } from './access.js'
import { documentNameOf } from './pages.js'

type VersionRow = typeof pageVersions.$inferSelect

/** How much of the prose a version list shows without loading the document. */
const PREVIEW = 160

export function toVersion(row: VersionRow, publishedId: string | null): PageVersion {
  return {
    id: row.id,
    workspaceId: row.workspaceId as PageVersion['workspaceId'],
    pageId: row.pageId,
    kind: row.kind as PageVersion['kind'],
    label: row.label,
    preview: row.text.slice(0, PREVIEW),
    size: row.size,
    authorId: row.authorId as PageVersion['authorId'],
    createdAt: row.createdAt.toISOString(),
    published: publishedId === row.id,
  }
}

export function quireVersions(kernel: Kernel, access: QuireAccess) {
  /** The document's current state and a snapshot of it, from the collab service. */
  async function snapshotOf(workspaceId: string, pageId: string) {
    return kernel.call<{ snapshot: string; state: string }>('collab.document.snapshot', {
      name: documentNameOf({ workspaceId, id: pageId }),
    })
  }

  return {
    /**
     * Write down what the page says now.
     *
     * Returns null when the document has never been written to — a page created and never opened
     * has nothing to version, and an empty row in the history would be a lie about somebody having
     * saved something.
     */
    async capture(
      tx: Tx,
      workspaceId: string,
      pageId: string,
      opts: { kind: PageVersion['kind']; label?: string | null; authorId?: string | null },
    ): Promise<VersionRow | null> {
      const taken = await snapshotOf(workspaceId, pageId).catch((err) => {
        kernel.log.warn({ err: String(err), pageId }, 'could not snapshot the document')
        return null
      })
      if (!taken) return null

      const [row] = await tx
        .select({ text: pages.text })
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .limit(1)

      const state = Buffer.from(taken.state, 'base64')
      const [version] = await tx
        .insert(pageVersions)
        .values({
          id: uuidv7(),
          workspaceId,
          pageId,
          kind: opts.kind,
          label: opts.label ?? null,
          state,
          snapshot: Buffer.from(taken.snapshot, 'base64'),
          text: row?.text ?? '',
          size: state.length,
          authorId: opts.authorId ?? null,
        })
        .returning()
      return version ?? null
    },

    async list(tx: Tx, workspaceId: string, pageId: string, limit: number, cursor: string | null) {
      const page = await access.pageRow(tx, workspaceId, pageId)
      const rows = await tx
        .select()
        .from(pageVersions)
        .where(
          and(
            eq(pageVersions.workspaceId, workspaceId),
            eq(pageVersions.pageId, pageId),
            cursor ? lt(pageVersions.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(pageVersions.id))
        .limit(limit + 1)
      const items = rows.slice(0, limit).map((r) => toVersion(r, page.publishedVersionId))
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null }
    },

    async row(tx: Tx, workspaceId: string, versionId: string) {
      const [row] = await tx
        .select()
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.id, versionId)))
        .limit(1)
      if (!row) throw KernError.notFound('Version')
      return row
    },

    /**
     * Put an older version back.
     *
     * Two things make this safe to offer. The state it is about to replace is captured first, so
     * restoring is never itself the thing that loses work; and the replacement goes through the
     * collab service rather than the database, because `applyUpdate` would merge the two and bring
     * every deleted paragraph back alongside the ones that replaced it.
     */
    async restore(tx: Tx, principal: Principal, workspaceId: string, versionId: string) {
      const version = await this.row(tx, workspaceId, versionId)
      await access.pageRow(tx, workspaceId, version.pageId)

      await this.capture(tx, workspaceId, version.pageId, {
        kind: 'auto',
        label: null,
        authorId: principal.userId,
      })
      await kernel.call('collab.document.replace', {
        name: documentNameOf({ workspaceId, id: version.pageId }),
        state: Buffer.from(version.state).toString('base64'),
      })
      const restored = await this.capture(tx, workspaceId, version.pageId, {
        kind: 'restore',
        label: version.label,
        authorId: principal.userId,
      })
      if (!restored) throw KernError.badRequest('The document could not be restored')
      return restored
    },

    /** What a reader is served, once somebody decides it is ready. */
    async publish(tx: Tx, principal: Principal, workspaceId: string, pageId: string, label: string | null) {
      const page = await access.pageRow(tx, workspaceId, pageId)
      if (page.kind !== 'page')
        throw KernError.badRequest('Only a page has a published version; a live doc is always live')

      const version = await this.capture(tx, workspaceId, pageId, {
        kind: 'publish',
        label,
        authorId: principal.userId,
      })
      if (!version) throw KernError.badRequest('There is nothing written to publish')

      const [updated] = await tx
        .update(pages)
        .set({
          publishedVersionId: version.id,
          hasUnpublishedChanges: false,
          updatedBy: principal.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .returning()
      return updated!
    },

    /** Throw the draft away and go back to what readers can already see. */
    async revert(tx: Tx, principal: Principal, workspaceId: string, pageId: string) {
      const page = await access.pageRow(tx, workspaceId, pageId)
      if (!page.publishedVersionId)
        throw KernError.badRequest('This page has never been published, so there is nothing to go back to')

      const published = await this.row(tx, workspaceId, page.publishedVersionId)
      // The draft being discarded is kept, because "revert" should not be a way to lose an
      // afternoon's writing with no way back.
      await this.capture(tx, workspaceId, pageId, {
        kind: 'auto',
        label: null,
        authorId: principal.userId,
      })
      await kernel.call('collab.document.replace', {
        name: documentNameOf({ workspaceId, id: pageId }),
        state: Buffer.from(published.state).toString('base64'),
      })
      const [updated] = await tx
        .update(pages)
        .set({ hasUnpublishedChanges: false, updatedBy: principal.userId, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .returning()
      return updated!
    },

    /** When the newest version was taken, so an automatic one is not taken every keystroke. */
    async lastCapturedAt(tx: Tx, workspaceId: string, pageId: string): Promise<Date | null> {
      const [row] = await tx
        .select({ createdAt: pageVersions.createdAt })
        .from(pageVersions)
        .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.pageId, pageId)))
        .orderBy(desc(pageVersions.id))
        .limit(1)
      return row?.createdAt ?? null
    },

    /** The current state, for anything that needs the document without opening a socket. */
    documentState(workspaceId: string, pageId: string) {
      return kernel.call<CollabDocumentState>('collab.document.state', {
        name: documentNameOf({ workspaceId, id: pageId }),
      })
    },
  }
}
export type QuireVersions = ReturnType<typeof quireVersions>
