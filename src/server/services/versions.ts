import type { CollabDocumentState, Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import type { PageVersion } from '../../contract/index.js'
import { pageDocFromBase64, pageDocFromState } from '../document.js'
import { referencesIn, renderPageDoc, textFromPageDoc } from '../render.js'
import { pages, pageVersions, spaces } from '../schema.js'
import type { QuireAccess } from './access.js'
import { documentNameOf } from './pages.js'

type VersionRow = typeof pageVersions.$inferSelect

/** How much of the prose a version list shows without loading the document. */
const PREVIEW = 160

/**
 * What a picture looks like in HTML that is stored rather than shown.
 *
 * A signed storage URL cannot be stored: it is the object's key, which carries the tenant's
 * workspace uuid and the file's own uuid, and it stops working an hour after it is written. So the
 * public render leaves a root-relative reference the publication layer resolves at read time —
 * `publicHtml` turns it into an address on the published site, and drops the picture outright if it
 * cannot. It has to survive `safeHref`, which is why it is a path and not a scheme of its own, and
 * it starts with `__` so no slug the server ever invents can collide with it.
 */
export const ASSET_REFERENCE_PREFIX = '/__quire-asset/'
export const assetReference = (fileId: string): string => `${ASSET_REFERENCE_PREFIX}${fileId}`

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
      /*
       * Flattened from the state that is being stored, not copied from `pages.text`.
       *
       * `pages.text` is what the collab service published, and its flatten renders marks as markup
       * — a page with one link contributed `rel="noopener noreferrer nofollow"` to the preview and
       * to search. Decoding here costs nothing extra: the bytes are already in hand.
       */
      const decoded = pageDocFromBase64(taken.state)
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
          // The mirrored column is the fallback, so a document that will not decode still gets a
          // version — losing the preview is a small thing; not taking the version is somebody's work.
          text: decoded ? textFromPageDoc(decoded) : (row?.text ?? ''),
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

    /**
     * A stored version drawn as HTML, with its pictures signed and its page mentions linked.
     *
     * This is what a version is *for*: `preview` is 160 characters of flattened text, which tells
     * you a version exists and nothing about what it said. The bytes to answer properly have been
     * in `page_versions.state` since the first migration, and `renderPageDoc` has known how to draw
     * them since it was written — nothing joined the two, so the server could store a document, flatten
     * it, and still not show it to anybody.
     *
     * The two resolvers are why it is here rather than in `render.ts`: that file is pure, and both
     * a signed picture URL and a page's `/quire/<key>/<id>` address need something outside the
     * document. `referencesIn` collects the ids in one walk so this is two queries and a
     * signature per distinct picture, whatever the order they appear in.
     *
     * Everything degrades rather than failing. A version that will not decode renders as an empty
     * string; a picture whose file has been deleted, or whose storage is not configured, is dropped
     * rather than drawn as a broken image; a mention of a purged page stays as its label. None of
     * those is worth turning a read of somebody's history into an error.
     *
     * **`pictures` is a security parameter, not a performance one.** `'signed'` is right for a
     * person reading their own history over an authenticated request: the URL is theirs, it is
     * short-lived, and it is never stored. `'referenced'` is the only thing that may be *written
     * down*, because a signed URL is the storage key — the tenant's workspace uuid and the file's
     * own uuid — and it expires an hour after it is minted. The publication render stores its
     * output, so it uses `'referenced'` and `publicHtml` resolves the reference per read.
     */
    async html(
      tx: Tx,
      workspaceId: string,
      state: Buffer | Uint8Array | null,
      opts: { pictures?: 'signed' | 'referenced' } = {},
    ): Promise<string> {
      const doc = pageDocFromState(state)
      if (!doc) return ''
      const { fileIds, pageIds } = referencesIn(doc)

      const hrefs = new Map<string, string>()
      if (pageIds.length > 0) {
        const rows = await tx
          .select({ id: pages.id, key: spaces.key })
          .from(pages)
          .innerJoin(spaces, eq(spaces.id, pages.spaceId))
          .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, pageIds)))
        for (const row of rows) hrefs.set(row.id, `/quire/${row.key}/${row.id}`)
      }

      const sources = new Map<string, string>()
      if (opts.pictures === 'referenced') {
        // No storage round trip at all: the reference is the file id, and whether the object is
        // still there is a question for the read that serves it rather than for the render.
        for (const id of fileIds) sources.set(id, assetReference(id))
      } else {
        await Promise.all(
          fileIds.map(async (id) => {
            try {
              const file = await kernel.call<{ key: string; mimeType: string } | null>('core.files.get', {
                id,
              })
              if (!file?.key) return
              sources.set(
                id,
                await kernel.storage.presignGet(file.key, {
                  disposition: 'inline',
                  contentType: file.mimeType,
                }),
              )
            } catch (err) {
              kernel.log.warn({ err: String(err), fileId: id }, 'could not sign a picture for a version')
            }
          }),
        )
      }

      return renderPageDoc(doc, {
        fileSrc: (id) => sources.get(id) ?? null,
        pageHref: (id) => hrefs.get(id) ?? null,
      })
    },
  }
}
export type QuireVersions = ReturnType<typeof quireVersions>
