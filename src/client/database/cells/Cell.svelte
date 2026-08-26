<script lang="ts">
import type { Property, Row } from '../../../contract/index.js'
import type { Person } from '../../core-api.js'
import { t } from '../../i18n.js'
import { descriptorFor } from '../property-types.js'
import CheckboxCell from './CheckboxCell.svelte'
import ComputedCell from './ComputedCell.svelte'
import DateCell from './DateCell.svelte'
import LinkCell from './LinkCell.svelte'
import NumberCell from './NumberCell.svelte'
import PersonCell from './PersonCell.svelte'
import RelationCell from './RelationCell.svelte'
import SelectCell from './SelectCell.svelte'
import TextCell from './TextCell.svelte'

/**
 * One cell: the property's type in, the right editor out.
 *
 * Every branch reads `property-types.ts` rather than switching on the type again, so a type added to
 * the contract lands in exactly one place. A cell reads `computed` for the six server-written types
 * and `props` for everything else — the same split the server's `valueExpr` makes, and getting it
 * wrong here shows an empty column rather than an error.
 *
 * `onchange` fires once per **committed** edit, never per keystroke.
 */
interface Props {
  property: Property
  row: Row
  people: Person[]
  workspaceId: string
  /** false when the viewer may not edit this database at all */
  canEdit: boolean
  onchange: (value: unknown) => void
}
const { property, row, people, workspaceId, canEdit, onchange }: Props = $props()

const descriptor = $derived(descriptorFor(property.type))
const value = $derived(descriptor.readOnly ? row.computed[property.key] : row.props[property.key])
const editable = $derived(canEdit && !descriptor.readOnly)

/**
 * Why this cell cannot be typed into. A disabled control with no explanation is a bug, and the two
 * reasons are different: the column is worked out, or you may not edit anything here.
 */
const reason = $derived(descriptor.readOnly ? t('db_cell_readonly') : t('db_cell_no_permission'))
</script>

{#if descriptor.editor === 'computed'}
  <ComputedCell {value} name={property.name} type={property.type} {people} />
{:else if descriptor.editor === 'unsupported'}
  <span class="unsupported" title={t('db_files_unsupported')}>{t('db_files_unsupported')}</span>
{:else if descriptor.editor === 'number'}
  <NumberCell {value} name={property.name} config={property.config} {editable} {reason} {onchange} />
{:else if descriptor.editor === 'select'}
  <SelectCell
    {value}
    name={property.name}
    type={property.type}
    config={property.config}
    {editable}
    {reason}
    {onchange}
  />
{:else if descriptor.editor === 'date'}
  <DateCell {value} name={property.name} config={property.config} {editable} {reason} {onchange} />
{:else if descriptor.editor === 'person'}
  <PersonCell
    {value}
    name={property.name}
    config={property.config}
    {people}
    {editable}
    {reason}
    {onchange}
  />
{:else if descriptor.editor === 'checkbox'}
  <CheckboxCell {value} name={property.name} {editable} {reason} {onchange} />
{:else if descriptor.editor === 'link'}
  <LinkCell {value} name={property.name} type={property.type} {editable} {reason} {onchange} />
{:else if descriptor.editor === 'relation'}
  <RelationCell
    {value}
    name={property.name}
    config={property.config}
    {workspaceId}
    {editable}
    {reason}
    {onchange}
  />
{:else}
  <TextCell {value} name={property.name} {editable} {reason} {onchange} />
{/if}

<style>
.unsupported {
  font-size: 12.5px;
  color: var(--kern-ink-450);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
</style>
