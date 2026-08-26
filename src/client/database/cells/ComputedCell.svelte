<script lang="ts">
import { Avatar, formatDateTime, Icon, messageLocale } from '@kernhq/ui'
import type { PropertyType } from '../../../contract/index.js'
import type { Person } from '../../core-api.js'
import { t } from '../../i18n.js'

/**
 * formula, rollup and the four audit stamps — everything the server works out.
 *
 * Read-only, and it says so on hover rather than rendering a disabled input with no explanation.
 *
 * A broken formula is stored as `{ error: "…" }`, and rendering that with `String()` puts
 * `[object Object]` in the cell — which reads as a bug in the table rather than as a mistake in the
 * expression. The message is shown instead, in the danger tone, which is where the fix actually is.
 */
interface Props {
  value: unknown
  name: string
  type: PropertyType
  people: Person[]
  reason?: string
}
const { value, name, type, people, reason }: Props = $props()

const error = $derived(
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'error' in value
    ? String((value as { error: unknown }).error)
    : null,
)

const personFor = (id: string) => people.find((p) => p.id === id) ?? null

const shown = $derived.by(() => {
  if (error) return ''
  if (value === null || value === undefined || value === '') return ''
  if (type === 'created_time' || type === 'edited_time') return formatDateTime(String(value))
  if (typeof value === 'boolean') return value ? '✓' : '—'
  if (typeof value === 'number') return new Intl.NumberFormat(messageLocale()).format(value)
  if (Array.isArray(value)) return value.map(String).join(', ')
  return String(value)
})

const isPerson = $derived(type === 'created_by' || type === 'edited_by')
const personId = $derived(isPerson && typeof value === 'string' && value !== '' ? value : null)
</script>

{#if error}
  <!-- The message, not the chip, is what tells somebody where the mistake is. -->
  <span class="err" title={error} aria-label={`${name}: ${error}`}>
    <Icon name="triangle-alert" size={13} strokeWidth={1.7} />
    <span class="nm">{t('db_cell_formula_error')}</span>
  </span>
{:else if isPerson}
  <span class="cell-static" title={reason ?? t('db_cell_readonly')} aria-label={name}>
    {#if personId}
      <Avatar id={personId} name={personFor(personId)?.name ?? null} src={personFor(personId)?.avatarUrl ?? null} size={20} />
      <span class="nm">{personFor(personId)?.name ?? personId}</span>
    {:else}
      <span class="muted">{t('db_cell_empty')}</span>
    {/if}
  </span>
{:else}
  <span class="cell-static" title={reason ?? t('db_cell_readonly')} aria-label={name}>
    {#if shown}{shown}{:else}<span class="muted">{t('db_cell_empty')}</span>{/if}
  </span>
{/if}

<style>
.cell-static {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 26px;
  overflow: hidden;
  cursor: default;
  font-size: 13px;
  color: var(--kern-ink-550);
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 7px;
  border-radius: var(--kern-r-md);
  background: var(--kern-danger-tint);
  color: var(--kern-danger);
  font-size: 12px;
  cursor: help;
}
.muted {
  color: var(--kern-ink-450);
}
</style>
