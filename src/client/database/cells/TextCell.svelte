<script lang="ts">
import { t } from '../../i18n.js'

/**
 * A bare input that only looks like a control while somebody is in it (DESIGN.md §3.13).
 *
 * Committed on blur and on Enter, never per keystroke: each edit is its own mutation, and a request
 * per character is both slow and impossible to reason about when one of them fails.
 */
interface Props {
  value: unknown
  name: string
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, editable, reason, onchange }: Props = $props()

const text = $derived(value == null ? '' : String(value))

/** An empty field is a cleared cell, and `null` is how the API says that. */
const commit = (next: string) => {
  if (next === text) return
  onchange(next === '' ? null : next)
}
</script>

{#if editable}
  <input
    class="cell-input"
    value={text}
    aria-label={name}
    placeholder={t('db_cell_empty')}
    onblur={(e) => commit(e.currentTarget.value)}
    onkeydown={(e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        e.currentTarget.value = text
        e.currentTarget.blur()
      }
    }}
  />
{:else}
  <span class="cell-static" title={reason}>
    {#if text}{text}{:else}<span class="muted">{t('db_cell_empty')}</span>{/if}
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
