<script lang="ts">
import { Avatar, Badge, Button, EmptyState, ListRow, relativeTime, Sheet, Skeleton } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { PageVersion } from '../index.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'

/**
 * What a page used to say, and how to put it back.
 *
 * Restoring is offered without a confirmation on purpose: it captures the state it replaces first,
 * so it is undoable by restoring the version it just made. A confirmation dialog on a reversible
 * action trains people to click through the ones that are not.
 */
interface Props {
  open: boolean
  workspaceId: string
  pageId: string
  publishedVersionId: string | null
}
let { open = $bindable(false), workspaceId, pageId, publishedVersionId }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: [...quireKeys.page(workspaceId, pageId), 'versions'],
  enabled: open && Boolean(workspaceId && pageId),
  queryFn: () => api.versions.list({ workspaceId, pageId, limit: 50 }),
}))

const versions = $derived(query.data?.items ?? [])

let restoring = $state<string | null>(null)
let error = $state<string | null>(null)

/**
 * Which version is open, and what it said.
 *
 * A row shows 160 characters of flattened text, which tells you a version exists and nothing about
 * what was in it — the headings, the table, the paragraph somebody is looking for. The document is
 * stored; `versions.get` draws it. Fetched only when a row is opened, because the whole point of
 * the list is that it loads without fifty documents behind it.
 */
let previewing = $state<string | null>(null)

const preview = createQuery(() => ({
  queryKey: [...quireKeys.page(workspaceId, pageId), 'version', previewing],
  enabled: previewing !== null,
  queryFn: () => api.versions.get({ workspaceId, versionId: previewing as string }),
}))

async function restore(version: PageVersion) {
  if (restoring) return
  restoring = version.id
  error = null
  try {
    await api.versions.restore({ workspaceId, versionId: version.id })
    await client.invalidateQueries({ queryKey: quireKeys.page(workspaceId, pageId) })
    await query.refetch()
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    restoring = null
  }
}

const kindLabel = (v: PageVersion) =>
  v.kind === 'publish'
    ? t('version_published')
    : v.kind === 'restore'
      ? t('version_restored')
      : v.kind === 'import'
        ? t('version_imported')
        : t('version_auto')
</script>

<Sheet bind:open title={t('history')} width={420}>
  {#if query.isLoading}
    <div class="rows">
      {#each [1, 2, 3, 4] as n (n)}<Skeleton height="56px" />{/each}
    </div>
  {:else if query.isError}
    <EmptyState icon="triangle-alert" title={t('history_error')} description={t('retry')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void query.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if versions.length === 0}
    <EmptyState icon="scroll-text" title={t('history_empty')} description={t('history_empty_desc')} />
  {:else}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="rows">
      {#each versions as version (version.id)}
        <ListRow>
          <div class="row">
            <Avatar id={version.authorId} size={24} />
            <div class="meta">
              <div class="line">
                <span class="when">{relativeTime(version.createdAt)}</span>
                {#if version.id === publishedVersionId}
                  <Badge tone="active">{t('version_live')}</Badge>
                {:else}
                  <span class="kind">{version.label || kindLabel(version)}</span>
                {/if}
              </div>
              {#if version.preview}
                <p class="preview">{version.preview}</p>
              {/if}
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={previewing === version.id}
              onclick={() => {
                previewing = previewing === version.id ? null : version.id
              }}
            >
              {previewing === version.id ? t('version_preview_hide') : t('version_preview')}
            </Button>
            {#if canQuire('pageEdit') && version.id !== publishedVersionId}
              <Button
                size="sm"
                variant="secondary"
                disabled={restoring !== null}
                onclick={() => restore(version)}
              >
                {restoring === version.id ? t('restoring') : t('restore')}
              </Button>
            {/if}
          </div>
          {#if previewing === version.id}
            <div class="body">
              {#if preview.isLoading}
                <Skeleton height="72px" />
              {:else if preview.isError}
                <p class="error" role="alert">{t('version_preview_error')}</p>
              {:else if preview.data?.html}
                <!-- Every value in it is escaped by the server's renderer; see src/server/render.ts. -->
                <div class="kern-prose">{@html preview.data.html}</div>
              {:else}
                <p class="empty">{t('version_preview_empty')}</p>
              {/if}
            </div>
          {/if}
        </ListRow>
      {/each}
    </div>
  {/if}
</Sheet>

<style>
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
}
.meta {
  flex: 1;
  min-width: 0;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.when {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.kind {
  font-size: 12.5px;
  color: var(--kern-ink-400);
}
.preview {
  margin: 3px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-400);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.error {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--kern-danger);
}
.body {
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--kern-r-card);
  background: var(--kern-surface-raised);
  font-size: 13px;
  /* A version can hold a wide table; it scrolls inside this box rather than pushing the sheet. */
  overflow-x: auto;
}
.empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-ink-400);
}
</style>
