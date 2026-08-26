<script lang="ts">
import { formatDate, formatDateTime } from '@kernhq/ui'
import type { PropertyConfig } from '../../../contract/index.js'
import { t } from '../../i18n.js'

/**
 * A date, stored as an ISO string.
 *
 * The native picker rather than a hand-rolled calendar: it is localised, keyboard-operable and
 * reachable by a screen reader without any of that being written here. It is drawn through
 * `formatDate` when it is not being edited, so the table reads in the interface language rather
 * than in the browser's.
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

const withTime = $derived(config.includeTime === true)
const iso = $derived(typeof value === 'string' && value !== '' ? value : null)

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time; `date` wants `YYYY-MM-DD`. */
const fieldValue = $derived.by(() => {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return withTime ? `${day}T${pad(at.getHours())}:${pad(at.getMinutes())}` : day
})

const shown = $derived(iso ? (withTime ? formatDateTime(iso) : formatDate(iso)) : '')

const commit = (next: string) => {
  if (next === '') {
    if (iso) onchange(null)
    return
  }
  const at = new Date(next)
  if (Number.isNaN(at.getTime())) return
  onchange(at.toISOString())
}
</script>

{#if editable}
  <input
    class="cell-input"
    type={withTime ? 'datetime-local' : 'date'}
    value={fieldValue}
    aria-label={name}
    onchange={(e) => commit(e.currentTarget.value)}
  />
{:else}
  <span class="cell-static" title={reason}>
    {#if shown}{shown}{:else}<span class="muted">{t('db_cell_empty')}</span>{/if}
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
