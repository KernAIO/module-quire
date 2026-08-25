<script lang="ts">
import { Button, Dialog, Field, Input, Select, Textarea } from '@kernhq/ui'
import { useQueryClient } from '@tanstack/svelte-query'
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
  keyTouched = false
  error = null
}

async function submit() {
  if (!valid || saving) return
  saving = true
  error = null
  try {
    const space = await api.spaces.create({
      workspaceId,
      key,
      name: name.trim(),
      description: description.trim(),
      icon: null,
      visibility,
    })
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

    {#if error}<p class="error">{error}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (open = false)}>{t('common.cancel')}</Button>
    <Button disabled={!valid || saving} onclick={submit}>{t('common.create')}</Button>
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
