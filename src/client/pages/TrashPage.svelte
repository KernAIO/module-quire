<script lang="ts">
import {
  Avatar,
  Button,
  coreApi,
  EmptyState,
  formatCount,
  formatDateTime,
  Icon,
  IconButton,
  keys,
  navigation,
  Page,
  PageHeader,
  relativeTime,
  Skeleton,
  session,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  toast,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Page as QuirePage } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import ConfirmDialog from '../components/ConfirmDialog.svelte'
import { type CoreApi, toPerson } from '../core-api.js'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'

/**
 * The way back.
 *
 * "Move to trash" took a page and every page under it, with no confirmation and nowhere to look
 * afterwards — deleting "Working here" silently took "Your first week" and "Time off" with it, and
 * the only trace was that they had stopped being in the sidebar. `pages.trash` has always listed
 * what was taken; nothing drew it. This is that screen.
 *
 * **Rows are subtrees, not pages.** The listing is flat — trashing a parent marks each descendant —
 * so drawing it row-for-row would show three entries for one act and offer to restore each of them
 * separately, which is exactly the confusion that made the loss invisible in the first place. A row
 * is a page whose parent is *not* also in the trash, and it says how many pages went with it. That
 * matches what restore and purge actually do: both act on the subtree.
 *
 * **When and by whom** is as honest as the data allows. `deleted_at` is a column; there is no
 * `deleted_by`, so the person shown is the page's last editor and the column says so rather than
 * implying they were the one who deleted it.
 */
interface Props {
  params?: Record<string, string>
  spaceKey?: string
}
const { params, spaceKey: spaceKeyProp }: Props = $props()
const spaceKey = $derived(spaceKeyProp ?? params?.space ?? '')

const api = getQuireApi()
const core = coreApi<CoreApi>()
const client = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const spacesQuery = createQuery(() => ({
  queryKey: quireKeys.spaces(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.spaces.list({ workspaceId, includeArchived: false }),
}))
const space = $derived((spacesQuery.data ?? []).find((s) => s.key === spaceKey) ?? null)

/**
 * How many pages of the listing to walk.
 *
 * The trash is cursor-paginated and a subtree can straddle a page boundary, so grouping has to be
 * done over the whole listing rather than over one batch — a batch that happens to hold a child
 * and not its parent would draw the child as a subtree of its own. So the query walks the cursor
 * itself. The cap is in the query key: when it is reached, **Show more** raises it and the query
 * re-runs, rather than the screen quietly pretending there was nothing else.
 */
const BATCH = 200
let rounds = $state(3)

const query = createQuery(() => ({
  queryKey: [...quireKeys.trash(workspaceId, space?.id ?? ''), rounds],
  enabled: Boolean(workspaceId && space),
  queryFn: async () => {
    const items: QuirePage[] = []
    let cursor: string | undefined
    let capped = false
    for (let round = 0; round < rounds; round++) {
      const batch = await api.pages.trash({
        workspaceId,
        spaceId: space?.id ?? '',
        limit: BATCH,
        ...(cursor ? { cursor } : {}),
      })
      items.push(...batch.items)
      cursor = batch.nextCursor ?? undefined
      if (!cursor) break
      capped = round === rounds - 1
    }
    return { items, capped }
  },
}))

const members = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId, limit: 200 }),
}))
const people = $derived(new Map((members.data?.items ?? []).map(toPerson).map((p) => [p.id, p])))

const items = $derived(query.data?.items ?? [])

/** Every page in the trash, so "is my parent here too" is a lookup rather than a scan. */
const trashed = $derived(new Set(items.map((p) => p.id)))

interface Group {
  page: QuirePage
  /** how many pages go with it, itself included — the number restore and purge both act on */
  size: number
}

const groups = $derived.by((): Group[] => {
  const children = new Map<string, QuirePage[]>()
  for (const p of items) {
    if (!p.parentId) continue
    children.set(p.parentId, [...(children.get(p.parentId) ?? []), p])
  }
  const sizeOf = (page: QuirePage): number => {
    let total = 1
    let guard = 0
    const stack = [page.id]
    while (stack.length > 0 && guard++ < 5000) {
      const id = stack.pop() as string
      for (const child of children.get(id) ?? []) {
        total++
        stack.push(child.id)
      }
    }
    return total
  }
  return items
    .filter((p) => !p.parentId || !trashed.has(p.parentId))
    .sort((a, b) => ((a.deletedAt ?? '') < (b.deletedAt ?? '') ? 1 : -1))
    .map((page) => ({ page, size: sizeOf(page) }))
})

const titleOf = (page: QuirePage) => page.title.trim() || t('untitled')

const iconFor = (page: QuirePage) =>
  page.kind === 'live' ? 'square-pen' : page.kind === 'database' ? 'database' : 'file-text'

let busy = $state(false)
let purging = $state<Group | null>(null)
const purgeOpen = $derived(purging !== null)

/**
 * The favourites and recents lists move with the page.
 *
 * Both are composed by joining to `pages`, so restoring a page puts it back into them and purging
 * one takes it out — and neither would notice on its own: they live under their own query prefix,
 * and a page change invalidates the `page` one.
 */
const refresh = async () => {
  await client.invalidateQueries({ queryKey: quireKeys.trash(workspaceId, space?.id ?? '') })
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, space?.id ?? '') })
  await client.invalidateQueries({ queryKey: quireKeys.favorites(workspaceId) })
  await client.invalidateQueries({ queryKey: quireKeys.recents(workspaceId) })
}

async function restore(group: Group) {
  if (busy) return
  busy = true
  try {
    await api.pages.restore({ workspaceId, pageId: group.page.id })
    await refresh()
    toast.success(t('trash_restore_done', { title: titleOf(group.page) }))
  } finally {
    busy = false
  }
}

async function purge(group: Group) {
  const answer = await api.pages.purge({ workspaceId, pageId: group.page.id })
  purging = null
  await refresh()
  toast.success(t('trash_purge_done', { count: answer.count }))
}
</script>

<PageHeader
  crumbs={[
    { label: workspace?.name ?? '' },
    { label: t('title'), href: `/${workspaceSlug}/quire` },
    ...(space
      ? [{ label: space.name, href: `/${workspaceSlug}/quire/${encodeURIComponent(space.key)}` }]
      : []),
    { label: t('trash') },
  ]}
  title={t('trash')}
  subtitle={t('trash_subtitle')}
/>

<Page>
  {#if spacesQuery.isLoading || (query.isLoading && Boolean(space))}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
    </div>
  {:else if !space}
    <EmptyState icon="scroll-text" title={t('space_missing')} description={t('space_missing_desc')} />
  {:else if query.isError}
    <EmptyState icon="triangle-alert" title={t('trash_error')} description={t('page_error_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void query.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if groups.length === 0}
    <EmptyState icon="trash-2" title={t('trash_empty')} description={t('trash_empty_desc')} />
  {:else}
    <!--
      The two text columns have a floor, and that is what makes the scroll box below do anything.

      `minmax(0, …)` lets a column shrink to *nothing* rather than overflow, so at 390px the page
      column collapsed to zero and the row drew the icon and "with 1 page inside it" and none of
      the page's actual name — while the scroll box reported nothing to scroll, because nothing had
      overflowed. Measured at 390px in en, fa and ar alike: the name was 0 wide in all three.
      A minimum turns it back into an overflow, which is a thing a finger can move.

      260px rather than something rounder, because the page cell holds three things: the icon, the
      title, and "with 1 page inside it" — which is `flex: none` and around 106px, so a floor that
      only clears the fixed pair leaves the title 33px again.
    -->
    <Table
      columns="minmax(260px, 2fr) 110px minmax(90px, 1fr) 92px"
      ariaLabel={t('trash')}
      class="trash-table"
    >
      <TableHeader>
        <TableCell header>{t('trash_col_page')}</TableCell>
        <TableCell header>{t('trash_col_deleted')}</TableCell>
        <TableCell header>{t('trash_col_editor')}</TableCell>
        <TableCell header end>{formatCount(groups.length)}</TableCell>
      </TableHeader>

      {#each groups as group (group.page.id)}
        {@const person = group.page.updatedBy ? people.get(group.page.updatedBy) : undefined}
        <TableRow>
          <TableCell>
            <span class="ic"><Icon name={iconFor(group.page)} size={15} strokeWidth={1.6} /></span>
            <span class="name">{titleOf(group.page)}</span>
            {#if group.size > 1}
              <span class="inside">{t('trash_inside', { count: group.size - 1 })}</span>
            {/if}
          </TableCell>

          <TableCell>
            <!--
              A relative time with the exact one on hover: "3d" is what this column is read for, and
              the full date is what somebody deciding whether to purge actually needs.

              Through `formatDateTime`, not the raw column. `deletedAt` is an ISO 8601 UTC string,
              so the tooltip read `2026-08-25T19:45:47.634Z` in every language — Latin digits and a
              machine's calendar hanging off a cell that had just said پریروز. It is the same defect
              the date column had, one layer up: the one untranslated thing on the page.
            -->
            <span class="when" title={group.page.deletedAt ? formatDateTime(group.page.deletedAt) : ''}>
              {group.page.deletedAt ? relativeTime(group.page.deletedAt) : ''}
            </span>
          </TableCell>

          <TableCell>
            {#if person}
              <Avatar id={person.id} name={person.name} src={person.avatarUrl ?? undefined} size={20} />
              <span class="who">{person.name}</span>
            {:else}
              <span class="who">{t('comment_someone')}</span>
            {/if}
          </TableCell>

          <TableCell end>
            <IconButton
              icon="rotate-ccw"
              size={26}
              variant="ghost"
              label={t('restore')}
              aria-busy={busy}
              onclick={() => void restore(group)}
            />
            {#if canQuire('pageDelete')}
              <IconButton
                icon="trash-2"
                size={26}
                variant="ghost"
                label={t('trash_purge_title', { title: titleOf(group.page) })}
                onclick={() => (purging = group)}
              />
            {/if}
          </TableCell>
        </TableRow>
      {/each}
    </Table>

    {#if query.data?.capped}
      <div class="more">
        <Button variant="secondary" size="sm" onclick={() => (rounds += 3)}>{t('trash_more')}</Button>
      </div>
    {/if}
  {/if}
</Page>

<ConfirmDialog
  open={purgeOpen}
  title={t('trash_purge_title', { title: purging ? titleOf(purging.page) : '' })}
  body={t('trash_purge_body', { count: purging?.size ?? 1 })}
  confirmLabel={t('trash_purge')}
  danger
  onCancel={() => (purging = null)}
  onConfirm={async () => {
    if (purging) await purge(purging)
  }}
/>

<style>
.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ic {
  display: inline-flex;
  color: var(--kern-ink-400);
  flex: none;
}
.name {
  color: var(--kern-ink-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * "with 2 pages inside it" is the whole point of the row, so it is a colour rather than a fade —
 * `opacity` here would put the one fact a person came to read below the contrast floor.
 */
.inside {
  flex: none;
  font-size: 12px;
  color: var(--kern-ink-450);
  white-space: nowrap;
}
.when {
  font-family: var(--kern-font-mono);
  font-size: 12px;
  color: var(--kern-ink-500);
  letter-spacing: -0.01em;
}
.who {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kern-ink-600);
}
.more {
  display: flex;
  justify-content: center;
  padding-block-start: 14px;
}
/*
 * The table is the only thing on this screen wide enough to overflow a narrow window, so it
 * scrolls inside itself rather than taking the page sideways with it — which is how a Persian
 * layout ends up with a horizontal scrollbar under everything.
 */
:global(.trash-table) {
  overflow-x: auto;
}
</style>
