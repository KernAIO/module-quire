<script lang="ts">
import { DropdownMenu, Icon, IconButton, ListRow, type MenuItem } from '@kernhq/ui'
import type { Database, Row, View } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import Cell from './cells/Cell.svelte'
import { visiblePropertiesOf } from './view-config.js'

/**
 * One row per row: the title, then two or three columns as trailing values.
 *
 * `ListRow` is given neither `href` nor `onclick` — either turns it into a link or a button, and
 * the actions live inside it. Opening is the explicit action at the end, as in the table.
 */
interface Props {
  database: Database
  view: View | null
  rows: Row[]
  people: Person[]
  workspaceId: string
  canEdit: boolean
  onOpenRow: (row: Row) => void
  onOpenPage: (row: Row) => void
  onDeleteRow: (row: Row) => void
}
const { database, view, rows, people, workspaceId, canEdit, onOpenRow, onOpenPage, onDeleteRow }: Props =
  $props()

const columns = $derived(visiblePropertiesOf(database, view).slice(0, 3))

const menu = (row: Row): MenuItem[] => [
  { id: 'open', label: t('db_open_row'), icon: 'maximize-2', onSelect: () => onOpenRow(row) },
  { id: 'page', label: t('db_open_as_page'), icon: 'file-text', onSelect: () => onOpenPage(row) },
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

<div class="list">
  {#each rows as row (row.id)}
    <ListRow>
      {#snippet leading()}
        <Icon name="file-text" size={14} strokeWidth={1.6} />
      {/snippet}
      {#snippet title()}
        {row.title.trim() || t('untitled')}
      {/snippet}
      {#snippet meta()}
        {#each columns as property (property.id)}
          <span class="meta-cell" title={property.name}>
            <Cell {property} {row} {people} {workspaceId} canEdit={false} onchange={() => {}} />
          </span>
        {/each}
      {/snippet}
      {#snippet trailing()}
        <span class="actions">
          <IconButton
            icon="maximize-2"
            label={t('db_open_row_named', { title: row.title.trim() || t('untitled') })}
            size={26}
            variant="ghost"
            onclick={() => onOpenRow(row)}
          />
          <DropdownMenu items={menu(row)}>
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
      {/snippet}
    </ListRow>
  {/each}
</div>

<style>
.list {
  padding-block-end: 40px;
}
.meta-cell {
  display: inline-flex;
  align-items: center;
  max-width: 200px;
  min-width: 0;
  overflow: hidden;
}
.actions {
  display: inline-flex;
  gap: 2px;
  opacity: 0;
}
:global(.krow:hover) .actions,
:global(.krow:focus-within) .actions {
  opacity: 1;
}
</style>
