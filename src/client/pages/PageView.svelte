<script lang="ts">
import {
  Avatar,
  Button,
  type CollabPeer,
  DropdownMenu,
  EmptyState,
  Icon,
  IconButton,
  navigation,
  Page,
  relativeTime,
  Skeleton,
  session,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import CommentsPanel from '../components/CommentsPanel.svelte'
import PageEditor from '../components/PageEditor.svelte'
import VersionHistory from '../components/VersionHistory.svelte'
import DatabaseView from '../database/DatabaseView.svelte'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
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

const query = createQuery(() => ({
  queryKey: quireKeys.page(workspaceId, pageId),
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.pages.get({ workspaceId, pageId }),
}))
const doc = $derived(query.data ?? null)

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

async function saveTitle() {
  if (!doc || !dirty) return
  const next = title.trim()
  if (next === doc.title) {
    dirty = false
    return
  }
  await api.pages.update({ workspaceId, pageId, title: next })
  dirty = false
  await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, doc.spaceId) })
}

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

async function trash() {
  if (!doc) return
  await api.pages.trashPage({ workspaceId, pageId })
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, doc.spaceId) })
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(spaceKey)}`)
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
          {
            id: 'archive',
            label: doc.archivedAt ? t('unarchive') : t('archive'),
            icon: 'archive',
            disabled: !editable,
            onSelect: () => void archive(!doc.archivedAt),
          },
          {
            id: 'trash',
            label: t('move_to_trash'),
            icon: 'trash-2',
            danger: true,
            disabled: !editable,
            onSelect: () => void trash(),
          },
        ]}
      >
        {#snippet trigger(props: Record<string, unknown>)}
          <IconButton icon="ellipsis" label={t('page_actions')} variant="ghost" {...props} />
        {/snippet}
      </DropdownMenu>
    </div>

    <div class="byline">
      <Avatar id={doc.updatedBy} size={24} />
      <span>{t('edited_ago', { when: relativeTime(doc.updatedAt) })}</span>
      {#if doc.kind === 'live'}
        <span class="chip"><Icon name="square-pen" size={12} /> {t('kind_live')}</span>
      {/if}
      {#if doc.archivedAt}
        <span class="chip"><Icon name="archive" size={12} /> {t('archived')}</span>
      {/if}
      {#if peers.length > 0}
        <span class="chip">{t('people_here', { count: peers.length })}</span>
      {/if}
    </div>

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
.title-field:focus {
  outline: none;
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
