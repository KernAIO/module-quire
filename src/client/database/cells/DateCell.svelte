<script lang="ts">
import { formatDate, formatDateTime } from '@kernhq/ui'
import type { PropertyConfig } from '../../../contract/index.js'
import { t } from '../../i18n.js'

/**
 * A date, stored as an ISO string.
 *
 * The native picker rather than a hand-rolled calendar: it is localised, keyboard-operable and
 * reachable by a screen reader without any of that being written here. But a native
 * `<input type="date">` draws its *value* in the **browser's** locale, not the page's, and nothing
 * can restyle that — so a table left permanently in edit mode showed `08/21/2026` in Latin digits
 * on a Persian screen, in a column beside one already counting `۱ ۲ ۳`. The one untranslated thing
 * on the page, which is the shape this project treats as a defect rather than as polish.
 *
 * So the cell reads through `formatDate` whether or not it is editable, and the input appears when
 * somebody goes to change it. Focus moves to it on the way in and the formatted text comes back on
 * the way out, so a keyboard never lands on something it cannot see.
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

/** Swapped for the native input only while somebody is actually changing the date. */
let editing = $state(false)
let field = $state<HTMLInputElement>()

/*
 * Taking focus is not optional here. Replacing the button with the input would otherwise leave
 * focus on a removed element, which the browser resolves by dropping it to `<body>` — a keyboard
 * user tabs to a date, presses Enter and is returned to the top of the page.
 */
$effect(() => {
  if (editing && field) {
    field.focus()
    field.showPicker?.()
  }
})

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

{#if editable && editing}
  <input
    bind:this={field}
    class="cell-input"
    type={withTime ? 'datetime-local' : 'date'}
    value={fieldValue}
    aria-label={name}
    onchange={(e) => commit(e.currentTarget.value)}
    onblur={() => {
      editing = false
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape' || e.key === 'Enter') editing = false
    }}
  />
{:else if editable}
  <button type="button" class="cell-open" aria-label={name} onclick={() => (editing = true)}>
    {#if shown}{shown}{:else}<span class="muted">{t('db_cell_empty')}</span>{/if}
  </button>
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
/* Mirrors `.cell-input` so swapping one for the other does not move the row by a pixel. */
.cell-open {
  display: block;
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
  text-align: start;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.cell-open:hover {
  background: var(--kern-surface-active);
}
/*
 * The ring itself comes from the global `:focus-visible` rule in tokens.css — a box-shadow, not an
 * outline. Only the ground is set here, so the two do not fight.
 */
.cell-open:focus-visible {
  background: var(--kern-surface-raised);
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
