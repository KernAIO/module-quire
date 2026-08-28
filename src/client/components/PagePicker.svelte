<script lang="ts">
import { Dialog, EmptyState, Icon, Input, Select, Skeleton } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { PageNode } from '../index.js'
import { quireKeys } from '../query.js'

/**
 * Which page a macro points at.
 *
 * Two of the eight macros — include page, and include another page's excerpt — name a page, and
 * `@kernhq/ui` cannot search for one: it is a design system, it has no API client, and a macro
 * whose `pageId` is null draws an empty frame for every reader. So the `/` menu offers those two
 * entries **only** where the host supplies a picker, exactly as it does for Image. This is that
 * picker, and without it those two macros are in the schema and unreachable — which is the state
 * they were in.
 *
 * Three decisions worth stating, because each of them is a thing that would otherwise be wrong:
 *
 * - **Only what a macro can actually draw is offered.** The resolver's `drawable` filter takes
 *   ordinary pages and nothing else — no databases, no live docs, nothing archived or in the trash
 *   — so offering one of those here would let somebody choose a page that renders as an empty frame
 *   for ever, with nothing anywhere saying why. The row that is not there is the honest answer.
 * - **A page can be picked out of any space, so the space is a control rather than an assumption.**
 *   An include that crosses spaces is the normal case for a handbook quoting a policy, and the
 *   permission question is asked at render time against whoever is reading — never here. This
 *   dialog offers what *this* writer may see, which is what `spaces.list` and `pages.tree` already
 *   return; it decides nothing about anybody else.
 * - **Enter picks the first row.** Type three letters and press Enter, which is how everybody uses
 *   a picker; the mouse and Tab both still work. Escape leaves without choosing, and dismissing has
 *   to resolve the promise the `/` menu is waiting on — an unresolved one leaves the editor with a
 *   menu entry that appears to do nothing.
 */
interface Props {
  open: boolean
  workspaceId: string
  /** the space the writer is in, which is where the picker starts */
  spaceId: string
  /** the page holding the macro — a page cannot usefully include itself */
  excludeId?: string | null
  /** the choice, or null when the dialog was dismissed. The title is for the editor's card only. */
  onPick: (page: { id: string; title: string } | null) => void
}
let { open = $bindable(false), workspaceId, spaceId, excludeId = null, onPick }: Props = $props()

const api = getQuireApi()

let search = $state('')
let chosenSpace = $state(spaceId)
/**
 * Whether this opening has already answered.
 *
 * Not `$state`: nothing draws it, and it exists so that choosing a row does not also fire the
 * dismissal path when `open` goes false. A promise resolved twice is not an error anybody sees —
 * the second answer is dropped silently — which is exactly why it is worth being explicit.
 */
let settled = false

$effect(() => {
  if (!open) return
  settled = false
  search = ''
  chosenSpace = spaceId
})

const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId) && open,
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const spaceList = $derived(spacesQuery.data ?? [])

const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, chosenSpace),
  enabled: Boolean(workspaceId && chosenSpace) && open,
  queryFn: () => api.pages.tree({ workspaceId, spaceId: chosenSpace, includeArchived: false }),
}))

interface Row {
  id: string
  title: string
  /** the pages above it, so two "Overview" rows can be told apart */
  path: string
}

const nodes = $derived(treeQuery.data ?? [])

/**
 * The tree, flattened to rows with a readable path.
 *
 * `pages.tree` answers with a flat, position-ordered list and a `parentId` on each row, so the path
 * is a walk up through a map rather than a second request. It is bounded: a cycle would be a bug in
 * a move, and a picker is not the place to hang on one.
 */
const rows = $derived.by((): Row[] => {
  const byId = new Map<string, PageNode>(nodes.map((node) => [node.id, node]))
  const out: Row[] = []
  for (const node of nodes) {
    if (node.kind !== 'page' || node.archivedAt || node.id === excludeId) continue
    const names: string[] = []
    let parent = node.parentId ? byId.get(node.parentId) : undefined
    for (let i = 0; parent && i < 8; i++) {
      names.unshift(parent.title.trim() || t('untitled'))
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    out.push({ id: node.id, title: node.title.trim() || t('untitled'), path: names.join(' / ') })
  }
  return out
})

/** At most this many rows are drawn. Somebody past forty matches should type another letter. */
const MAX_ROWS = 40

const matches = $derived.by((): Row[] => {
  const needle = search.trim().toLowerCase()
  const hits = needle
    ? rows.filter(
        (row) => row.title.toLowerCase().includes(needle) || row.path.toLowerCase().includes(needle),
      )
    : rows
  return hits.slice(0, MAX_ROWS)
})

function choose(row: Row) {
  if (settled) return
  settled = true
  open = false
  onPick({ id: row.id, title: row.title })
}

function dismissed() {
  if (settled) return
  settled = true
  onPick(null)
}

function onSearchKey(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  const first = matches[0]
  if (!first) return
  event.preventDefault()
  choose(first)
}
</script>

<Dialog
  bind:open
  title={t('macro_pick_page')}
  description={t('macro_pick_page_desc')}
  size="md"
  onOpenChange={(next) => {
    if (!next) dismissed()
  }}
>
  <div class="picker">
    <div class="controls">
      <Input
        bind:value={search}
        icon="search"
        placeholder={t('macro_pick_search')}
        aria-label={t('macro_pick_search')}
        onkeydown={onSearchKey}
      />
      {#if spaceList.length > 1}
        <Select
          ariaLabel={t('macro_pick_space')}
          value={chosenSpace}
          options={spaceList.map((space) => ({ value: space.id, label: space.name }))}
          onValueChange={(value: string) => (chosenSpace = value)}
        />
      {/if}
    </div>

    {#if treeQuery.isPending}
      <div class="loading">
        {#each [0, 1, 2, 3] as row (row)}<Skeleton height="34px" />{/each}
      </div>
    {:else if matches.length === 0}
      <EmptyState icon="search" title={t('macro_pick_none')} description={t('macro_pick_none_desc')} />
    {:else}
      <!--
        A list of buttons rather than a listbox: each row does something the moment it is activated,
        which is what a button is. Tab reaches every row, Enter and Space activate it, and the
        search field's Enter takes the first — so the whole dialog is usable without a pointer.
      -->
      <ul class="rows">
        {#each matches as row (row.id)}
          <li>
            <button type="button" class="row" onclick={() => choose(row)}>
              <Icon name="file-text" size={14} />
              <span class="title">{row.title}</span>
              {#if row.path}<span class="path">{row.path}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Dialog>

<style>
.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* The dialog grows with its content up to here, then the list scrolls rather than the page. */
  max-height: 60vh;
}
.controls {
  display: flex;
  gap: 8px;
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  /* Logical, so the row reads from the right in Persian and Arabic without a second rule. */
  padding: 7px 10px;
  border: 0;
  border-radius: var(--kern-r-md);
  background: transparent;
  color: var(--kern-ink-800);
  font: inherit;
  font-size: 13.5px;
  text-align: start;
  cursor: pointer;
}
.row:hover,
.row:focus-visible {
  background: var(--kern-surface-hover);
}
.title {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * The path is secondary and is muted with a colour, never with `opacity` — fading it against the
 * page is how a line meant to read as quieter ends up unreadable, whatever its token says.
 */
.path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kern-ink-450);
  font-size: 12.5px;
}
</style>
