<script lang="ts">
import { Icon, IconButton, Popover, SearchBox, Spinner } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { PropertyConfig, RowRef } from '../../../contract/index.js'
import { getQuireApi } from '../../api-instance.js'
import { t } from '../../i18n.js'
import { quireKeys } from '../../query.js'

/**
 * Rows linked from another database.
 *
 * A relation stores page ids and nothing else, so both jobs this cell has — drawing the links it
 * already holds and finding the next one — are `databases.lookup` calls against the database on the
 * other side. Without the first, the column is a list of uuids.
 *
 * The write goes through `updateRow`'s props like every other cell; the server splits relation keys
 * out and routes them to `setRelation`, so the join table and the mirror in `props` cannot diverge
 * whichever surface did the editing.
 */
interface Props {
  value: unknown
  name: string
  config: PropertyConfig
  workspaceId: string
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, config, workspaceId, editable, reason, onchange }: Props = $props()

const api = getQuireApi()

const ids = $derived(
  value == null ? [] : (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== ''),
)
const targetId = $derived(config.relationDatabaseId ?? null)

let open = $state(false)
let term = $state('')

/** The names of what is already linked. Keyed by the ids so it re-resolves when they change. */
const linked = createQuery(() => ({
  queryKey: [...quireKeys.lookup(workspaceId, targetId ?? '', 'ids'), ids.join(',')],
  enabled: Boolean(workspaceId && targetId) && ids.length > 0,
  queryFn: () => api.databases.lookup({ workspaceId, databaseId: targetId!, ids, query: '', limit: 100 }),
}))

const search = createQuery(() => ({
  queryKey: quireKeys.lookup(workspaceId, targetId ?? '', term),
  enabled: Boolean(workspaceId && targetId) && open,
  queryFn: () =>
    api.databases.lookup({ workspaceId, databaseId: targetId!, query: term, ids: [], limit: 25 }),
}))

/** An id whose row has been deleted still has to draw as something. */
const chips = $derived<RowRef[]>(
  ids.map((id) => (linked.data ?? []).find((r) => r.id === id) ?? { id, title: t('untitled'), icon: null }),
)

const results = $derived((search.data ?? []).filter((r) => !ids.includes(r.id)))

const link = (id: string) => {
  onchange([...ids, id])
  term = ''
}
const unlink = (id: string) => onchange(ids.filter((v) => v !== id))
</script>

<span class="rel">
  {#each chips as chip (chip.id)}
    <span class="chip">
      <span class="nm">{chip.title.trim() || t('untitled')}</span>
      {#if editable}
        <button
          type="button"
          class="x"
          aria-label={t('db_relation_unlink', { title: chip.title.trim() || t('untitled') })}
          onclick={() => unlink(chip.id)}
        >
          <Icon name="x" size={11} strokeWidth={2} />
        </button>
      {/if}
    </span>
  {/each}

  {#if ids.length === 0 && !editable}
    <span class="muted" title={reason}>{t('db_cell_empty')}</span>
  {/if}

  {#if editable}
    {#if !targetId}
      <!-- Not disabled-with-no-reason: the column has nothing on the other side to link to yet. -->
      <span class="muted" title={t('db_relation_untargeted')}>{t('db_relation_untargeted')}</span>
    {:else}
      <Popover bind:open align="start" width="300px" onOpenChange={(o) => !o && (term = '')}>
        {#snippet trigger(props: Record<string, unknown>)}
          <button {...props} type="button" class="add" aria-label={t('db_relation_link')}>
            <Icon name="plus" size={13} strokeWidth={1.9} />
          </button>
        {/snippet}
        <div class="picker">
          <SearchBox
            bind:value={term}
            placeholder={t('db_relation_search')}
            label={t('db_relation_search')}
            height={32}
          />
          {#if search.isLoading}
            <div class="state"><Spinner size={16} /></div>
          {:else if search.isError}
            <p class="state">{t('common.error')}</p>
          {:else if results.length === 0}
            <p class="state">{t('db_relation_none')}</p>
          {:else}
            <ul class="results">
              {#each results as row (row.id)}
                <li>
                  <button type="button" class="result" onclick={() => link(row.id)}>
                    <Icon name="file-text" size={13} strokeWidth={1.7} />
                    <span class="nm">{row.title.trim() || t('untitled')}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </Popover>
    {/if}
  {/if}
</span>

<style>
.rel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 160px;
  padding-inline: 7px 2px;
  padding-block: 2px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
  color: var(--kern-ink-550);
  font-size: 12px;
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x,
.add {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-450);
}
.x:hover,
.add:hover {
  background: var(--kern-surface-active);
  color: var(--kern-ink-900);
}
.picker {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 240px;
  overflow-y: auto;
}
.result {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--kern-r-md);
  background: none;
  color: var(--kern-ink-700);
  font: inherit;
  font-size: 13px;
  text-align: start;
}
.result:hover {
  background: var(--kern-surface-popover-hover);
}
.state {
  margin: 0;
  padding: 12px 4px;
  text-align: center;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
.muted {
  color: var(--kern-ink-450);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
