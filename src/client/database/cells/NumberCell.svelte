<script lang="ts">
import { messageLocale } from '@kernhq/ui'
import type { PropertyConfig } from '../../../contract/index.js'
import { t } from '../../i18n.js'

/**
 * A number, drawn formatted and edited raw.
 *
 * Formatting while somebody is typing fights them — a thousands separator inserted mid-number moves
 * the caret — so the field carries the plain value whenever it has focus and the formatted one the
 * rest of the time. `Intl.NumberFormat` for the interface locale, because a percentage rendered as
 * "12%" beside Persian digits is the one untranslated thing on the screen.
 */
interface Props {
  value: unknown
  name: string
  config: PropertyConfig
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, config, editable, reason, onchange }: Props = $props()

let focused = $state(false)

const raw = $derived(typeof value === 'number' ? value : value == null || value === '' ? null : Number(value))
const plain = $derived(raw === null || Number.isNaN(raw) ? '' : String(raw))

const formatted = $derived.by(() => {
  if (raw === null || Number.isNaN(raw)) return ''
  const options: Intl.NumberFormatOptions = {}
  if (config.precision !== undefined) {
    options.minimumFractionDigits = config.precision
    options.maximumFractionDigits = config.precision
  }
  if (config.format === 'percent') options.style = 'percent'
  if (config.format === 'currency') {
    options.style = 'currency'
    options.currency = 'USD'
  }
  try {
    // `percent` multiplies by 100, so a column storing 0.2 reads "20%" — which is what a percentage
    // column means. A column storing 20 and formatted as a percentage is the author's own choice.
    return new Intl.NumberFormat(messageLocale(), options).format(raw)
  } catch {
    return String(raw)
  }
})

const commit = (next: string) => {
  const trimmed = next.trim()
  if (trimmed === '') {
    if (raw !== null) onchange(null)
    return
  }
  const parsed = Number(trimmed)
  if (Number.isNaN(parsed) || parsed === raw) return
  onchange(parsed)
}
</script>

{#if editable}
  <input
    class="cell-input num"
    inputmode="decimal"
    value={focused ? plain : formatted}
    aria-label={name}
    placeholder={t('db_cell_empty')}
    onfocus={(e) => {
      focused = true
      e.currentTarget.value = plain
    }}
    onblur={(e) => {
      focused = false
      commit(e.currentTarget.value)
    }}
    onkeydown={(e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        e.currentTarget.value = plain
        e.currentTarget.blur()
      }
    }}
  />
{:else}
  <span class="cell-static num" title={reason}>
    {#if formatted}{formatted}{:else}<span class="muted">{t('db_cell_empty')}</span>{/if}
  </span>
{/if}

<style>
.cell-input {
  width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 1px solid transparent;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.cell-input:hover {
  background: var(--kern-surface-active);
}
.cell-input:focus {
  border-color: var(--kern-border);
  background: var(--kern-surface-raised);
  outline: none;
}
.cell-input::placeholder {
  color: var(--kern-ink-350);
}
/* A number is read by comparing it with the one above; a tabular figure is what makes that work. */
.num {
  font-variant-numeric: tabular-nums;
}
.cell-static {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  font-size: 13px;
}
.muted {
  color: var(--kern-ink-450);
}
</style>
