<script lang="ts">
import {
  Button,
  Dialog,
  formatBytes,
  Icon,
  navigation,
  ProgressBar,
  relativeTime,
  toast,
  uid,
  uploadFile,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { tick, untrack } from 'svelte'
import type { ImportJob, ImportSource } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'
import {
  IMPORT_SOURCES,
  isRunning,
  messageOf,
  sourceDescription,
  sourceLabel,
  stateIcon,
  stateLabel,
} from '../transfers.js'
import ImportReport from './ImportReport.svelte'

/**
 * Bringing a Notion, Confluence or Markdown export into one space.
 *
 * **This is the one thing in Quire that writes hundreds of pages in a single act**, and the whole
 * shape of the dialog follows from that rather than from the upload being fiddly:
 *
 * 1. **The consequence is stated above the button that causes it, and it names the space.** Not in
 *    a tooltip and not after the fact: "adds every page in this archive to *Handbook*", "nothing
 *    already in Handbook is changed", "there is no single way back". The permission is declared
 *    `dangerous` on the server for the same reason, and a dangerous permission whose screen says
 *    nothing is a permission flag doing no work.
 * 2. **The report is the outcome, not the counts.** A real export has files that will not map, so
 *    the job answers with one row per file and the dialog draws them. An import that finished with
 *    forty silent drops looks identical to one that finished cleanly, right up until somebody goes
 *    looking for a page.
 * 3. **An import is a server job**, so this attaches to a running one on open rather than
 *    remembering anything locally — reload mid-import, reopen, and the progress is still here. The
 *    same shape as `ExportDialog`, for the same reason.
 *
 * The upload is the shell's one uploader (`uploadFile` in `@kernhq/ui`): ask core for a ticket, PUT
 * the bytes straight to storage, tell core the file is ready. Skipping the third step leaves the
 * file `pending`, and `imports.start` refuses a file that is not `ready` — which is the check
 * catching a mistake this dialog cannot make, rather than a reason to do the upload by hand.
 */
interface Props {
  open?: boolean
  workspaceId: string
  /** the space being written into. An import always targets exactly one, and it is named on screen. */
  space: { id: string; key: string; name: string }
}
let { open = $bindable(false), workspaceId, space }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()
const workspaceSlug = $derived(navigation.workspaceSlug)

/** Unique per instance: the sidebar's dialog and any other can be mounted at the same time. */
const group = uid('quire-import')

/**
 * Mirrors `MAX_ARCHIVE_BYTES` in `services/import.ts`, and is checked here **as well as** there.
 *
 * Not instead of. The server's copy is the one that matters and the one that cannot be bypassed;
 * this one exists so that a 400 MB archive is refused before somebody watches it upload for six
 * minutes. A limit checked only on the client is a lie; a limit checked only on the server is six
 * wasted minutes and a failure with no obvious cause.
 */
const MAX_BYTES = 256 * 1024 * 1024

// ------------------------------------------------------------------------------------------------
// What is already happening
// ------------------------------------------------------------------------------------------------

const listQuery = createQuery(() => ({
  queryKey: quireKeys.imports(workspaceId),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.imports.list({ workspaceId, limit: 20 }),
}))

let watching = $state<string | null>(null)
let source = $state<ImportSource>('notion')
let file = $state<File | null>(null)
let error = $state<string | null>(null)
/**
 * Two variables rather than one, and the difference is a bug that was written here first.
 *
 * `sending` is whether an upload is happening; `uploaded` is how far along it is, and it is **null
 * whenever the browser is not reporting progress** — a same-origin PUT of a small file often reports
 * nothing at all. Deriving "is it sending" from "do we have a ratio" made the progress region vanish
 * mid-upload on exactly those transfers, which reads as a dialog that gave up.
 */
let sending = $state(false)
let uploaded = $state<number | null>(null)
let dragging = $state(false)

/** Which opening this form belongs to; `attached` records what that opening already looked for. */
let session = $state<string | null>(null)
let attached = false

$effect(() => {
  const key = open ? space.id : null
  if (untrack(() => session) !== key) {
    session = key
    attached = false
    error = null
    watching = null
    file = null
    sending = false
    uploaded = null
    source = 'notion'
  }
  if (key === null || attached) return
  const rows = listQuery.data
  if (!rows) return
  attached = true
  // Newest first from the server, so this is the most recent import into this space — running or
  // finished. Coming back to a report is the other half of "a job outlives the tab".
  const mine = rows.find((row) => row.targetId === space.id)
  if (!mine) return
  watching = mine.id
  source = mine.source
})

/**
 * Polled while running, and invalidated by realtime beside it.
 *
 * The server announces a `change` on the `import` entity as the job moves, and this key sits under
 * that entity's prefix — so on a healthy socket the report appears the moment it is written. The
 * timer is what makes it appear anyway in `dev:mock` or behind a proxy that eats websockets.
 */
const jobQuery = createQuery(() => ({
  queryKey: quireKeys.importJob(workspaceId, watching ?? ''),
  enabled: open && Boolean(workspaceId && watching),
  queryFn: () => api.imports.get({ workspaceId, jobId: watching as string }),
  refetchInterval: (query: { state: { data?: ImportJob } }) =>
    query.state.data && isRunning(query.state.data.state) ? 1500 : false,
}))
const job = $derived((jobQuery.data ?? null) as ImportJob | null)

/**
 * A finished import has put pages into the space, and every tree, list and trash view of it is now
 * wrong. Done once, when the job first reports `done`, rather than on every poll.
 */
let refreshedFor: string | null = null
$effect(() => {
  const finished = job && job.state === 'done' ? job.id : null
  if (!finished || refreshedFor === finished) return
  refreshedFor = finished
  void client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, space.id) })
  void client.invalidateQueries({ queryKey: quireKeys.spaces(workspaceId) })
})

// ------------------------------------------------------------------------------------------------
// Choosing a file
// ------------------------------------------------------------------------------------------------

const looksLikeZip = (chosen: File) =>
  /\.zip$/i.test(chosen.name) ||
  chosen.type === 'application/zip' ||
  chosen.type === 'application/x-zip-compressed'

function choose(chosen: File | null | undefined) {
  if (!chosen) return
  error = null
  if (!looksLikeZip(chosen)) {
    file = null
    error = t('import_wrong_type')
    return
  }
  if (chosen.size > MAX_BYTES) {
    file = null
    error = t('import_too_big', { size: formatBytes(chosen.size), max: formatBytes(MAX_BYTES) })
    return
  }
  file = chosen
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  dragging = false
  choose(event.dataTransfer?.files?.[0])
}

// ------------------------------------------------------------------------------------------------
// Doing it
// ------------------------------------------------------------------------------------------------

/* Set in the same tick as the click. `isPending` reaches the button one render later, so a
   double-click is two uploads and two imports — and an import run twice is every page twice. */
let busy = false

/**
 * Where focus goes when the dialog swaps one half of itself for the other.
 *
 * Both transitions destroy the button that caused them, and the browser hands the focus of a removed
 * element to `<body>` and leaves it there — so a keyboard user who presses **Import** has to tab in
 * from the top of the page to reach the dialog they are standing in. Forward, focus lands on the
 * status region rather than a button, so a repeated Enter cannot press anything; back, it lands on
 * the first source option. Same fix `ExportDialog` and `PublishDialog` carry, for the same reason.
 */
let jobRegion = $state<HTMLElement | null>(null)
let sourceFieldset = $state<HTMLElement | null>(null)

async function start() {
  const chosen = file
  if (busy || !chosen) return
  busy = true
  error = null
  sending = true
  uploaded = null
  try {
    const object = await uploadFile({
      workspaceId,
      file: chosen,
      name: chosen.name,
      mimeType: 'application/zip',
      attachedTo: { module: 'quire', type: 'import', id: space.id },
      // `ratio` is null whenever the browser is not reporting progress, and then no bar is drawn:
      // a bar pinned at 0% for the whole upload is a worse answer than the sentence beside it.
      onProgress: ({ ratio }) => {
        uploaded = ratio
      },
    })
    const created = await api.imports.start({
      workspaceId,
      spaceId: space.id,
      source,
      fileId: object.id,
    })
    /*
     * The row `start` answered with **is** the answer `get` would give, so it is put in the cache
     * rather than waited for. Without this there is a round trip in which the job exists on the
     * server and the dialog is still showing the form with a live **Import** button on it — and an
     * import run twice is every page in the archive written twice. `busy` does not cover it: it is
     * cleared as soon as this function returns.
     */
    watching = created.id
    client.setQueryData(quireKeys.importJob(workspaceId, created.id), created)
    await tick()
    jobRegion?.focus()
    await listQuery.refetch()
  } catch (err) {
    error = messageOf(err)
  } finally {
    sending = false
    uploaded = null
    busy = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('transfer_copied'))
  } catch {
    toast.info(t('share_copy_manually'))
  }
}

/** Back to the form. The archive is not kept — a second import needs a second, deliberate choice. */
async function again() {
  watching = null
  file = null
  error = null
  await tick()
  sourceFieldset?.querySelector('input')?.focus()
}

const fileFieldId = $derived(`${group}-file`)
const spaceHref = $derived(`/${workspaceSlug}/quire/${encodeURIComponent(space.key)}`)
const pageHref = (pageId: string) =>
  `/${workspaceSlug}/quire/${encodeURIComponent(space.key)}/${encodeURIComponent(pageId)}`
</script>

<Dialog bind:open title={t('import_title')} size="lg">
  {#if job}
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
        {t('import_of', { source: sourceLabel(job.source), name: space.name })}
      </p>

      {#if isRunning(job.state)}
        <!--
          No bar. An import reads the whole archive before it writes anything, so there is no total
          to measure against until the moment it is finished — and a bar with nothing behind it is
          worse than a sentence, because a bar is a promise about how long this will take.
        -->
        <p class="note">{t('import_reading')}</p>
      {/if}

      {#if job.state === 'failed'}
        <!--
          Said first and said plainly. An import is written in one transaction, so a failure leaves
          the space exactly as it was — and the thing somebody wants to know before anything else is
          whether they now have half an archive in their handbook.
        -->
        <p class="warn">{t('import_failed_nothing')}</p>
        {#if job.error}
          <!-- `dir="auto"` for the same reason as the report's reasons: the server writes this in
               English, and an English sentence inheriting an RTL direction breaks at its punctuation. -->
          <div class="fail">
            <p class="fail-text" dir="auto">{job.error}</p>
            <Button size="xs" variant="ghost" icon="copy" onclick={() => void copy(job.error ?? '')}>
              {t('transfer_copy')}
            </Button>
          </div>
        {/if}
      {/if}

      {#if job.state === 'done' || job.report.length > 0}
        <ImportReport report={job.report} counts={job.counts} link={pageHref} />
      {/if}

      <p class="when">{t('import_started', { when: relativeTime(job.createdAt) })}</p>
    </section>
  {:else}
    <fieldset class="choices" bind:this={sourceFieldset}>
      <legend>{t('import_source')}</legend>
      {#each IMPORT_SOURCES as option (option)}
        <label class="choice" class:on={source === option}>
          <input
            type="radio"
            name={`${group}-source`}
            value={option}
            checked={source === option}
            onchange={() => (source = option)}
          />
          <span class="choice-body">
            <span class="choice-title">{sourceLabel(option)}</span>
            <span class="choice-desc">{sourceDescription(option)}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <!--
      The input stays in the tree and stays focusable — it is the control, and the label is only its
      visible surface. Hiding it with `display: none` would take the whole thing away from a keyboard
      and leave a label pointing at nothing.
    -->
    <div class="drop" class:on={dragging}>
      <input
        id={fileFieldId}
        class="file"
        type="file"
        accept=".zip,application/zip"
        onchange={(event: Event) => choose((event.currentTarget as HTMLInputElement).files?.[0])}
      />
      <label
        for={fileFieldId}
        ondragover={(event: DragEvent) => {
          event.preventDefault()
          dragging = true
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
      >
        <Icon name="upload" size={20} />
        <span class="drop-title">{file ? file.name : t('import_choose')}</span>
        <span class="drop-hint">
          {file ? formatBytes(file.size) : t('import_file_hint', { max: formatBytes(MAX_BYTES) })}
        </span>
      </label>
    </div>

    <!--
      What is about to happen, above the button that does it, in the words somebody would use
      afterwards — and naming the space every time, because the sidebar's idea of "the space you are
      in" is not necessarily the one somebody opened this from.
    -->
    <section class="tell">
      <Icon name="triangle-alert" size={17} />
      <div class="tell-body">
        <p class="tell-title">{t('import_consequence_title', { name: space.name })}</p>
        <p>{t('import_consequence_adds', { name: space.name })}</p>
        <p>{t('import_consequence_keeps', { name: space.name })}</p>
        <p>{t('import_consequence_undo')}</p>
        <p>{t('import_consequence_report')}</p>
      </div>
    </section>

    {#if sending}
      <div class="upload" role="status">
        <p class="note">{t('import_uploading')}</p>
        {#if uploaded !== null}
          <ProgressBar value={uploaded * 100} label={t('import_uploading')} />
        {/if}
      </div>
    {/if}
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#snippet footer()}
    <div class="foot">
      {#if job}
        <Button variant="ghost" size="sm" onclick={again}>{t('import_another')}</Button>
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('transfer_close')}</Button>
        {#if job.state === 'done' && job.counts.done > 0}
          <Button href={spaceHref} onclick={() => (open = false)}>{t('import_open_space')}</Button>
        {/if}
      {:else}
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
        <!--
          `disabled` only for "there is no file", which is a statement about the form the drop zone
          already makes. The second click is stopped by the flag inside `start()` instead, and there
          is deliberately no `loading` here: `Button`'s loading state *disables* the button, and this
          is the button somebody has their finger and their focus on — disabling it blurs it and the
          browser hands that focus to `<body>`, so the keyboard user who pressed Import loses their
          place on the page. The progress region above says the same thing without moving anything.
        -->
        <Button icon="upload" disabled={!file} onclick={() => void start()}>
          {t('import_start', { name: space.name })}
        </Button>
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
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
.choice:focus-within {
  outline: 2px solid var(--kern-ring);
  outline-offset: 1px;
}
.choice input {
  margin: 2px 0 0;
  accent-color: var(--kern-accent);
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

.drop {
  position: relative;
  margin-block-end: 16px;
}
/*
 * Off screen but still in the accessibility tree and still focusable — `display: none` or
 * `visibility: hidden` would take the only control here away from a keyboard entirely.
 */
.file {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/*
 * `--kern-border-hover`, not `--kern-border-strong`, and the difference is only visible in dark.
 *
 * Measured: in the dark theme `--kern-surface-raised` resolves to the *same* colour as the dialog it
 * sits on, so the dashed line is the only thing that says "a target", and `--kern-border-strong`
 * against that ground is 1.34:1 — a line nobody can see. `--kern-border-hover` is 2.2:1, which is a
 * visible dashed box in both themes. The zone stays identifiable without it either way: its icon and
 * its two lines of text are at 5.45:1 and the input inside it draws a real focus ring.
 */
.drop label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 20px 16px;
  border: 1px dashed var(--kern-border-hover);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface-input);
  color: var(--kern-ink-500);
  cursor: pointer;
  text-align: center;
}
.drop label:hover,
.drop.on label {
  border-color: var(--kern-accent);
  background: var(--kern-accent-tint);
}
/* The input carries the focus and the label is what can be seen, so the ring is drawn out here. */
.drop:focus-within label {
  outline: 2px solid var(--kern-ring);
  outline-offset: 2px;
}
.drop-title {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
  overflow-wrap: anywhere;
}
.drop-hint {
  font-size: 12.5px;
  color: var(--kern-ink-550);
}

.tell {
  display: flex;
  gap: 10px;
  padding: 12px 13px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-warning-tint);
  color: var(--kern-ink-700);
}
.tell-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tell p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  text-wrap: pretty;
}
.tell-title {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--kern-ink-900);
}

.upload {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-block-start: 14px;
}

.job {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  margin: -8px 0 0;
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
