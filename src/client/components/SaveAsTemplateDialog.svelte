<script lang="ts">
/**
 * Saving what is on the screen so it can be made again.
 *
 * Two things here are worth knowing before changing anything.
 *
 * **The body is never sent.** The dialog names a *source* — this page, or this whole space — and the
 * server reads the prose itself. A client that could post a document would make "save as a template"
 * a way to write arbitrary text into something everybody in the space is then offered.
 *
 * **"Replace a template Kern ships" is a real list, not a checkbox.** The starters are constants in
 * the module; a workspace edits one by writing a row that carries its key and stands in its place.
 * The options come from `templates.list` — which is where the starters' translated names live — and
 * a starter this workspace has already replaced is not in the list, because the second override is a
 * conflict rather than a second entry.
 */
import {
  Button,
  Dialog,
  Field,
  Icon,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import {
  TEMPLATE_BUILT_IN_VARIABLES,
  type Template,
  type TemplateKind,
  type TemplateStarterKey,
  type TemplateVariable,
  type TemplateVariableType,
} from '../index.js'
import { quireKeys } from '../query.js'

interface Props {
  open: boolean
  workspaceId: string
  spaceId: string
  spaceName: string
  /** the page whose prose becomes the body, for a page template */
  pageId: string
  pageTitle: string
  onSaved?: (template: Template) => void
}
let { open = $bindable(false), workspaceId, spaceId, spaceName, pageId, pageTitle, onSaved }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

let kind = $state<TemplateKind>('page')
let name = $state('')
let description = $state('')
let scope = $state<'space' | 'workspace'>('space')
let replaces = $state('')
let fields = $state<TemplateVariable[]>([])
let error = $state<string | null>(null)
/** Guarded in the same tick as the click; `disabled` on the button arrives a render too late. */
let busy = $state(false)

/**
 * The starters still available to replace, with the names the server translated.
 *
 * Read from the picker's own query rather than from `TEMPLATE_STARTER_KEYS`, because a key is not a
 * name: the starters' words are a table on the server, resolved per reader, and a client spelling
 * them itself would be a sixth copy in one language.
 */
const startersQuery = createQuery(() => ({
  queryKey: quireKeys.templates(workspaceId, 'page', spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.templates.list({ workspaceId, kind: 'page', spaceId }),
}))
const replaceable = $derived(
  (startersQuery.data ?? []).filter((choice) => choice.builtIn && choice.id === null && choice.key),
)

/**
 * Save as a new template, or take an existing one's body from this page again.
 *
 * The second is not a nicety. A template's prose drifts — somebody improves the meeting note they
 * are looking at and wants everybody's next one to start from it — and without this the only way to
 * express that is to save a second template with the same name and delete the first, which loses
 * whichever of the two other people had already started using.
 */
let target = $state('')
const editable = $derived((startersQuery.data ?? []).filter((choice) => choice.id))

/**
 * The chosen template in full, which is where its variables come from.
 *
 * `templates.list` deliberately carries no body — thirty documents to draw thirty names — so
 * "replace this one" needs the row itself before the form can show what it currently asks for.
 */
const chosenQuery = createQuery(() => ({
  queryKey: quireKeys.template(workspaceId, target),
  enabled: open && Boolean(workspaceId && target),
  queryFn: () => api.templates.get({ workspaceId, templateId: target }),
}))

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** Why this field cannot be saved, or null. Shown under the field rather than at submit time. */
function problemWith(field: TemplateVariable, at: number): string | null {
  if (!field.name) return null
  if (!NAME_PATTERN.test(field.name)) return t('template_field_name_invalid')
  if ((TEMPLATE_BUILT_IN_VARIABLES as readonly string[]).includes(field.name))
    return t('template_field_name_reserved')
  if (fields.some((other, index) => index !== at && other.name === field.name))
    return t('template_field_name_twice')
  return null
}

const valid = $derived(
  name.trim().length > 0 &&
    fields.every(
      (field, at) => field.name.length > 0 && field.label.length > 0 && problemWith(field, at) === null,
    ),
)

function addField() {
  fields = [...fields, { name: '', label: '', type: 'text', options: [], default: null, required: false }]
}

function patchField(at: number, patch: Partial<TemplateVariable>) {
  fields = fields.map((field, index) => (index === at ? { ...field, ...patch } : field))
}

function removeField(at: number) {
  fields = fields.filter((_, index) => index !== at)
}

function reset() {
  kind = 'page'
  name = ''
  description = ''
  scope = 'space'
  replaces = ''
  target = ''
  fields = []
  error = null
}

async function submit() {
  if (!valid || busy) return
  busy = true
  error = null
  try {
    const template = target
      ? await api.templates.update({
          workspaceId,
          templateId: target,
          name: name.trim(),
          description: description.trim(),
          variables: fields,
          /*
           * Three-valued, like `publications.update`'s password: sending it re-reads the body, and
           * leaving it out would change the name and quietly keep the old prose.
           *
           * Always this page, never the space, because the list this target came from is
           * `kind: 'page'` — a space template is not offered here, and the server would resolve
           * `sourceId` as a space id for one.
           */
          sourceId: pageId,
        })
      : await api.templates.createFromPage({
          workspaceId,
          kind,
          // The page for a page template, the space for a space template — `kind` says which.
          sourceId: kind === 'space' ? spaceId : pageId,
          // A space template makes a space, so it cannot live inside one.
          spaceId: kind === 'space' || scope === 'workspace' ? null : spaceId,
          name: name.trim(),
          description: description.trim(),
          icon: null,
          variables: fields,
          // The Select's empty option means "a new template"; every other value is a starter's key.
          key: (replaces || null) as TemplateStarterKey | null,
        })
    // Both lists: the space's picker and the workspace-wide one a "New space" picker reads.
    await client.invalidateQueries({ queryKey: ['quire', 'template', workspaceId] })
    open = false
    reset()
    onSaved?.(template)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    busy = false
  }
}

const TYPES: Array<{ value: TemplateVariableType; label: string }> = $derived([
  { value: 'text', label: t('template_type_text') },
  { value: 'number', label: t('template_type_number') },
  { value: 'date', label: t('template_type_date') },
  { value: 'select', label: t('template_type_select') },
  { value: 'user', label: t('template_type_user') },
])

/**
 * The page's own title is the obvious name for a template made from it, until somebody types one.
 *
 * `name` is read and written inside `untrack`, so this effect depends on `open` and `pageTitle` and
 * on nothing it writes. Without that it is its own trigger: it re-runs on every keystroke in the
 * name field, and the only reason it settles rather than looping is the `=== ''` guard — a
 * termination condition that is one edit away from not being there.
 */
$effect(() => {
  if (!open) return
  const suggestion = pageTitle
  untrack(() => {
    if (name === '') name = suggestion
  })
})

/**
 * Choosing a template to replace fills the form with what it says now.
 *
 * Same rule as above: the row is tracked, and everything the effect writes is read and written
 * inside `untrack`, so typing in the name field does not re-run it and overwrite what was typed.
 */
$effect(() => {
  const chosen = chosenQuery.data
  if (!chosen || chosen.id !== target) return
  untrack(() => {
    name = chosen.name
    description = chosen.description
    fields = chosen.variables.map((variable) => ({ ...variable }))
  })
})
</script>

<Dialog
  bind:open
  size="lg"
  title={t('template_save_title')}
  description={t('template_save_desc')}
  onOpenChange={(o: boolean) => {
    if (!o) reset()
  }}
>
  <div class="form">
    <!--
      Only once this workspace has a template to update. Before that "a new template" is the only
      answer, and a menu with one entry is a question nobody should have to read.
    -->
    {#if editable.length > 0}
      <Field label={t('template_target')}>
        {#snippet children(id: string)}
          <Select
            {id}
            ariaLabel={t('template_target')}
            value={target}
            options={[
              { value: '', label: t('template_target_new') },
              ...editable.map((choice) => ({ value: choice.id as string, label: choice.name })),
            ]}
            onValueChange={(v: string) => {
              target = v
              // Back to "a new template" starts from a clean form rather than from whatever the
              // template that was selected happened to say.
              if (!v) {
                name = pageTitle
                description = ''
                fields = []
              }
            }}
          />
        {/snippet}
      </Field>
    {/if}

    <!--
      What a template *is* — a page or a space — is fixed the day it is made. Changing it would
      change the shape of its body, so updating an existing one does not offer the choice.
    -->
    {#if !target}
      <Field label={t('template_source')}>
        {#snippet children(_id: string)}
          <SegmentedControl
            label={t('template_source')}
            value={kind}
            items={[
              { value: 'page', label: t('template_source_page'), icon: 'file-text' },
              { value: 'space', label: t('template_source_space'), icon: 'scroll-text' },
            ]}
            onValueChange={(v: string) => (kind = v as TemplateKind)}
          />
        {/snippet}
      </Field>
    {/if}

    <Field label={t('template_name')}>
      {#snippet children(id: string)}
        <Input {id} bind:value={name} placeholder={t('template_name_hint')} />
      {/snippet}
    </Field>

    <Field label={t('template_desc_label')}>
      {#snippet children(id: string)}
        <Textarea {id} bind:value={description} rows={2} />
      {/snippet}
    </Field>

    <!--
      A space template makes a space, so "only in this space" is not a thing it can be. The control
      is left out rather than shown and ignored: a disabled field somebody cannot act on is a
      question they have to work out the answer to.
    -->
    {#if kind === 'page' && !target}
      <Field label={t('template_scope')}>
        {#snippet children(id: string)}
          <Select
            {id}
            ariaLabel={t('template_scope')}
            value={scope}
            options={[
              { value: 'space', label: t('template_scope_space', { space: spaceName }) },
              { value: 'workspace', label: t('template_scope_workspace') },
            ]}
            onValueChange={(v: string) => (scope = v as 'space' | 'workspace')}
          />
        {/snippet}
      </Field>

      {#if replaceable.length > 0}
        <Field label={t('template_replace')} hint={t('template_replace_hint')}>
          {#snippet children(id: string)}
            <Select
              {id}
              ariaLabel={t('template_replace')}
              value={replaces}
              options={[
                { value: '', label: t('template_replace_none') },
                ...replaceable.map((choice) => ({ value: choice.key as string, label: choice.name })),
              ]}
              onValueChange={(v: string) => (replaces = v)}
            />
          {/snippet}
        </Field>
      {/if}
    {/if}

    <section class="fields">
      <div class="head">
        <span class="title">{t('template_fields')}</span>
        <Button variant="ghost" size="sm" icon="plus" onclick={addField}>{t('template_field_add')}</Button>
      </div>
      <p class="hint">{t('template_fields_hint')}</p>

      {#each fields as field, at (at)}
        <div class="field">
          <div class="grid">
            <Field label={t('template_field_name')} error={problemWith(field, at)}>
              {#snippet children(id: string)}
                <Input
                  {id}
                  value={field.name}
                  oninput={(e: Event) =>
                    patchField(at, { name: (e.currentTarget as HTMLInputElement).value.toLowerCase() })}
                />
              {/snippet}
            </Field>
            <Field label={t('template_field_label')}>
              {#snippet children(id: string)}
                <Input
                  {id}
                  value={field.label}
                  oninput={(e: Event) =>
                    patchField(at, { label: (e.currentTarget as HTMLInputElement).value })}
                />
              {/snippet}
            </Field>
            <Field label={t('template_field_type')}>
              {#snippet children(id: string)}
                <Select
                  {id}
                  ariaLabel={t('template_field_type')}
                  value={field.type}
                  options={TYPES}
                  onValueChange={(v: string) => patchField(at, { type: v as TemplateVariableType })}
                />
              {/snippet}
            </Field>
          </div>

          {#if field.type === 'select'}
            <Field label={t('template_field_options')} hint={t('template_field_options_hint')}>
              {#snippet children(id: string)}
                <Textarea
                  {id}
                  rows={3}
                  value={field.options.join('\n')}
                  oninput={(e: Event) =>
                    patchField(at, {
                      options: (e.currentTarget as HTMLTextAreaElement).value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => line.length > 0),
                    })}
                />
              {/snippet}
            </Field>
          {/if}

          <div class="foot">
            <Switch
              checked={field.required}
              label={t('template_field_required')}
              onCheckedChange={(v: boolean) => patchField(at, { required: v })}
            />
            <IconButton
              icon="trash-2"
              variant="ghost"
              size={30}
              label={t('template_field_remove', { label: field.label || field.name })}
              onclick={() => removeField(at)}
            />
          </div>
        </div>
      {/each}
    </section>

    {#if error}
      <p class="error" role="alert"><Icon name="triangle-alert" size={14} /> {error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
    <Button aria-busy={busy} disabled={!valid} onclick={submit}>
      {busy ? t('template_saving') : target ? t('template_update') : t('template_save')}
    </Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--kern-border-hairline);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-700);
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-450);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-raised);
}
.grid {
  display: grid;
  /* `auto-fit` rather than three fixed columns: the dialog is narrow on a phone, and three inputs
     side by side there is three inputs nobody can type in. */
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
