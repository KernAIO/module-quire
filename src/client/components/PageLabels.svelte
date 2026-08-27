<script lang="ts">
import { DropdownMenu, IconButton, type MenuItem } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import LabelChip from './LabelChip.svelte'
import LabelManager from './LabelManager.svelte'

/**
 * The labels a page wears, and the menu that changes them.
 *
 * `pages.setLabels` replaces the whole set rather than adding one, so this holds the ticked set
 * locally and sends all of it on every toggle. That is what makes unticking expressible at all —
 * an additive procedure would need a second one to pair with it, and the pair would then have to
 * agree about a page two people are editing.
 *
 * The local set is also what makes the menu feel like a menu. A checkbox that only ticks once the
 * server has answered reads as broken at any latency worth having, so the tick lands immediately
 * and the request follows; a failure resyncs from the server rather than leaving a lie on screen.
 *
 * The seeding effect reads `selected` and `inflight` through `untrack` because it writes the first
 * and is gated on the second — tracked, the write would make the effect its own trigger and every
 * tick would be undone by the stale answer still in the cache.
 */
interface Props {
  workspaceId: string
  spaceId: string
  pageId: string
  canEdit: boolean
  canManage: boolean
}
const { workspaceId, spaceId, pageId, canEdit, canManage }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const onPage = createQuery(() => ({
  queryKey: quireKeys.pageLabels(workspaceId, pageId),
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.labels.forPage({ workspaceId, pageId }),
}))

/** The whole vocabulary, so the menu can offer what is *not* on the page as well as what is. */
const inSpace = createQuery(() => ({
  queryKey: quireKeys.labels(workspaceId, spaceId),
  enabled: Boolean(workspaceId && spaceId),
  queryFn: () => api.labels.list({ workspaceId, spaceId }),
}))

let selected = $state(new Set<string>())
let inflight = $state(0)
let managerOpen = $state(false)

$effect(() => {
  const data = onPage.data
  if (!data) return
  if (untrack(() => inflight) > 0) return
  const next = new Set(data.map((l) => l.id))
  const current = untrack(() => selected)
  if (next.size !== current.size || [...next].some((id) => !current.has(id))) selected = next
})

/**
 * Drawn from the space's list rather than from the page's own answer, so a rename shows up on the
 * chip without this page being refetched — and so a tick that has not reached the server yet is
 * already a chip. The page's answer stands in until the list has loaded.
 */
const chips = $derived(
  inSpace.data
    ? inSpace.data.filter((l) => selected.has(l.id))
    : (onPage.data ?? []).filter((l) => selected.has(l.id)),
)

async function toggle(labelId: string, on: boolean) {
  const next = new Set(selected)
  if (on) next.add(labelId)
  else next.delete(labelId)
  selected = next
  inflight++
  try {
    await api.pages.setLabels({ workspaceId, pageId, labelIds: [...next] })
  } catch {
    // The optimistic tick was a guess; the server's answer is the fact.
    await onPage.refetch()
  } finally {
    inflight--
    /*
     * The whole `label` prefix, not just this page's key. The sidebar's label filter holds a
     * page-to-labels map for the space, and labelling a page here is precisely what makes it
     * stale — the server announces `page updated` for this, which lands on the `page` prefix and
     * never reaches it.
     */
    if (inflight === 0) await client.invalidateQueries({ queryKey: ['quire', 'label', workspaceId] })
  }
}

const items = $derived.by((): MenuItem[] => {
  const all = inSpace.data ?? []
  const rows: MenuItem[] = [{ type: 'label', label: t('labels_edit') }]
  if (all.length === 0) rows.push({ id: 'none', label: t('labels_empty'), disabled: true })
  for (const label of all)
    rows.push({
      type: 'checkbox',
      id: label.id,
      label: label.name,
      checked: selected.has(label.id),
      onCheckedChange: (on: boolean) => void toggle(label.id, on),
    })
  if (canManage) {
    rows.push({ type: 'separator' })
    rows.push({
      id: 'manage',
      label: t('labels_manage'),
      icon: 'settings',
      onSelect: () => (managerOpen = true),
    })
  }
  return rows
})
</script>

{#if chips.length > 0 || canEdit}
  <div class="labels">
    {#each chips as label (label.id)}
      <LabelChip {label} />
    {/each}

    {#if canEdit}
      <DropdownMenu {items} align="start">
        {#snippet trigger(props: Record<string, unknown>)}
          <IconButton
            {...props}
            icon="tag"
            size={26}
            variant="ghost"
            label={chips.length === 0 ? t('label_none_on_page') : t('labels_edit')}
          />
        {/snippet}
      </DropdownMenu>
    {/if}
  </div>
{/if}

{#if canManage}
  <LabelManager bind:open={managerOpen} {workspaceId} {spaceId} />
{/if}

<style>
.labels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-block-start: 12px;
}
</style>
