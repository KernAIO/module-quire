<script lang="ts">
import { Button, EmptyState, navigation, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import TemplatePicker from '../components/TemplatePicker.svelte'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'
import PageView from './PageView.svelte'

/**
 * A space with no page chosen.
 *
 * If the space has a home page, that is what opening it means; otherwise this is the first thing
 * somebody sees, so it has to offer the one action that gets them out of it.
 */
/**
 * The shell hands a module route one `params` object and never a named prop, so reading `spaceKey`
 * alone left the query disabled and every space rendered "Space not found".
 */
interface Props {
  params?: Record<string, string>
  spaceKey?: string
}
const { params, spaceKey: spaceKeyProp }: Props = $props()
const spaceKey = $derived(spaceKeyProp ?? params?.space ?? '')

const api = getQuireApi()
const workspaceSlug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === workspaceSlug)?.id ?? '')

const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const space = $derived((spacesQuery.data ?? []).find((s) => s.key === spaceKey) ?? null)

/*
 * A space without a home page is not an empty space.
 *
 * This screen used to branch on `homepageId` alone and tell anyone whose space had no home page
 * that it had no pages at all — while the sidebar beside it listed them. Opening a space means
 * "show me this space", so with no home page chosen it opens the first top-level page, and the
 * empty state is kept for the one case that is actually empty.
 */
const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, space?.id ?? ''),
  enabled: Boolean(workspaceId && space && !space.homepageId),
  queryFn: () => api.pages.tree({ workspaceId, spaceId: space?.id ?? '', includeArchived: false }),
}))

/** The first top-level page by position — the same order the sidebar draws. */
const firstPageId = $derived(
  (treeQuery.data ?? [])
    .filter((p) => p.parentId === null && !p.archivedAt)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))[0]?.id ?? null,
)

let creating = $state(false)
/**
 * The first page of an empty space is the one page most worth offering a template for — a handbook
 * that starts as a how-to is a handbook somebody kept writing. The picker still opens on **Blank
 * page**, so nothing about starting from nothing got slower.
 */
let pickerOpen = $state(false)

const open = (pageId: string) =>
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(spaceKey)}/${encodeURIComponent(pageId)}`)

async function createFirst() {
  if (!space || creating) return
  creating = true
  try {
    const created = await api.pages.create({
      workspaceId,
      spaceId: space.id,
      parentId: null,
      title: '',
      kind: 'page',
      icon: null,
      afterId: null,
    })
    open(created.id)
  } finally {
    creating = false
  }
}
</script>

{#if spacesQuery.isLoading}
  <div class="pad"><Skeleton height="36px" /></div>
{:else if !space}
  <div class="pad">
    <EmptyState icon="scroll-text" title={t('space_missing')} description={t('space_missing_desc')} />
  </div>
{:else if space.homepageId}
  <PageView {spaceKey} pageId={space.homepageId} />
{:else if treeQuery.isLoading}
  <div class="pad"><Skeleton height="36px" /></div>
{:else if firstPageId}
  <PageView {spaceKey} pageId={firstPageId} />
{:else}
  <div class="pad">
    <EmptyState icon="file-text" title={t('space_empty')} description={t('space_empty_desc')}>
      {#snippet actions()}
        {#if canQuire('pageCreate')}
          <Button aria-busy={creating} onclick={() => (pickerOpen = true)}>{t('new_page')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
  <TemplatePicker
    bind:open={pickerOpen}
    {workspaceId}
    spaceId={space.id}
    onBlank={() => void createFirst()}
    onMade={(result) => result.pageId && open(result.pageId)}
  />
{/if}

<style>
.pad {
  padding: 28px 32px 48px;
}
</style>
