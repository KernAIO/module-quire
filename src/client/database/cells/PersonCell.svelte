<script lang="ts">
import { Avatar, DropdownMenu, type MenuItem } from '@kernhq/ui'
import type { PropertyConfig } from '../../../contract/index.js'
import type { Person } from '../../core-api.js'
import { t } from '../../i18n.js'

/**
 * One or more people, stored as user ids.
 *
 * The face comes before the name in the menu, because a person is recognised by their picture
 * faster than by their name — which is what `MenuItem`'s `avatar` field is for.
 */
interface Props {
  value: unknown
  name: string
  config: PropertyConfig
  people: Person[]
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, config, people, editable, reason, onchange }: Props = $props()

const many = $derived(config.multiple !== false)
const chosen = $derived(
  value == null ? [] : (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== ''),
)
const personFor = (id: string) => people.find((p) => p.id === id) ?? null

const commit = (next: string[]) => onchange(many ? next : (next[0] ?? null))
const toggle = (id: string, on: boolean) => {
  if (many) commit(on ? [...chosen.filter((v) => v !== id), id] : chosen.filter((v) => v !== id))
  else commit(on ? [id] : [])
}

const items = $derived.by(() => {
  const list: MenuItem[] = people.map((person) => ({
    type: 'checkbox' as const,
    id: person.id,
    label: person.name,
    avatar: { id: person.id, name: person.name, src: person.avatarUrl },
    checked: chosen.includes(person.id),
    onCheckedChange: (on: boolean) => toggle(person.id, on),
  }))
  if (list.length === 0) return [{ type: 'label' as const, label: t('db_people_none') }]
  if (chosen.length > 0)
    list.push(
      { type: 'separator' },
      { id: 'clear', label: t('db_select_clear'), icon: 'x', onSelect: () => commit([]) },
    )
  return list
})
</script>

{#snippet faces()}
  {#if chosen.length === 0}
    <span class="muted">{t('db_cell_empty')}</span>
  {:else}
    {#each chosen as id (id)}
      <span class="who">
        <Avatar id={id} name={personFor(id)?.name ?? null} src={personFor(id)?.avatarUrl ?? null} size={20} />
        <span class="nm">{personFor(id)?.name ?? id}</span>
      </span>
    {/each}
  {/if}
{/snippet}

{#if editable}
  <DropdownMenu {items} align="start">
    {#snippet trigger(props: Record<string, unknown>)}
      <button {...props} type="button" class="cell-trigger" aria-label={name}>{@render faces()}</button>
    {/snippet}
  </DropdownMenu>
{:else}
  <span class="cell-trigger static" title={reason}>{@render faces()}</span>
{/if}

<style>
.cell-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 26px;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: start;
  overflow: hidden;
}
button.cell-trigger:hover {
  background: var(--kern-surface-active);
}
.cell-trigger.static {
  cursor: default;
}
.who {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--kern-ink-450);
}
</style>
