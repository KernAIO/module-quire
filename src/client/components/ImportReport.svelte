<script lang="ts">
import { Button, formatCount, Icon, toast } from '@kernhq/ui'
import type { ImportOutcome, ImportReportEntry, TransferCounts } from '../../contract/index.js'
import { t } from '../i18n.js'

/**
 * What happened to every file in an archive.
 *
 * **The report is the screen.** An import that silently drops forty pages is worse than one that
 * refuses, so the server writes one row per file — imported, skipped, or failed and why — and this
 * is the thing that makes those rows worth writing. Three decisions in it are worth knowing:
 *
 * 1. **`skipped` and `failed` are drawn differently and are never added together.** A picture Quire
 *    deliberately cannot carry is skipped; a `.md` that should have become a page and did not is
 *    failed. Collapsing them into "not imported" turns a broken import into a tidy-looking one,
 *    which is the exact failure mode the report exists to prevent.
 * 2. **A failure is copyable, one row at a time and all at once.** The person who can act on
 *    "its checksum does not match" is usually not the person reading it, and re-typing forty paths
 *    into a message is how a report gets ignored.
 * 3. **The list is filtered, not truncated.** A real Notion export is thousands of files, and the
 *    question is almost always "what did not come in" — so the filter is the first control, and the
 *    counts above it are buttons rather than decoration. Rendering is capped for the browser's sake
 *    and says so; the cap never hides a row from *Copy every failure*, which reads the whole report.
 */
interface Props {
  report: readonly ImportReportEntry[]
  counts: TransferCounts
  /** where an imported page can be opened, when the caller knows — omit and the rows are read-only */
  link?: ((pageId: string) => string) | null
}
const { report, counts, link = null }: Props = $props()

type Filter = ImportOutcome | 'all'
let filter = $state<Filter>('all')

/** Rendered at once. A thousand list items is a browser hanging, and nobody scrolls a thousand. */
const PAGE = 300
let shown = $state(PAGE)

/** Back to the top of the list whenever the question changes — a cap carried over reads as a bug. */
function choose(next: Filter) {
  filter = next
  shown = PAGE
}

const rows = $derived(filter === 'all' ? report : report.filter((row) => row.outcome === filter))
const visible = $derived(rows.slice(0, shown))
const failures = $derived(report.filter((row) => row.outcome === 'failed'))

const outcomeLabel = (outcome: ImportOutcome) =>
  outcome === 'imported'
    ? t('import_outcome_imported')
    : outcome === 'skipped'
      ? t('import_outcome_skipped')
      : t('import_outcome_failed')

const outcomeIcon = (outcome: ImportOutcome) =>
  outcome === 'imported' ? 'check' : outcome === 'skipped' ? 'minus' : 'triangle-alert'

/** One row as a line somebody can paste into a message: the path, the outcome, and the reason. */
const asText = (row: ImportReportEntry) =>
  [row.path, outcomeLabel(row.outcome), row.reason ?? ''].filter(Boolean).join(' — ')

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('transfer_copied'))
  } catch {
    // A denied clipboard is not worth an error toast: the text is on screen to select.
    toast.info(t('share_copy_manually'))
  }
}

const tabs = $derived<{ value: Filter; label: string; count: number; tone: string }[]>([
  { value: 'all', label: t('import_outcome_all'), count: counts.total, tone: 'all' },
  { value: 'imported', label: t('import_outcome_imported'), count: counts.done, tone: 'ok' },
  { value: 'skipped', label: t('import_outcome_skipped'), count: counts.skipped, tone: 'skip' },
  { value: 'failed', label: t('import_outcome_failed'), count: counts.failed, tone: 'bad' },
])
</script>

<div class="report">
  <!--
    The counts are the filter. Two controls saying the same four numbers is one of them going stale,
    and "3 failed" is a thing people reach for with a pointer the moment they read it.
    `aria-pressed` rather than a radio group: these are toggles over a list that is already on
    screen, not a choice that has to be submitted.
  -->
  <div class="tabs">
    {#each tabs as tab (tab.value)}
      <button
        type="button"
        class="tab {tab.tone}"
        class:on={filter === tab.value}
        aria-pressed={filter === tab.value}
        onclick={() => choose(tab.value)}
      >
        <!--
          Through `formatCount`, not interpolated. Every other number on this screen reaches the page
          through `t()`, which puts it through `Intl.NumberFormat` — these four were the only ones
          written straight into the template, and on a Persian screen they were the only Latin digits
          on it, sitting in the largest type. The cap is raised because a Notion export really is
          thousands of files and "99+" is not an answer here.
        -->
        <span class="tab-n">{formatCount(tab.count, 999_999)}</span>
        <span class="tab-l">{tab.label}</span>
      </button>
    {/each}
  </div>

  {#if failures.length > 0}
    <div class="bulk">
      <Button
        size="xs"
        variant="secondary"
        icon="copy"
        onclick={() => void copy(failures.map(asText).join('\n'))}
      >
        {t('import_copy_failures', { count: failures.length })}
      </Button>
    </div>
  {/if}

  {#if rows.length === 0}
    <p class="none">{t('import_report_none')}</p>
  {:else}
    <ul class="rows">
      {#each visible as row, index (`${row.path}:${index}`)}
        <li class="row {row.outcome}">
          <span class="mark" aria-hidden="true"><Icon name={outcomeIcon(row.outcome)} size={13} /></span>
          <div class="body">
            <!--
              A path is a filename with slashes in it, and it is Latin whichever way the page runs.
              Without its own direction the bidi algorithm lays it out against the paragraph's and a
              Persian report comes apart at every slash.
            -->
            <p class="path">{row.path}</p>
            <!--
              `dir="auto"` because a reason is **not a translated string**. `ImportReportEntry.reason`
              is free text the server writes — a checksum that does not match, the column types a CSV
              was read as — and it is English whatever the interface language is. Left to inherit, an
              English sentence inside an RTL paragraph is laid out right to left and comes apart at
              its punctuation: measured in Persian, `…came from “Tasks 71cc9e10.csv”` rendered with
              both quotation marks on the same side of the filename. `dir="auto"` takes the direction
              from the first strong character, so it is right for this sentence today and stays right
              on the day these reasons are translated.
            -->
            {#if row.reason}<p class="reason" dir="auto">{row.reason}</p>{/if}
          </div>
          <!--
            The outcome as a word, not only as the icon's colour. Green and amber are the same
            greyish smudge to a good number of readers, and to every screen reader.
          -->
          <span class="outcome">{outcomeLabel(row.outcome)}</span>
          {#if row.outcome === 'imported' && row.pageId && link}
            <Button size="xs" variant="ghost" href={link(row.pageId)}>{t('import_open_page')}</Button>
          {:else}
            <Button size="xs" variant="ghost" icon="copy" onclick={() => void copy(asText(row))}>
              {t('transfer_copy')}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>

    {#if rows.length > visible.length}
      <div class="more">
        <p class="none">{t('import_report_capped', { shown: visible.length, total: rows.length })}</p>
        <Button size="sm" variant="secondary" onclick={() => (shown += PAGE)}>
          {t('import_report_more')}
        </Button>
      </div>
    {/if}
  {/if}
</div>

<style>
.report {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tab {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 44px tall and 84px wide: a count is the smallest label on this screen and the easiest to miss */
  min-width: 84px;
  min-height: 46px;
  padding: 6px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface);
  color: var(--kern-ink-700);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.tab:hover {
  border-color: var(--kern-border-hover);
  background: var(--kern-surface-hover);
}
.tab.on {
  border-color: var(--kern-accent);
  background: var(--kern-accent-tint);
}
.tab-n {
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--kern-ink-900);
}
.tab.ok .tab-n {
  color: var(--kern-success-ink);
}
.tab.bad .tab-n {
  color: var(--kern-danger);
}
.tab-l {
  font-size: 12px;
  color: var(--kern-ink-600);
}

.bulk {
  display: flex;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: start;
  gap: 10px;
  padding-block: 8px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.row:last-child {
  border-block-end: 0;
}
.mark {
  display: inline-flex;
  margin-block-start: 1px;
  color: var(--kern-ink-450);
}
.row.imported .mark {
  color: var(--kern-success-ink);
}
.row.failed .mark {
  color: var(--kern-danger);
}
.body {
  flex: 1;
  min-width: 0;
}
.path {
  margin: 0;
  font-family: var(--kern-font-mono);
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-800);
  /* a path reads left to right in every language; isolated so it cannot reorder a Persian row */
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
  overflow-wrap: anywhere;
}
.reason {
  margin: 3px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-650);
  text-wrap: pretty;
}
.row.failed .reason {
  color: var(--kern-danger);
}
.outcome {
  flex: none;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-550);
}

.none {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-550);
  text-wrap: pretty;
}
.more {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-block-start: 4px;
}
</style>
