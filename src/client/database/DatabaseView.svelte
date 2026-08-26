<script lang="ts">
import {
  Button,
  coreApi,
  Dialog,
  DropdownMenu,
  EmptyState,
  Icon,
  IconButton,
  keys,
  type MenuItem,
  navigation,
  Skeleton,
  Tabs,
  Toolbar,
  ToolbarButton,
  toast,
} from '@kernhq/ui'
import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type {
  Property,
  PropertyConfig,
  PropertyType,
  Row,
  View,
  ViewConfig,
  ViewKind,
} from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { type CoreApi, toPerson } from '../core-api.js'
import { t } from '../i18n.js'
import { canQuire } from '../permissions.js'
import { quireKeys } from '../query.js'
import BoardView from './BoardView.svelte'
import CalendarView from './CalendarView.svelte'
import FilterMenu from './FilterMenu.svelte'
import GalleryView from './GalleryView.svelte'
import ListView from './ListView.svelte'
import PropertyDialog from './PropertyDialog.svelte'
import { descriptorFor, viewIcon } from './property-types.js'
import RowPanel from './RowPanel.svelte'
import SortMenu from './SortMenu.svelte'
import TableView from './TableView.svelte'
import ViewDialog from './ViewDialog.svelte'
import { EMPTY_GROUP, groupValue, mergeConfig, orderedProperties } from './view-config.js'

/**
 * A database page: the view tabs, the 52px toolbar, and whichever view is chosen.
 *
 * Everything that writes lives here rather than in the views, so there is one place that knows a
 * `ViewConfig` is replaced wholesale and one place that reports a failure. The views take data and
 * callbacks and hold no queries of their own.
 *
 * The table pages lazily; the other four ask for one large page, because a board cannot show a
 * "load more" button at the bottom of a lane without lying about what the lane contains. That cap
 * is stated on screen rather than left as a silently short list.
 */
interface Props {
  workspaceId: string
  spaceKey: string
  pageId: string
  spaceId: string
}
const { workspaceId, spaceKey, pageId, spaceId }: Props = $props()

const api = getQuireApi()
const core = coreApi<CoreApi>()
const client = useQueryClient()

const PAGE_SIZE = 50
/** What a non-paging view will show before it says it has stopped. */
const CAP = 500

const canEdit = $derived(canQuire('pageEdit'))
const canCreate = $derived(canQuire('pageCreate'))

// ---- data ---------------------------------------------------------------------------------

const forPage = createQuery(() => ({
  queryKey: quireKeys.databaseForPage(workspaceId, pageId),
  enabled: Boolean(workspaceId && pageId),
  queryFn: () => api.databases.forPage({ workspaceId, pageId }),
}))

const databaseId = $derived(forPage.data?.id ?? '')

const databaseQuery = createQuery(() => ({
  queryKey: quireKeys.database(workspaceId, databaseId),
  enabled: Boolean(workspaceId && databaseId),
  queryFn: () => api.databases.get({ workspaceId, databaseId }),
}))

const database = $derived(databaseQuery.data ?? forPage.data ?? null)
const views = $derived(database?.views ?? [])

let chosenViewId = $state<string | null>(null)
const view = $derived<View | null>(
  views.find((v) => v.id === chosenViewId) ?? views.find((v) => v.isDefault) ?? views[0] ?? null,
)

/** `nextCursor` is an offset the server minted; the client never builds one. */
type RowPage = { items: Row[]; nextCursor: string | null }

const rowsQuery = createInfiniteQuery(() => ({
  queryKey: quireKeys.rows(workspaceId, databaseId, view?.id ?? null),
  enabled: Boolean(workspaceId && databaseId && view),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam }: { pageParam: string | null }): Promise<RowPage> =>
    api.databases.rows({
      workspaceId,
      databaseId,
      viewId: view?.id ?? null,
      limit: PAGE_SIZE,
      cursor: pageParam ?? undefined,
    }),
  getNextPageParam: (last: RowPage) => last.nextCursor,
}))

const rows = $derived<Row[]>(((rowsQuery.data?.pages ?? []) as RowPage[]).flatMap((p) => p.items))

const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId, limit: 200 }),
}))
const people = $derived((membersQuery.data?.items ?? []).map(toPerson))

/**
 * A board, gallery, list or calendar wants the whole set at once, so it keeps asking until it has
 * it — up to the cap, which is then said out loud.
 */
const paging = $derived(view?.kind === 'table')
$effect(() => {
  if (paging || !rowsQuery.hasNextPage || rowsQuery.isFetchingNextPage) return
  if (rows.length >= CAP) return
  void rowsQuery.fetchNextPage()
})
const capped = $derived(!paging && rows.length >= CAP && Boolean(rowsQuery.hasNextPage))

// ---- state --------------------------------------------------------------------------------

let busy = $state(false)
let filterOpen = $state(false)
let sortOpen = $state(false)
let propertyDialog = $state<{ property: Property | null } | null>(null)
let viewDialog = $state<{ view: View | null } | null>(null)
let confirming = $state<
  { kind: 'property'; property: Property } | { kind: 'view'; view: View } | { kind: 'row'; row: Row } | null
>(null)
let inspecting = $state<string | null>(null)

const inspected = $derived(inspecting ? (rows.find((r) => r.id === inspecting) ?? null) : null)
$effect(() => {
  // The row was deleted, or a filter now excludes it; the panel must not linger over nothing.
  if (inspecting && rows.length > 0 && !rows.some((r) => r.id === inspecting)) inspecting = null
})

const properties = $derived(database ? orderedProperties(database) : [])
const relations = $derived(properties.filter((p) => p.type === 'relation'))
const groupProperty = $derived(
  view?.config.groupBy ? (properties.find((p) => p.key === view.config.groupBy) ?? null) : null,
)

// ---- writing ------------------------------------------------------------------------------

const refreshSchema = async () => {
  await client.invalidateQueries({ queryKey: quireKeys.databaseForPage(workspaceId, pageId) })
  await client.invalidateQueries({ queryKey: quireKeys.database(workspaceId, databaseId) })
}
const refreshRows = () => client.invalidateQueries({ queryKey: ['quire', 'row', workspaceId, databaseId] })

/**
 * One place that reports a failure, and one flag that stops a second click.
 *
 * `disabled={busy}` alone does not: the attribute reaches the button on the next render and two
 * quick clicks are one render apart, so the guard is read here in the same tick as the click.
 */
async function act(work: () => Promise<unknown>, after: () => Promise<unknown>) {
  if (busy) return
  busy = true
  try {
    await work()
    await after()
  } catch (err) {
    toast.error(err instanceof Error && err.message ? err.message : t('common.error'))
  } finally {
    busy = false
  }
}

const patchView = (patch: Partial<ViewConfig>) => {
  if (!view) return
  // `updateView` replaces `config` wholesale, so a partial write deletes the rest of the view.
  const config = mergeConfig(view.config, patch)
  void act(() => api.databases.updateView({ workspaceId, viewId: view.id, config }), refreshSchema)
}

const writeCell = (row: Row, property: Property, value: unknown) =>
  act(
    () => api.databases.updateRow({ workspaceId, rowId: row.id, props: { [property.key]: value } }),
    refreshRows,
  )

const writeTitle = (row: Row, title: string) => {
  if (title === row.title) return Promise.resolve()
  return act(
    () => api.databases.updateRow({ workspaceId, rowId: row.id, title }),
    async () => {
      await refreshRows()
      await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
    },
  )
}

const addRow = (seed: Record<string, unknown> = {}) =>
  act(
    () => api.databases.addRow({ workspaceId, databaseId, title: '', props: seed }),
    async () => {
      await refreshRows()
      await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
    },
  )

const duplicateRow = (row: Row) =>
  act(
    () =>
      api.databases.addRow({
        workspaceId,
        databaseId,
        title: row.title,
        props: $state.snapshot(row.props),
      }),
    refreshRows,
  )

const openPage = (row: Row) =>
  navigation.go(
    `/${navigation.workspaceSlug}/quire/${encodeURIComponent(spaceKey)}/${encodeURIComponent(row.id)}`,
  )

const moveOnBoard = (row: Row, laneId: string) => {
  if (!groupProperty) return Promise.resolve()
  const value = groupValue(laneId)
  return act(
    () =>
      api.databases.updateRow({
        workspaceId,
        rowId: row.id,
        props: {
          [groupProperty.key]: groupProperty.type === 'checkbox' ? value === 'true' : value,
        },
      }),
    refreshRows,
  )
}

const setDate = (row: Row, iso: string | null) => {
  const key = view?.config.dateProperty
  if (!key) return Promise.resolve()
  return act(
    () => api.databases.updateRow({ workspaceId, rowId: row.id, props: { [key]: iso } }),
    refreshRows,
  )
}

const submitProperty = (input: { name: string; type: PropertyType; config: PropertyConfig }) => {
  const editing = propertyDialog?.property ?? null
  return act(
    () =>
      editing
        ? api.databases.updateProperty({ workspaceId, propertyId: editing.id, ...input })
        : api.databases.addProperty({ workspaceId, databaseId, ...input }),
    async () => {
      propertyDialog = null
      await refreshSchema()
      await refreshRows()
    },
  )
}

const moveProperty = (property: Property, direction: -1 | 1) => {
  const order = properties.filter((p) => !p.hidden)
  const at = order.findIndex((p) => p.id === property.id)
  const to = at + direction
  if (at < 0 || to < 0 || to >= order.length) return Promise.resolve()
  // Landing "before" the previous column means following the one before *that*, or nothing.
  const afterId = direction === 1 ? (order[to]?.id ?? null) : (order[to - 1]?.id ?? null)
  return act(
    () => api.databases.moveProperty({ workspaceId, propertyId: property.id, afterId }),
    refreshSchema,
  )
}

const hideProperty = (property: Property) =>
  act(
    () => api.databases.updateProperty({ workspaceId, propertyId: property.id, hidden: !property.hidden }),
    refreshSchema,
  )

const sortBy = (property: Property, direction: 'asc' | 'desc' | null) => {
  if (!view) return
  const rest = view.config.sorts.filter((s) => s.propertyKey !== property.key)
  patchView({ sorts: direction ? [{ propertyKey: property.key, direction }, ...rest] : rest })
}

const sortDirectionOf = (key: string) =>
  view?.config.sorts.find((s) => s.propertyKey === key)?.direction ?? null

function filterBy(property: Property) {
  if (!view) return
  const already = view.config.filters.some((f) => f.propertyKey === property.key)
  if (!already) {
    const operator = descriptorFor(property.type).operators[0] ?? 'equals'
    patchView({ filters: [...view.config.filters, { propertyKey: property.key, operator, value: null }] })
  }
  filterOpen = true
}

const submitView = (input: { name: string; kind: ViewKind; config: ViewConfig }) => {
  const editing = viewDialog?.view ?? null
  return act(
    async () => {
      if (editing) return api.databases.updateView({ workspaceId, viewId: editing.id, ...input })
      const created = await api.databases.addView({ workspaceId, databaseId, ...input })
      chosenViewId = created.id
      return created
    },
    async () => {
      viewDialog = null
      await refreshSchema()
    },
  )
}

function confirmed() {
  const target = confirming
  if (!target) return
  if (target.kind === 'property')
    void act(
      () => api.databases.removeProperty({ workspaceId, propertyId: target.property.id }),
      async () => {
        confirming = null
        await refreshSchema()
        await refreshRows()
      },
    )
  else if (target.kind === 'view')
    void act(
      () => api.databases.removeView({ workspaceId, viewId: target.view.id }),
      async () => {
        confirming = null
        if (chosenViewId === target.view.id) chosenViewId = null
        await refreshSchema()
      },
    )
  else
    void act(
      () => api.pages.trashPage({ workspaceId, pageId: target.row.id }),
      async () => {
        confirming = null
        if (inspecting === target.row.id) inspecting = null
        await refreshRows()
        await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
      },
    )
}

const confirmTitle = $derived(
  confirming?.kind === 'property'
    ? t('db_delete_property_confirm', { name: confirming.property.name })
    : confirming?.kind === 'view'
      ? t('db_delete_view_confirm', { name: confirming.view.name })
      : confirming?.kind === 'row'
        ? t('db_delete_row_confirm', { title: confirming.row.title.trim() || t('untitled') })
        : '',
)
const confirmBody = $derived(
  confirming?.kind === 'property'
    ? t('db_delete_property_desc')
    : confirming?.kind === 'view'
      ? t('db_delete_view_desc')
      : confirming?.kind === 'row'
        ? t('db_delete_row_desc')
        : '',
)

// ---- toolbar menus -------------------------------------------------------------------------

const groupItems = $derived<MenuItem[]>([
  {
    type: 'radio',
    value: view?.config.groupBy ?? '',
    options: [
      { value: '', label: t('db_group_none') },
      ...properties
        .filter((p) => descriptorFor(p.type).canGroup)
        .map((p) => ({ value: p.key, label: p.name, icon: descriptorFor(p.type).icon })),
    ],
    onValueChange: (next: string) => patchView({ groupBy: next || null }),
  },
])

const columnItems = $derived<MenuItem[]>(
  properties.length === 0
    ? [{ type: 'label', label: t('db_no_columns') }]
    : properties.map((property) => ({
        type: 'checkbox' as const,
        id: property.id,
        label: property.name,
        icon: descriptorFor(property.type).icon,
        checked: !property.hidden,
        disabled: !canEdit,
        onCheckedChange: () => void hideProperty(property),
      })),
)

const viewItems = $derived<MenuItem[]>([
  {
    id: 'edit',
    label: t('db_edit_view'),
    icon: 'sliders-vertical',
    disabled: !canEdit || !view,
    onSelect: () => {
      if (view) viewDialog = { view }
    },
  },
  {
    id: 'add',
    label: t('db_add_view'),
    icon: 'plus',
    disabled: !canEdit,
    onSelect: () => (viewDialog = { view: null }),
  },
  { type: 'separator' },
  {
    id: 'delete',
    label: t('db_delete_view'),
    icon: 'trash-2',
    danger: true,
    disabled: !canEdit || !view || views.length <= 1,
    hint: views.length <= 1 ? t('db_view_last') : undefined,
    onSelect: () => {
      if (view) confirming = { kind: 'view', view }
    },
  },
])

const tabs = $derived(views.map((v) => ({ value: v.id, label: v.name, icon: viewIcon(v.kind) })))

const loading = $derived(forPage.isLoading || (Boolean(databaseId) && databaseQuery.isLoading))
const failed = $derived(forPage.isError || databaseQuery.isError || rowsQuery.isError)
</script>

{#if loading}
  <div class="pad">
    <Skeleton height="34px" />
    <div class="gap"></div>
    <Skeleton height="18px" lines={8} />
  </div>
{:else if failed}
  <div class="pad">
    <EmptyState icon="triangle-alert" title={t('db_error')} description={t('db_error_desc')}>
      {#snippet actions()}
        <Button
          variant="secondary"
          onclick={() => {
            void forPage.refetch()
            void databaseQuery.refetch()
            void rowsQuery.refetch()
          }}
        >
          {t('common.retry')}
        </Button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !database}
  <div class="pad">
    <EmptyState icon="database" title={t('db_missing')} description={t('db_missing_desc')} />
  </div>
{:else}
  <div class="head">
    {#if tabs.length > 0}
      <Tabs
        items={tabs}
        value={view?.id ?? tabs[0]?.value ?? ''}
        variant="underline"
        label={t('db_views')}
        onValueChange={(next) => (chosenViewId = next)}
      />
    {/if}
    <span class="sp"></span>
    <DropdownMenu items={viewItems}>
      {#snippet trigger(props: Record<string, unknown>)}
        <IconButton {...props} icon="ellipsis" label={t('db_view_actions')} size={28} variant="ghost" />
      {/snippet}
    </DropdownMenu>
  </div>

  <Toolbar>
    <FilterMenu
      {database}
      config={view?.config ?? { filters: [], filterMode: 'and', sorts: [], groupBy: null, dateProperty: null, visibleProperties: null, columnWidths: {}, cardSize: 'medium', coverProperty: null }}
      {workspaceId}
      {people}
      {canEdit}
      open={filterOpen}
      onOpenChange={(o) => (filterOpen = o)}
      onchange={patchView}
    />
    <SortMenu
      {database}
      config={view?.config ?? { filters: [], filterMode: 'and', sorts: [], groupBy: null, dateProperty: null, visibleProperties: null, columnWidths: {}, cardSize: 'medium', coverProperty: null }}
      {canEdit}
      open={sortOpen}
      onOpenChange={(o) => (sortOpen = o)}
      onchange={patchView}
    />
    {#if view?.kind === 'board'}
      <DropdownMenu items={groupItems} align="start">
        {#snippet trigger(props: Record<string, unknown>)}
          <ToolbarButton {...props} prefix={t('db_by')} active={Boolean(view?.config.groupBy)}>
            {groupProperty?.name ?? t('db_group_none')}
          </ToolbarButton>
        {/snippet}
      </DropdownMenu>
    {/if}
    <DropdownMenu items={columnItems} align="start">
      {#snippet trigger(props: Record<string, unknown>)}
        <ToolbarButton {...props} icon="columns-3">{t('db_properties')}</ToolbarButton>
      {/snippet}
    </DropdownMenu>

    {#snippet end()}
      <span class="count">{t('db_rows', { n: rows.length })}</span>
      {#if canCreate}
        <Button size="sm" disabled={busy} onclick={() => void addRow()}>{t('db_new_row')}</Button>
      {/if}
    {/snippet}
  </Toolbar>

  <div class="body">
    {#if rowsQuery.isLoading}
      <div class="pad"><Skeleton height="40px" lines={6} /></div>
    {:else if rows.length === 0}
      <div class="pad">
        <EmptyState icon="database" title={t('db_empty')} description={t('db_empty_desc')}>
          {#snippet actions()}
            {#if canCreate}
              <Button disabled={busy} onclick={() => void addRow()}>{t('db_new_row')}</Button>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else if !view || view.kind === 'table' || view.kind === 'timeline'}
      {#if view?.kind === 'timeline'}
        <p class="notice" role="status">
          <Icon name="circle-alert" size={14} strokeWidth={1.7} />
          {t('db_timeline_unbuilt')}
        </p>
      {/if}
      <TableView
        {database}
        {view}
        {rows}
        {people}
        {workspaceId}
        {canEdit}
        {canCreate}
        {sortDirectionOf}
        onCellChange={(row, property, value) => void writeCell(row, property, value)}
        onTitleChange={(row, title) => void writeTitle(row, title)}
        onOpenRow={(row) => (inspecting = row.id)}
        onOpenPage={(row) => void openPage(row)}
        onDuplicateRow={(row) => void duplicateRow(row)}
        onDeleteRow={(row) => (confirming = { kind: 'row', row })}
        onAddRow={() => void addRow()}
        onAddProperty={() => (propertyDialog = { property: null })}
        onEditProperty={(property) => (propertyDialog = { property })}
        onMoveProperty={(property, direction) => void moveProperty(property, direction)}
        onHideProperty={(property) => void hideProperty(property)}
        onDeleteProperty={(property) => (confirming = { kind: 'property', property })}
        onSortBy={sortBy}
        onFilterBy={filterBy}
        onConfigChange={patchView}
      />
      {#if rowsQuery.hasNextPage}
        <div class="more">
          <Button
            variant="secondary"
            disabled={rowsQuery.isFetchingNextPage}
            onclick={() => void rowsQuery.fetchNextPage()}
          >
            {rowsQuery.isFetchingNextPage ? t('common.loading') : t('db_load_more')}
          </Button>
        </div>
      {/if}
    {:else if view.kind === 'board'}
      <BoardView
        {database}
        {view}
        {rows}
        {people}
        {workspaceId}
        {canEdit}
        {canCreate}
        onMove={(row, laneId) => void moveOnBoard(row, laneId)}
        onOpenRow={(row) => (inspecting = row.id)}
        onAddRow={(laneId) =>
          void addRow(
            groupProperty && laneId !== EMPTY_GROUP
              ? { [groupProperty.key]: groupProperty.type === 'checkbox' ? laneId === 'true' : laneId }
              : {},
          )}
        onConfigure={() => {
          if (view) viewDialog = { view }
        }}
      />
    {:else if view.kind === 'gallery'}
      <GalleryView
        {database}
        {view}
        {rows}
        {people}
        {workspaceId}
        {canEdit}
        onOpenRow={(row) => (inspecting = row.id)}
        onOpenPage={(row) => void openPage(row)}
        onDeleteRow={(row) => (confirming = { kind: 'row', row })}
      />
    {:else if view.kind === 'list'}
      <ListView
        {database}
        {view}
        {rows}
        {people}
        {workspaceId}
        {canEdit}
        onOpenRow={(row) => (inspecting = row.id)}
        onOpenPage={(row) => void openPage(row)}
        onDeleteRow={(row) => (confirming = { kind: 'row', row })}
      />
    {:else}
      <CalendarView
        {database}
        {view}
        {rows}
        {canEdit}
        onOpenRow={(row) => (inspecting = row.id)}
        onSetDate={(row, iso) => void setDate(row, iso)}
        onConfigure={() => {
          if (view) viewDialog = { view }
        }}
      />
    {/if}

    {#if capped}
      <p class="notice" role="status">
        <Icon name="circle-alert" size={14} strokeWidth={1.7} />
        {t('db_capped', { n: CAP })}
      </p>
    {/if}
  </div>
{/if}

{#if database && inspected}
  <RowPanel
    {database}
    row={inspected}
    {people}
    {workspaceId}
    {canEdit}
    onClose={() => (inspecting = null)}
    onChange={(property, value) => void writeCell(inspected, property, value)}
    onTitleChange={(title) => void writeTitle(inspected, title)}
    onOpenPage={() => void openPage(inspected)}
  />
{/if}

{#if database}
  <PropertyDialog
    open={propertyDialog !== null}
    {workspaceId}
    {spaceId}
    {databaseId}
    property={propertyDialog?.property ?? null}
    {relations}
    {busy}
    onClose={() => (propertyDialog = null)}
    onSubmit={(input) => void submitProperty(input)}
  />
  <ViewDialog
    open={viewDialog !== null}
    {database}
    view={viewDialog?.view ?? null}
    {busy}
    onClose={() => (viewDialog = null)}
    onSubmit={(input) => void submitView(input)}
  />
{/if}

<Dialog
  open={confirming !== null}
  title={confirmTitle}
  size="sm"
  onOpenChange={(o) => !o && (confirming = null)}
>
  <p class="confirm">{confirmBody}</p>
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (confirming = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" disabled={busy} onclick={confirmed}>{t('common.delete')}</Button>
  {/snippet}
</Dialog>

<style>
.head {
  display: flex;
  align-items: stretch;
  gap: 10px;
  height: 44px;
  padding: 0 28px;
  border-block-end: 1px solid var(--kern-border);
  background: var(--kern-surface);
  flex: none;
}
.head .sp {
  flex: 1;
}
.head :global(.ktabs) {
  display: flex;
  align-items: stretch;
}
/*
 * No scroller of its own: this renders inside `Page`, which already scrolls. Two nested scrollers
 * means a wheel that stops at an invisible boundary halfway down the screen.
 */
.body {
  min-height: 0;
}
.pad {
  padding: 24px 28px 40px;
}
.gap {
  height: 14px;
}
.count {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-450);
  white-space: nowrap;
}
.more {
  display: flex;
  justify-content: center;
  padding: 4px 0 32px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 28px 28px;
  padding: 9px 12px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
.confirm {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-600);
}
@media (max-width: 768px) {
  .head {
    padding: 0 16px;
  }
  .pad {
    padding: 16px;
  }
  .notice {
    margin-inline: 16px;
  }
}
</style>
