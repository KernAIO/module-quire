<script lang="ts">
import { Button, Dialog, Icon, ProgressBar, relativeTime, toast, uid } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { tick, untrack } from 'svelte'
import type { ExportFormat, ExportJobDetail, ExportScope } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import {
  EXPORT_FORMATS,
  formatDescription,
  formatLabel,
  isRunning,
  messageOf,
  progressRatio,
  scopeLabel,
  startDownload,
  stateIcon,
  stateLabel,
} from '../transfers.js'

/**
 * Taking a page, a section or a whole space out of Quire as a file.
 *
 * **An export is a server job, so this dialog is a window onto one rather than the thing itself.**
 * That is the single decision the rest of the file follows from. Pressing *Export* records a row and
 * returns; the file is written by a worker minutes later; and closing the dialog, navigating away or
 * reloading the browser has no effect on any of it. So the dialog has two modes and opens in
 * whichever one is true:
 *
 * - **the form**, when nothing is running for this target, and
 * - **a job**, when something is — found by asking `exports.list` on open rather than by remembering
 *   anything locally. Reload mid-export, reopen this dialog, and the same progress bar is there.
 *   A `$state` flag holding the job id would have been a job that only exists while a tab is open,
 *   which is exactly the lie this shape avoids.
 *
 * Two things about the file itself are stated on screen rather than assumed, because both surprise
 * people: **an export contains only the pages the person asking may read** — a subtree export with a
 * page withheld is a smaller file, not a refusal, and `counts.skipped` is the only way anybody finds
 * out — and the artefact is **deleted after seven days**, so it is a download rather than an archive.
 *
 * Word is not offered. `ExportFormat` declares `docx` and the server refuses it at `exports.start`;
 * a control whose only outcome is an error is worse than a sentence saying what to use instead, so
 * the sentence is what this draws. See `services/export.ts` for why a *correct* `.docx` is not a
 * matter of effort.
 */
/**
 * `spaceId` rather than the space itself, because the two entry points know different things.
 *
 * The page screen has a page's `spaceId` and the space's *key* from the URL and no name; the sidebar
 * has the whole row. Passing an id and resolving the name here from the list the sidebar has already
 * loaded is one lookup in one place, instead of a second `spaces.list` bolted onto `PageView` so that
 * it can hand over a string this component was going to need anyway.
 */
interface Props {
  open?: boolean
  workspaceId: string
  /** the space the export lives in — the target of a `space` export, and where a page's tree is */
  spaceId: string
  /** the page the dialog was opened from; null when it was opened from the space menu */
  page?: { id: string; title: string } | null
}
let { open = $bindable(false), workspaceId, spaceId, page = null }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

/**
 * The space's name, for the sentence about what is being exported and for the file's name.
 *
 * `includeArchived: false` matches the sidebar's call exactly — same key, same arguments, so this
 * costs nothing in the common case and cannot become a second query wearing the same name.
 */
const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const spaceName = $derived((spacesQuery.data ?? []).find((row) => row.id === spaceId)?.name ?? '')

/**
 * Both entry points can be mounted at once — the page menu's dialog and the sidebar's — so the radio
 * groups need names that cannot collide. Sharing one would make the two dialogs one control set:
 * choosing a format in the sidebar would silently change the page dialog's.
 */
const group = uid('quire-transfer')

// ------------------------------------------------------------------------------------------------
// What is already happening
// ------------------------------------------------------------------------------------------------

/**
 * This person's own exports, newest first, and the reason this dialog asks for them at all.
 *
 * It is not a history — the transfers screen is that. It is the answer to "is one of these already
 * running for the thing I am looking at", which is what makes a reload survivable and what stops
 * somebody queueing the same space export four times because the first one had no visible trace.
 */
const listQuery = createQuery(() => ({
  queryKey: quireKeys.exports(workspaceId),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.exports.list({ workspaceId, limit: 20 }),
}))

let watching = $state<string | null>(null)
let scope = $state<ExportScope>('space')
let format = $state<ExportFormat>('markdown')
let error = $state<string | null>(null)

/**
 * Which opening of the dialog the form belongs to, so it is filled once rather than on every render.
 *
 * The same `untrack` shape as `PublishDialog`: an effect that reads the fields it also writes is its
 * own trigger. What genuinely selects this one is whether the dialog is open, which target it was
 * opened for, and whether the list has arrived — never what it has already decided.
 *
 * `attached` is a plain `let` beside it, like `busy` below, and for the same reason: it records what
 * this opening has already done and must not be a dependency. Without it, pressing **New export**
 * would put you straight back on the finished job the list still holds.
 */
let session = $state<string | null>(null)
let attached = false

$effect(() => {
  const key = open ? `${page?.id ?? '-'}|${spaceId}` : null
  if (untrack(() => session) !== key) {
    session = key
    attached = false
    error = null
    watching = null
    scope = page ? 'page' : 'space'
    format = 'markdown'
  }
  if (key === null || attached) return
  const rows = listQuery.data
  if (!rows) return
  attached = true
  /*
   * Newest first from the server, so `find` is the most recent one about this page or this space.
   * Any state, not only a running one: coming back to a finished export and being handed the file
   * is the other half of "a job outlives the tab", and a failed one has to be seen at all.
   */
  const mine = rows.find((row) => (page !== null && row.targetId === page.id) || row.targetId === spaceId)
  if (!mine) return
  watching = mine.id
  scope = mine.scope
  format = mine.format
})

/**
 * The job being watched.
 *
 * Polled while it is running **and** invalidated by realtime: the server announces a `change` on the
 * `export` entity every time it writes the counters, and `quireKeys.exportJob` is under that entity's
 * prefix, so on a healthy socket the bar moves without this timer. The timer is what makes it move
 * anyway — in `dev:mock`, on a dropped socket, behind a proxy that eats websockets. Neither is
 * redundant: one is fast and one is certain.
 */
const jobQuery = createQuery(() => ({
  queryKey: quireKeys.exportJob(workspaceId, watching ?? ''),
  enabled: open && Boolean(workspaceId && watching),
  queryFn: () => api.exports.get({ workspaceId, jobId: watching as string }),
  refetchInterval: (query: { state: { data?: ExportJobDetail } }) =>
    query.state.data && isRunning(query.state.data.state) ? 1500 : false,
}))
const job = $derived((jobQuery.data ?? null) as ExportJobDetail | null)
const ratio = $derived(job ? progressRatio(job.counts) : null)

// ------------------------------------------------------------------------------------------------
// What the form is offering
// ------------------------------------------------------------------------------------------------

/**
 * The space's tree, for the two numbers the scope choices carry.
 *
 * The same key the sidebar already holds, with the same `includeArchived: false`, so opening this
 * from a page costs no request — and a key that differed by one argument would be a second query
 * wearing the same name. The count is what the *reader* can see, which is the same filter the export
 * itself applies; `counts.skipped` afterwards is the authority, and this is the estimate before.
 */
const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.pages.tree({ workspaceId, spaceId, includeArchived: false }),
}))

const subtreeCount = $derived.by((): number | null => {
  const nodes = treeQuery.data
  if (!nodes || !page) return null
  const children = new Map<string, string[]>()
  for (const node of nodes)
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id])
  let total = 1
  let guard = 0
  const stack = [page.id]
  while (stack.length > 0 && guard++ < 5000) {
    const id = stack.pop() as string
    for (const child of children.get(id) ?? []) {
      total++
      stack.push(child)
    }
  }
  return total
})
const spaceCount = $derived(treeQuery.data?.length ?? null)

interface Choice {
  value: ExportScope
  label: string
  description: string
}
const scopes = $derived.by((): Choice[] => [
  ...(page
    ? [
        {
          value: 'page' as const,
          label: t('export_scope_page'),
          description: t('export_scope_page_desc', { title: page.title.trim() || t('untitled') }),
        },
        {
          value: 'subtree' as const,
          label: t('export_scope_subtree'),
          description:
            subtreeCount === null
              ? t('export_scope_subtree_desc')
              : t('export_count', { count: subtreeCount }),
        },
      ]
    : []),
  {
    value: 'space' as const,
    label: t('export_scope_space'),
    description:
      spaceCount === null ? t('export_scope_space_desc') : t('export_count', { count: spaceCount }),
  },
])

// ------------------------------------------------------------------------------------------------
// Doing it
// ------------------------------------------------------------------------------------------------

/* Set in the same tick as the click. `isPending` reaches the button one render later, so two quick
   clicks on Export are one render apart and both get through — which here means two jobs, two
   artefacts and two rows in everybody's list. Guarded rather than disabled, so the button somebody
   is standing on is never taken away from under their focus. */
let busy = false

/**
 * Where focus goes when the dialog swaps one half of itself for the other.
 *
 * Both transitions destroy the button that caused them — pressing **Export** replaces the form with
 * a progress region, pressing **New export** replaces the progress region with the form — and the
 * browser hands the focus of a removed element to `<body>` and leaves it there. A keyboard user then
 * has to tab in from the top of the page to reach a dialog they are standing in. The same family as
 * disabling a focused control, and `PublishDialog` documents the same fix for its confirmation.
 *
 * Going forward, focus lands on the status region rather than on a button, so a repeated Enter
 * cannot press anything; coming back, it lands on the first scope option, which is where somebody
 * about to start another export is going anyway.
 */
let jobRegion = $state<HTMLElement | null>(null)
let scopeFieldset = $state<HTMLElement | null>(null)

/* Also a plain `let`, and deliberately not fed to `Button`'s `loading`: that prop disables the
   button, and this is the button somebody's focus is sitting on — disabling it blurs the control
   and the browser hands the focus to `<body>`. Guarding the handler stops the second click without
   taking anybody's place on the page away. */
let downloading = false

async function start() {
  if (busy) return
  busy = true
  error = null
  try {
    const created = await api.exports.start({
      workspaceId,
      scope,
      targetId: scope === 'space' ? spaceId : (page?.id ?? spaceId),
      format,
    })
    /*
     * The row `start` answered with **is** the answer `get` would give, so it is put in the cache
     * rather than waited for. Without this there is a gap — a round trip long — in which the job
     * exists on the server and the dialog is still showing the form, with a live **Export** button
     * on it: pressing it again in that gap queues a second job, a second artefact and a second row
     * in everybody's list. The `busy` flag does not cover it, because it is cleared as soon as this
     * function returns. Seeding closes the gap rather than papering over it, and it is honest —
     * `exports.start` and `exports.get` return the same shape for the same row.
     */
    watching = created.id
    client.setQueryData(quireKeys.exportJob(workspaceId, created.id), created)
    await tick()
    jobRegion?.focus()
    // The list is what the next opening reads to find this job, so it has to know about it.
    await listQuery.refetch()
  } catch (err) {
    error = messageOf(err)
  } finally {
    busy = false
  }
}

/**
 * Ask for the link at the moment of the download, never before.
 *
 * `downloadUrl` is signed for fifteen minutes and the polling stops the moment the job is done, so
 * the copy on screen goes stale in a dialog somebody leaves open over lunch. Re-reading the job is
 * one request and cannot be stale — and it is the request the server checks the permission on, which
 * is the whole point of the link being minted per fetch rather than stored on the row.
 */
async function download() {
  const id = watching
  if (!id || downloading) return
  downloading = true
  error = null
  try {
    const fresh = await api.exports.get({ workspaceId, jobId: id })
    if (!fresh.downloadUrl) {
      error = t('export_no_link')
      return
    }
    const stem = (page && fresh.scope !== 'space' ? page.title : spaceName).trim() || t('untitled')
    startDownload(fresh.downloadUrl, `${stem}.${fresh.format === 'pdf' ? 'pdf' : 'zip'}`)
  } catch (err) {
    error = messageOf(err)
  } finally {
    downloading = false
  }
}

async function copyError(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('transfer_copied'))
  } catch {
    // A denied clipboard is not worth an error: the text is on screen to select.
    toast.info(t('share_copy_manually'))
  }
}

/** Back to the form, keeping the last scope and format — "again, but PDF" is the common second act. */
async function newExport() {
  watching = null
  error = null
  await tick()
  scopeFieldset?.querySelector('input')?.focus()
}

/**
 * What is being exported, in words, or `''` while the spaces list is still on its way.
 *
 * Empty is a state the template branches on rather than papering over. Interpolating a blank into
 * "The whole space · · Markdown" is the sort of half-drawn sentence that looks like a bug and is
 * one; a second message with no name in it is the honest version of the same line, and it is on
 * screen for the fraction of a second before the cached list arrives.
 */
const targetName = $derived(job && job.scope === 'space' ? spaceName : (page?.title.trim() ?? spaceName))
</script>

<Dialog bind:open title={t('export_title')} size="md">
  {#if job}
    <!--
      `status`, not `alert`: this region rewrites itself every second and a half while a job runs, and
      an assertive live region would interrupt a screen reader on every one of those. `aria-busy`
      says the same thing about the whole block that a spinner says visually.
    -->
    <!-- `tabindex="-1"` so it can be given focus deliberately when the form is replaced by it; it is
         never in the tab order itself. -->
    <section
      class="job"
      role="status"
      tabindex="-1"
      bind:this={jobRegion}
      aria-busy={isRunning(job.state)}
    >
      <p class="job-state">
        <span class="job-icon" class:spin={isRunning(job.state)} class:bad={job.state === 'failed'}>
          <Icon name={stateIcon(job.state)} size={17} />
        </span>
        {stateLabel(job.state)}
      </p>
      <p class="job-what">
        {targetName
          ? t('export_of', {
              scope: scopeLabel(job.scope),
              name: targetName,
              format: formatLabel(job.format),
            })
          : t('export_of_unnamed', { scope: scopeLabel(job.scope), format: formatLabel(job.format) })}
      </p>

      {#if isRunning(job.state)}
        {#if ratio === null}
          <p class="note">{t('export_counting')}</p>
        {:else}
          <ProgressBar value={ratio * 100} label={t('export_title')} />
          <!--
            The numbers go in as numbers. `t()` puts every interpolated number through
            `Intl.NumberFormat` for the interface locale, so "۳ of ۱۲" on a Persian screen comes for
            free — pre-formatting them into strings here is what leaves Latin digits in the one
            sentence on the page that is nothing but digits.
          -->
          <p class="note">
            {t('export_progress', {
              done: job.counts.done + job.counts.skipped + job.counts.failed,
              total: job.counts.total,
            })}
          </p>
        {/if}
      {/if}

      {#if job.state === 'done'}
        {#if job.counts.done === 0}
          <!--
            An artefact with nothing in it is a success by every counter and a broken file to whoever
            opens it. It happens for one reason — every page in scope was withheld — so it says that
            rather than leaving somebody to work it out from a zip with no folders in it.
          -->
          <p class="warn">{t('export_empty')}</p>
        {:else if job.counts.skipped > 0}
          <p class="warn">{t('export_skipped', { count: job.counts.skipped })}</p>
        {/if}
        <p class="note">{t('export_kept')}</p>
      {/if}

      {#if job.state === 'failed' && job.error}
        <!--
          The reason, in the words of whatever refused — a Gotenberg that is not running, a page that
          would not render. It is diagnostic rather than kind, so it is drawn as what it is: mono,
          selectable, and with the one control that makes it useful to somebody who has to paste it
          into a message to an administrator.
        -->
        <!--
          `dir="auto"`: `error` is whatever refused, in its own words, and that is English on every
          instance whatever the interface language is. Inheriting an RTL paragraph direction lays a
          Latin sentence out right to left and breaks it at its punctuation — a URL in a Gotenberg
          refusal comes apart at the colon. The first strong character decides instead.
        -->
        <div class="fail">
          <p class="fail-text" dir="auto">{job.error}</p>
          <Button size="xs" variant="ghost" icon="copy" onclick={() => void copyError(job.error ?? '')}>
            {t('transfer_copy')}
          </Button>
        </div>
      {/if}

      <p class="when">{t('export_started', { when: relativeTime(job.createdAt) })}</p>
    </section>
  {:else}
    <fieldset class="choices" bind:this={scopeFieldset}>
      <legend>{t('export_scope')}</legend>
      {#each scopes as choice (choice.value)}
        <label class="choice" class:on={scope === choice.value}>
          <input
            type="radio"
            name={`${group}-scope`}
            value={choice.value}
            checked={scope === choice.value}
            onchange={() => (scope = choice.value)}
          />
          <span class="choice-body">
            <span class="choice-title">{choice.label}</span>
            <span class="choice-desc">{choice.description}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <fieldset class="choices">
      <legend>{t('export_format')}</legend>
      {#each EXPORT_FORMATS as option (option)}
        <label class="choice" class:on={format === option}>
          <input
            type="radio"
            name={`${group}-format`}
            value={option}
            checked={format === option}
            onchange={() => (format = option)}
          />
          <span class="choice-body">
            <span class="choice-title">{formatLabel(option)}</span>
            <span class="choice-desc">{formatDescription(option)}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <p class="note">{t('export_no_docx')}</p>
    <!--
      Said before the button, not after the file arrives. "Only the pages you can read" is the one
      thing about an export that people are wrong about, and being wrong about it looks like a
      complete handbook until somebody notices three sections missing.
    -->
    <p class="note">{t('export_only_readable')}</p>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#snippet footer()}
    <div class="foot">
      {#if job}
        <Button variant="ghost" size="sm" onclick={newExport}>{t('export_new')}</Button>
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('transfer_close')}</Button>
        {#if job.state === 'done' && job.counts.done > 0}
          <Button icon="download" onclick={() => void download()}>{t('export_download')}</Button>
        {/if}
      {:else}
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
        <Button icon="download" onclick={() => void start()}>{t('export_start')}</Button>
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
/*
 * A choice is a whole card, so the target is the sentence and not a 13px disc. `align-items: start`
 * keeps the disc against the first line of a description that wraps to three.
 */
.choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 16px;
  padding: 0;
  border: 0;
}
.choices legend {
  padding: 0 0 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.choice {
  display: flex;
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  cursor: pointer;
}
.choice:hover {
  border-color: var(--kern-border-hover);
  background: var(--kern-surface-hover);
}
.choice.on {
  border-color: var(--kern-accent);
  background: var(--kern-accent-tint);
}
/* The whole card is the label, so the ring belongs to the card rather than to the disc inside it. */
.choice:focus-within {
  outline: 2px solid var(--kern-ring);
  outline-offset: 1px;
}
.choice input {
  margin: 2px 0 0;
  accent-color: var(--kern-accent);
  /* the disc is the smallest thing here and still has to be visible against the tinted card */
  width: 15px;
  height: 15px;
  flex: none;
}
.choice-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.choice-title {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.choice-desc {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-600);
  text-wrap: pretty;
}

.job {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.job-state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--kern-ink-900);
}
.job-icon {
  display: inline-flex;
  color: var(--kern-ink-500);
}
.job-icon.bad {
  color: var(--kern-danger);
}
.job-icon.spin {
  animation: quire-spin 900ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .job-icon.spin {
    animation: none;
  }
}
@keyframes quire-spin {
  to {
    transform: rotate(360deg);
  }
}
.job-what {
  margin: -6px 0 0;
  font-size: 13px;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}

.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  /* muted with a colour: `opacity` fades this against the dialog until nobody can read it */
  color: var(--kern-ink-550);
  text-wrap: pretty;
}
.warn {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-warning-tint);
  color: var(--kern-ink-800);
  font-size: 12.5px;
  line-height: 1.55;
  text-wrap: pretty;
}
.when {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-450);
}

.fail {
  display: flex;
  align-items: start;
  gap: 8px;
  padding: 10px 11px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-danger-tint);
}
.fail-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: var(--kern-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--kern-ink-800);
  overflow-wrap: anywhere;
  user-select: text;
}

.error {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--kern-danger);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
}
.spacer {
  flex: 1;
}
</style>
