<script lang="ts">
import { DropdownMenu, Icon, type MenuItem } from '@kernhq/ui'
import type { Property } from '../../contract/index.js'
import { t } from '../i18n.js'
import { descriptorFor } from './property-types.js'

/**
 * A column header, and everything that can be done to it.
 *
 * This menu is also where the **keyboard route** for the two pointer gestures lives: dragging the
 * grabber resizes and there is no drag on the header row at all, so "move earlier", "move later",
 * "widen" and "narrow" are not conveniences — they are the only way to do those things without a
 * mouse, which makes them part of the specification rather than an extra.
 */
interface Props {
  property: Property
  canEdit: boolean
  first: boolean
  last: boolean
  sortDirection: 'asc' | 'desc' | null
  onEdit: () => void
  onHide: () => void
  onMove: (direction: -1 | 1) => void
  onResize: (delta: number) => void
  onSort: (direction: 'asc' | 'desc' | null) => void
  onFilter: () => void
  onDelete: () => void
}
const {
  property,
  canEdit,
  first,
  last,
  sortDirection,
  onEdit,
  onHide,
  onMove,
  onResize,
  onSort,
  onFilter,
  onDelete,
}: Props = $props()

const descriptor = $derived(descriptorFor(property.type))

const items = $derived<MenuItem[]>([
  { type: 'label', label: property.name },
  {
    id: 'sort-asc',
    label: t('db_sort_asc'),
    icon: 'arrow-up',
    disabled: sortDirection === 'asc',
    onSelect: () => onSort('asc'),
  },
  {
    id: 'sort-desc',
    label: t('db_sort_desc'),
    icon: 'chevron-down',
    disabled: sortDirection === 'desc',
    onSelect: () => onSort('desc'),
  },
  ...(sortDirection
    ? [{ id: 'sort-clear', label: t('db_sort_remove'), icon: 'x', onSelect: () => onSort(null) }]
    : []),
  { type: 'separator' },
  { id: 'filter', label: t('db_filter_by'), icon: 'filter', onSelect: onFilter },
  { type: 'separator' },
  {
    id: 'move-earlier',
    label: t('db_move_earlier'),
    icon: 'chevron-left',
    disabled: first || !canEdit,
    onSelect: () => onMove(-1),
  },
  {
    id: 'move-later',
    label: t('db_move_later'),
    icon: 'chevron-right',
    disabled: last || !canEdit,
    onSelect: () => onMove(1),
  },
  { id: 'widen', label: t('db_widen'), icon: 'maximize-2', onSelect: () => onResize(40) },
  { id: 'narrow', label: t('db_narrow'), icon: 'minimize-2', onSelect: () => onResize(-40) },
  { type: 'separator' },
  {
    id: 'edit',
    label: t('db_edit_property'),
    icon: 'pencil',
    disabled: !canEdit,
    onSelect: onEdit,
  },
  {
    id: 'hide',
    label: t('db_hide_property'),
    icon: 'eye-off',
    disabled: !canEdit,
    onSelect: onHide,
  },
  {
    id: 'delete',
    label: t('db_delete_property'),
    icon: 'trash-2',
    danger: true,
    disabled: !canEdit,
    onSelect: onDelete,
  },
])
</script>

<DropdownMenu {items} align="start">
  {#snippet trigger(props: Record<string, unknown>)}
    <button {...props} type="button" class="head" title={property.name}>
      <Icon name={descriptor.icon} size={12} strokeWidth={1.7} />
      <span class="nm">{property.name}</span>
      {#if sortDirection}
        <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'chevron-down'} size={11} strokeWidth={2} />
      {/if}
    </button>
  {/snippet}
</DropdownMenu>

<style>
/*
 * The header cell is the trigger, so the whole 34px strip is the hit target rather than a 12px
 * chevron beside a label.
 */
.head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
  height: 26px;
  padding: 0 6px;
  margin-inline-start: -6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-280);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: start;
}
/* Uppercase tracking breaks connected Arabic and Persian letters. */
:global([dir='rtl']) .head {
  letter-spacing: 0;
  text-transform: none;
}
.head:hover {
  background: var(--kern-surface-hover);
  color: var(--kern-ink-900);
}
.nm {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
