<script lang="ts">
import {
  Avatar,
  Button,
  coreApi,
  EmptyState,
  Icon,
  IconButton,
  keys,
  relativeTime,
  Skeleton,
  session,
} from '@kernhq/ui'
import { RichTextEditor } from '@kernhq/ui/editor'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { type CoreApi, toPerson } from '../core-api.js'
import { t } from '../i18n.js'
import type { CommentThread } from '../index.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'

/**
 * The margin.
 *
 * Threads rather than a flat list, because a remark and its answers are one conversation — and
 * because resolving is a property of the conversation, not of the last thing said in it.
 *
 * A thread whose anchored text has been deleted still appears, showing what it was about. Hiding it
 * would quietly discard somebody's question the moment the sentence it referred to was rewritten,
 * which is exactly when the question matters most.
 */
interface Props {
  workspaceId: string
  pageId: string
  /** the thread the editor has highlighted, if any */
  activeId: string | null
  /** anchors whose text no longer resolves, so the panel can say so */
  orphaned: Set<string>
  onFocus?: (id: string | null) => void
  /** a selection waiting for its first remark */
  pending: { anchor: { from: string; to: string }; quotedText: string } | null
  onPendingHandled?: () => void
}
const { workspaceId, pageId, activeId, orphaned, onFocus, pending, onPendingHandled }: Props = $props()

const api = getQuireApi()
const core = coreApi<CoreApi>()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: [...quireKeys.page(workspaceId, pageId), 'comments'],
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.comments.list({ workspaceId, pageId, includeResolved: false }),
}))
const threads = $derived(query.data ?? [])

/**
 * Who said it.
 *
 * A comment carries an author id and nothing else, so without this the margin reads "3h ago" over
 * an unlettered square — a conversation where nobody can tell who is speaking, and an avatar a
 * screen reader passes over in silence. The same member list the database's person cells use.
 */
const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId, limit: 200 }),
}))
const nameOf = $derived.by(() => {
  const byId = new Map((membersQuery.data?.items ?? []).map(toPerson).map((p) => [p.id, p]))
  // `authorId` is nullable — a comment left by somebody since removed from the workspace — and an
  // unresolved id reads the same way, so both land on the same honest placeholder.
  return (id: string | null) =>
    (id ? byId.get(id) : undefined) ?? { id: id ?? '', name: t('comment_someone'), avatarUrl: null }
})

let draft = $state<unknown>(undefined)
let replyTo = $state<string | null>(null)
let replyDraft = $state<unknown>(undefined)
let busy = $state(false)
let error = $state<string | null>(null)

const empty = (doc: unknown) => {
  const text = JSON.stringify(doc ?? {})
  return !text.includes('"text"')
}

async function submit(parentId: string | null, body: unknown) {
  if (busy || empty(body)) return
  busy = true
  error = null
  try {
    await api.comments.create({
      workspaceId,
      pageId,
      body: $state.snapshot(body) as Record<string, unknown>,
      // An empty pair is how the page-level composer says "about the page, not a piece of it".
      anchor: parentId || !pending?.anchor.from ? null : pending.anchor,
      quotedText: parentId ? '' : (pending?.quotedText ?? ''),
      parentId,
    })
    await query.refetch()
    if (parentId) {
      replyDraft = undefined
      replyTo = null
    } else {
      draft = undefined
      onPendingHandled?.()
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    busy = false
  }
}

async function resolve(thread: CommentThread) {
  busy = true
  try {
    await api.comments.resolve({ workspaceId, commentId: thread.id, resolved: true })
    await query.refetch()
    await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
  } finally {
    busy = false
  }
}

async function remove(commentId: string) {
  busy = true
  try {
    await api.comments.remove({ workspaceId, commentId })
    await query.refetch()
  } finally {
    busy = false
  }
}
</script>

<aside class="panel" aria-label={t('comments')}>
  <h2 class="heading">{t('comments')}</h2>

  {#if pending}
    <div class="composer new">
      {#if pending.quotedText}
        <p class="quoted">“{pending.quotedText}”</p>
      {/if}
      <!--
        `label`, because a rich-text field is a `contenteditable` div: without one a screen reader
        announces "edit text" and nothing about what is being written. The placeholder is a prompt,
        not a name — it disappears the moment somebody types.
      -->
      <RichTextEditor
        bind:value={draft}
        label={t('comment_field')}
        placeholder={t('comment_placeholder')}
        minRows={2}
      />
      <div class="actions">
        <Button size="sm" variant="secondary" onclick={() => onPendingHandled?.()}>{t('cancel')}</Button>
        <Button size="sm" disabled={busy || empty(draft)} onclick={() => submit(null, draft)}>
          {t('comment_post')}
        </Button>
      </div>
    </div>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if query.isLoading}
    <Skeleton height="72px" />
  {:else if threads.length === 0 && !pending}
    <EmptyState
      bare
      compact
      icon="message-circle"
      title={t('comments_empty')}
      description={t('comments_empty_desc')}
    />
  {:else}
    {#each threads as thread (thread.id)}
      <!--
        Not a `role="button"`, though it was one.
        A thread holds a delete, a reply and a resolve, and a button's accessible name is its
        contents — so a screen reader announced the whole conversation, its timestamps and the
        labels of the three controls inside it, as the name of one button, and offered those
        controls inside it anyway. Highlighting the anchored text is a *side effect* of arriving
        here, so it happens on `focusin` for the keyboard and on click for the pointer, and the
        thread stays a plain container with nothing to announce.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="thread"
        class:active={thread.id === activeId}
        onclick={() => onFocus?.(thread.id)}
        onfocusin={() => onFocus?.(thread.id)}
      >
        {#if thread.root.quotedText}
          <p class="quoted" class:orphan={orphaned.has(thread.id)}>“{thread.root.quotedText}”</p>
          {#if orphaned.has(thread.id)}
            <p class="orphan-note"><Icon name="circle-alert" size={12} /> {t('comment_orphaned')}</p>
          {/if}
        {/if}

        {#each [thread.root, ...thread.replies] as comment (comment.id)}
          {@const author = nameOf(comment.authorId)}
          <div class="comment">
            <Avatar id={author.id} name={author.name} src={author.avatarUrl} size={22} />
            <div class="bubble">
              <div class="who">
                <span class="author">{author.name}</span>
                <span class="time">{relativeTime(comment.createdAt)}</span>
                {#if comment.editedAt}<span class="edited">{t('comment_edited')}</span>{/if}
                {#if comment.authorId === session.user?.id}
                  <span class="spacer"></span>
                  <IconButton
                    icon="trash-2"
                    size={22}
                    variant="ghost"
                    label={t('delete')}
                    onclick={() => remove(comment.id)}
                  />
                {/if}
              </div>
              <p class="text">{comment.bodyText}</p>
            </div>
          </div>
        {/each}

        <div class="thread-actions">
          {#if replyTo === thread.id}
            <RichTextEditor
              bind:value={replyDraft}
              label={t('comment_reply_field')}
              placeholder={t('comment_reply')}
              minRows={1}
            />
            <div class="actions">
              <Button size="sm" variant="secondary" onclick={() => (replyTo = null)}>{t('cancel')}</Button>
              <Button
                size="sm"
                disabled={busy || empty(replyDraft)}
                onclick={() => submit(thread.root.id, replyDraft)}
              >
                {t('comment_post')}
              </Button>
            </div>
          {:else if canQuire('pageComment')}
            <Button size="sm" variant="ghost" onclick={() => (replyTo = thread.id)}>
              {t('comment_reply')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => resolve(thread)}>
              {t('comment_resolve')}
            </Button>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</aside>

<style>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 18px;
  border-inline-start: 1px solid var(--kern-border);
  background: var(--kern-surface);
  overflow-y: auto;
  min-height: 0;
}
.heading {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--kern-ink-400);
}
.thread {
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-card);
  background: var(--kern-surface-raised);
  padding: 12px;
  cursor: pointer;
}
.thread.active {
  border-color: var(--kern-accent);
}
.quoted {
  margin: 0 0 10px;
  padding-inline-start: 8px;
  border-inline-start: 2px solid var(--kern-warning);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-400);
}
.quoted.orphan {
  border-inline-start-color: var(--kern-ink-350);
  text-decoration: line-through;
}
.orphan-note {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: -6px 0 10px;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.comment {
  display: flex;
  gap: 8px;
  margin-block-end: 10px;
}
.bubble {
  flex: 1;
  min-width: 0;
}
.who {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.author {
  font-weight: 600;
  color: var(--kern-ink-700);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.text {
  margin: 2px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--kern-ink-700);
  white-space: pre-wrap;
}
.composer.new {
  border: 1px solid var(--kern-accent);
  border-radius: var(--kern-r-card);
  padding: 12px;
  background: var(--kern-surface-raised);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-block-start: 8px;
}
.thread-actions {
  display: flex;
  gap: 4px;
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
