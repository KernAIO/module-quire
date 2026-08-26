<script lang="ts">
import { Button, EmptyState, navigation, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
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

let creating = $state(false)
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
    void navigation.go(
      `/${workspaceSlug}/quire/${encodeURIComponent(spaceKey)}/${encodeURIComponent(created.id)}`,
    )
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
{:else}
  <div class="pad">
    <EmptyState icon="file-text" title={t('space_empty')} description={t('space_empty_desc')}>
      {#snippet actions()}
        {#if canQuire('pageCreate')}
          <Button disabled={creating} onclick={createFirst}>{t('new_page')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
{/if}

<style>
.pad {
  padding: 28px 32px 48px;
}
</style>
