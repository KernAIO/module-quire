<script lang="ts">
import { Button, DropdownMenu, EmptyState, IconButton, type MenuItem, messageLocale } from '@kernhq/ui'
import type { Database, Row, View } from '../../contract/index.js'
import { t } from '../i18n.js'
import { descriptorFor } from './property-types.js'

/**
 * A month of rows, plotted on the view's date column.
 *
 * The month is component state rather than a URL parameter: which month somebody is looking at is
 * not what the page is *about*, and putting it in the address makes every scroll through the year a
 * history entry to walk back through.
 *
 * A day cell is a drop target, and every card carries **Move to a date** so the drag is never the
 * only route — the same rule the board follows.
 */
interface Props {
  database: Database
  view: View | null
  rows: Row[]
  canEdit: boolean
  onOpenRow: (row: Row) => void
  onSetDate: (row: Row, iso: string | null) => void
  onConfigure: () => void
}
const { database, view, rows, canEdit, onOpenRow, onSetDate, onConfigure }: Props = $props()

const dateKey = $derived(view?.config.dateProperty ?? null)
const dateProperty = $derived(dateKey ? (database.properties.find((p) => p.key === dateKey) ?? null) : null)
const plottable = $derived(dateProperty !== null && descriptorFor(dateProperty.type).canDate)

const today = new Date()
let cursor = $state(new Date(today.getFullYear(), today.getMonth(), 1))

const monthLabel = $derived(
  new Intl.DateTimeFormat(messageLocale(), { month: 'long', year: 'numeric' }).format(cursor),
)

/** Weekday names for the header, starting on the locale's first day. */
const weekdays = $derived.by(() => {
  const format = new Intl.DateTimeFormat(messageLocale(), { weekday: 'short' })
  // 2024-01-07 was a Sunday; the grid starts on Monday, which is what a working week means here.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 8 + i))))
})

const dayKey = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

/** Six weeks from the Monday on or before the first of the month — a month never needs more. */
const days = $derived.by(() => {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  return Array.from(
    { length: 42 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  )
})

const byDay = $derived.by(() => {
  const map = new Map<string, Row[]>()
  if (!dateProperty) return map
  for (const row of rows) {
    const raw = row.props[dateProperty.key]
    if (typeof raw !== 'string' || raw === '') continue
    const at = new Date(raw)
    if (Number.isNaN(at.getTime())) continue
    const key = dayKey(at)
    map.set(key, [...(map.get(key) ?? []), row])
  }
  return map
})

const undated = $derived(
  dateProperty
    ? rows.filter((row) => {
        const raw = row.props[dateProperty.key]
        return typeof raw !== 'string' || raw === '' || Number.isNaN(new Date(raw).getTime())
      })
    : [],
)

const shift = (months: number) => {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + months, 1)
}

let dragged = $state<string | null>(null)

function dropOn(at: Date) {
  const row = rows.find((r) => r.id === dragged)
  dragged = null
  if (!row) return
  onSetDate(row, new Date(at.getFullYear(), at.getMonth(), at.getDate(), 9).toISOString())
}

const cardMenu = (row: Row): MenuItem[] => [
  { id: 'open', label: t('db_open_row'), icon: 'maximize-2', onSelect: () => onOpenRow(row) },
  { type: 'separator' },
  { type: 'label', label: t('db_move_to_date') },
  ...[0, 1, 7].map((offset) => {
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 9)
    return {
      id: `date-${offset}`,
      label:
        offset === 0 ? t('db_date_today') : offset === 1 ? t('db_date_tomorrow') : t('db_date_next_week'),
      icon: 'calendar',
      disabled: !canEdit,
      onSelect: () => onSetDate(row, at.toISOString()),
    }
  }),
  {
    id: 'clear-date',
    label: t('db_date_clear'),
    icon: 'x',
    disabled: !canEdit,
    onSelect: () => onSetDate(row, null),
  },
]
</script>

{#if !plottable}
  <div class="pad">
    <EmptyState
      icon="calendar-days"
      title={t('db_calendar_needs_date')}
      description={t('db_calendar_needs_date_desc')}
    >
      {#snippet actions()}
        {#if canEdit}
          <Button variant="secondary" onclick={onConfigure}>{t('db_edit_view')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="cal">
    <div class="bar">
      <IconButton icon="chevron-left" label={t('db_prev_month')} size={28} variant="ghost" onclick={() => shift(-1)} />
      <h2 class="month">{monthLabel}</h2>
      <IconButton icon="chevron-right" label={t('db_next_month')} size={28} variant="ghost" onclick={() => shift(1)} />
      <Button
        size="sm"
        variant="secondary"
        onclick={() => (cursor = new Date(today.getFullYear(), today.getMonth(), 1))}
      >
        {t('db_this_month')}
      </Button>
    </div>

    <!--
      A plain layout, not `role="grid"`. A real grid promises arrow-key navigation between cells,
      and promising that without implementing it is worse for a screen-reader user than not claiming
      it at all — the keyboard route to every action here is the card's own menu.
    -->
    <div class="grid" aria-label={monthLabel}>
      {#each weekdays as weekday (weekday)}
        <div class="dow">{weekday}</div>
      {/each}
      {#each days as day (day.toISOString())}
        {@const key = dayKey(day)}
        {@const inMonth = day.getMonth() === cursor.getMonth()}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="day"
          class:out={!inMonth}
          class:today={key === dayKey(today)}
          ondragover={(e) => canEdit && e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault()
            if (canEdit) dropOn(day)
          }}
        >
          <span class="num">{day.getDate()}</span>
          {#each byDay.get(key) ?? [] as row (row.id)}
            <div
              class="event"
              draggable={canEdit}
              ondragstart={() => (dragged = row.id)}
              ondragend={() => (dragged = null)}
            >
              <span class="ev-title">{row.title.trim() || t('untitled')}</span>
              <DropdownMenu items={cardMenu(row)}>
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
          {/each}
        </div>
      {/each}
    </div>

    {#if undated.length > 0}
      <section class="undated">
        <h3>{t('db_no_date_rows', { n: undated.length })}</h3>
        <ul>
          {#each undated as row (row.id)}
            <li>
              <span class="ev-title">{row.title.trim() || t('untitled')}</span>
              <DropdownMenu items={cardMenu(row)}>
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
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
{/if}

<style>
.cal {
  padding: 18px 24px 40px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block-end: 14px;
}
.month {
  margin: 0;
  min-width: 180px;
  font-size: 15px;
  font-weight: 600;
  color: var(--kern-ink-900);
}
.grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  overflow: hidden;
}
.dow {
  padding: 7px 8px;
  background: var(--kern-surface-header);
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-450);
}
:global([dir='rtl']) .dow {
  letter-spacing: 0;
  text-transform: none;
}
.day {
  min-height: 96px;
  padding: 5px 6px 8px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-inline-end: 1px solid var(--kern-border-hairline);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* Muted with a colour, never with opacity — opacity fades the text against the page. */
.day.out .num {
  color: var(--kern-ink-350);
}
.day.out {
  background: var(--kern-surface-header);
}
.day.today .num {
  background: var(--kern-ink-900);
  color: var(--kern-ink-inverse);
}
.num {
  align-self: flex-start;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--kern-r-full);
  display: inline-grid;
  place-items: center;
  font-size: 11.5px;
  color: var(--kern-ink-550);
}
.event {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  padding-inline: 7px 1px;
  padding-block: 1px;
  border-radius: var(--kern-r-md);
  background: var(--kern-accent-tint);
  color: var(--kern-accent-deep);
  font-size: 12px;
  cursor: grab;
}
.ev-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.undated {
  margin-block-start: 18px;
}
.undated h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kern-ink-450);
}
.undated ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.undated li {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 260px;
  padding-inline: 9px 2px;
  padding-block: 2px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
  color: var(--kern-ink-550);
  font-size: 12.5px;
}
.pad {
  padding: 28px;
}
</style>
