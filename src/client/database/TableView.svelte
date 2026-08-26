<script lang="ts">
import {
  DropdownMenu,
  Icon,
  IconButton,
  type MenuItem,
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@kernhq/ui'
import type { Database, Property, Row, View, ViewConfig } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import Cell from './cells/Cell.svelte'
import PropertyMenu from './PropertyMenu.svelte'
import {
  clampWidth,
  columnTemplate,
  DEFAULT_COLUMN_WIDTH,
  tableMinWidth,
  visiblePropertiesOf,
} from './view-config.js'

/**
 * The table.
 *
 * Three things about it are deliberate and easy to undo by accident.
 *
 * `TableRow` is given neither `href` nor `onclick`: it becomes an `<a>` with the first and a
 * `<button>` with the second, and a button cannot contain the inline editors — so "open" lives in
 * the hover action group instead, where it is also reachable by keyboard.
 *
 * The whole table scrolls inside its **own** `overflow-x: auto` wrapper. `Page` sets
 * `overflow-x: hidden`, so without the wrapper a wide table is clipped rather than scrolled, and
 * the columns past the edge are unreachable.
 *
 * Resizing is a pointer gesture with no keyboard equivalent of its own, so widen and narrow live in
 * the column menu. Reordering has **no** drag at all — the menu's move-earlier and move-later are
 * the whole interaction, which is one fewer thing to get wrong and loses nothing.
 */
interface Props {
  database: Database
  view: View | null
  rows: Row[]
  people: Person[]
  workspaceId: string
  canEdit: boolean
  canCreate: boolean
  sortDirectionOf: (key: string) => 'asc' | 'desc' | null
  onCellChange: (row: Row, property: Property, value: unknown) => void
  onTitleChange: (row: Row, title: string) => void
  onOpenRow: (row: Row) => void
  onOpenPage: (row: Row) => void
  onDuplicateRow: (row: Row) => void
  onDeleteRow: (row: Row) => void
  onAddRow: () => void
  onAddProperty: () => void
  onEditProperty: (property: Property) => void
  onMoveProperty: (property: Property, direction: -1 | 1) => void
  onHideProperty: (property: Property) => void
  onDeleteProperty: (property: Property) => void
  onSortBy: (property: Property, direction: 'asc' | 'desc' | null) => void
  onFilterBy: (property: Property) => void
  onConfigChange: (patch: Partial<ViewConfig>) => void
}
const {
  database,
  view,
  rows,
  people,
  workspaceId,
  canEdit,
  canCreate,
  sortDirectionOf,
  onCellChange,
  onTitleChange,
  onOpenRow,
  onOpenPage,
  onDuplicateRow,
  onDeleteRow,
  onAddRow,
  onAddProperty,
  onEditProperty,
  onMoveProperty,
  onHideProperty,
  onDeleteProperty,
  onSortBy,
  onFilterBy,
  onConfigChange,
}: Props = $props()

const columns = $derived(visiblePropertiesOf(database, view))
const widths = $derived(view?.config.columnWidths ?? {})
const template = $derived(columnTemplate(columns, widths))
const minWidth = $derived(tableMinWidth(columns, widths))

/** The pointer drag in progress, if any. Committed once, on release, not on every move. */
let dragging = $state<{ key: string; startX: number; startWidth: number } | null>(null)
let previewWidth = $state<Record<string, number>>({})

const widthOf = (key: string) => previewWidth[key] ?? widths[key] ?? DEFAULT_COLUMN_WIDTH

const liveTemplate = $derived(dragging ? columnTemplate(columns, { ...widths, ...previewWidth }) : template)

function startResize(event: PointerEvent, property: Property) {
  if (!canEdit) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  dragging = { key: property.key, startX: event.clientX, startWidth: widthOf(property.key) }
}

function moveResize(event: PointerEvent) {
  if (!dragging) return
  // In RTL the pointer moves the other way, and a column that shrinks when you drag it outwards is
  // the sort of thing that reads as broken rather than as mirrored.
  const rtl = document.documentElement.dir === 'rtl'
  const delta = (event.clientX - dragging.startX) * (rtl ? -1 : 1)
  previewWidth = { ...previewWidth, [dragging.key]: clampWidth(dragging.startWidth + delta) }
}

function endResize() {
  if (!dragging) return
  const key = dragging.key
  const next = previewWidth[key]
  dragging = null
  previewWidth = {}
  if (next !== undefined && next !== (widths[key] ?? DEFAULT_COLUMN_WIDTH))
    onConfigChange({ columnWidths: { ...widths, [key]: next } })
}

/** The keyboard route for the drag: widen and narrow by a fixed step from the column menu. */
function resizeBy(property: Property, delta: number) {
  const next = clampWidth(widthOf(property.key) + delta)
  onConfigChange({ columnWidths: { ...widths, [property.key]: next } })
}

const rowMenu = (row: Row): MenuItem[] => [
  { id: 'open', label: t('db_open_row'), icon: 'maximize-2', onSelect: () => onOpenRow(row) },
  { id: 'page', label: t('db_open_as_page'), icon: 'file-text', onSelect: () => onOpenPage(row) },
  {
    id: 'duplicate',
    label: t('db_duplicate_row'),
    icon: 'copy',
    disabled: !canCreate,
    onSelect: () => onDuplicateRow(row),
  },
  { type: 'separator' },
  {
    id: 'delete',
    label: t('db_delete_row'),
    icon: 'trash-2',
    danger: true,
    disabled: !canEdit,
    onSelect: () => onDeleteRow(row),
  },
]
</script>

<div class="scroll">
  <div class="rail" data-testid="database-table" style:min-width="{minWidth}px">
    <Table columns={liveTemplate} dense>
      <TableHeader>
        <TableCell header>
          <span class="title-head">{t('db_title_column')}</span>
        </TableCell>
        {#each columns as property, index (property.id)}
          <TableCell header class="col-head">
            <PropertyMenu
              {property}
              {canEdit}
              first={index === 0}
              last={index === columns.length - 1}
              sortDirection={sortDirectionOf(property.key)}
              onEdit={() => onEditProperty(property)}
              onHide={() => onHideProperty(property)}
              onMove={(direction) => onMoveProperty(property, direction)}
              onResize={(delta) => resizeBy(property, delta)}
              onSort={(direction) => onSortBy(property, direction)}
              onFilter={() => onFilterBy(property)}
              onDelete={() => onDeleteProperty(property)}
            />
            {#if canEdit}
              <!--
                A 6px grabber with a 24px hit area behind it: under 24 it fails the target-size rule
                and it sits right beside the next header, so the spacing exception does not apply.
              -->
              <span
                class="grip"
                role="separator"
                aria-label={t('db_resize', { name: property.name })}
                aria-orientation="vertical"
                onpointerdown={(e) => startResize(e, property)}
                onpointermove={moveResize}
                onpointerup={endResize}
                onpointercancel={endResize}
              ></span>
            {/if}
          </TableCell>
        {/each}
        <TableCell header end>
          {#if canEdit}
            <IconButton icon="plus" label={t('db_add_property')} size={26} variant="ghost" onclick={onAddProperty} />
          {/if}
        </TableCell>
      </TableHeader>

      {#each rows as row (row.id)}
        <TableRow data-testid="database-row" data-row-id={row.id}>
          <TableCell class="title-cell">
            {#if canEdit}
              <input
                class="title-input"
                value={row.title}
                aria-label={t('db_title_column')}
                placeholder={t('untitled')}
                onblur={(e) => onTitleChange(row, e.currentTarget.value)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.currentTarget.value = row.title
                    e.currentTarget.blur()
                  }
                }}
              />
            {:else}
              <span class="title-static">{row.title.trim() || t('untitled')}</span>
            {/if}
          </TableCell>

          {#each columns as property (property.id)}
            <TableCell>
              <Cell
                {property}
                {row}
                {people}
                {workspaceId}
                canEdit={canEdit}
                onchange={(value) => onCellChange(row, property, value)}
              />
            </TableCell>
          {/each}

          <TableCell end class="acts">
            <span class="actions">
              <IconButton
                icon="maximize-2"
                label={t('db_open_row_named', { title: row.title.trim() || t('untitled') })}
                size={26}
                variant="ghost"
                onclick={() => onOpenRow(row)}
              />
              <DropdownMenu items={rowMenu(row)}>
                {#snippet trigger(props: Record<string, unknown>)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    label={t('db_row_actions', { title: row.title.trim() || t('untitled') })}
                    size={26}
                    variant="ghost"
                  />
                {/snippet}
              </DropdownMenu>
            </span>
          </TableCell>
        </TableRow>
      {/each}

      {#if canCreate}
        <button type="button" class="new-row" onclick={onAddRow}>
          <Icon name="plus" size={13} strokeWidth={1.9} />
          <span>{t('db_new_row')}</span>
        </button>
      {/if}
    </Table>
  </div>
</div>

<style>
/*
 * `Page` is `overflow-x: hidden`, so the table has to own its own horizontal scroll or the columns
 * past the viewport are simply unreachable.
 */
.scroll {
  overflow-x: auto;
  overflow-y: visible;
  padding-block-end: 40px;
}
.rail {
  min-width: 100%;
}
.title-head {
  font-size: inherit;
  letter-spacing: inherit;
}
:global([dir='rtl']) .title-head {
  letter-spacing: 0;
  text-transform: none;
}
/* `.ktd` is `overflow: hidden`; the header cell needs the grabber to sit on its trailing edge. */
:global(.ktd.col-head) {
  position: relative;
  overflow: visible;
}
.grip {
  position: absolute;
  inset-block: 4px;
  inset-inline-end: -9px;
  width: 6px;
  border-radius: 3px;
  cursor: col-resize;
  touch-action: none;
}
.grip::after {
  content: '';
  position: absolute;
  inset-block: -4px;
  inset-inline: -9px;
}
.grip:hover,
.grip:active {
  background: var(--kern-accent);
}
.title-input {
  width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 1px solid transparent;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-900);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
}
.title-input:hover {
  background: var(--kern-surface-active);
}
.title-input:focus {
  border-color: var(--kern-border);
  background: var(--kern-surface-raised);
  outline: none;
}
.title-input::placeholder {
  color: var(--kern-ink-350);
}
.title-static {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kern-ink-900);
  font-weight: 500;
}
/*
 * Hidden until the row is hovered or something inside it has focus — `focus-within` is what keeps
 * the actions reachable by keyboard, which `display: none` until hover would not.
 */
.actions {
  display: inline-flex;
  gap: 2px;
  opacity: 0;
}
:global(.ktr:hover) .actions,
:global(.ktr:focus-within) .actions {
  opacity: 1;
}
.new-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-bottom: 1px solid var(--kern-border-hairline);
  background: none;
  color: var(--kern-ink-450);
  font: inherit;
  font-size: 13px;
  text-align: start;
}
.new-row:hover {
  background: var(--kern-surface-raised);
  color: var(--kern-ink-900);
}
</style>
