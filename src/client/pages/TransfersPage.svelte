<script lang="ts">
import {
  Button,
  EmptyState,
  Icon,
  navigation,
  Page,
  PageHeader,
  relativeTime,
  Skeleton,
  session,
  toast,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { ExportJob, ImportJob } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import ImportReport from '../components/ImportReport.svelte'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'
import {
  formatLabel,
  isRunning,
  messageOf,
  scopeLabel,
  sourceLabel,
  startDownload,
  stateIcon,
  stateLabel,
} from '../transfers.js'

/**
 * Work this person has taken out of Quire, and archives they have brought in.
 *
 * **This screen exists because a transfer is a server job and a dialog is not.** An export takes
 * minutes and its file is kept for a week; an import's report is the only account of what happened
 * to a thousand files. Both of those outlive the dialog that started them, and without somewhere to
 * come back to they were reachable only by whoever remembered which page they had been standing on.
 *
 * Two things it does *not* do, both deliberate:
 *
 * - **It is not the workspace's transfers, it is yours.** `exports.list` and `imports.list` filter
 *   on `requested_by` on the server: row-level security fences the tenant, and a tenant is not a
 *   person, so one colleague's export of the salary handbook is not in anybody else's list. There is
 *   no procedure that would answer otherwise and there should not be.
 * - **It carries no permission of its own.** The two keys behind it are independent —
 *   `quire.page.export` is a member by default and `quire.page.import` is owner-and-admin — so a
 *   single gate on the route would either hide this from somebody who may import or show it to
 *   somebody who may do neither. Each half asks its own key instead, and asks it before making the
 *   request rather than letting the server answer 403 into an error state. (A gate here would also
 *   be worse than useless: a route the shell refuses falls through to `/quire/:space`, and the
 *   person would be told "Space not found" about a space called *transfers*.)
 */
const api = getQuireApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const canExport = $derived(canQuire('pageExport'))
const canImport = $derived(canQuire('pageImport'))

// ------------------------------------------------------------------------------------------------
// The two lists
// ------------------------------------------------------------------------------------------------

/**
 * Polled only while something is unfinished, and invalidated by realtime the rest of the time.
 *
 * The keys sit under the `export` and `import` entities the server announces on every progress
 * write, so an open tab redraws itself as a job moves without this timer; the timer is what makes
 * that true anyway on a dropped socket or in `dev:mock`. A list where nothing is running polls
 * never, which is the common case and the one worth not paying for.
 */
const exportsQuery = createQuery(() => ({
  queryKey: quireKeys.exports(workspaceId),
  enabled: canExport && Boolean(workspaceId),
  queryFn: () => api.exports.list({ workspaceId, limit: 20 }),
  refetchInterval: (query: { state: { data?: ExportJob[] } }) =>
    (query.state.data ?? []).some((row) => isRunning(row.state)) ? 2000 : false,
}))

const importsQuery = createQuery(() => ({
  queryKey: quireKeys.imports(workspaceId),
  enabled: canImport && Boolean(workspaceId),
  queryFn: () => api.imports.list({ workspaceId, limit: 20 }),
  refetchInterval: (query: { state: { data?: Omit<ImportJob, 'report'>[] } }) =>
    (query.state.data ?? []).some((row) => isRunning(row.state)) ? 2000 : false,
}))

const exportRows = $derived(exportsQuery.data ?? [])
const importRows = $derived(importsQuery.data ?? [])

/**
 * The spaces, for the names on `space`-scoped rows.
 *
 * `includeArchived: false` matches the sidebar's call **exactly**, which is not a detail: the two
 * share `quireKeys.spaces`, and a query differing by one argument under the same key is two queries
 * wearing one name — whichever ran last wins, and the sidebar would start losing or gaining spaces
 * depending on whether this screen had been opened. A row naming a space that is no longer in the
 * list says so rather than drawing an id.
 */
const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const spaceById = $derived(new Map((spacesQuery.data ?? []).map((s) => [s.id, s])))

/**
 * The titles of the pages that were exported, resolved in one query.
 *
 * `ExportJob` carries a `targetId` and no title, and a list of "Section · PDF · 2h ago" with no name
 * on it is unusable the moment somebody has two. So the page-scoped targets are looked up — at most
 * twenty, because that is the list's own limit, and each is the same `pages.get` the page screen
 * already caches. A target that answers nothing (trashed, purged, or no longer readable) resolves to
 * null and the row says so; it is not an error, and it must not take the list down with it.
 *
 * Keyed under the `page` entity so a rename anywhere reaches it, and `staleTime` because a title
 * that changed a minute ago is not worth twenty requests on every redraw.
 */
const pageTargets = $derived(
  Array.from(new Set(exportRows.filter((row) => row.scope !== 'space').map((row) => row.targetId))).sort(),
)

const titlesQuery = createQuery(() => ({
  queryKey: ['quire', 'page', workspaceId, 'transfer-targets', pageTargets.join(',')] as const,
  enabled: Boolean(workspaceId) && pageTargets.length > 0,
  staleTime: 60_000,
  queryFn: async () => {
    const found: Record<string, { title: string; spaceId: string }> = {}
    const answers = await Promise.all(
      pageTargets.map((id) => api.pages.get({ workspaceId, pageId: id }).catch(() => null)),
    )
    pageTargets.forEach((id, at) => {
      const row = answers[at]
      if (row) found[id] = { title: row.title, spaceId: row.spaceId }
    })
    return found
  },
}))

interface Named {
  label: string
  href: string | null
}

function nameOf(row: ExportJob): Named {
  if (row.scope === 'space') {
    const space = spaceById.get(row.targetId)
    return space
      ? { label: space.name, href: `/${workspaceSlug}/quire/${encodeURIComponent(space.key)}` }
      : { label: t('transfer_gone_space'), href: null }
  }
  const found = titlesQuery.data?.[row.targetId]
  if (!found) return { label: titlesQuery.isPending ? '…' : t('transfer_gone_page'), href: null }
  const space = spaceById.get(found.spaceId)
  return {
    label: found.title.trim() || t('untitled'),
    href: space
      ? `/${workspaceSlug}/quire/${encodeURIComponent(space.key)}/${encodeURIComponent(row.targetId)}`
      : null,
  }
}

// ------------------------------------------------------------------------------------------------
// One import's report
// ------------------------------------------------------------------------------------------------

/**
 * Which report is open, seeded from the address.
 *
 * `imports.list` deliberately answers **without** reports — a Notion export is thousands of files, so
 * twenty of them in one response is megabytes to draw a table of dates. The report is fetched for the
 * one row somebody opens, and `?import=<id>` is what lets the import dialog hand somebody a link
 * straight to it rather than "it is in the list somewhere".
 */
let opened = $state<string | null>(navigation.search.import ?? null)

const reportQuery = createQuery(() => ({
  queryKey: quireKeys.importJob(workspaceId, opened ?? ''),
  enabled: Boolean(workspaceId && opened),
  queryFn: () => api.imports.get({ workspaceId, jobId: opened as string }),
}))
const report = $derived((reportQuery.data ?? null) as ImportJob | null)

function toggleReport(id: string) {
  opened = opened === id ? null : id
}

function pageHref(spaceId: string) {
  const space = spaceById.get(spaceId)
  return space
    ? (pageId: string) =>
        `/${workspaceSlug}/quire/${encodeURIComponent(space.key)}/${encodeURIComponent(pageId)}`
    : null
}

// ------------------------------------------------------------------------------------------------
// Fetching an artefact
// ------------------------------------------------------------------------------------------------

let downloadError = $state<string | null>(null)
/* A plain `let`, not `$state`, and never fed to a `disabled`: the row's button is the one somebody's
   focus is on, and disabling a focused control hands that focus to `<body>`. */
let downloading = false

/**
 * The link is asked for at the moment of the download and never before.
 *
 * `exports.list` carries no URL on purpose, and `exports.get` mints one signed for fifteen minutes as
 * it answers. Fetching twenty of them to draw twenty buttons would be twenty signatures nobody used,
 * every one of them expiring while the list sat on screen — and the request is where the permission
 * is checked, which is the whole reason the address is not stored on the row.
 */
async function download(row: ExportJob) {
  if (downloading) return
  downloading = true
  downloadError = null
  try {
    const fresh = await api.exports.get({ workspaceId, jobId: row.id })
    if (!fresh.downloadUrl) {
      downloadError = t('export_no_link')
      return
    }
    const stem = nameOf(row).label.trim() || t('untitled')
    startDownload(fresh.downloadUrl, `${stem}.${fresh.format === 'pdf' ? 'pdf' : 'zip'}`)
  } catch (err) {
    downloadError = messageOf(err)
  } finally {
    downloading = false
  }
}

/**
 * The diagnostic, onto the clipboard.
 *
 * The person who can act on "point GOTENBERG_URL at one that is running" is usually not the person
 * reading it, so the failure has to be *sendable* — and this is the worst place to select it by
 * hand: four wrapped lines of English inside a right-to-left page on a phone. `ExportDialog` and
 * every row of `ImportReport` already offer this; a failure on the list that outlives the dialog is
 * the one somebody is most likely to come back to, and it was the only one without a control.
 */
async function copyFailure(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('transfer_copied'))
  } catch {
    // A denied clipboard is not worth an error: the text is on screen to select.
    toast.info(t('share_copy_manually'))
  }
}
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('title'), href: `/${workspaceSlug}/quire` }, { label: t('transfers') }]}
  title={t('transfers')}
  subtitle={t('transfers_subtitle')}
/>

<Page>
  {#if !canExport && !canImport}
    <EmptyState icon="package" title={t('transfers_none_allowed')} description={t('transfers_none_allowed_desc')} />
  {:else}
    {#if canExport}
      <section class="block">
        <h2>{t('transfers_exports')}</h2>
        {#if exportsQuery.isPending}
          <div class="loading">
            {#each [1, 2, 3] as n (n)}<Skeleton height="56px" />{/each}
          </div>
        {:else if exportsQuery.isError}
          <EmptyState icon="triangle-alert" title={t('transfers_error')} description={t('transfers_error_desc')}>
            {#snippet actions()}
              <Button variant="secondary" size="sm" onclick={() => void exportsQuery.refetch()}>
                {t('retry')}
              </Button>
            {/snippet}
          </EmptyState>
        {:else if exportRows.length === 0}
          <EmptyState icon="download" title={t('transfers_exports_none')} description={t('transfers_exports_none_desc')} />
        {:else}
          <ul class="rows">
            {#each exportRows as row (row.id)}
              {@const named = nameOf(row)}
              <li class="row">
                <span class="mark" class:spin={isRunning(row.state)} class:bad={row.state === 'failed'}>
                  <Icon name={stateIcon(row.state)} size={16} />
                </span>
                <div class="body">
                  <p class="title">
                    {#if named.href}
                      <a href={named.href}>{named.label}</a>
                    {:else}
                      {named.label}
                    {/if}
                  </p>
                  <p class="meta">
                    {t('transfer_export_meta', {
                      scope: scopeLabel(row.scope),
                      format: formatLabel(row.format),
                      state: stateLabel(row.state),
                      when: relativeTime(row.createdAt),
                    })}
                  </p>
                  {#if row.state === 'done' && row.counts.skipped > 0}
                    <p class="meta warn">{t('export_skipped', { count: row.counts.skipped })}</p>
                  {/if}
                  {#if row.state === 'failed' && row.error}
                    <!-- `dir="auto"`: the server's own words, English on every instance, so it must
                         not inherit an RTL paragraph direction and break at its punctuation. -->
                    <div class="fail">
                      <p class="fail-text" dir="auto">{row.error}</p>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="copy"
                        onclick={() => void copyFailure(row.error ?? '')}
                      >
                        {t('transfer_copy')}
                      </Button>
                    </div>
                  {/if}
                </div>
                {#if row.state === 'done' && row.counts.done > 0}
                  <Button size="sm" variant="secondary" icon="download" onclick={() => void download(row)}>
                    {t('export_download')}
                  </Button>
                {/if}
              </li>
            {/each}
          </ul>
          <p class="foot-note">{t('export_kept')}</p>
          {#if downloadError}<p class="error" role="alert">{downloadError}</p>{/if}
        {/if}
      </section>
    {/if}

    {#if canImport}
      <section class="block">
        <h2>{t('transfers_imports')}</h2>
        {#if importsQuery.isPending}
          <div class="loading">
            {#each [1, 2] as n (n)}<Skeleton height="56px" />{/each}
          </div>
        {:else if importsQuery.isError}
          <EmptyState icon="triangle-alert" title={t('transfers_error')} description={t('transfers_error_desc')}>
            {#snippet actions()}
              <Button variant="secondary" size="sm" onclick={() => void importsQuery.refetch()}>
                {t('retry')}
              </Button>
            {/snippet}
          </EmptyState>
        {:else if importRows.length === 0}
          <EmptyState icon="upload" title={t('transfers_imports_none')} description={t('transfers_imports_none_desc')} />
        {:else}
          <ul class="rows">
            {#each importRows as row (row.id)}
              {@const space = spaceById.get(row.targetId)}
              <li class="row block-row">
                <div class="line">
                  <span class="mark" class:spin={isRunning(row.state)} class:bad={row.state === 'failed'}>
                    <Icon name={stateIcon(row.state)} size={16} />
                  </span>
                  <div class="body">
                    <p class="title">{space?.name ?? t('transfer_gone_space')}</p>
                    <p class="meta">
                      {t('transfer_import_meta', {
                        source: sourceLabel(row.source),
                        state: stateLabel(row.state),
                        when: relativeTime(row.createdAt),
                      })}
                    </p>
                    {#if row.state === 'done'}
                      <p class="meta">
                        {t('transfer_import_counts', {
                          imported: row.counts.done,
                          skipped: row.counts.skipped,
                          failed: row.counts.failed,
                        })}
                      </p>
                    {/if}
                    {#if row.state === 'failed'}
                      <div class="fail">
                        <p class="fail-text" dir="auto">{row.error ?? t('import_failed_nothing')}</p>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="copy"
                          onclick={() => void copyFailure(row.error ?? t('import_failed_nothing'))}
                        >
                          {t('transfer_copy')}
                        </Button>
                      </div>
                    {/if}
                  </div>
                  <!--
                    `aria-expanded` on the control rather than a chevron on its own: the report is
                    drawn inside this list item, so what the button does is disclose it, and that is
                    the one fact a screen reader has no other way to learn.
                  -->
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={opened === row.id}
                    onclick={() => toggleReport(row.id)}
                  >
                    {opened === row.id ? t('transfer_hide_report') : t('transfer_report')}
                  </Button>
                </div>

                {#if opened === row.id}
                  <div class="report">
                    {#if reportQuery.isPending}
                      <Skeleton height="96px" />
                    {:else if reportQuery.isError}
                      <p class="error" role="alert">{t('transfers_error_desc')}</p>
                    {:else if report}
                      <ImportReport
                        report={report.report}
                        counts={report.counts}
                        link={pageHref(report.targetId)}
                      />
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</Page>

<style>
.block {
  margin-block-end: 32px;
}
.block h2 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--kern-ink-900);
  letter-spacing: -0.01em;
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.row:last-child {
  border-block-end: 0;
}
.block-row {
  display: block;
}
.line {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mark {
  display: inline-flex;
  flex: none;
  color: var(--kern-ink-500);
}
.mark.bad {
  color: var(--kern-danger);
}
.mark.spin {
  animation: quire-spin 900ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .mark.spin {
    animation: none;
  }
}
@keyframes quire-spin {
  to {
    transform: rotate(360deg);
  }
}
.body {
  flex: 1;
  min-width: 0;
}
.title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
  overflow-wrap: anywhere;
}
.title a {
  color: inherit;
  text-decoration: none;
}
.title a:hover {
  text-decoration: underline;
}
.meta {
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  /* muted with a colour: `opacity` here fades the row's text against the page until it is unreadable */
  color: var(--kern-ink-550);
  text-wrap: pretty;
}
.meta.warn {
  color: var(--kern-ink-700);
}
/*
 * A failure, drawn as the diagnostic it is: mono, selectable, and beside the control that sends it
 * somewhere. The same block as `ExportDialog`'s, because it is the same sentence — a person who saw
 * it in the dialog and comes back to the list a day later should not find a different thing.
 */
.fail {
  display: flex;
  align-items: start;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 10px;
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
.report {
  padding-block: 14px 4px;
  /* logical, so the report indents from the right in Persian exactly as it does from the left */
  padding-inline-start: 28px;
}
.foot-note {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--kern-ink-550);
}
.error {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
