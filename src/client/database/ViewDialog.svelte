<script lang="ts">
import { Button, Dialog, Field, Input, Select } from '@kernhq/ui'
import type { Database, View, ViewConfig, ViewKind } from '../../contract/index.js'
import { t } from '../i18n.js'
import { descriptorFor, VIEW_KINDS } from './property-types.js'
import { mergeConfig, orderedProperties } from './view-config.js'

/**
 * Add a view, or change one.
 *
 * Only the settings the chosen kind uses are shown: a table has no group-by, a board has no date
 * column, and a gallery's cover picker is disabled **with the reason** rather than hidden — the
 * setting exists, it is files that are not built.
 *
 * The config sent is always the merged whole, because `updateView` replaces it.
 */
interface Props {
  open: boolean
  database: Database
  /** null when adding */
  view: View | null
  busy: boolean
  onClose: () => void
  onSubmit: (input: { name: string; kind: ViewKind; config: ViewConfig }) => void
}
const { open, database, view, busy, onClose, onSubmit }: Props = $props()

const BLANK: ViewConfig = {
  filters: [],
  filterMode: 'and',
  sorts: [],
  groupBy: null,
  dateProperty: null,
  visibleProperties: null,
  columnWidths: {},
  cardSize: 'medium',
  coverProperty: null,
}

let name = $state('')
let kind = $state<ViewKind>('table')
let config = $state<ViewConfig>(BLANK)
let submitting = $state(false)

$effect(() => {
  if (!open) return
  name = view?.name ?? ''
  kind = view && VIEW_KINDS.some((v) => v.kind === view.kind) ? view.kind : 'table'
  config = view ? mergeConfig(BLANK, view.config) : BLANK
  submitting = false
})

const properties = $derived(orderedProperties(database))
const groupable = $derived(properties.filter((p) => descriptorFor(p.type).canGroup))
const datable = $derived(properties.filter((p) => descriptorFor(p.type).canDate))

const patch = (next: Partial<ViewConfig>) => {
  config = mergeConfig(config, next)
}

const visible = $derived(config.visibleProperties ?? properties.filter((p) => !p.hidden).map((p) => p.key))

const toggleVisible = (key: string, on: boolean) =>
  patch({
    visibleProperties: on ? [...visible.filter((k) => k !== key), key] : visible.filter((k) => k !== key),
  })

const valid = $derived(name.trim().length > 0)

function submit() {
  if (submitting || !valid) return
  submitting = true
  onSubmit({ name: name.trim(), kind, config: $state.snapshot(config) })
}

$effect(() => {
  if (!busy) submitting = false
})
</script>

<Dialog {open} title={view ? t('db_edit_view') : t('db_add_view')} size="md" onOpenChange={(o) => !o && onClose()}>
  <div class="form">
    <Field label={t('db_view_name')}>
      {#snippet children(id: string)}
        <Input {id} bind:value={name} placeholder={t('db_view_name')} />
      {/snippet}
    </Field>

    <Field label={t('db_view_kind')}>
      {#snippet children(id: string)}
        <Select
          ariaLabel={t('db_view_kind')}
          {id}
          value={kind}
          options={VIEW_KINDS.map((v) => ({ value: v.kind, label: t(`db_kind_${v.kind}`), icon: v.icon }))}
          onValueChange={(next) => (kind = next as ViewKind)}
        />
      {/snippet}
    </Field>

    {#if kind === 'board'}
      <Field label={t('db_group_by')} hint={groupable.length === 0 ? t('db_group_needs_column') : undefined}>
        {#snippet children(id: string)}
          <Select
          ariaLabel={t('db_group_by')}
            {id}
            value={config.groupBy ?? ''}
            placeholder={t('db_group_none')}
            disabled={groupable.length === 0}
            options={groupable.map((p) => ({ value: p.key, label: p.name, icon: descriptorFor(p.type).icon }))}
            onValueChange={(next) => patch({ groupBy: next || null })}
          />
        {/snippet}
      </Field>
    {/if}

    {#if kind === 'calendar'}
      <Field label={t('db_date_property')} hint={datable.length === 0 ? t('db_date_needs_column') : undefined}>
        {#snippet children(id: string)}
          <Select
          ariaLabel={t('db_date_property')}
            {id}
            value={config.dateProperty ?? ''}
            placeholder={t('db_date_choose')}
            disabled={datable.length === 0}
            options={datable.map((p) => ({ value: p.key, label: p.name, icon: descriptorFor(p.type).icon }))}
            onValueChange={(next) => patch({ dateProperty: next || null })}
          />
        {/snippet}
      </Field>
    {/if}

    {#if kind === 'gallery'}
      <Field label={t('db_cover_property')} hint={t('db_cover_unsupported')}>
        {#snippet children(id: string)}
          <Select
            ariaLabel={t('db_cover_property')}
            {id}
            value=""
            disabled
            placeholder={t('db_cover_none')}
            options={[]}
          />
        {/snippet}
      </Field>
      <Field label={t('db_card_size')}>
        {#snippet children(id: string)}
          <Select
          ariaLabel={t('db_card_size')}
            {id}
            value={config.cardSize}
            options={(['small', 'medium', 'large'] as const).map((s) => ({
              value: s,
              label: t(`db_size_${s}`),
            }))}
            onValueChange={(next) => patch({ cardSize: next as 'small' | 'medium' | 'large' })}
          />
        {/snippet}
      </Field>
    {/if}

    <fieldset class="group">
      <legend>{t('db_visible_properties')}</legend>
      {#if properties.length === 0}
        <p class="hint">{t('db_no_columns')}</p>
      {:else}
        <ul class="cols">
          {#each properties as property (property.id)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={visible.includes(property.key)}
                  onchange={(e) => toggleVisible(property.key, e.currentTarget.checked)}
                />
                <span>{property.name}</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </fieldset>
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={onClose}>{t('cancel')}</Button>
    <Button disabled={!valid || busy || submitting} onclick={submit}>
      {view ? t('save') : t('create')}
    </Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.group {
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  padding: 12px 14px 14px;
  margin: 0;
}
legend {
  padding-inline: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kern-ink-550);
}
.cols {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.cols label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 2px 4px;
  border-radius: var(--kern-r-sm);
  font-size: 13px;
  color: var(--kern-ink-700);
  cursor: pointer;
}
.cols label:hover {
  background: var(--kern-surface-hover);
}
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
</style>
