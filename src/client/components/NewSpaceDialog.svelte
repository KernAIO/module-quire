<script lang="ts">
import { Button, Dialog, Field, Input, Select, Textarea } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Space } from '../index.js'
import { quireKeys } from '../query.js'

interface Props {
  open: boolean
  workspaceId: string
  onCreated?: (space: Space) => void
}
let { open = $bindable(false), workspaceId, onCreated }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

let name = $state('')
let key = $state('')
let description = $state('')
let visibility = $state<Space['visibility']>('open')
let saving = $state(false)
let error = $state<string | null>(null)

/**
 * A whole space somebody saved, so a team can be given the shape as well as the name.
 *
 * There is no shipped space template and there should not be: the five starters Kern ships are
 * pages, because a page template is generic in a way a space's organisation never is. So this
 * control appears only once somebody in the workspace has saved one — an empty picker is a question
 * with one answer.
 *
 * `spaceId: null` is the workspace-wide question, which is the only one that can be asked before
 * there is a space.
 */
let fromTemplate = $state('')
const templatesQuery = createQuery(() => ({
  queryKey: quireKeys.templates(workspaceId, 'space', null),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.templates.list({ workspaceId, kind: 'space', spaceId: null }),
}))
const spaceTemplates = $derived((templatesQuery.data ?? []).filter((choice) => choice.id))

/**
 * The key is derived from the name until somebody types one, and then left alone. Overwriting a key
 * a person has edited — because they went back and fixed a typo in the name — is the kind of thing
 * that only shows up after the space exists and the URL is wrong.
 */
let keyTouched = $state(false)
const slugify = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

$effect(() => {
  if (!keyTouched) key = slugify(name)
})

const valid = $derived(name.trim().length > 0 && key.length >= 2)

function reset() {
  name = ''
  key = ''
  description = ''
  visibility = 'open'
  fromTemplate = ''
  keyTouched = false
  error = null
}

/**
 * Make the space, from a template or from nothing.
 *
 * `templates.instantiate` makes the space itself — it has to, because it also writes the tree in the
 * same transaction — so the two fields it has no opinion about are applied afterwards rather than
 * dropped. A dialog that asks for a description and then quietly ignores it is worse than one that
 * never asked.
 */
async function make(): Promise<Space> {
  if (!fromTemplate)
    return api.spaces.create({
      workspaceId,
      key,
      name: name.trim(),
      description: description.trim(),
      icon: null,
      visibility,
    })

  const made = await api.templates.instantiate({
    workspaceId,
    templateId: fromTemplate,
    key,
    name: name.trim(),
  })
  if (description.trim() || visibility !== 'open')
    return api.spaces.update({
      workspaceId,
      spaceId: made.spaceId,
      description: description.trim(),
      visibility,
    })
  return api.spaces.get({ workspaceId, spaceId: made.spaceId })
}

async function submit() {
  if (!valid || saving) return
  saving = true
  error = null
  try {
    const space = await make()
    await client.invalidateQueries({ queryKey: quireKeys.spaces(workspaceId) })
    open = false
    reset()
    onCreated?.(space)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    saving = false
  }
}
</script>

<Dialog bind:open title={t('new_space')} description={t('new_space_desc')}>
  <div class="form">
    <Field label={t('space_name')}>
      {#snippet children(id: string)}
        <Input {id} bind:value={name} placeholder={t('space_name_hint')} />
      {/snippet}
    </Field>

    <Field label={t('space_key')} hint={t('space_key_hint')}>
      {#snippet children(id: string)}
        <Input
          {id}
          value={key}
          oninput={(e: Event) => {
            keyTouched = true
            key = slugify((e.currentTarget as HTMLInputElement).value)
          }}
        />
      {/snippet}
    </Field>

    <Field label={t('space_description')}>
      {#snippet children(id: string)}
        <Textarea {id} bind:value={description} rows={2} />
      {/snippet}
    </Field>

    <Field label={t('space_visibility')}>
      {#snippet children(id: string)}
        <Select
          ariaLabel={t('space_visibility')}
          {id}
          value={visibility}
          options={[
            { value: 'open', label: t('visibility_open') },
            { value: 'restricted', label: t('visibility_restricted') },
            { value: 'private', label: t('visibility_private') },
          ]}
          onValueChange={(v: string) => (visibility = v as Space['visibility'])}
        />
      {/snippet}
    </Field>

    <!--
      Only once there is something to choose between. With no space templates saved this is a menu
      whose single entry is "an empty space", which teaches somebody that the control does nothing.
    -->
    {#if spaceTemplates.length > 0}
      <Field label={t('template_new_space_from')}>
        {#snippet children(id: string)}
          <Select
            {id}
            ariaLabel={t('template_new_space_from')}
            value={fromTemplate}
            options={[
              { value: '', label: t('template_new_space_blank') },
              ...spaceTemplates.map((choice) => ({ value: choice.id as string, label: choice.name })),
            ]}
            onValueChange={(v: string) => (fromTemplate = v)}
          />
        {/snippet}
      </Field>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
    <Button disabled={!valid || saving} onclick={submit}>{t('create')}</Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
