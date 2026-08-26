<script lang="ts">
import { DropdownMenu, Icon, IconButton, type MenuItem } from '@kernhq/ui'
import type { Database, Row, View } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import Cell from './cells/Cell.svelte'
import { visiblePropertiesOf } from './view-config.js'

/**
 * Cards of a title and the columns the view shows.
 *
 * No picture: a cover would come from a `files` property, and Quire has no file handling at all —
 * so the card leads with an icon band rather than pretending an image is missing. The view editor
 * says the same thing where somebody would go looking for the setting.
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

const size = $derived(view?.config.cardSize ?? 'medium')
const columns = $derived(visiblePropertiesOf(database, view).slice(0, size === 'small' ? 2 : 4))

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

<ul class="gallery" class:small={size === 'small'} class:large={size === 'large'}>
  {#each rows as row (row.id)}
    <li>
      <article class="card">
        <div class="band" aria-hidden="true"><Icon name="file-text" size={18} strokeWidth={1.5} /></div>
        <div class="body">
          <div class="top">
            <h3 class="title">{row.title.trim() || t('untitled')}</h3>
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
          </div>
          {#if columns.length > 0}
            <dl class="fields">
              {#each columns as property (property.id)}
                <div class="field">
                  <dt>{property.name}</dt>
                  <dd>
                    <Cell {property} {row} {people} {workspaceId} canEdit={false} onchange={() => {}} />
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}
        </div>
      </article>
    </li>
  {/each}
</ul>

<style>
.gallery {
  list-style: none;
  margin: 0;
  padding: 22px 28px 40px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  /* the cell stretches, not the card inside it, or one long title makes its neighbour short */
  grid-auto-rows: 1fr;
  gap: 14px;
}
.gallery.small {
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}
.gallery.large {
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
}
.gallery > li {
  display: grid;
}
.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-xl);
  background: var(--kern-surface-raised);
  overflow: hidden;
}
.card:hover {
  border-color: var(--kern-border-hover);
}
.band {
  height: 54px;
  display: grid;
  place-items: center;
  background: var(--kern-surface-hover);
  color: var(--kern-ink-350);
}
.body {
  flex: 1;
  padding: 11px 8px 13px 13px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--kern-ink-900);
}
.fields {
  margin-inline-end: 5px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.field dt {
  font-size: 11.5px;
  color: var(--kern-ink-450);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field dd {
  margin: 0;
  min-width: 0;
  font-size: 12.5px;
  color: var(--kern-ink-600);
  overflow: hidden;
}
@media (max-width: 768px) {
  .gallery {
    padding: 16px;
  }
}
</style>
