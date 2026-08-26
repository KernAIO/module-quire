<script lang="ts">
import { Button, Card, EmptyState, Icon, navigation, Page, PageHeader, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import NewSpaceDialog from '../components/NewSpaceDialog.svelte'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'

/**
 * The spaces in this workspace.
 *
 * Quire's front door is a list of spaces rather than a page, because a space is the unit people
 * think in — "the handbook", "engineering" — and the tree in the sidebar only makes sense once one
 * is chosen. A space with a home page opens straight to it.
 */
const api = getQuireApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const spaceList = $derived(spacesQuery.data ?? [])

let newOpen = $state(navigation.search.new === '1')

function open(key: string) {
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(key)}`)
}
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('title') }]}
  title={t('title')}
  subtitle={t('subtitle')}
>
  {#snippet actions()}
    {#if canQuire('spaceManage')}
      <Button size="sm" onclick={() => (newOpen = true)}>{t('new_space')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  {#if spacesQuery.isLoading}
    <div class="grid">
      {#each [1, 2, 3] as n (n)}<Skeleton height="112px" />{/each}
    </div>
  {:else if spacesQuery.isError}
    <EmptyState icon="triangle-alert" title={t('spaces_error')} description={t('spaces_error_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void spacesQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if spaceList.length === 0}
    <EmptyState icon="scroll-text" title={t('no_spaces')} description={t('no_spaces_desc')}>
      {#snippet actions()}
        {#if canQuire('spaceManage')}
          <Button icon="plus" onclick={() => (newOpen = true)}>{t('new_space')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="grid">
      {#each spaceList as space (space.id)}
        <button class="space" type="button" onclick={() => open(space.key)}>
          <Card>
            <div class="head">
              <span class="ic"><Icon name={space.icon || 'scroll-text'} size={18} /></span>
              <span class="name">{space.name}</span>
            </div>
            {#if space.description}
              <p class="desc">{space.description}</p>
            {/if}
            <p class="meta">
              {space.visibility === 'open'
                ? t('visibility_open')
                : space.visibility === 'restricted'
                  ? t('visibility_restricted')
                  : t('visibility_private')}
            </p>
          </Card>
        </button>
      {/each}
    </div>
  {/if}
</Page>

<NewSpaceDialog bind:open={newOpen} {workspaceId} onCreated={(space) => open(space.key)} />

<style>
.grid {
  display: grid;
  /*
   * `auto-fit`, not `auto-fill`. `auto-fill` keeps the empty tracks, so two spaces in a wide window
   * sit at their minimum width with the rest of the row blank; `auto-fit` collapses them and the
   * cards share the space. Every other card grid in the app already does this.
   */
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.space {
  border: 0;
  background: none;
  padding: 0;
  text-align: start;
  cursor: pointer;
  font: inherit;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ic {
  display: inline-flex;
  color: var(--kern-ink-400);
}
.name {
  font-size: 15px;
  font-weight: 600;
  color: var(--kern-ink-900);
  letter-spacing: -0.01em;
}
.desc {
  margin: 8px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--kern-ink-650);
}
.meta {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--kern-ink-400);
}
</style>
