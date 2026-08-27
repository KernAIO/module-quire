<script lang="ts">
import {
  Button,
  DropdownMenu,
  EmptyState,
  IconButton,
  type MenuItem,
  navigation,
  SearchBox,
  SectionLabel,
  Select,
  SidebarItem,
  Skeleton,
  session,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import type { Label } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { buildPageTree, type PageTreeNode } from '../index.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'
import LabelManager from './LabelManager.svelte'
import PageTreeRow from './PageTreeRow.svelte'
import SidebarFavorites from './SidebarFavorites.svelte'
import SidebarRecents from './SidebarRecents.svelte'

/**
 * Quire's spaces and pages, in the application sidebar (DESIGN.md §2.3).
 *
 * The sidebar belongs to whichever module you are in — that is why a wiki gets a space switcher, a
 * "Search this space" box and its page tree here rather than a third column. The tree is the table
 * of contents, so it shows every level at once and comes from one request per space.
 */
const api = getQuireApi()
const client = useQueryClient()

/**
 * The shell passes these — `SidebarProps` — and they are the ones to use.
 *
 * Reading `navigation` here instead looks equivalent and is not: the shell fills that singleton
 * from an `$effect`, which runs *after* the first render, so the sidebar's first paint would query
 * with an empty workspace id and show nothing.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  pathname: string
  segment: string
}
const { workspaceId, workspaceSlug, pathname }: Props = $props()

const spaceKeyInUrl = $derived(navigation.params.space ?? null)
const activePageId = $derived(navigation.params.page ?? null)

const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))

const spaceList = $derived(spacesQuery.data ?? [])
const activeSpace = $derived(spaceList.find((space) => space.key === spaceKeyInUrl) ?? spaceList[0] ?? null)

const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, activeSpace?.id ?? ''),
  enabled: Boolean(workspaceId && activeSpace),
  queryFn: () => api.pages.tree({ workspaceId, spaceId: activeSpace?.id ?? '', includeArchived: false }),
}))

let search = $state('')
let expanded = $state(new Set<string>())

const nodes = $derived(treeQuery.data ?? [])
const roots = $derived(buildPageTree(nodes))

/**
 * Searching replaces the tree in the same scroll area rather than appearing under it, so the results
 * are where the list was and never below the fold. It filters what is already loaded — the whole
 * space is in memory — so it costs no request and answers as you type.
 */
const query = $derived(search.trim().toLowerCase())
const matches = $derived(
  query ? nodes.filter((n) => (n.title || t('untitled')).toLowerCase().includes(query)) : [],
)

/**
 * A page opened from a link may be nested; its ancestors have to be open for it to be visible.
 *
 * `expanded` is read through `untrack` because this effect also writes it. Tracked, the write makes
 * the effect its own trigger: collapsing an ancestor of the open page removed it from the set, the
 * effect re-ran and put it straight back, and the disclosure was inert — click it, press Enter on
 * it, nothing moves. That is the "effect that reads a flag it also clears" trap already written
 * down in shell's CLAUDE.md, and it was invisible until `navigation.params.page` started arriving:
 * with `activePageId` permanently null the loop never ran at all.
 *
 * What genuinely selects this effect is which page is open and what the tree contains. Whether a
 * disclosure is open is the *result*, and a result must not be an input.
 */
$effect(() => {
  if (!activePageId || nodes.length === 0) return
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const current = untrack(() => expanded)
  const next = new Set(current)
  let cursor = byId.get(activePageId)?.parentId ?? null
  let guard = 0
  while (cursor && guard++ < 100) {
    next.add(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  if (next.size !== current.size) expanded = next
})

function toggle(id: string) {
  const next = new Set(expanded)
  if (!next.delete(id)) next.add(id)
  expanded = next
}

function openPage(id: string) {
  if (!activeSpace) return
  void navigation.go(
    `/${workspaceSlug}/quire/${encodeURIComponent(activeSpace.key)}/${encodeURIComponent(id)}`,
  )
}

function switchSpace(key: string) {
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(key)}`)
}

// ---------------------------------------------------------------------------------------------
// Labels: the space's vocabulary, and the filter built on it
// ---------------------------------------------------------------------------------------------

let labelFilter = $state<string | null>(null)
let labelsOpen = $state(false)

const labelsQuery = createQuery(() => ({
  queryKey: quireKeys.labels(workspaceId, activeSpace?.id ?? ''),
  enabled: Boolean(workspaceId && activeSpace),
  queryFn: () => api.labels.list({ workspaceId, spaceId: activeSpace?.id ?? '' }),
}))
const labelList = $derived(labelsQuery.data ?? [])
const activeLabel = $derived(labelList.find((l) => l.id === labelFilter) ?? null)

/** Switching space takes its vocabulary with it, so a filter from the last one must not survive. */
$effect(() => {
  void activeSpace?.id
  labelFilter = null
})

/**
 * Which pages wear which label — one request per page in the space.
 *
 * That is the honest cost and it is worth naming: the contract has `labels.forPage` and nothing
 * that answers "which pages wear this label", so a filter can only be built by asking about each
 * page. It is therefore gated behind actually choosing a filter rather than run on load, and
 * bounded — a space past `MAX_LABEL_SCAN` pages is not scanned at all, and the filter says nothing
 * matched rather than firing a thousand requests. The fix is a listing on the server; until it
 * exists this is the shape that works without one.
 */
const MAX_LABEL_SCAN = 400
const CONCURRENCY = 8

const labelMapQuery = createQuery(() => ({
  queryKey: ['quire', 'label', workspaceId, 'tree', activeSpace?.id ?? '', nodes.length] as const,
  enabled: Boolean(workspaceId && activeSpace && labelFilter && nodes.length > 0),
  staleTime: 30_000,
  queryFn: async () => {
    const wanted = nodes.slice(0, MAX_LABEL_SCAN).map((n) => n.id)
    const map: Record<string, string[]> = {}
    for (let from = 0; from < wanted.length; from += CONCURRENCY) {
      const slice = wanted.slice(from, from + CONCURRENCY)
      const answers = await Promise.all(slice.map((pageId) => api.labels.forPage({ workspaceId, pageId })))
      slice.forEach((pageId, at) => {
        map[pageId] = (answers[at] ?? []).map((l: Label) => l.id)
      })
    }
    return map
  },
}))

const labelled = $derived.by(() => {
  const wanted = labelFilter
  const map = labelMapQuery.data
  if (!wanted || !map) return []
  return nodes.filter((n) => (map[n.id] ?? []).includes(wanted))
})

const filterMenu = $derived.by((): MenuItem[] => [
  { type: 'label', label: t('label_filter') },
  {
    type: 'radio',
    value: labelFilter ?? '',
    options: [
      { value: '', label: t('label_filter_all') },
      ...labelList.map((l) => ({ value: l.id, label: l.name })),
    ],
    onValueChange: (value: string) => {
      labelFilter = value === '' ? null : value
    },
  },
])

/**
 * `pathname` is a prop, not `navigation.pathname`.
 *
 * The shell fills that singleton from an `$effect`, which runs after the first render — the same
 * reason `workspaceId` is a prop here. Reading it instead would leave the trash entry unhighlighted
 * on the paint that matters.
 */
const onTrash = $derived(pathname.endsWith('/trash'))

function openTrash() {
  if (!activeSpace) return
  void navigation.go(`/${workspaceSlug}/quire/${encodeURIComponent(activeSpace.key)}/trash`)
}

let creating = $state(false)

async function createPage(parentId: string | null) {
  if (!activeSpace || creating) return
  creating = true
  try {
    const created = await api.pages.create({
      workspaceId,
      spaceId: activeSpace.id,
      parentId,
      title: '',
      kind: 'page',
      icon: null,
      afterId: null,
    })
    await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, activeSpace.id) })
    if (parentId) expanded = new Set(expanded).add(parentId)
    openPage(created.id)
  } finally {
    creating = false
  }
}
</script>

<div class="wrap">
  {#if spaceList.length > 1}
    <div class="switcher">
      <!--
        `ariaLabel`, because the trigger otherwise falls back to the placeholder and announces
        itself as "Select…" — which names nothing. The chosen space is read after the label.
      -->
      <Select
        value={activeSpace?.key ?? ''}
        ariaLabel={t('space_choose')}
        options={spaceList.map((space) => ({ value: space.key, label: space.name }))}
        onValueChange={(v: string) => switchSpace(v)}
      />
    </div>
  {/if}

  <div class="strip">
    <SearchBox bind:value={search} placeholder={t('search_space')} />
    {#if labelList.length > 0}
      <DropdownMenu items={filterMenu}>
        {#snippet trigger(props: Record<string, unknown>)}
          <IconButton
            {...props}
            icon="filter"
            size={30}
            variant="ghost"
            active={labelFilter !== null}
            label={t('label_filter')}
          />
        {/snippet}
      </DropdownMenu>
    {/if}
  </div>

  <div class="scroll">
    <SidebarFavorites
      {workspaceId}
      {workspaceSlug}
      spaces={spaceList}
      activePageId={activePageId}
    />

    {#if spacesQuery.isLoading || treeQuery.isLoading}
      <div class="loading">
        {#each [1, 2, 3, 4, 5] as n (n)}
          <Skeleton height="34px" />
        {/each}
      </div>
    {:else if spacesQuery.isError || treeQuery.isError}
      <EmptyState
        icon="triangle-alert"
        title={t('tree_error')}
        description={t('tree_error_desc')}
      >
        {#snippet actions()}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              void spacesQuery.refetch()
              void treeQuery.refetch()
            }}
          >
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if spaceList.length === 0}
      <EmptyState icon="scroll-text" title={t('no_spaces')} description={t('no_spaces_desc')} />
    {:else if labelFilter}
      <!--
        A label filter replaces the tree in the same scroll area, exactly as search does: what a
        label gathers is a set of pages rather than a shape, and drawing it as a tree with the
        unmatched branches still in it would answer a different question. The banner names the
        filter and carries the way out of it — a filtered sidebar with no visible reason for being
        short is how somebody concludes their pages are gone.
      -->
      <div class="banner">
        <span class="banner-text">{t('label_filter_active', { name: activeLabel?.name ?? '' })}</span>
        <IconButton
          icon="x"
          size={22}
          variant="ghost"
          label={t('label_filter_clear')}
          onclick={() => (labelFilter = null)}
        />
      </div>
      {#if labelMapQuery.isLoading}
        <div class="loading">
          {#each [1, 2, 3] as n (n)}
            <Skeleton height="34px" />
          {/each}
        </div>
      {:else if labelled.length === 0}
        <p class="none">{t('label_filter_none')}</p>
      {:else}
        {#each labelled as node (node.id)}
          <PageTreeRow
            node={{ ...node, children: [] } as PageTreeNode}
            depth={0}
            activeId={activePageId}
            expanded={new Set()}
            onToggle={() => {}}
            onOpen={openPage}
            onCreateChild={createPage}
            canCreate={false}
          />
        {/each}
      {/if}
    {:else if query}
      <SectionLabel label={t('search_results')} />
      {#if matches.length === 0}
        <p class="none">{t('search_none')}</p>
      {:else}
        {#each matches as node (node.id)}
          <PageTreeRow
            node={{ ...node, children: [] } as PageTreeNode}
            depth={0}
            activeId={activePageId}
            expanded={new Set()}
            onToggle={() => {}}
            onOpen={openPage}
            onCreateChild={createPage}
            canCreate={false}
          />
        {/each}
      {/if}
    {:else}
      <SectionLabel label={activeSpace?.name ?? t('nav')} />
      {#if roots.length === 0}
        <p class="none">{t('space_empty')}</p>
      {:else}
        {#each roots as node (node.id)}
          <PageTreeRow
            {node}
            depth={0}
            activeId={activePageId}
            {expanded}
            onToggle={toggle}
            onOpen={openPage}
            onCreateChild={createPage}
            canCreate={canQuire('pageCreate')}
          />
        {/each}
      {/if}

      {#if canQuire('pageCreate') && activeSpace}
        <div class="new">
          <Button variant="ghost" size="sm" icon="plus" disabled={creating} onclick={() => createPage(null)}>
            {t('new_page')}
          </Button>
        </div>
      {/if}

      <SidebarRecents
        {workspaceId}
        {workspaceSlug}
        spaces={spaceList}
        activePageId={activePageId}
      />
    {/if}
  </div>

  <!--
    Outside the scroll area, so the way back from a deletion is where it can always be found rather
    than wherever a long tree happens to end. This is the only entrance to the trash: without it
    `pages.trash` was a procedure with no screen, and "Move to trash" was a one-way door.
  -->
  {#if activeSpace}
    <div class="foot">
      {#if canQuire('pageEdit')}
        <SidebarItem
          label={t('trash')}
          icon="trash-2"
          active={onTrash}
          onclick={openTrash}
        />
      {/if}
      {#if canQuire('spaceManage')}
        <SidebarItem label={t('labels')} icon="tag" onclick={() => (labelsOpen = true)} />
      {/if}
    </div>
  {/if}
</div>

{#if activeSpace && canQuire('spaceManage')}
  <LabelManager bind:open={labelsOpen} {workspaceId} spaceId={activeSpace.id} />
{/if}

<style>
.wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.switcher {
  padding: 10px 12px 0;
}
.strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 4px;
}
/*
 * The search box takes the room and the filter is a fixed 30px beside it. Selected as the first
 * child rather than by `SearchBox`'s own class — that class belongs to `@kernhq/ui` and a module
 * reaching for it is a rule that stops working silently the next time the design system renames
 * something.
 */
.strip > :global(:first-child) {
  flex: 1;
  min-width: 0;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 14px;
  min-height: 0;
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-block-start: 8px;
}
.none {
  padding: 10px;
  font-size: 13px;
  color: var(--kern-ink-400);
  margin: 0;
}
.new {
  padding-block-start: 6px;
}
/*
 * Pinned to the bottom of the pane, and sticky rather than flex-pinned.
 *
 * The scroller is the shell's own `nav`, not this component — `.scroll` below never actually
 * overflows, because nothing above gives `.wrap` a height to work against. So a footer laid out as
 * the last flex child sits after the tree and scrolls away with it, which for a space of any size
 * puts the only way back from a deletion below the fold. `position: sticky` inside somebody else's
 * scrollport is what works from in here, and it needs an opaque background of its own:
 * `--kern-shell` is the pane's colour, so the rows underneath do not read through it.
 */
.foot {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 12px 12px;
  background: var(--kern-shell);
  border-block-start: 1px solid var(--kern-border);
}
/*
 * A sticky element stops at the scrollport's *padding* edge, and the pane has 14px of it — so rows
 * scrolling underneath reappeared in the strip below this footer, which in dark mode is a bright
 * cream sliver of whichever row happens to be active. Measured, not guessed. The background is bled
 * downwards rather than the offset being negative, so the exact padding does not have to be known
 * here — and 24px covers it with room to spare.
 */
.foot::after {
  content: '';
  position: absolute;
  inset-block-start: 100%;
  inset-inline: 0;
  height: 24px;
  background: var(--kern-shell);
}
.banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-block: 6px 4px;
  /*
   * Logical, not `padding: 6px 6px 6px 10px`. The extra room belongs to the sentence and the
   * tighter side to the clear button beside it, and written physically that pairing survives only
   * in English: under `dir="rtl"` the 10px stayed on the physical left, which is where the button
   * is, so Persian and Arabic read the banner with the padding swapped.
   */
  padding-block: 6px;
  padding-inline: 10px 6px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-accent-tint);
}
.banner-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--kern-accent-deep);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
