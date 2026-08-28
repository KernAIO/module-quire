<script lang="ts">
/**
 * What comes up when somebody presses "New page".
 *
 * **A blank page has to stay the fastest thing to make**, and that is the constraint the whole
 * component is arranged around. Putting a picker in front of "New page" is exactly the kind of
 * change that makes a product feel slower — every page anybody ever writes now costs a dialog — so
 * blank is the *first* row, it holds focus the moment the dialog opens, and Enter makes it. One
 * keystroke, and Escape is the other one that also costs nothing.
 *
 * Two steps, and the second only appears when it has something to ask. A template with no variables
 * makes its page on the first press; a template with variables asks for them, because a form that
 * appears for every template would be the same tax the blank row exists to avoid.
 */
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDate,
  Icon,
  IconButton,
  Input,
  Select,
  Skeleton,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { TemplateChoice, TemplateResult, TemplateStarterKey } from '../index.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'
import ConfirmDialog from './ConfirmDialog.svelte'

interface Props {
  open: boolean
  workspaceId: string
  spaceId: string
  /** where the new page hangs — null makes it a top-level page of the space */
  parentId?: string | null
  /** the sibling it lands behind; null puts it first */
  afterId?: string | null
  /** a page was made from a template */
  onMade?: (result: TemplateResult) => void
  /** the blank row, which does not go through `instantiate` at all */
  onBlank?: () => void
}
let {
  open = $bindable(false),
  workspaceId,
  spaceId,
  parentId = null,
  afterId = null,
  onMade,
  onBlank,
}: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: quireKeys.templates(workspaceId, 'page', spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.templates.list({ workspaceId, kind: 'page', spaceId }),
}))
const choices = $derived(query.data ?? [])

/** The template being filled in, or null while the list is showing. */
let asking = $state<TemplateChoice | null>(null)
let answers = $state<Record<string, string>>({})
let error = $state<string | null>(null)
/**
 * A plain flag rather than `mutation.isPending`.
 *
 * `disabled={pending}` reaches the button on the next render, and two quick clicks are one render
 * apart — so a double-click on a template would make two pages, both of which somebody then has to
 * find and delete.
 */
let busy = $state(false)
/**
 * Which row is being made, so `aria-busy` lands on that one rather than on all of them.
 *
 * `aria-busy` on every row would tell a screen-reader user that the whole list is working, which is
 * both untrue and unhelpful — the one thing worth saying is that the row they just pressed is.
 */
let pending = $state<string | null>(null)

/** The blank row, so the dialog can hand it focus rather than the browser guessing. */
let blankRow = $state<HTMLButtonElement | null>(null)

/** A starter is addressed by key and a saved template by id, so a row's identity is one or other. */
const idOf = (choice: TemplateChoice) => choice.id ?? (choice.key as string)

/**
 * The row a confirmation is open about.
 *
 * Deleting a template and resetting an overridden starter are **the same act** — the row goes — so
 * they are one code path wearing whichever word is true. Confirmed rather than done on the press,
 * because it is not undoable and because the thing people most need told is what it does *not* do:
 * the pages already made from it stay exactly where they are.
 */
let removing = $state<TemplateChoice | null>(null)

async function removeTemplate(choice: TemplateChoice) {
  if (!choice.id) return
  try {
    await api.templates.remove({ workspaceId, templateId: choice.id })
    await client.invalidateQueries({ queryKey: ['quire', 'template', workspaceId] })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
}

function reset() {
  asking = null
  answers = {}
  error = null
}

function choose(choice: TemplateChoice) {
  error = null
  if (choice.variables.length === 0) {
    void make(choice)
    return
  }
  answers = Object.fromEntries(choice.variables.map((v) => [v.name, v.default ?? '']))
  asking = choice
}

const missing = $derived(
  (asking?.variables ?? []).filter((v) => v.required && !(answers[v.name] ?? '').trim()),
)

async function make(choice: TemplateChoice) {
  if (busy) return
  busy = true
  pending = idOf(choice)
  error = null
  try {
    const result = await api.templates.instantiate({
      workspaceId,
      templateId: choice.id,
      // A shipped starter has no row, so its key is what addresses it. Exactly one of the two.
      starterKey: choice.id === null ? (choice.key as TemplateStarterKey) : null,
      spaceId,
      parentId,
      afterId,
      title: '',
      values: answers,
    })
    await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
    open = false
    reset()
    onMade?.(result)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    busy = false
    pending = null
  }
}

function blank() {
  if (busy) return
  open = false
  reset()
  onBlank?.()
}
</script>

<Dialog
  bind:open
  size="lg"
  title={asking ? t('template_fill_title') : t('template_pick_title')}
  description={asking ? t('template_fill_desc') : t('template_pick_desc')}
  initialFocus={() => blankRow}
  onOpenChange={(o: boolean) => {
    if (!o) reset()
  }}
>
  {#if asking}
    <div class="form">
      {#each asking.variables as variable (variable.name)}
        <Field
          label={variable.label}
          required={variable.required}
          error={variable.required && !(answers[variable.name] ?? '').trim()
            ? t('template_required_missing')
            : null}
        >
          {#snippet children(id: string)}
            {#if variable.type === 'select'}
              <Select
                {id}
                ariaLabel={variable.label}
                placeholder={t('template_choose_option')}
                value={answers[variable.name] ?? ''}
                options={variable.options.map((option) => ({ value: option, label: option }))}
                onValueChange={(v: string) => (answers = { ...answers, [variable.name]: v })}
              />
            {:else}
              <!--
                The type picks the control and nothing else: every answer is substituted as text, so
                a date field is a date input whose value is a string like any other.
              -->
              <Input
                {id}
                type={variable.type === 'number' ? 'number' : variable.type === 'date' ? 'date' : 'text'}
                value={answers[variable.name] ?? ''}
                oninput={(e: Event) =>
                  (answers = {
                    ...answers,
                    [variable.name]: (e.currentTarget as HTMLInputElement).value,
                  })}
              />
            {/if}
          {/snippet}
        </Field>
      {/each}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  {:else if query.isLoading}
    <div class="list">
      {#each [1, 2, 3, 4] as n (n)}
        <Skeleton height="56px" />
      {/each}
    </div>
  {:else if query.isError}
    <EmptyState icon="triangle-alert" title={t('template_error')} description={t('template_error_desc')} />
  {:else}
    <div class="list">
      <!--
        First, focused, and visually the same weight as the rest: the point is that pressing Enter
        the instant the dialog appears is still the fastest way to a page.
      -->
      <button class="row blank" type="button" bind:this={blankRow} onclick={blank}>
        <span class="mark"><Icon name="file-text" size={18} /></span>
        <span class="what">
          <span class="name">{t('template_blank')}</span>
          <span class="desc">{t('template_blank_desc')}</span>
        </span>
      </button>

      <!--
        A row is a `<div>` wrapping two controls rather than one big `<button>`, because a button
        inside a button is not a thing a browser will render — the pick and the delete are siblings.
      -->
      {#each choices as choice (idOf(choice))}
        <div class="row">
          <button
            class="pick"
            type="button"
            aria-busy={pending === idOf(choice)}
            onclick={() => choose(choice)}
          >
            <span class="mark"><Icon name={choice.icon ?? 'file-text'} size={18} /></span>
            <span class="what">
              <span class="name">
                {choice.name}
                <!--
                  A starter this workspace has edited is a different thing from the shipped one, and
                  the only way to tell from the outside is that it has a row. Saying so is what makes
                  "delete it and the shipped one comes back" make sense.
                -->
                {#if choice.builtIn && choice.id}<span class="tag">{t('template_customised')}</span>{/if}
              </span>
              <span class="desc">{choice.description}</span>
            </span>
            {#if choice.updatedAt}
              <span class="when">{formatDate(choice.updatedAt)}</span>
            {/if}
          </button>

          <!--
            The only way out of a template somebody no longer wants, and the only way back to a
            shipped one that was replaced — the two are the same act on the row, so they are one
            control wearing the right word. A shipped starter has no row and therefore no control.

            `space.manage`, matching `templates.remove`: a template is the space's furniture.
          -->
          {#if choice.id && canQuire('spaceManage')}
            <IconButton
              icon={choice.builtIn ? 'rotate-ccw' : 'trash-2'}
              variant="ghost"
              size={30}
              label={choice.builtIn
                ? t('template_reset', { name: choice.name })
                : t('template_delete', { name: choice.name })}
              onclick={() => (removing = choice)}
            />
          {/if}
        </div>
      {/each}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if asking}
      <Button variant="secondary" onclick={reset}>{t('template_back')}</Button>
      <Button
        aria-busy={busy}
        disabled={missing.length > 0}
        onclick={() => asking && make(asking)}
      >
        {t('template_create')}
      </Button>
    {:else}
      <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
    {/if}
  {/snippet}
</Dialog>

{#if removing}
  <ConfirmDialog
    open={true}
    danger={!removing.builtIn}
    title={removing.builtIn ? t('template_reset_title') : t('template_delete_title')}
    body={t('template_delete_body', { name: removing.name })}
    confirmLabel={removing.builtIn ? t('template_reset_confirm') : t('template_delete_confirm')}
    onConfirm={async () => {
      if (removing) await removeTemplate(removing)
      removing = null
    }}
    onCancel={() => (removing = null)}
  />
{/if}

<style>
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/*
 * `.row` is the frame — a `<div>` around a saved template, and the `<button>` itself for the blank
 * one, which has nothing beside it. `.pick` is the part somebody presses in both cases.
 */
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  /* A row people press: 56px tall, so it is a comfortable target on a phone as well as a pointer. */
  min-height: 56px;
  padding: 6px 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
  color: var(--kern-ink-800);
  /* Logical, so the icon leads the row in Persian and Arabic rather than trailing it. */
  text-align: start;
}
.row:hover {
  background: var(--kern-surface-hover);
  border-color: var(--kern-border-hover);
}
.pick {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 4px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.row:focus-visible,
.pick:focus-visible {
  outline: 2px solid var(--kern-ring);
  outline-offset: 2px;
}
/* The blank row is the frame and the control at once, so it carries both sets of rules. */
.blank {
  gap: 12px;
  padding: 10px 12px;
  border-color: var(--kern-border-strong);
  cursor: pointer;
}
.mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface-chip);
  color: var(--kern-ink-600);
}
.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}
.desc {
  /* Muted with a colour, never with opacity — opacity fades the text against the page. */
  font-size: 12px;
  color: var(--kern-ink-450);
}
.tag {
  padding: 1px 6px;
  border-radius: var(--kern-r-full);
  background: var(--kern-accent-tint);
  color: var(--kern-accent-text);
  font-size: 11px;
  font-weight: 500;
}
.when {
  margin-inline-start: auto;
  flex: none;
  font-size: 11px;
  color: var(--kern-ink-450);
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
