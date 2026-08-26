<script lang="ts">
import { Button, Icon, Popover, ToolbarButton } from '@kernhq/ui'
import type { Database, Sort, ViewConfig } from '../../contract/index.js'
import { t } from '../i18n.js'
import { orderedProperties } from './view-config.js'

/**
 * The view's sorting, in order.
 *
 * Order matters and is the whole reason this is a list rather than a single choice, so moving a
 * rule up and down is a control rather than something you get by deleting and re-adding.
 */
interface Props {
  database: Database
  config: ViewConfig
  canEdit: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onchange: (patch: Partial<ViewConfig>) => void
}
const { database, config, canEdit, open, onOpenChange, onchange }: Props = $props()

const properties = $derived(orderedProperties(database))
const sorts = $derived(config.sorts)

const setSorts = (next: Sort[]) => onchange({ sorts: next })
const patchAt = (index: number, patch: Partial<Sort>) =>
  setSorts(sorts.map((s, i) => (i === index ? { ...s, ...patch } : s)))

function addSort() {
  const used = new Set(sorts.map((s) => s.propertyKey))
  const next = properties.find((p) => !used.has(p.key)) ?? properties[0]
  if (!next) return
  setSorts([...sorts, { propertyKey: next.key, direction: 'asc' }])
}

function move(index: number, delta: -1 | 1) {
  const to = index + delta
  if (to < 0 || to >= sorts.length) return
  const next = [...sorts]
  const [moved] = next.splice(index, 1)
  if (moved) next.splice(to, 0, moved)
  setSorts(next)
}
</script>

<Popover {open} {onOpenChange} align="start" width="380px">
  {#snippet trigger(props: Record<string, unknown>)}
    <ToolbarButton
      {...props}
      icon="chevrons-up-down"
      active={sorts.length > 0}
      onClear={sorts.length > 0 && canEdit ? () => setSorts([]) : undefined}
    >
      {sorts.length > 0 ? t('db_sorts', { n: sorts.length }) : t('db_sort')}
    </ToolbarButton>
  {/snippet}

  <div class="panel">
    {#if sorts.length === 0}
      <p class="empty">{t('db_sort_none_desc')}</p>
    {:else}
      <ul class="rows">
        {#each sorts as sort, index (index)}
          <li class="line">
            <select
              class="control grow"
              value={sort.propertyKey}
              disabled={!canEdit}
              aria-label={t('db_sort_property')}
              onchange={(e) => patchAt(index, { propertyKey: e.currentTarget.value })}
            >
              {#each properties as option (option.key)}
                <option value={option.key}>{option.name}</option>
              {/each}
            </select>
            <select
              class="control"
              value={sort.direction}
              disabled={!canEdit}
              aria-label={t('db_sort_direction')}
              onchange={(e) => patchAt(index, { direction: e.currentTarget.value as 'asc' | 'desc' })}
            >
              <option value="asc">{t('db_asc')}</option>
              <option value="desc">{t('db_desc')}</option>
            </select>
            <button
              type="button"
              class="icon"
              disabled={!canEdit || index === 0}
              aria-label={t('db_move_up')}
              onclick={() => move(index, -1)}
            >
              <Icon name="chevron-up" size={13} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              class="icon"
              disabled={!canEdit || index === sorts.length - 1}
              aria-label={t('db_move_down')}
              onclick={() => move(index, 1)}
            >
              <Icon name="chevron-down" size={13} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              class="icon"
              disabled={!canEdit}
              aria-label={t('db_sort_remove')}
              onclick={() => setSorts(sorts.filter((_, i) => i !== index))}
            >
              <Icon name="x" size={13} strokeWidth={1.9} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="foot">
      <Button size="sm" variant="secondary" disabled={!canEdit || properties.length === 0} onclick={addSort}>
        {t('db_sort_add')}
      </Button>
      {#if sorts.length > 0}
        <Button size="sm" variant="secondary" disabled={!canEdit} onclick={() => setSorts([])}>
          {t('db_sort_clear')}
        </Button>
      {/if}
    </div>
  </div>
</Popover>

<style>
.panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.line {
  display: flex;
  align-items: center;
  gap: 4px;
}
.control {
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-raised);
  color: var(--kern-ink-700);
  font: inherit;
  font-size: 12.5px;
}
.control:focus {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: 0 0 0 3px var(--kern-ring);
}
.grow {
  flex: 1;
}
.icon {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-450);
}
.icon:hover:not(:disabled) {
  background: var(--kern-surface-hover);
  color: var(--kern-ink-900);
}
.icon:disabled {
  color: var(--kern-ink-300);
  cursor: default;
}
.foot {
  display: flex;
  gap: 8px;
}
</style>
