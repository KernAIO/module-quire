<script lang="ts">
import { Button, Dialog, Field, Icon, Input, Select, Switch } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type {
  DatabaseRef,
  Property,
  PropertyConfig,
  PropertyType,
  RollupFunction,
  SelectOption,
} from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { FormulaError, parseFormula } from '../formula.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import { OPTION_COLOURS, toneFor } from './colours.js'
import { CREATABLE_TYPES, descriptorFor } from './property-types.js'
import { STATUS_GROUPS } from './view-config.js'

/**
 * Add a column, or change one.
 *
 * Only the configuration the chosen type actually uses is shown — a select's options are not a
 * question you can answer about a number, and a form full of inert fields is how a person learns to
 * stop reading it.
 *
 * The formula is validated **here**, as it is typed, by the same parser the server evaluates with.
 * That is why `formula.ts` moved into `src/client`: a round trip per keystroke is not a validator,
 * and a column saved with a broken expression is a table of error chips.
 */
interface Props {
  open: boolean
  workspaceId: string
  spaceId: string
  databaseId: string
  /** null when adding */
  property: Property | null
  /** this database's relation columns, which a rollup walks */
  relations: Property[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: { name: string; type: PropertyType; config: PropertyConfig }) => void
}
const { open, workspaceId, spaceId, databaseId, property, relations, busy, onClose, onSubmit }: Props =
  $props()

const api = getQuireApi()

let name = $state('')
let type = $state<PropertyType>('text')
let config = $state<PropertyConfig>({})
let submitting = $state(false)

/** Reset every time the dialog opens, so a cancelled edit never leaks into the next one. */
$effect(() => {
  if (!open) return
  name = property?.name ?? ''
  type = property?.type ?? 'text'
  config = { ...(property?.config ?? {}) }
  submitting = false
})

const descriptor = $derived(descriptorFor(type))

/** The databases a relation may point at, and the one a rollup reads through. */
const databasesQuery = createQuery(() => ({
  queryKey: ['quire', 'database', workspaceId, 'space', spaceId],
  enabled: open && Boolean(workspaceId && spaceId) && (type === 'relation' || type === 'rollup'),
  queryFn: () => api.databases.list({ workspaceId, spaceId }),
}))
const targets = $derived<DatabaseRef[]>(databasesQuery.data ?? [])

/** A rollup gathers a column from the database on the *other* side of the relation it walks. */
const viaProperty = $derived(relations.find((r) => r.id === config.rollupRelationPropertyId) ?? null)
const viaDatabaseId = $derived(viaProperty?.config.relationDatabaseId ?? null)
const viaDatabase = createQuery(() => ({
  queryKey: quireKeys.database(workspaceId, viaDatabaseId ?? ''),
  enabled: open && type === 'rollup' && Boolean(viaDatabaseId),
  queryFn: () => api.databases.get({ workspaceId, databaseId: viaDatabaseId! }),
}))

const formulaError = $derived.by(() => {
  if (type !== 'formula') return null
  const expression = (config.expression ?? '').trim()
  if (!expression) return null
  try {
    parseFormula(expression)
    return null
  } catch (err) {
    return err instanceof FormulaError || err instanceof Error ? err.message : t('error')
  }
})

const options = $derived<SelectOption[]>(config.options ?? [])
const needsOptions = $derived(type === 'select' || type === 'multi_select' || type === 'status')

const setConfig = (patch: Partial<PropertyConfig>) => {
  config = { ...config, ...patch }
}

/** A stable id, because the option id is what every row already stores. */
const nextOptionId = () => `opt_${Math.random().toString(36).slice(2, 9)}`

const addOption = () =>
  setConfig({
    options: [
      ...options,
      {
        id: nextOptionId(),
        label: t('db_option_new'),
        colour: OPTION_COLOURS[options.length % OPTION_COLOURS.length] ?? 'grey',
        ...(type === 'status' ? { group: 'todo' as const } : {}),
      },
    ],
  })

const patchOption = (id: string, patch: Partial<SelectOption>) =>
  setConfig({ options: options.map((o) => (o.id === id ? { ...o, ...patch } : o)) })

const removeOption = (id: string) => setConfig({ options: options.filter((o) => o.id !== id) })

const ROLLUP_FUNCTIONS: RollupFunction[] = [
  'count',
  'count_values',
  'count_unique',
  'sum',
  'average',
  'min',
  'max',
  'range',
  'show_original',
  'checked',
  'unchecked',
  'percent_checked',
]

const valid = $derived(
  name.trim().length > 0 &&
    formulaError === null &&
    (!needsOptions || options.every((o) => o.label.trim().length > 0)),
)

/**
 * `disabled={busy}` reaches the button on the next render, and two quick clicks are one render
 * apart — so the flag is set in the same tick as the click and read before anything is sent.
 */
function submit() {
  if (submitting || !valid) return
  submitting = true
  onSubmit({ name: name.trim(), type, config: $state.snapshot(config) })
}

$effect(() => {
  if (!busy) submitting = false
})
</script>

<Dialog
  {open}
  title={property ? t('db_edit_property') : t('db_add_property')}
  size="md"
  onOpenChange={(o) => !o && onClose()}
>
  <div class="form">
    <Field label={t('db_property_name')}>
      {#snippet children(id: string)}
        <Input {id} bind:value={name} placeholder={t('db_property_name')} />
      {/snippet}
    </Field>

    <Field label={t('db_property_type')} hint={property ? t('db_property_retype_hint') : undefined}>
      {#snippet children(id: string)}
        <Select
          {id}
          value={type}
          options={CREATABLE_TYPES.map((option) => ({
            value: option,
            label: t(`db_type_${option}`),
            icon: descriptorFor(option).icon,
          }))}
          onValueChange={(next) => (type = next as PropertyType)}
        />
      {/snippet}
    </Field>

    {#if needsOptions}
      <fieldset class="group">
        <legend>{t('db_options')}</legend>
        {#if options.length === 0}
          <p class="hint">{t('db_options_none')}</p>
        {/if}
        <ul class="options">
          {#each options as option (option.id)}
            <li>
              <span class="swatch" style:background={toneFor(option.colour).bg}></span>
              <input
                class="opt-label"
                value={option.label}
                aria-label={t('db_option_label')}
                oninput={(e) => patchOption(option.id, { label: e.currentTarget.value })}
              />
              <select
                class="opt-select"
                value={option.colour}
                aria-label={t('db_option_colour')}
                onchange={(e) => patchOption(option.id, { colour: e.currentTarget.value })}
              >
                {#each OPTION_COLOURS as colour (colour)}
                  <option value={colour}>{t(`db_colour_${colour}`)}</option>
                {/each}
              </select>
              {#if type === 'status'}
                <select
                  class="opt-select"
                  value={option.group ?? 'todo'}
                  aria-label={t('db_option_group')}
                  onchange={(e) =>
                    patchOption(option.id, {
                      group: e.currentTarget.value as 'todo' | 'doing' | 'done',
                    })}
                >
                  {#each STATUS_GROUPS as band (band)}
                    <option value={band}>{t(`db_status_${band}`)}</option>
                  {/each}
                </select>
              {/if}
              <button
                type="button"
                class="opt-remove"
                aria-label={t('db_option_remove', { label: option.label })}
                onclick={() => removeOption(option.id)}
              >
                <Icon name="x" size={13} strokeWidth={1.9} />
              </button>
            </li>
          {/each}
        </ul>
        <Button size="sm" variant="secondary" onclick={addOption}>{t('db_option_add')}</Button>
      </fieldset>
    {/if}

    {#if type === 'number'}
      <Field label={t('db_number_format')}>
        {#snippet children(id: string)}
          <Select
            {id}
            value={config.format ?? 'plain'}
            options={['plain', 'percent', 'currency'].map((f) => ({ value: f, label: t(`db_format_${f}`) }))}
            onValueChange={(next) => setConfig({ format: next })}
          />
        {/snippet}
      </Field>
      <Field label={t('db_precision')}>
        {#snippet children(id: string)}
          <Input
            {id}
            type="number"
            min="0"
            max="8"
            value={config.precision ?? ''}
            oninput={(e) => {
              const raw = (e.currentTarget as HTMLInputElement).value
              setConfig({ precision: raw === '' ? undefined : Number(raw) })
            }}
          />
        {/snippet}
      </Field>
    {/if}

    {#if type === 'date'}
      <Switch
        checked={config.includeTime === true}
        label={t('db_include_time')}
        onCheckedChange={(on) => setConfig({ includeTime: on })}
      />
    {/if}

    {#if type === 'person'}
      <Switch
        checked={config.multiple !== false}
        label={t('db_person_multiple')}
        onCheckedChange={(on) => setConfig({ multiple: on })}
      />
    {/if}

    {#if type === 'relation'}
      <Field label={t('db_relation_database')} hint={t('db_relation_database_hint')}>
        {#snippet children(id: string)}
          <Select
            {id}
            value={config.relationDatabaseId ?? ''}
            placeholder={t('db_relation_choose')}
            options={targets
              .filter((d) => d.id !== databaseId)
              .map((d) => ({ value: d.id, label: d.name || t('untitled') }))}
            onValueChange={(next) => setConfig({ relationDatabaseId: next || undefined })}
          />
        {/snippet}
      </Field>
    {/if}

    {#if type === 'rollup'}
      <Field label={t('db_rollup_relation')}>
        {#snippet children(id: string)}
          <Select
            {id}
            value={config.rollupRelationPropertyId ?? ''}
            placeholder={t('db_rollup_choose')}
            options={relations.map((r) => ({ value: r.id, label: r.name }))}
            onValueChange={(next) => setConfig({ rollupRelationPropertyId: next || undefined })}
          />
        {/snippet}
      </Field>
      {#if relations.length === 0}
        <p class="hint">{t('db_rollup_needs_relation')}</p>
      {/if}
      <Field label={t('db_rollup_target')}>
        {#snippet children(id: string)}
          <Select
            {id}
            value={config.rollupTargetPropertyId ?? ''}
            placeholder={t('db_rollup_choose')}
            disabled={!viaDatabaseId}
            options={(viaDatabase.data?.properties ?? []).map((p) => ({ value: p.id, label: p.name }))}
            onValueChange={(next) => setConfig({ rollupTargetPropertyId: next || undefined })}
          />
        {/snippet}
      </Field>
      <Field label={t('db_rollup_function')}>
        {#snippet children(id: string)}
          <Select
            {id}
            value={config.rollupFunction ?? 'count'}
            options={ROLLUP_FUNCTIONS.map((fn) => ({ value: fn, label: t(`db_rollup_${fn}`) }))}
            onValueChange={(next) => setConfig({ rollupFunction: next as RollupFunction })}
          />
        {/snippet}
      </Field>
    {/if}

    {#if type === 'formula'}
      <Field
        label={t('db_expression')}
        hint={formulaError ? undefined : t('db_expression_hint')}
        error={formulaError}
      >
        {#snippet children(id: string)}
          <Input
            {id}
            mono
            value={config.expression ?? ''}
            placeholder={'round(prop("Hours") / 8, 2)'}
            oninput={(e) => setConfig({ expression: (e.currentTarget as HTMLInputElement).value })}
          />
        {/snippet}
      </Field>
    {/if}

    {#if descriptor.readOnly && type !== 'formula' && type !== 'rollup'}
      <p class="hint">{t('db_type_readonly_hint')}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={onClose}>{t('cancel')}</Button>
    <Button disabled={!valid || busy || submitting} onclick={submit}>
      {property ? t('save') : t('add')}
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
  display: flex;
  flex-direction: column;
  gap: 10px;
}
legend {
  padding-inline: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kern-ink-550);
}
.options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.options li {
  display: flex;
  align-items: center;
  gap: 7px;
}
.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
}
.opt-label {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-raised);
  color: var(--kern-ink-700);
  font: inherit;
  font-size: 13px;
}
.opt-label:focus {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: 0 0 0 3px var(--kern-ring);
}
.opt-select {
  flex: none;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-raised);
  color: var(--kern-ink-700);
  font: inherit;
  font-size: 12.5px;
}
.opt-remove {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-450);
}
.opt-remove:hover {
  background: var(--kern-surface-hover);
  color: var(--kern-ink-900);
}
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
</style>
