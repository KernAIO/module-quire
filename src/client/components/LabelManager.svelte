<script lang="ts">
import { Button, Dialog, EmptyState, Icon, IconButton, Input, Skeleton } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Label, LabelColour } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { OPTION_COLOURS, toneFor } from '../database/colours.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import ConfirmDialog from './ConfirmDialog.svelte'
import LabelChip from './LabelChip.svelte'

/**
 * A space's vocabulary, where it belongs to whoever runs the space.
 *
 * Reading a label is `quire.space.view` and writing one is `quire.space.manage`, because renaming
 * "Draft" changes what it means on every page wearing it — that is not something somebody who may
 * edit one page should be able to do to everyone else's. This dialog is only offered to the second
 * group; the picker on a page offers a way in here, and simply omits it for the first.
 *
 * One row is in edit mode at a time rather than every row carrying its own draft. Svelte state
 * lives per component instance, not per `{#each}` iteration, so a draft per row would mean either
 * a component per row or a map that has to be reconciled against the query on every refetch — and
 * a map like that is exactly the sort of state an `$effect` ends up both reading and writing.
 */
interface Props {
  open?: boolean
  workspaceId: string
  spaceId: string
}
let { open = $bindable(false), workspaceId, spaceId }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: quireKeys.labels(workspaceId, spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.labels.list({ workspaceId, spaceId }),
}))
const labels = $derived(query.data ?? [])

/** The one row being edited, and what is being typed into it. */
let editingId = $state<string | null>(null)
let draftName = $state('')
let draftColour = $state<LabelColour>('grey')

let newName = $state('')
let newColour = $state<LabelColour>('grey')
let error = $state<string | null>(null)
let busy = $state(false)

let confirming = $state<Label | null>(null)
const confirmOpen = $derived(confirming !== null)

/**
 * "Draft" beside "draft" in one picker is broken data, so the clash is case-insensitive here for
 * the same reason it is in the database. Caught locally as well as on the server: the server's
 * answer is right and arrives after a round trip, and a name field should say so as you type.
 */
const clashes = (name: string, exceptId: string | null) =>
  labels.some((l) => l.id !== exceptId && l.name.toLowerCase() === name.trim().toLowerCase())

const refresh = () => client.invalidateQueries({ queryKey: quireKeys.labels(workspaceId, spaceId) })

function startEditing(label: Label) {
  editingId = label.id
  draftName = label.name
  draftColour = label.colour
  error = null
}

function stopEditing() {
  editingId = null
  error = null
}

async function create() {
  const name = newName.trim()
  if (busy || !name) return
  if (clashes(name, null)) {
    error = t('label_taken')
    return
  }
  busy = true
  error = null
  try {
    await api.labels.create({ workspaceId, spaceId, name, colour: newColour })
    newName = ''
    newColour = 'grey'
    await refresh()
  } catch (err) {
    error = messageFor(err)
  } finally {
    busy = false
  }
}

async function save() {
  const name = draftName.trim()
  if (busy || !editingId || !name) return
  if (clashes(name, editingId)) {
    error = t('label_taken')
    return
  }
  busy = true
  error = null
  try {
    await api.labels.update({ workspaceId, labelId: editingId, name, colour: draftColour })
    editingId = null
    await refresh()
  } catch (err) {
    error = messageFor(err)
  } finally {
    busy = false
  }
}

async function remove(label: Label) {
  await api.labels.remove({ workspaceId, labelId: label.id })
  confirming = null
  await refresh()
  /*
   * A label coming off pages is a change to those pages, and the chips drawing it are keyed per
   * page. Nothing else would clear them: the server announces the label's own deletion, which
   * refreshes this list and not the page that was wearing it.
   */
  await client.invalidateQueries({ queryKey: ['quire', 'label', workspaceId] })
}

/** A conflict from the server is the same sentence the field already knows how to say. */
function messageFor(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'CONFLICT') return t('label_taken')
  return err instanceof Error ? err.message : t('error')
}
</script>

<Dialog bind:open title={t('labels_manage')} size="md">
  {#if query.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="38px" />{/each}
    </div>
  {:else if query.isError}
    <EmptyState icon="triangle-alert" title={t('labels_error')} description={t('retry')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void query.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#if labels.length === 0}
      <EmptyState
        icon="tag"
        compact
        title={t('labels_empty')}
        description={t('labels_empty_desc')}
      />
    {:else}
      <ul class="rows">
        {#each labels as label (label.id)}
          <li class="row">
            {#if editingId === label.id}
              <div class="edit">
                <Input
                  bind:value={draftName}
                  size="sm"
                  aria-label={t('label_name')}
                  maxlength={60}
                  onkeydown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void save()
                    }
                    if (e.key === 'Escape') stopEditing()
                  }}
                />
                <div class="swatches" role="radiogroup" aria-label={t('label_colour')}>
                  {#each OPTION_COLOURS as colour (colour)}
                    <button
                      type="button"
                      class="swatch"
                      role="radio"
                      aria-checked={draftColour === colour}
                      aria-label={t(`db_colour_${colour}`)}
                      style:background={toneFor(colour).bg}
                      style:color={toneFor(colour).fg}
                      onclick={() => (draftColour = colour as LabelColour)}
                    >
                      {#if draftColour === colour}<Icon name="check" size={13} strokeWidth={2.2} />{/if}
                    </button>
                  {/each}
                </div>
                <Button size="sm" aria-busy={busy} onclick={() => void save()}>{t('save')}</Button>
                <Button size="sm" variant="ghost" onclick={stopEditing}>{t('cancel')}</Button>
              </div>
            {:else}
              <LabelChip {label} />
              <span class="spacer"></span>
              <IconButton
                icon="pencil"
                size={26}
                variant="ghost"
                label={t('label_rename', { name: label.name })}
                onclick={() => startEditing(label)}
              />
              <IconButton
                icon="trash-2"
                size={26}
                variant="ghost"
                label={t('label_delete_title', { name: label.name })}
                onclick={() => (confirming = label)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <form
      class="new"
      onsubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <Input
        bind:value={newName}
        size="sm"
        placeholder={t('label_new')}
        aria-label={t('label_name')}
        maxlength={60}
      />
      <div class="swatches" role="radiogroup" aria-label={t('label_colour')}>
        {#each OPTION_COLOURS as colour (colour)}
          <button
            type="button"
            class="swatch"
            role="radio"
            aria-checked={newColour === colour}
            aria-label={t(`db_colour_${colour}`)}
            style:background={toneFor(colour).bg}
            style:color={toneFor(colour).fg}
            onclick={() => (newColour = colour as LabelColour)}
          >
            {#if newColour === colour}<Icon name="check" size={13} strokeWidth={2.2} />{/if}
          </button>
        {/each}
      </div>
      <Button size="sm" type="submit" icon="plus" aria-busy={busy} disabled={newName.trim() === ''}>
        {t('add')}
      </Button>
    </form>

    {#if error}<p class="err" role="alert">{error}</p>{/if}
  {/if}
</Dialog>

<ConfirmDialog
  open={confirmOpen}
  title={t('label_delete_title', { name: confirming?.name ?? '' })}
  body={t('label_delete_body')}
  confirmLabel={t('delete')}
  danger
  onCancel={() => (confirming = null)}
  onConfirm={async () => {
    if (confirming) await remove(confirming)
  }}
/>

<style>
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding-inline: 2px;
  border-radius: var(--kern-r-md);
}
.row:hover {
  background: var(--kern-surface-hover);
}
.spacer {
  flex: 1;
}
.edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  padding-block: 4px;
}
.new {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-block-start: 14px;
  padding-block-start: 14px;
  border-block-start: 1px solid var(--kern-border);
}
.swatches {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
/*
 * 26px, because a control under 24px with another beside it is a target the audit fails — and a
 * row of eight colours is the most crowded thing in this dialog.
 */
.swatch {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  cursor: pointer;
  padding: 0;
}
.swatch[aria-checked='true'] {
  border-color: var(--kern-ink-900);
}
.err {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
</style>
