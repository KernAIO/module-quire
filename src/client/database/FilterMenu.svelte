<script lang="ts">
import { Button, Icon, Popover, ToolbarButton } from '@kernhq/ui'
import type { Database, Filter, FilterOperator, ViewConfig } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import FilterValue from './FilterValue.svelte'
import { operatorsFor, VALUELESS_OPERATORS } from './property-types.js'
import { orderedProperties } from './view-config.js'

/**
 * The view's filters.
 *
 * A column only offers the operators it can actually answer — the contract declares fourteen and no
 * type accepts all of them, so listing every one produces a filter that silently matches nothing.
 * `property-types.ts` is the single place that decides which.
 *
 * Every write sends the **whole** `ViewConfig`, because `updateView` replaces the column.
 */
interface Props {
  database: Database
  config: ViewConfig
  workspaceId: string
  people: Person[]
  canEdit: boolean
  /** the toolbar can ask for the popover to open on a particular column */
  open: boolean
  onOpenChange: (open: boolean) => void
  onchange: (patch: Partial<ViewConfig>) => void
}
const { database, config, workspaceId, people, canEdit, open, onOpenChange, onchange }: Props = $props()

const properties = $derived(orderedProperties(database))
const filters = $derived(config.filters)

const propertyFor = (key: string) => properties.find((p) => p.key === key) ?? null

const setFilters = (next: Filter[]) => onchange({ filters: next })

const patchAt = (index: number, patch: Partial<Filter>) =>
  setFilters(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)))

function addFilter() {
  const first = properties[0]
  if (!first) return
  const operator = operatorsFor(first.type)[0] ?? 'equals'
  setFilters([...filters, { propertyKey: first.key, operator, value: null }])
}

/**
 * Changing the column has to re-pick the operator: a checkbox cannot answer `starts_with`, and
 * leaving the old one behind is a filter that returns nothing for no visible reason.
 */
function changeProperty(index: number, key: string) {
  const property = propertyFor(key)
  if (!property) return
  const current = filters[index]?.operator
  const allowed = operatorsFor(property.type)
  patchAt(index, {
    propertyKey: key,
    operator: current && allowed.includes(current) ? current : (allowed[0] ?? 'equals'),
    value: null,
  })
}
</script>

<Popover {open} {onOpenChange} align="start" width="420px">
  {#snippet trigger(props: Record<string, unknown>)}
    <ToolbarButton
      {...props}
      icon="filter"
      active={filters.length > 0}
      onClear={filters.length > 0 && canEdit ? () => setFilters([]) : undefined}
    >
      {filters.length > 0 ? t('db_filters', { n: filters.length }) : t('db_filter')}
    </ToolbarButton>
  {/snippet}

  <div class="panel">
    {#if filters.length === 0}
      <p class="empty">{t('db_filter_none_desc')}</p>
    {:else}
      <div class="mode" role="group" aria-label={t('db_filter_mode')}>
        <button
          type="button"
          class:on={config.filterMode === 'and'}
          disabled={!canEdit}
          onclick={() => onchange({ filterMode: 'and' })}
        >
          {t('db_filter_mode_and')}
        </button>
        <button
          type="button"
          class:on={config.filterMode === 'or'}
          disabled={!canEdit}
          onclick={() => onchange({ filterMode: 'or' })}
        >
          {t('db_filter_mode_or')}
        </button>
      </div>

      <ul class="rows">
        {#each filters as filter, index (index)}
          {@const property = propertyFor(filter.propertyKey)}
          <li class="row">
            <div class="line">
              <select
                class="control grow"
                value={filter.propertyKey}
                disabled={!canEdit}
                aria-label={t('db_filter_property')}
                onchange={(e) => changeProperty(index, e.currentTarget.value)}
              >
                {#each properties as option (option.key)}
                  <option value={option.key}>{option.name}</option>
                {/each}
              </select>
              <select
                class="control grow"
                value={filter.operator}
                disabled={!canEdit || !property}
                aria-label={t('db_filter_operator')}
                onchange={(e) =>
                  patchAt(index, {
                    operator: e.currentTarget.value as FilterOperator,
                    ...(VALUELESS_OPERATORS.includes(e.currentTarget.value as FilterOperator)
                      ? { value: null }
                      : {}),
                  })}
              >
                {#each property ? operatorsFor(property.type) : [] as op (op)}
                  <option value={op}>{t(`db_op_${op}`)}</option>
                {/each}
              </select>
              <button
                type="button"
                class="remove"
                disabled={!canEdit}
                aria-label={t('db_filter_remove')}
                onclick={() => setFilters(filters.filter((_, i) => i !== index))}
              >
                <Icon name="x" size={13} strokeWidth={1.9} />
              </button>
            </div>
            {#if property}
              <div class="value">
                <FilterValue
                  {property}
                  operator={filter.operator}
                  value={filter.value}
                  {workspaceId}
                  {people}
                  onchange={(next) => patchAt(index, { value: next })}
                />
              </div>
            {:else}
              <p class="warn">{t('db_filter_unknown_property')}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="foot">
      <Button size="sm" variant="secondary" disabled={!canEdit || properties.length === 0} onclick={addFilter}>
        {t('db_filter_add')}
      </Button>
      {#if filters.length > 0}
        <Button size="sm" variant="secondary" disabled={!canEdit} onclick={() => setFilters([])}>
          {t('db_filter_clear')}
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
.mode {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-hover);
  align-self: flex-start;
}
.mode button {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-450);
  font: inherit;
  font-size: 12px;
}
.mode button.on {
  background: var(--kern-surface-raised);
  color: var(--kern-ink-900);
  font-weight: 600;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-block-end: 10px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.rows li:last-child {
  border-block-end: 0;
  padding-block-end: 0;
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
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
.remove {
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
.remove:hover:not(:disabled) {
  background: var(--kern-surface-hover);
  color: var(--kern-ink-900);
}
.value {
  padding-inline-start: 2px;
}
.warn {
  margin: 0;
  font-size: 12px;
  color: var(--kern-warning);
}
.foot {
  display: flex;
  gap: 8px;
}
</style>
