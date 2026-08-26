import type { Database, Property, Row, SelectOption, View, ViewConfig } from '../../contract/index.js'

/**
 * Reading and writing a view's configuration.
 *
 * **`updateView` replaces `config` wholesale.** It is one jsonb column and the service writes what
 * it is given, so sending `{ sorts: [...] }` destroys the filters, the grouping, the column widths
 * and the visible properties in the same request. Every write goes through `mergeConfig`, which is
 * the only reason this module exists.
 */

/** The complete configuration, with the patch applied. Never send a partial one. */
export function mergeConfig(current: ViewConfig, patch: Partial<ViewConfig>): ViewConfig {
  return {
    filters: patch.filters ?? current.filters,
    filterMode: patch.filterMode ?? current.filterMode,
    sorts: patch.sorts ?? current.sorts,
    groupBy: patch.groupBy !== undefined ? patch.groupBy : current.groupBy,
    dateProperty: patch.dateProperty !== undefined ? patch.dateProperty : current.dateProperty,
    visibleProperties:
      patch.visibleProperties !== undefined ? patch.visibleProperties : current.visibleProperties,
    columnWidths: patch.columnWidths ?? current.columnWidths,
    cardSize: patch.cardSize ?? current.cardSize,
    coverProperty: patch.coverProperty !== undefined ? patch.coverProperty : current.coverProperty,
  }
}

/**
 * The columns a view draws, in position order.
 *
 * `visibleProperties: null` means "every column that is not hidden" rather than "none" — a view
 * created before anybody chose has no list, and reading null as an empty list draws a table with no
 * columns at all.
 */
export function visiblePropertiesOf(database: Database, view: View | null): Property[] {
  const ordered = [...database.properties].sort((a, b) => (a.position < b.position ? -1 : 1))
  const chosen = view?.config.visibleProperties ?? null
  if (!chosen) return ordered.filter((p) => !p.hidden)
  return ordered.filter((p) => chosen.includes(p.key))
}

/** Every column, hidden ones included, in position order — what the properties editor lists. */
export const orderedProperties = (database: Database): Property[] =>
  [...database.properties].sort((a, b) => (a.position < b.position ? -1 : 1))

export const DEFAULT_COLUMN_WIDTH = 180
export const MIN_COLUMN_WIDTH = 90
export const MAX_COLUMN_WIDTH = 640
/** The title column absorbs the extra width — DESIGN.md §2.7: a working view fills. */
export const TITLE_COLUMN = 'minmax(240px, 1fr)'
/** Room for the row's hover actions, which sit outside the last cell. */
export const ACTIONS_COLUMN = '84px'

/** The grid template for a table: title, then each visible column at its stored or default width. */
export function columnTemplate(properties: Property[], widths: Record<string, number>): string {
  const cols = properties.map((p) => `${clampWidth(widths[p.key] ?? DEFAULT_COLUMN_WIDTH)}px`)
  return [TITLE_COLUMN, ...cols, ACTIONS_COLUMN].join(' ')
}

export const clampWidth = (px: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(px)))

/** The minimum width the table needs before it starts scrolling inside its own wrapper. */
export function tableMinWidth(properties: Property[], widths: Record<string, number>): number {
  const cols = properties.reduce((total, p) => total + clampWidth(widths[p.key] ?? DEFAULT_COLUMN_WIDTH), 0)
  return 240 + cols + 84 + (properties.length + 2) * 12
}

/** The lane a row with no value falls into. Not a valid option id — options are at least one char. */
export const EMPTY_GROUP = '__none__'

export interface Lane {
  id: string
  option: SelectOption | null
  rows: Row[]
}

/**
 * The lanes of a board, in the order the column's options are declared.
 *
 * The uncategorised lane is last and always present: a board that hides it hides the rows nobody
 * has triaged yet, which are the ones the board exists to surface.
 */
export function groupsOf(property: Property | null, rows: Row[]): Lane[] {
  const options = property?.config.options ?? []
  const lanes: Lane[] = options.map((option) => ({ id: option.id, option, rows: [] }))
  const none: Lane = { id: EMPTY_GROUP, option: null, rows: [] }

  for (const row of rows) {
    const raw = property ? row.props[property.key] : null
    const value = Array.isArray(raw) ? raw[0] : raw
    const lane = value == null ? undefined : lanes.find((l) => l.id === String(value))
    ;(lane ?? none).rows.push(row)
  }
  return [...lanes, none]
}

/** The value to write when a card is dropped in a lane; the uncategorised lane means "no value". */
export const groupValue = (laneId: string): string | null => (laneId === EMPTY_GROUP ? null : laneId)

/** The status bands, in workflow order, so a status menu is grouped rather than alphabetical. */
export const STATUS_GROUPS = ['todo', 'doing', 'done'] as const
