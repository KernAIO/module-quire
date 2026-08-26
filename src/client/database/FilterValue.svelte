<script lang="ts">
import { createQuery } from '@tanstack/svelte-query'
import type { FilterOperator, Property } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import { descriptorFor, VALUELESS_OPERATORS } from './property-types.js'

/**
 * The value half of one filter.
 *
 * Which control appears is decided by the property's editor family and by the operator: `is_empty`
 * takes no value at all, so nothing is drawn rather than a disabled box that looks like it wants
 * one. `is_any_of` takes several, so the closed-set types offer checkboxes rather than a field
 * somebody has to type comma-separated ids into.
 */
interface Props {
  property: Property
  operator: FilterOperator
  value: unknown
  workspaceId: string
  people: Person[]
  onchange: (value: unknown) => void
}
const { property, operator, value, workspaceId, people, onchange }: Props = $props()

const api = getQuireApi()
const editor = $derived(descriptorFor(property.type).editor)
const many = $derived(operator === 'is_any_of' || operator === 'is_none_of')

const asList = $derived(
  value == null ? [] : (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== ''),
)
const asText = $derived(value == null ? '' : Array.isArray(value) ? '' : String(value))

const toggle = (id: string, on: boolean) => {
  const next = on ? [...asList.filter((v) => v !== id), id] : asList.filter((v) => v !== id)
  onchange(many ? next : (next.at(-1) ?? null))
}

const choices = $derived(
  (property.config.options ?? []).map((option) => ({ id: option.id, label: option.label })),
)

/** A relation filter compares page ids, so the picker has to name them. */
const linked = createQuery(() => ({
  queryKey: quireKeys.lookup(workspaceId, property.config.relationDatabaseId ?? '', ''),
  enabled: editor === 'relation' && Boolean(property.config.relationDatabaseId),
  queryFn: () =>
    api.databases.lookup({
      workspaceId,
      databaseId: property.config.relationDatabaseId!,
      query: '',
      ids: [],
      limit: 50,
    }),
}))

const rows = $derived.by(() => {
  if (editor === 'select') return choices
  if (editor === 'person') return people.map((p) => ({ id: p.id, label: p.name }))
  if (editor === 'relation')
    return (linked.data ?? []).map((r) => ({ id: r.id, label: r.title.trim() || t('untitled') }))
  return []
})
</script>

{#if VALUELESS_OPERATORS.includes(operator)}
  <!-- nothing to compare against -->
{:else if editor === 'checkbox'}
  <select
    class="control"
    value={value === true ? 'true' : 'false'}
    aria-label={t('db_filter_value', { name: property.name })}
    onchange={(e) => onchange(e.currentTarget.value === 'true')}
  >
    <option value="true">{t('db_checked')}</option>
    <option value="false">{t('db_unchecked')}</option>
  </select>
{:else if editor === 'select' || editor === 'person' || editor === 'relation'}
  {#if rows.length === 0}
    <p class="hint">{t('db_filter_no_choices')}</p>
  {:else}
    <ul class="choices" aria-label={t('db_filter_value', { name: property.name })}>
      {#each rows as choice (choice.id)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={asList.includes(choice.id)}
              onchange={(e) => toggle(choice.id, e.currentTarget.checked)}
            />
            <span>{choice.label}</span>
          </label>
        </li>
      {/each}
    </ul>
  {/if}
{:else if editor === 'date' || property.type === 'created_time' || property.type === 'edited_time'}
  <input
    class="control"
    type="date"
    value={asText ? asText.slice(0, 10) : ''}
    aria-label={t('db_filter_value', { name: property.name })}
    onchange={(e) =>
      onchange(e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : null)}
  />
{:else if editor === 'number' || editor === 'computed'}
  <input
    class="control"
    type="number"
    inputmode="decimal"
    value={asText}
    aria-label={t('db_filter_value', { name: property.name })}
    onchange={(e) => onchange(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
  />
{:else}
  <input
    class="control"
    type="text"
    value={asText}
    placeholder={t('db_filter_value_placeholder')}
    aria-label={t('db_filter_value', { name: property.name })}
    onchange={(e) => onchange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
  />
{/if}

<style>
.control {
  width: 100%;
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
.choices {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
}
.choices label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  padding: 2px 4px;
  border-radius: var(--kern-r-sm);
  font-size: 12.5px;
  color: var(--kern-ink-700);
  cursor: pointer;
}
.choices label:hover {
  background: var(--kern-surface-hover);
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-450);
}
</style>
