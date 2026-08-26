<script lang="ts">
import { Icon } from '@kernhq/ui'
import type { PropertyType } from '../../../contract/index.js'
import { t } from '../../i18n.js'

/**
 * url, email and phone.
 *
 * The trailing action is **hidden** when the cell is empty rather than disabled: a control that
 * cannot do anything and does not say why is worse than one that is not there, and "open this
 * link" has no meaning without a link.
 */
interface Props {
  value: unknown
  name: string
  type: PropertyType
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, type, editable, reason, onchange }: Props = $props()

const text = $derived(value == null ? '' : String(value))

const href = $derived.by(() => {
  const raw = text.trim()
  if (!raw) return null
  if (type === 'email') return `mailto:${raw}`
  if (type === 'phone') return `tel:${raw.replace(/\s+/g, '')}`
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
})

const icon = $derived(type === 'email' ? 'mail' : type === 'phone' ? 'smartphone' : 'external-link')
const actionLabel = $derived(
  type === 'email' ? t('db_send_email') : type === 'phone' ? t('db_call') : t('db_open_link'),
)
const placeholder = $derived(type === 'url' ? 'https://' : t('db_cell_empty'))

const commit = (next: string) => {
  if (next === text) return
  onchange(next === '' ? null : next)
}
</script>

<span class="link-cell">
  {#if editable}
    <input
      class="cell-input"
      type="text"
      inputmode={type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'url'}
      value={text}
      aria-label={name}
      {placeholder}
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
  {#if href}
    <a
      class="go"
      {href}
      target={type === 'url' ? '_blank' : undefined}
      rel={type === 'url' ? 'noreferrer noopener' : undefined}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <Icon name={icon} size={13} strokeWidth={1.7} />
    </a>
  {/if}
</span>

<style>
.link-cell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  width: 100%;
}
.cell-input {
  flex: 1;
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
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  font-size: 13px;
}
/*
 * 26px square with the icon centred: under 24 it fails the target-size rule the ux sweep checks,
 * and it sits next to an input, so the spacing exception does not apply.
 */
.go {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--kern-r-sm);
  color: var(--kern-ink-450);
}
.go:hover {
  background: var(--kern-surface-active);
  color: var(--kern-ink-900);
}
.muted {
  color: var(--kern-ink-450);
}
</style>
