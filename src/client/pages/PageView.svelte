<script lang="ts">
import {
  Avatar,
  Button,
  type CollabPeer,
  coreApi,
  DropdownMenu,
  EmptyState,
  Icon,
  IconButton,
  keys,
  navigation,
  Page,
  relativeTime,
  Skeleton,
  session,
  Tooltip,
  toast,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { getQuireApi } from '../api-instance.js'
import CommentsPanel from '../components/CommentsPanel.svelte'
import ConfirmDialog from '../components/ConfirmDialog.svelte'
import ExportDialog from '../components/ExportDialog.svelte'
import FavoriteStar from '../components/FavoriteStar.svelte'
import PageEditor from '../components/PageEditor.svelte'
import PageLabels from '../components/PageLabels.svelte'
import PublishDialog from '../components/PublishDialog.svelte'
import VersionHistory from '../components/VersionHistory.svelte'
import { type CoreApi, toPerson } from '../core-api.js'
import DatabaseView from '../database/DatabaseView.svelte'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { publicSiteUrl } from '../public-url.js'
import { quireKeys } from '../query.js'

/**
 * One page (DESIGN.md §3.6): 780px measure, a 30px title, a byline under a hairline.
 *
 * The body is not here yet. The collaborative editor is the next slice, and until it exists this
 * says so rather than drawing an empty box that looks broken — a surface that pretends to be
 * editable and silently drops what you type is worse than one that admits it is not finished.
 */
/**
 * The shell mounts a module route as `<Page {workspaceId} {workspaceSlug} params rest />` — one
 * `params` object, never named props. The named ones are kept because `SpacePage` renders this
 * component directly with a page it already knows.
 */
interface Props {
  params?: Record<string, string>
  spaceKey?: string
  pageId?: string
}
const { params, spaceKey: spaceKeyProp, pageId: pageIdProp }: Props = $props()
const spaceKey = $derived(spaceKeyProp ?? params?.space ?? '')
const pageId = $derived(pageIdProp ?? params?.page ?? '')

const api = getQuireApi()
const client = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const core = coreApi<CoreApi>()
/*
 * Who last edited this, by name.
 *
 * The byline drew `<Avatar id={doc.updatedBy} />` with no name — a "?" square with an empty
 * accessible name — over the words "Edited 1h ago", so the one line on the page whose job is to say
 * who touched it said everything except that. The same member list the margin and the person cells
 * read.
 */
const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId, limit: 200 }),
}))

const query = createQuery(() => ({
  queryKey: quireKeys.page(workspaceId, pageId),
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.pages.get({ workspaceId, pageId }),
}))
const doc = $derived(query.data ?? null)
const editor = $derived.by(() => {
  const id = doc?.updatedBy ?? null
  if (!id) return null
  return (membersQuery.data?.items ?? []).map(toPerson).find((p) => p.id === id) ?? null
})

const editable = $derived(canQuire('pageEdit'))
/** A database page draws a view where the prose would be, and a table needs the whole width. */
const isDatabase = $derived(doc?.kind === 'database')
let title = $state('')
let dirty = $state(false)
let titleEl = $state<HTMLInputElement | null>(null)
let peers = $state<CollabPeer[]>([])
let historyOpen = $state(false)
let busy = $state(false)
let activeComment = $state<string | null>(null)
let pendingComment = $state<{ anchor: { from: string; to: string }; quotedText: string } | null>(null)

/**
 * Anchors for the editor to highlight, from the threads the panel has loaded.
 *
 * The panel owns the query; this reads the same cache rather than asking again, so the margin and
 * the highlights can never disagree about which threads exist.
 */
const threads = createQuery(() => ({
  queryKey: [...quireKeys.page(workspaceId, pageId), 'comments'],
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.comments.list({ workspaceId, pageId, includeResolved: false }),
}))

const commentRanges = $derived(
  (threads.data ?? [])
    .filter((t) => t.root.anchor)
    .map((t) => ({ id: t.id, from: t.root.anchor!.from, to: t.root.anchor!.to })),
)

/**
 * Threads whose text is gone.
 *
 * A relative position resolves to nothing once the content it pointed at is deleted, which is the
 * whole reason for using one. The panel says so rather than the thread quietly vanishing — that is
 * exactly when somebody's question matters most.
 */
let orphaned = $state(new Set<string>())

/** The margin appears when there is something in it, or when somebody is about to put something there. */
const showComments = $derived(pendingComment !== null || (threads.data ?? []).length > 0)

/**
 * A page created from the sidebar arrives with no title, and the only thing anybody wants to do next
 * is name it. Without this the page is called "Untitled" and you have to go and find the field.
 * Guarded on the title being empty so opening an existing page never steals the caret.
 */
$effect(() => {
  const el = titleEl
  if (el && doc && doc.title === '' && !dirty) el.focus()
})

/** Reset the field when a different page loads, but never over something being typed. */
$effect(() => {
  const loaded = doc
  if (!loaded) return
  if (!dirty) title = loaded.title
})
$effect(() => {
  void pageId
  dirty = false
})

/**
 * The title saves as you type, not only when you leave the field.
 *
 * It used to save on `blur` alone, and nothing else — so typing a name and then going somewhere
 * without blurring first (a keyboard shortcut, ⌘K, closing the tab, any programmatic navigation)
 * threw the name away and left the page called "Untitled" for ever. Measured against the live
 * stack: fifteen seconds after typing, `mod_quire.pages.title` was still `''`; it only ever became
 * the typed value on blur.
 *
 * A page's *body* has never had this problem, because it is a Y.Doc the collab service persists on
 * its own schedule. The title is not — it is a plain column behind `pages.update` — so the schedule
 * has to be written here. `docs/adr/0006` says the title should live in the Y.Doc beside the body
 * for exactly this reason, and because two people renaming at once currently clobber each other;
 * that is a larger change and this is not a substitute for it.
 */
const TITLE_SAVE_AFTER_MS = 700
let titleTimer: ReturnType<typeof setTimeout> | null = null
/* Set in the same tick as the call, because `isPending` arrives a render late and two saves would
   race to write the same column in an order neither of them chose. */
let savingTitle = false

function queueTitleSave() {
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => {
    titleTimer = null
    void saveTitle()
  }, TITLE_SAVE_AFTER_MS)
}

async function saveTitle() {
  if (titleTimer) {
    clearTimeout(titleTimer)
    titleTimer = null
  }
  if (!doc || !dirty || savingTitle) return
  const next = title.trim()
  if (next === doc.title) {
    dirty = false
    return
  }
  savingTitle = true
  try {
    await api.pages.update({ workspaceId, pageId, title: next })
    dirty = false
    await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
    await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, doc.spaceId) })
  } finally {
    savingTitle = false
  }
}

/* Leaving the page mid-word must not lose the word. */
$effect(() => {
  void pageId
  return () => {
    if (titleTimer) {
      clearTimeout(titleTimer)
      titleTimer = null
    }
    if (untrack(() => dirty)) void saveTitle()
  }
})

async function archive(archived: boolean) {
  if (!doc) return
  await api.pages.archive({ workspaceId, pageId, archived })
  await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, doc.spaceId) })
}

/**
 * A page has a published face and a draft; a live doc has neither. Everything below is therefore
 * only offered for a `page` — a live doc with a "publish" button would be a control that does
 * nothing, which is worse than an absent one.
 */
async function publish() {
  if (!doc || busy) return
  busy = true
  try {
    await api.publishing.publish({ workspaceId, pageId, label: null })
    await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
  } finally {
    busy = false
  }
}

async function revert() {
  if (!doc || busy) return
  busy = true
  try {
    await api.publishing.revert({ workspaceId, pageId })
    await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
  } finally {
    busy = false
  }
}

// -----------------------------------------------------------------------------------------------
// Whether this page is on the internet
// -----------------------------------------------------------------------------------------------

/**
 * The share dialog owns publishing; this owns the one thing the *page* has to say about it.
 *
 * Both queries are gated on `quire.page.publish` because `publications.list` asks for it, and a
 * query that is certain to be refused is a 403 in everybody else's network tab and an indicator
 * that never appears either way. The consequence is worth stating plainly: **somebody who cannot
 * publish does not see the "Public" chip.** That is the wrong way round for a reader who would
 * like to know, and it is the only shape available until there is a procedure that answers "is this
 * page public" without asking to publish it — a chip is not worth a new public surface.
 */
let shareOpen = $state(false)
const canPublish = $derived(canQuire('pagePublish'))

/**
 * Taking this page out as a file.
 *
 * Nothing is loaded for it here: the dialog is the only thing that knows what an export needs, and
 * it asks for the space, the tree and any job already running the moment it opens. This screen's
 * whole part in the feature is a flag and a menu entry, which is what an entry point should be.
 */
let exportOpen = $state(false)

const publicationsQuery = createQuery(() => ({
  queryKey: quireKeys.publications(workspaceId, doc?.spaceId ?? ''),
  enabled: canPublish && Boolean(workspaceId && doc?.spaceId),
  queryFn: () => api.publications.list({ workspaceId, spaceId: doc?.spaceId ?? '' }),
}))

/**
 * The space's tree, only once something in it has been published.
 *
 * Same key as the sidebar's, so on a page reached through the sidebar this costs nothing at all;
 * and a space with no published site never asks for it.
 */
const spaceTreeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, doc?.spaceId ?? ''),
  enabled: canPublish && (publicationsQuery.data?.length ?? 0) > 0 && Boolean(workspaceId && doc?.spaceId),
  queryFn: () => api.pages.tree({ workspaceId, spaceId: doc?.spaceId ?? '', includeArchived: false }),
}))

/**
 * The publication a signed-out stranger could read *this* page through, or null.
 *
 * It reproduces the server's prune rather than asking whether the page is somewhere under a root:
 * every page on the way up — this one, each ancestor, and the root itself — has to be a `page`,
 * unarchived, not opted out and actually published, because that is exactly what the recursive walk
 * behind `public.site` descends through. Getting this looser would put a "Public" chip on a page
 * strangers cannot open, which is the mistake that teaches somebody the chip means nothing.
 */
const publicVia = $derived.by((): { slug: string; root: boolean } | null => {
  const rows = publicationsQuery.data ?? []
  const here = doc
  if (!here || rows.length === 0) return null
  if (here.kind !== 'page' || here.archivedAt || here.deletedAt || !here.publishedVersionId) return null
  const nodes = spaceTreeQuery.data
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]))
  for (const row of rows) {
    if (row.rootPageId === here.id) return { slug: row.slug, root: true }
    if (!row.includeDescendants || !nodes) continue
    let at = byId.get(here.id)
    let guard = 0
    while (at && guard++ < 1000) {
      if (at.kind !== 'page' || at.archivedAt || at.excludedFromPublic || !at.hasPublishedVersion) break
      if (at.id === row.rootPageId) return { slug: row.slug, root: false }
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
  }
  return null
})

const publicUrl = $derived(publicVia ? publicSiteUrl({ workspaceId, slug: publicVia.slug }) : '')

// -----------------------------------------------------------------------------------------------
// Watching, recording, and the way this page is deleted
// -----------------------------------------------------------------------------------------------

/**
 * Whether you are watching, and how many others are.
 *
 * One request, because the control has to draw both — its own pressed state and the number beside
 * it — and asking twice within a keystroke of each other is two requests for one button. The reply
 * to `set` is the same shape, so it goes straight into the cache and nothing refetches.
 */
const watchQuery = createQuery(() => ({
  queryKey: quireKeys.watchers(workspaceId, pageId),
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.watchers.get({ workspaceId, pageId }),
}))
const watching = $derived(watchQuery.data?.watching ?? false)
const watcherCount = $derived(watchQuery.data?.watchers.length ?? 0)
let watchBusy = $state(false)

async function toggleWatch() {
  if (watchBusy) return
  watchBusy = true
  try {
    const next = await api.watchers.set({ workspaceId, pageId, watching: !watching })
    client.setQueryData(quireKeys.watchers(workspaceId, pageId), next)
    toast.success(next.watching ? t('watch_on') : t('watch_off'))
  } finally {
    watchBusy = false
  }
}

/**
 * Opening a page is what puts it in "Recent".
 *
 * A bump, not a log: one row per person per page, so the table is bounded by pages times people
 * rather than growing for ever to answer a question that only ever wants the most recent handful.
 * Failure is swallowed on purpose — a page you cannot record having read is still a page you are
 * reading, and an error toast about a sidebar list would be noise over the thing you came for.
 */
$effect(() => {
  const ws = workspaceId
  const id = pageId
  if (!ws || !id) return
  void api.recents
    .record({ workspaceId: ws, pageId: id })
    .then(() => client.invalidateQueries({ queryKey: quireKeys.recents(ws) }))
    .catch(() => {})
})

/**
 * How many pages "Move to trash" is about to take.
 *
 * It takes the whole subtree, and it used to fire with no confirmation and no way back: deleting
 * "Working here" silently took "Your first week" and "Time off" with it. So the count is worked out
 * *before* the dialog says anything, from the space's tree — loaded only when the dialog opens,
 * because a page nobody is deleting should not pay for a second copy of the tree.
 *
 * `includeArchived: true`, under a key of its own: the sidebar holds the same call with archived
 * pages left out, and reusing that key would either hand this the wrong list or replace the
 * sidebar's. Archived descendants go to the trash like any other, so a count that skipped them
 * would be the same lie in a smaller size.
 *
 * A database page's rows are not counted. They are pages, and `trashPage` takes them — but they are
 * rows to the person reading, and "and 340 pages inside it" for a table of 340 rows would read as a
 * different disaster from the one about to happen. The toast afterwards reports the number the
 * server actually took.
 */
let trashConfirm = $state(false)

const subtreeQuery = createQuery(() => ({
  queryKey: [...quireKeys.tree(workspaceId, doc?.spaceId ?? ''), 'with-archived'],
  enabled: trashConfirm && Boolean(workspaceId && doc?.spaceId),
  queryFn: () => api.pages.tree({ workspaceId, spaceId: doc?.spaceId ?? '', includeArchived: true }),
}))

/**
 * `isFetching`, not just `data`, because a cached tree is not a current one.
 *
 * TanStack hands a query its cached value the instant it is enabled and refetches behind it, so
 * `data === undefined` only catches the *first* open. Every later one renders whatever the last
 * fetch left, and the last fetch is routinely wrong: `refreshAfterMoving` runs while the dialog is
 * still open, so it reloads the tree with the subtree already in the trash and caches a tree
 * without it. Trash a page, press **Undo**, reach for **Move to trash** again, and the dialog said
 * "It goes to the trash, and you can put it back from there" — the singular sentence, for a page
 * that takes two others with it. Measured; the whole point of this dialog is that number, so a
 * stale one is worse than none.
 */
const trashCount = $derived.by((): number | null => {
  const nodes = subtreeQuery.data
  if (!nodes || subtreeQuery.isFetching) return null
  const children = new Map<string, string[]>()
  for (const node of nodes)
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id])
  let total = 1
  let guard = 0
  const stack = [pageId]
  while (stack.length > 0 && guard++ < 5000) {
    const id = stack.pop() as string
    for (const child of children.get(id) ?? []) {
      total++
      stack.push(child)
    }
  }
  return total
})

/**
 * Move it, then offer to take it back.
 *
 * The undo is the point. A confirmation stops the deletion you did not mean to start; it does
 * nothing for the one you meant and regretted, and `pages.restore` puts the whole subtree back —
 * so the toast carries the action rather than leaving the trash screen as the only way home. It
 * outlives this component: the shell owns the toaster, so navigating away does not cancel it.
 */
/**
 * Everything a page leaving or rejoining the space changes.
 *
 * The favourites and recents lists are the ones easy to forget, and forgetting them is visible:
 * both are composed by joining to `pages`, so a trashed page silently drops out of them — and a
 * sidebar still offering a shortcut to a page that is in the trash is exactly the kind of thing
 * that makes somebody distrust the sidebar. Nothing else will do it either, because a `page`
 * change invalidates the `page` prefix and these two live under their own.
 */
async function refreshAfterMoving(spaceId: string) {
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
  await client.invalidateQueries({ queryKey: quireKeys.trash(workspaceId, spaceId) })
  await client.invalidateQueries({ queryKey: quireKeys.favorites(workspaceId) })
  await client.invalidateQueries({ queryKey: quireKeys.recents(workspaceId) })
}

async function trash() {
  const page = doc
  if (!page) return
  const spaceId = page.spaceId
  const title = page.title.trim() || t('untitled')
  const answer = await api.pages.trashPage({ workspaceId, pageId })
  await refreshAfterMoving(spaceId)
  toast(t('trash_moved', { count: answer.count }), {
    // Long enough to read the sentence, notice the number and decide — the default 2.2s is a
    // confirmation, and this is an offer.
    duration: 9000,
    action: {
      label: t('undo'),
      onClick: () => void undoTrash(workspaceId, pageId, spaceId, title),
    },
  })
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(spaceKey)}`)
}

/**
 * `workspace` is passed in rather than read from the closure.
 *
 * This runs from a toast that outlives the component — the screen has already navigated away by
 * the time anybody presses **Undo** — so every value it needs is a plain argument. Reaching for
 * `workspaceId` here would be reading a `$derived` belonging to a component that no longer exists.
 */
async function undoTrash(workspace: string, id: string, spaceId: string, title: string) {
  try {
    await api.pages.restore({ workspaceId: workspace, pageId: id })
    await client.invalidateQueries({ queryKey: quireKeys.tree(workspace, spaceId) })
    await client.invalidateQueries({ queryKey: quireKeys.trash(workspace, spaceId) })
    await client.invalidateQueries({ queryKey: quireKeys.favorites(workspace) })
    await client.invalidateQueries({ queryKey: quireKeys.recents(workspace) })
    toast.success(t('trash_restore_done', { title }))
  } catch {
    toast.error(t('trash_undo_failed'))
  }
}
</script>

<div class="with-margin" class:open={showComments}>
<Page
  padding={isDatabase ? 'none' : 'docs'}
  maxWidth={isDatabase ? undefined : '780px'}
  class={isDatabase ? 'db-page' : undefined}
>
  {#if query.isLoading}
    <Skeleton height="36px" />
    <div class="gap"></div>
    <Skeleton height="18px" />
  {:else if query.isError}
    <EmptyState icon="triangle-alert" title={t('page_error')} description={t('page_error_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void query.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if !doc}
    <EmptyState icon="circle-help" title={t('page_missing')} description={t('page_missing_desc')} />
  {:else}
    <div class="head">
      <!--
        The editable title is *inside* the h1 rather than instead of it. A page whose only title is
        an `<input>` has no level-1 heading at all — which is what a screen reader looks for first,
        and what `ux.spec.ts` fails a route on.
      -->
      <h1 class="title">
        {#if editable}
          <input
            bind:this={titleEl}
            class="title-field"
            value={title}
            placeholder={t('untitled')}
            aria-label={t('page_title')}
            oninput={(e) => {
              title = (e.currentTarget as HTMLInputElement).value
              dirty = true
              queueTitleSave()
            }}
            onblur={saveTitle}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
          />
        {:else}
          {doc.title.trim() || t('untitled')}
        {/if}
      </h1>

      <!--
        The star sits beside the title rather than in the menu: "keep this to hand" is a thing
        people do while reading, and a two-state control buried behind an ellipsis cannot show its
        state at all.
      -->
      <FavoriteStar {workspaceId} pageId={doc.id} />

      <DropdownMenu
        items={[
          {
            id: 'comments',
            label: t('comments'),
            icon: 'message-circle',
            onSelect: () => {
              // Nothing selected, so this is a remark about the page rather than a piece of it.
              pendingComment = { anchor: { from: '', to: '' }, quotedText: '' }
            },
          },
          {
            id: 'history',
            label: t('history'),
            icon: 'rotate-ccw',
            onSelect: () => (historyOpen = true),
          },
          ...(doc.kind === 'page' && canQuire('pageEdit')
            ? [
                {
                  id: 'publish',
                  label: t('publish'),
                  icon: 'circle-check',
                  disabled: busy,
                  onSelect: () => void publish(),
                },
              ]
            : []),
          /*
           * Only a `page`, and only for somebody who may publish.
           *
           * A live doc and a database have no published version — `publishing.publish` refuses
           * them — so a site rooted at one would serve nothing, and an entry that opens a dialog
           * whose only outcome is an empty site is worse than an absent one. `page.publish` rather
           * than `page.edit`, matching every procedure the dialog calls: in a space where writing
           * is open and publishing is not, those are different people.
           */
          ...(doc.kind === 'page' && canPublish
            ? [
                {
                  id: 'share-web',
                  label: t('share_web'),
                  icon: 'globe',
                  onSelect: () => (shareOpen = true),
                },
              ]
            : []),
          /*
           * Every kind of page, not only a `page`. A live doc and a database both render through
           * `renderPageDoc` like anything else — a database exports as the table it is — so the
           * restriction that belongs on **Share to the web** does not belong here.
           *
           * `page.export` rather than `page.view`, matching what `exports.start` asks: reading a
           * handbook a page at a time and walking out with the whole thing in a zip are different
           * acts, and an administrator is allowed to think so.
           */
          ...(canQuire('pageExport')
            ? [
                {
                  id: 'export',
                  label: t('export_menu'),
                  icon: 'download',
                  onSelect: () => (exportOpen = true),
                },
              ]
            : []),
          {
            id: 'watch',
            label: watching ? t('watch_stop') : t('watch'),
            icon: watching ? 'bell-off' : 'bell',
            hint: watcherCount > 0 ? t('watchers', { count: watcherCount }) : undefined,
            onSelect: () => void toggleWatch(),
          },
          {
            id: 'archive',
            label: doc.archivedAt ? t('unarchive') : t('archive'),
            icon: 'archive',
            disabled: !editable,
            onSelect: () => void archive(!doc.archivedAt),
          },
          { type: 'separator' },
          {
            id: 'trash',
            label: t('move_to_trash'),
            icon: 'trash-2',
            danger: true,
            disabled: !editable,
            // Asks first, and says how many pages it is about to take with it.
            onSelect: () => (trashConfirm = true),
          },
          {
            id: 'open-trash',
            label: t('trash_open'),
            icon: 'rotate-ccw',
            disabled: !editable,
            onSelect: () =>
              void navigation.go(
                `/${workspaceSlug}/quire/${encodeURIComponent(spaceKey)}/trash`,
              ),
          },
        ]}
      >
        {#snippet trigger(props: Record<string, unknown>)}
          <IconButton icon="ellipsis" label={t('page_actions')} variant="ghost" {...props} />
        {/snippet}
      </DropdownMenu>
    </div>

    <div class="byline">
      <!--
        No avatar for an author nobody can name.

        `Avatar` with no `name` draws a "?" disc whose `title` is empty, so an unresolved author put
        a meaningless glyph at the head of the one line whose job is to say who touched the page —
        and a screen reader read it out as "question mark". `updatedBy` is null for every page the
        demo seeds and for any row written before the column existed, so this is the common path,
        not the edge. The sentence beside it already falls back to wording that claims no author.
      -->
      {#if editor}
        <Avatar id={doc.updatedBy} name={editor.name} src={editor.avatarUrl ?? undefined} size={24} />
      {/if}
      <span>
        {editor
          ? t('edited_ago_by', { when: relativeTime(doc.updatedAt), who: editor.name })
          : t('edited_ago', { when: relativeTime(doc.updatedAt) })}
      </span>
      <!--
        Quiet, and a link.

        "This page is on the internet" is a fact about the page, so it sits with the other facts
        under the title rather than as a banner — but it is the only one of them worth clicking,
        because the useful thing to do with it is to go and look at what strangers actually see.
        The sentence explaining it is a tooltip rather than the label: the label has to survive
        being one chip in a row of them, and the explanation is a whole sentence.
      -->
      {#if publicVia}
        <Tooltip text={publicVia.root ? t('public_chip_root') : t('public_chip_child')}>
          {#snippet children(props: Record<string, unknown>)}
            <a
              class="chip public"
              href={publicUrl}
              target="_blank"
              rel="noreferrer noopener"
              {...props}
            >
              <Icon name="globe" size={12} /> {t('public_chip')}
            </a>
          {/snippet}
        </Tooltip>
      {/if}
      {#if doc.kind === 'live'}
        <span class="chip"><Icon name="square-pen" size={12} /> {t('kind_live')}</span>
      {/if}
      {#if doc.archivedAt}
        <span class="chip"><Icon name="archive" size={12} /> {t('archived')}</span>
      {/if}
      {#if peers.length > 0}
        <span class="chip">{t('people_here', { count: peers.length })}</span>
      {/if}
      {#if watching}
        <span class="chip"><Icon name="bell" size={12} /> {t('watchers', { count: watcherCount })}</span>
      {/if}
    </div>

    <!--
      Under the byline, above the prose: a label is about the page as a whole, so it belongs with
      the things that say what this page *is* rather than inside what it says.
    -->
    <PageLabels
      {workspaceId}
      spaceId={doc.spaceId}
      pageId={doc.id}
      canEdit={editable}
      canManage={canQuire('spaceManage')}
    />

    {#if doc.kind === 'page' && doc.hasUnpublishedChanges}
      <div class="banner" role="status">
        <Icon name="circle-alert" size={15} />
        <span>{t('unpublished')}</span>
        <span class="spacer"></span>
        <Button size="sm" variant="secondary" disabled={busy} onclick={revert}>{t('revert')}</Button>
        {#if canQuire('pageEdit')}
          <Button size="sm" disabled={busy} onclick={publish}>{t('publish')}</Button>
        {/if}
      </div>
    {/if}

    {#if isDatabase}
      <DatabaseView {workspaceId} {spaceKey} {pageId} spaceId={doc.spaceId} />
    {:else}
      <div class="body">
        <PageEditor
          {doc}
          onpeers={(p) => (peers = p)}
          {commentRanges}
          {activeComment}
          onCommentClick={(id) => (activeComment = id)}
          oncomment={(anchor, quotedText) => {
            pendingComment = { anchor, quotedText }
            activeComment = null
          }}
        />
      </div>
    {/if}
  {/if}
</Page>

{#if doc && showComments}
  <CommentsPanel
    {workspaceId}
    {pageId}
    activeId={activeComment}
    {orphaned}
    onFocus={(id) => (activeComment = id)}
    pending={pendingComment}
    onPendingHandled={() => (pendingComment = null)}
  />
{/if}
</div>

{#if doc}
  <VersionHistory
    bind:open={historyOpen}
    {workspaceId}
    {pageId}
    publishedVersionId={doc.publishedVersionId}
  />

  <PublishDialog bind:open={shareOpen} {workspaceId} spaceId={doc.spaceId} page={doc} />

  <ExportDialog
    bind:open={exportOpen}
    {workspaceId}
    spaceId={doc.spaceId}
    page={{ id: doc.id, title: doc.title }}
  />

  <!--
    The body says nothing about numbers until it knows them. Naming a count before the tree has
    loaded would be the same silent lie in a smaller size — "it goes to the trash" for a page that
    is about to take two others with it.
  -->
  <ConfirmDialog
    bind:open={trashConfirm}
    title={t('trash_confirm_title', { title: doc.title.trim() || t('untitled') })}
    body={trashCount === null ? t('loading') : t('trash_confirm_body', { count: trashCount })}
    confirmLabel={t('move_to_trash')}
    danger
    pending={trashCount === null}
    onConfirm={trash}
  />
{/if}

<style>
.gap {
  height: 14px;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.2;
  color: var(--kern-ink-900);
  margin: 0;
}
.title-field {
  width: 100%;
  min-width: 0;
  color: inherit;
  font: inherit;
  margin: 0;
  border: 0;
  background: none;
  padding: 0;
}
/*
 * The title is the page's heading, not a form field, so it carries no ring — the caret says where
 * you are. `outline: none` is not enough on its own: the global `:focus-visible` rule draws a
 * `box-shadow`, which drew a box around the title on every click.
 */
.title-field:focus,
.title-field:focus-visible {
  outline: none;
  box-shadow: none;
}
.byline {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-block-start: 14px;
  padding-block-end: 20px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 13px;
  color: var(--kern-ink-400);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/*
 * The one chip that is a control, so it is the one that reads as one — a tinted pill with a hit
 * area a finger can find.
 *
 * `--kern-accent-deep`, and the arithmetic rather than the impression. On `--kern-accent-tint` the
 * flat accent is a fill colour and nowhere near readable; `--kern-accent-text` looks like the
 * answer and measures **4.22:1 in the light palette** (#a85a18 on #f3e9da) against the 4.5:1 this
 * text needs at 13px/500 — it only passes in the dark one, which is how it shipped. The deep tone
 * is 5.94:1 light and 5.95:1 dark, and 6.01/5.69 on the hover tint. Computed against the surface
 * this actually sits on, in both palettes, because a colour pair is arithmetic and not taste.
 */
.chip.public {
  gap: 5px;
  min-height: 22px;
  padding-inline: 8px;
  border-radius: var(--kern-r-full);
  background: var(--kern-accent-tint);
  color: var(--kern-accent-deep);
  font-weight: 500;
  text-decoration: none;
}
.chip.public:hover {
  background: var(--kern-accent-tint-2);
}
.body {
  margin-block-start: 22px;
}
/*
 * A database page drops the reading measure and the page padding, because the views set their own
 * (DESIGN.md §2.7: a reading view caps, a working view fills). The title and byline keep the 28px
 * gutter the toolbar under them already uses.
 */
:global(.db-page) .head {
  padding: 24px 28px 0;
}
:global(.db-page) .byline {
  padding-inline: 28px;
}
/*
 * The margin is a column beside the page rather than an overlay: a comment is about a specific
 * sentence, and an overlay covers the sentence you are reading it against.
 */
.with-margin {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.with-margin.open :global(> .kpage) {
  min-width: 0;
}
.with-margin.open > :global(aside) {
  width: 320px;
  flex: none;
}
@media (max-width: 900px) {
  .with-margin.open > :global(aside) {
    width: 260px;
  }
}
/*
 * Above the body rather than beside the title: it is about what a reader currently sees, which is
 * a statement about the text underneath it.
 */
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-block-start: 18px;
  padding: 10px 12px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-warning-tint);
  color: var(--kern-ink-700);
  font-size: 13px;
}
.spacer {
  flex: 1;
}
</style>
