<script lang="ts">
import { Button, RightPanel, relativeTime } from '@kernhq/ui'
import type { Database, Property, Row } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import Cell from './cells/Cell.svelte'
import { descriptorFor } from './property-types.js'
import { orderedProperties } from './view-config.js'

/**
 * One row, with every column — hidden ones included.
 *
 * This is where a row is inspected, and it has to be: `Page` carries no field saying "this page is
 * a row of that database", deliberately, so opening the row's own page shows its prose and could
 * not show its properties without inventing a second meaning for `pages.database_id`. The panel
 * links out to the page instead.
 */
interface Props {
  database: Database
  row: Row
  people: Person[]
  workspaceId: string
  canEdit: boolean
  onClose: () => void
  onChange: (property: Property, value: unknown) => void
  onTitleChange: (title: string) => void
  onOpenPage: () => void
}
const { database, row, people, workspaceId, canEdit, onClose, onChange, onTitleChange, onOpenPage }: Props =
  $props()

const properties = $derived(orderedProperties(database))
</script>

<RightPanel title={t('db_row_panel')} width={420} onClose={onClose}>
  <div class="body">
    {#if canEdit}
      <input
        class="title"
        value={row.title}
        aria-label={t('db_title_column')}
        placeholder={t('untitled')}
        onblur={(e) => onTitleChange(e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    {:else}
      <h2 class="title as-heading">{row.title.trim() || t('untitled')}</h2>
    {/if}

    <p class="stamp">{t('edited_ago', { when: relativeTime(row.updatedAt) })}</p>

    {#if properties.length === 0}
      <p class="hint">{t('db_no_columns')}</p>
    {:else}
      <dl class="fields">
        {#each properties as property (property.id)}
          <div class="field">
            <dt title={property.hidden ? t('db_hidden_here') : undefined}>
              {property.name}
              {#if property.hidden}<span class="tag">{t('db_hidden')}</span>{/if}
            </dt>
            <dd>
              <Cell
                {property}
                {row}
                {people}
                {workspaceId}
                canEdit={canEdit && !descriptorFor(property.type).readOnly}
                onchange={(value) => onChange(property, value)}
              />
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={onOpenPage}>{t('db_open_as_page')}</Button>
  {/snippet}
</RightPanel>

<style>
.body {
  padding: 18px;
}
.title {
  width: 100%;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 1px solid transparent;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-900);
  font: inherit;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.title:hover {
  background: var(--kern-surface-active);
}
.title:focus {
  border-color: var(--kern-border);
  background: var(--kern-surface-raised);
  outline: none;
}
.title.as-heading {
  margin: 0;
}
.stamp {
  margin: 6px 0 16px;
  font-size: 12px;
  color: var(--kern-ink-450);
}
.fields {
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.field dt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--kern-ink-450);
  overflow: hidden;
}
.field dd {
  margin: 0;
  min-width: 0;
  font-size: 13px;
  color: var(--kern-ink-700);
}
.tag {
  padding: 0 5px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface-chip);
  font-size: 10.5px;
  color: var(--kern-ink-550);
}
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
</style>
