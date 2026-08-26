<script lang="ts">
import { DropdownMenu, type MenuItem } from '@kernhq/ui'
import type { PropertyConfig, PropertyType } from '../../../contract/index.js'
import { t } from '../../i18n.js'
import OptionChip from '../OptionChip.svelte'
import { STATUS_GROUPS } from '../view-config.js'

/**
 * select, multi_select and status.
 *
 * A menu rather than an inline list, because the table cell clips (`.ktd` is `overflow: hidden`)
 * and `DropdownMenu` portals out of it. A status groups its options into the workflow bands it
 * declares, so "Done" is not sitting between "Blocked" and "Doing" in alphabetical order.
 */
interface Props {
  value: unknown
  name: string
  type: PropertyType
  config: PropertyConfig
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, type, config, editable, reason, onchange }: Props = $props()

const many = $derived(type === 'multi_select')
const options = $derived(config.options ?? [])

const chosen = $derived.by(() => {
  if (value == null) return [] as string[]
  return (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== '')
})
const optionFor = (id: string) => options.find((o) => o.id === id) ?? null

const commit = (next: string[]) => onchange(many ? next : (next[0] ?? null))

const toggle = (id: string, on: boolean) => {
  if (many) commit(on ? [...chosen.filter((v) => v !== id), id] : chosen.filter((v) => v !== id))
  else commit(on ? [id] : [])
}

/** Status options in band order; everything else in the order the column declares them. */
const ordered = $derived.by(() => {
  if (type !== 'status') return options.map((option) => ({ option, band: null as string | null }))
  const out: { option: (typeof options)[number]; band: string | null }[] = []
  for (const band of STATUS_GROUPS)
    for (const option of options.filter((o) => o.group === band)) out.push({ option, band })
  for (const option of options.filter((o) => !o.group || !STATUS_GROUPS.includes(o.group)))
    out.push({ option, band: null })
  return out
})

const items = $derived.by(() => {
  const list: MenuItem[] = []
  let band: string | null | undefined
  for (const entry of ordered) {
    if (type === 'status' && entry.band && entry.band !== band) {
      list.push({ type: 'label', label: t(`db_status_${entry.band}`) })
      band = entry.band
    }
    list.push({
      type: 'checkbox',
      id: entry.option.id,
      label: entry.option.label,
      checked: chosen.includes(entry.option.id),
      onCheckedChange: (on: boolean) => toggle(entry.option.id, on),
    })
  }
  if (list.length === 0) list.push({ type: 'label', label: t('db_options_none') })
  else if (chosen.length > 0)
    list.push(
      { type: 'separator' },
      { id: 'clear', label: t('db_select_clear'), icon: 'x', onSelect: () => commit([]) },
    )
  return list
})
</script>

{#if editable}
  <DropdownMenu items={items} align="start">
    {#snippet trigger(props: Record<string, unknown>)}
      <button {...props} type="button" class="cell-trigger" aria-label={name}>
        {#if chosen.length === 0}
          <span class="muted">{t('db_cell_empty')}</span>
        {:else}
          {#each chosen as id (id)}
            <OptionChip option={optionFor(id)} label={optionFor(id) ? undefined : id} compact />
          {/each}
        {/if}
      </button>
    {/snippet}
  </DropdownMenu>
{:else}
  <span class="cell-trigger static" title={reason}>
    {#if chosen.length === 0}
      <span class="muted">{t('db_cell_empty')}</span>
    {:else}
      {#each chosen as id (id)}
        <OptionChip option={optionFor(id)} label={optionFor(id) ? undefined : id} compact />
      {/each}
    {/if}
  </span>
{/if}

<style>
.cell-trigger {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px;
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
.muted {
  color: var(--kern-ink-450);
}
</style>
