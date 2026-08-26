<script lang="ts">
import { DropdownMenu, EmptyState, formatCount, Icon, IconButton, type MenuItem } from '@kernhq/ui'
import { untrack } from 'svelte'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import type { Database, Property, Row, View } from '../../contract/index.js'
import type { Person } from '../core-api.js'
import { t } from '../i18n.js'
import Cell from './cells/Cell.svelte'
import OptionChip from './OptionChip.svelte'
import { descriptorFor } from './property-types.js'
import { EMPTY_GROUP, groupsOf, type Lane, visiblePropertiesOf } from './view-config.js'

/**
 * The board (DESIGN.md §3.3), grouped by a select, status or checkbox column.
 *
 * Three traps in `svelte-dnd-action`, all of which have already shipped once in this project:
 *
 * - it tracks items by an `id` property and nothing else, so the lanes hold `Row`s and never
 *   wrappers;
 * - the lanes must be `$state.raw` — a deep-reactive proxy hands the library a different object on
 *   every read, which it reads as an endless stream of changes;
 * - the seeding effect reads its `dragging` guard through `untrack`. Clearing the flag at the end of
 *   a drop otherwise re-runs the effect against the *old* query data and undoes the move on screen
 *   while the mutation is still in flight.
 *
 * Every card carries a **Move to** menu. The drag is unreachable by keyboard, so without it half
 * the people using this board could not move a card at all.
 */
interface Props {
  database: Database
  view: View | null
  rows: Row[]
  people: Person[]
  workspaceId: string
  canEdit: boolean
  canCreate: boolean
  onMove: (row: Row, laneId: string) => void
  onOpenRow: (row: Row) => void
  onAddRow: (laneId: string) => void
  onConfigure: () => void
}
const {
  database,
  view,
  rows,
  people,
  workspaceId,
  canEdit,
  canCreate,
  onMove,
  onOpenRow,
  onAddRow,
  onConfigure,
}: Props = $props()

const FLIP = 160

const groupKey = $derived(view?.config.groupBy ?? null)
const groupProperty = $derived(
  groupKey ? (database.properties.find((p) => p.key === groupKey) ?? null) : null,
)
const groupable = $derived(groupProperty !== null && descriptorFor(groupProperty.type).canGroup)

/** Three properties on a card, not thirty: the card is a summary, the panel is the record. */
const cardProperties = $derived(
  visiblePropertiesOf(database, view)
    .filter((p) => p.key !== groupKey)
    .slice(0, 3),
)

let lanes = $state.raw<Lane[]>([])
let dragging = $state(false)

const replaceLane = (index: number, items: Row[]) => {
  lanes = lanes.map((lane, i) => (i === index ? { ...lane, rows: items } : lane))
}

$effect(() => {
  const next = groupable ? groupsOf(groupProperty, rows) : []
  if (untrack(() => dragging)) return
  lanes = next
})

const isShadow = (row: Row) =>
  (row as unknown as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true

function consider(index: number, event: CustomEvent<{ items: Row[] }>) {
  dragging = true
  replaceLane(index, event.detail.items)
}

function finalize(index: number, event: CustomEvent<{ items: Row[]; info: { id: string } }>) {
  dragging = false
  const lane = lanes[index]
  if (!lane) return
  replaceLane(index, event.detail.items)
  const moved = event.detail.items.find((r) => r.id === event.detail.info.id)
  // Both the source and the target lane fire; only the target holds the card.
  if (!moved) return
  const already = groupProperty ? moved.props[groupProperty.key] : null
  const current = Array.isArray(already) ? (already[0] ?? null) : (already ?? null)
  // A drop inside the same lane re-seeds and does nothing: rows carry no order of their own, so
  // there is nothing to persist and pretending otherwise would snap back a moment later anyway.
  if ((current ?? EMPTY_GROUP) === lane.id) return
  onMove(moved, lane.id)
}

const laneName = (lane: Lane) => lane.option?.label ?? t('db_board_uncategorised')

const cardMenu = (row: Row, from: Lane): MenuItem[] => [
  { id: 'open', label: t('db_open_row'), icon: 'maximize-2', onSelect: () => onOpenRow(row) },
  { type: 'separator' },
  { type: 'label', label: t('db_move_to') },
  ...lanes
    .filter((lane) => lane.id !== from.id)
    .map((lane) => ({
      id: `move-${lane.id}`,
      label: laneName(lane),
      icon: 'arrow-right',
      disabled: !canEdit,
      onSelect: () => onMove(row, lane.id),
    })),
]

const laneRule = (lane: Lane) =>
  `linear-gradient(to var(--kern-quire-lane-dir, right), ${
    lane.option ? 'var(--kern-accent)' : 'var(--kern-ink-300)'
  } 0 34px, var(--kern-border) 34px)`
</script>

{#if !groupable}
  <div class="pad">
    <EmptyState
      icon="kanban"
      title={t('db_board_needs_group')}
      description={t('db_board_needs_group_desc')}
    >
      {#snippet actions()}
        {#if canEdit}
          <button type="button" class="link" onclick={onConfigure}>{t('db_edit_view')}</button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="board" data-testid="database-board">
    {#each lanes as lane, index (lane.id)}
      <section class="col" data-lane={lane.id}>
        <header class="head">
          {#if lane.option}
            <OptionChip option={lane.option} compact />
          {:else}
            <span class="none">{t('db_board_uncategorised')}</span>
          {/if}
          <!--
            Through `formatCount`, not interpolated raw: a bare number is the one untranslated thing
            left on a Persian board, where every other digit on the screen is ۰-۹.
          -->
          <span class="count">{formatCount(lane.rows.length, 999)}</span>
          <span class="sp"></span>
          {#if canCreate}
            <IconButton
              icon="plus"
              label={t('db_new_row_in', { lane: laneName(lane) })}
              size={26}
              variant="ghost"
              onclick={() => onAddRow(lane.id)}
            />
          {/if}
        </header>
        <div class="rule" style:background={laneRule(lane)}></div>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="stack"
          use:dndzone={{
            items: lane.rows,
            flipDurationMs: FLIP,
            type: 'quire-rows',
            dragDisabled: !canEdit,
            dropTargetStyle: {},
          }}
          onconsider={(e) => consider(index, e)}
          onfinalize={(e) => finalize(index, e)}
        >
          {#each lane.rows as row (row.id)}
            <article class="card" class:shadow={isShadow(row)} data-testid="board-card">
              <div class="card-top">
                <h3 class="card-title">{row.title.trim() || t('untitled')}</h3>
                <DropdownMenu items={cardMenu(row, lane)}>
                  {#snippet trigger(props: Record<string, unknown>)}
                    <IconButton
                      {...props}
                      icon="ellipsis"
                      label={t('db_row_actions', { title: row.title.trim() || t('untitled') })}
                      size={26}
                      variant="ghost"
                    />
                  {/snippet}
                </DropdownMenu>
              </div>
              {#if cardProperties.length > 0}
                <dl class="fields">
                  {#each cardProperties as property (property.id)}
                    <div class="field">
                      <dt>{property.name}</dt>
                      <dd>
                        <Cell
                          {property}
                          {row}
                          {people}
                          {workspaceId}
                          canEdit={false}
                          onchange={() => {}}
                        />
                      </dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </article>
          {/each}
          {#if lane.rows.length === 0}
            <p class="lane-empty">{t('db_lane_empty')}</p>
          {/if}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style>
.board {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  padding: 22px 28px 30px;
  overflow-x: auto;
}
:global([dir='rtl']) .board {
  --kern-quire-lane-dir: left;
}
.col {
  width: var(--kern-board-col-w);
  flex: none;
}
.head {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
}
.none {
  font-size: 13px;
  color: var(--kern-ink-450);
}
.count {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-450);
}
.sp {
  flex: 1;
}
.rule {
  height: 2px;
  border-radius: 1px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-block-start: 14px;
  min-height: 80px;
  padding-block-end: 4px;
}
.card {
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-xl);
  background: var(--kern-surface-raised);
  padding: 11px 8px 12px 13px;
}
.card:hover {
  border-color: var(--kern-border-hover);
}
.card.shadow {
  border-style: dashed;
  background: var(--kern-surface-hover);
}
.card-top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.card-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.42;
  letter-spacing: -0.005em;
  color: var(--kern-ink-900);
}
.fields {
  margin-block-start: 10px;
  margin-inline-end: 5px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.field dt {
  font-size: 11.5px;
  color: var(--kern-ink-450);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field dd {
  margin: 0;
  min-width: 0;
  font-size: 12.5px;
  color: var(--kern-ink-600);
  overflow: hidden;
}
.lane-empty {
  margin: 0;
  padding: 14px 10px;
  border: 1px dashed var(--kern-border);
  border-radius: var(--kern-r-lg);
  text-align: center;
  font-size: 12.5px;
  color: var(--kern-ink-450);
}
.pad {
  padding: 28px;
}
.link {
  border: 0;
  background: none;
  color: var(--kern-accent-text);
  font: inherit;
  font-size: 13px;
  text-decoration: underline;
}
@media (max-width: 768px) {
  .board {
    padding: 16px;
    gap: 14px;
  }
}
</style>
