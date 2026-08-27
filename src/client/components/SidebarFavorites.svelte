<script lang="ts">
import {
  DropdownMenu,
  formatCount,
  IconButton,
  type MenuItem,
  navigation,
  SectionLabel,
  SidebarItem,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import type { FavoriteEntry, Space } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'

/**
 * One person's own shortcuts, at the top of the sidebar where a table of contents is not.
 *
 * The list is the *workspace's*, not the space's — a favourite is "I want this to hand", and
 * losing it because you switched space would defeat the point. Each entry carries the little of
 * its page a row needs to draw itself, so the group is one request rather than one per row.
 *
 * Reordering is a drag and a menu, and the menu is not a fallback: `svelte-dnd-action` cannot be
 * reached from a keyboard, so without **Move up** and **Move down** half the people using this
 * could not reorder anything. Both go through `favorites.reorder`, which mints a fractional index
 * server-side and answers with the whole list — so the reply *is* the new order and nothing has to
 * refetch to find out what happened.
 *
 * Three traps in `svelte-dnd-action`, all of which have shipped in this project before: it tracks
 * items by an `id` property and nothing else (a favourite is keyed by `pageId`, so the rows carry
 * an `id` alias); the list must be `$state.raw`, because a deep-reactive proxy hands the library a
 * different object on every read and it reads that as an endless stream of changes; and the
 * seeding effect reads its `dragging` guard through `untrack`, or clearing the flag at the end of
 * a drop re-runs it against the old query data and undoes the move on screen.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  /** the spaces this person can see, for turning a favourite's `spaceId` into a URL */
  spaces: readonly Space[]
  activePageId: string | null
}
const { workspaceId, workspaceSlug, spaces, activePageId }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: quireKeys.favorites(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.favorites.list({ workspaceId }),
}))

type Entry = FavoriteEntry & { id: string; [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean }

const keyOf = $derived(new Map(spaces.map((s) => [s.id, s.key])))

/**
 * A favourite whose space this person cannot see is not drawn.
 *
 * The row would have nowhere to go: a page's URL is `/quire/<space key>/<page id>`, and the key
 * comes from the space list. The server already drops the entries whose *pages* are unreadable, so
 * what is left here is the narrower case of a space that has since been archived.
 */
const rows = $derived(
  (query.data ?? []).filter((f) => keyOf.has(f.spaceId)).map((f): Entry => ({ ...f, id: f.pageId })),
)

let ordered = $state.raw<Entry[]>([])
let dragging = $state(false)
let busy = $state(false)

$effect(() => {
  const next = rows
  if (untrack(() => dragging)) return
  ordered = next
})

const hrefFor = (entry: Entry) =>
  `/${workspaceSlug}/quire/${encodeURIComponent(keyOf.get(entry.spaceId) ?? '')}/${encodeURIComponent(entry.pageId)}`

const iconFor = (entry: Entry) =>
  entry.kind === 'live' ? 'square-pen' : entry.kind === 'database' ? 'database' : 'file-text'

const titleOf = (entry: Entry) => entry.title.trim() || t('untitled')

const isShadow = (entry: Entry) => Boolean(entry[SHADOW_ITEM_MARKER_PROPERTY_NAME])

/** `afterId` is the favourite to land behind; null means first. */
async function move(pageId: string, afterId: string | null) {
  if (busy) return
  busy = true
  try {
    const list = await api.favorites.reorder({ workspaceId, pageId, afterId })
    client.setQueryData(quireKeys.favorites(workspaceId), list)
  } finally {
    busy = false
  }
}

async function remove(pageId: string) {
  if (busy) return
  busy = true
  try {
    const list = await api.favorites.remove({ workspaceId, pageId })
    client.setQueryData(quireKeys.favorites(workspaceId), list)
  } finally {
    busy = false
  }
}

function consider(event: CustomEvent<{ items: Entry[] }>) {
  dragging = true
  ordered = event.detail.items
}

function finalize(event: CustomEvent<{ items: Entry[] }>) {
  const items = event.detail.items
  ordered = items
  const before = new Map(untrack(() => rows).map((r, i) => [r.id, i]))
  const moved = items.find((item, index) => before.get(item.id) !== index)
  dragging = false
  if (!moved) return
  const at = items.indexOf(moved)
  void move(moved.pageId, at > 0 ? (items[at - 1]?.pageId ?? null) : null)
}

function menuFor(entry: Entry, index: number): MenuItem[] {
  const title = titleOf(entry)
  return [
    {
      id: 'up',
      label: t('favorite_move_up', { title }),
      icon: 'chevron-up',
      disabled: index === 0,
      onSelect: () => void move(entry.pageId, index > 1 ? (ordered[index - 2]?.pageId ?? null) : null),
    },
    {
      id: 'down',
      label: t('favorite_move_down', { title }),
      icon: 'chevron-down',
      disabled: index >= ordered.length - 1,
      onSelect: () => void move(entry.pageId, ordered[index + 1]?.pageId ?? null),
    },
    { type: 'separator' },
    {
      id: 'remove',
      label: t('favorite_remove'),
      icon: 'star',
      danger: true,
      onSelect: () => void remove(entry.pageId),
    },
  ]
}

function open(entry: Entry) {
  void navigation.go(hrefFor(entry))
}
</script>

{#if ordered.length > 0}
  <div class="group">
    <SectionLabel label={t('favorites')} count={formatCount(ordered.length)} />
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="stack"
      use:dndzone={{
        items: ordered,
        flipDurationMs: 140,
        type: 'quire-favorites',
        dragDisabled: ordered.length < 2,
        dropTargetStyle: {},
      }}
      onconsider={consider}
      onfinalize={finalize}
    >
      {#each ordered as entry, index (entry.id)}
        <div class="row" class:shadow={isShadow(entry)}>
          <SidebarItem
            label={titleOf(entry)}
            icon={iconFor(entry)}
            active={activePageId === entry.pageId}
            onclick={() => open(entry)}
          >
            {#snippet trailing()}
              <!--
                Room for the menu, which is a sibling laid over the row rather than a child of it:
                `SidebarItem` is a `<button>`, and a button inside a button is invalid markup whose
                accessible name becomes the two labels run together.
              -->
              <span class="well"></span>
            {/snippet}
          </SidebarItem>

          <span class="actions">
            <DropdownMenu items={menuFor(entry, index)}>
              {#snippet trigger(props: Record<string, unknown>)}
                <IconButton
                  {...props}
                  icon="ellipsis"
                  size={22}
                  variant="ghost"
                  label={t('favorite_actions', { title: titleOf(entry) })}
                />
              {/snippet}
            </DropdownMenu>
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
.group {
  padding-block-end: 6px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.row {
  position: relative;
}
/*
 * The placeholder the library leaves where the row came from. Drawn as an outline rather than
 * faded, because fading it would mute its text against the pane — `opacity` on a row is how
 * "muted" becomes "unreadable".
 */
.row.shadow :global(.ksi) {
  visibility: hidden;
}
.row.shadow {
  border: 1px dashed var(--kern-border-strong);
  border-radius: var(--kern-r-xl);
}
.well {
  width: 22px;
  flex: none;
}
/*
 * `opacity: 0` rather than `display: none` keeps the control focusable, and `:focus-within` on the
 * row is what makes it visible once the keyboard arrives — the same shape as the page tree's add
 * button, and the reason **Move up** is reachable at all.
 */
.actions {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-end: 8px;
  transform: translateY(-50%);
  display: inline-flex;
  opacity: 0;
}
.row:hover .actions,
.row:focus-within .actions {
  opacity: 1;
}
</style>
