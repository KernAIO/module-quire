import type { FilterOperator, PropertyType, ViewKind } from '../../contract/index.js'

/**
 * What every property type is, in one table.
 *
 * The interface asks the same four questions of a column over and over — which icon, which editor,
 * may it be written, which operators may a filter offer — and answering each of them with its own
 * `switch` is how a new property type ends up drawing nothing in one place and everything in
 * another. One record, exhaustively typed: adding a type to the contract stops compiling here until
 * it is described, which is the point.
 *
 * Icons are chosen from `@kernhq/ui`'s registry as it actually stands. An unregistered name renders
 * a blank square and throws nothing, and there is no `table`, `sigma` or `arrow-down` in it.
 */

/** The family of editor a cell uses. `unsupported` renders read-only and says why. */
export type CellEditor =
  | 'text'
  | 'number'
  | 'select'
  | 'date'
  | 'person'
  | 'checkbox'
  | 'link'
  | 'relation'
  | 'computed'
  | 'unsupported'

export interface PropertyDescriptor {
  icon: string
  editor: CellEditor
  /** written by the server, never by a person — a formula, a rollup, or an audit stamp */
  readOnly: boolean
  operators: FilterOperator[]
  /** may a board be grouped by it */
  canGroup: boolean
  /** may a calendar be plotted on it */
  canDate: boolean
  /** may somebody choose it when adding a column */
  creatable: boolean
}

const TEXTUAL: FilterOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
]
const NUMERIC: FilterOperator[] = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
]
const DATED: FilterOperator[] = [
  'equals',
  'on_or_before',
  'on_or_after',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
]
const CHOSEN: FilterOperator[] = [
  'equals',
  'not_equals',
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
]
const MANY: FilterOperator[] = [
  'contains',
  'not_contains',
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
]

export const PROPERTY_TYPES: Record<PropertyType, PropertyDescriptor> = {
  text: {
    icon: 'file-text',
    editor: 'text',
    readOnly: false,
    operators: TEXTUAL,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  number: {
    icon: 'hash',
    editor: 'number',
    readOnly: false,
    operators: NUMERIC,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  select: {
    icon: 'chevron-down',
    editor: 'select',
    readOnly: false,
    operators: CHOSEN,
    canGroup: true,
    canDate: false,
    creatable: true,
  },
  multi_select: {
    icon: 'tag',
    editor: 'select',
    readOnly: false,
    operators: MANY,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  status: {
    icon: 'circle-check',
    editor: 'select',
    readOnly: false,
    operators: CHOSEN,
    canGroup: true,
    canDate: false,
    creatable: true,
  },
  date: {
    icon: 'calendar',
    editor: 'date',
    readOnly: false,
    operators: DATED,
    canGroup: false,
    canDate: true,
    creatable: true,
  },
  person: {
    icon: 'user',
    editor: 'person',
    readOnly: false,
    operators: MANY,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  /**
   * Quire has no file handling at all — no upload path, no storage ticket — so a `files` column is
   * drawn read-only and is not offered when adding one. A picker that produces a column nobody can
   * fill is worse than an absent type.
   */
  files: {
    icon: 'paperclip',
    editor: 'unsupported',
    readOnly: true,
    operators: ['is_empty', 'is_not_empty'],
    canGroup: false,
    canDate: false,
    creatable: false,
  },
  checkbox: {
    icon: 'square-check-big',
    editor: 'checkbox',
    readOnly: false,
    operators: ['equals', 'is_empty', 'is_not_empty'],
    canGroup: true,
    canDate: false,
    creatable: true,
  },
  url: {
    icon: 'link',
    editor: 'link',
    readOnly: false,
    operators: TEXTUAL,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  email: {
    icon: 'at-sign',
    editor: 'link',
    readOnly: false,
    operators: TEXTUAL,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  phone: {
    icon: 'smartphone',
    editor: 'link',
    readOnly: false,
    operators: TEXTUAL,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  relation: {
    icon: 'git-branch',
    editor: 'relation',
    readOnly: false,
    operators: MANY,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  rollup: {
    icon: 'chart-column',
    editor: 'computed',
    readOnly: true,
    operators: NUMERIC,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  formula: {
    icon: 'code',
    editor: 'computed',
    readOnly: true,
    operators: NUMERIC,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  created_time: {
    icon: 'clock',
    editor: 'computed',
    readOnly: true,
    operators: DATED,
    canGroup: false,
    canDate: true,
    creatable: true,
  },
  created_by: {
    icon: 'circle-user',
    editor: 'computed',
    readOnly: true,
    operators: CHOSEN,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
  edited_time: {
    icon: 'clock',
    editor: 'computed',
    readOnly: true,
    operators: DATED,
    canGroup: false,
    canDate: true,
    creatable: true,
  },
  edited_by: {
    icon: 'circle-user',
    editor: 'computed',
    readOnly: true,
    operators: CHOSEN,
    canGroup: false,
    canDate: false,
    creatable: true,
  },
}

export const descriptorFor = (type: PropertyType): PropertyDescriptor => PROPERTY_TYPES[type]
export const operatorsFor = (type: PropertyType): FilterOperator[] => PROPERTY_TYPES[type].operators
export const isReadOnly = (type: PropertyType): boolean => PROPERTY_TYPES[type].readOnly

/** The types somebody may choose when adding or retyping a column, in the order they are offered. */
export const CREATABLE_TYPES: PropertyType[] = (Object.keys(PROPERTY_TYPES) as PropertyType[]).filter(
  (type) => PROPERTY_TYPES[type].creatable,
)

/** Operators that take no value at all — the value editor is hidden rather than disabled. */
export const VALUELESS_OPERATORS: FilterOperator[] = ['is_empty', 'is_not_empty']

/**
 * Timeline is declared by `ViewKind` and is not built.
 *
 * It needs a start and an end date per row, a scale and a horizontal virtualiser, and none of that
 * exists — so it is left out of the kinds the interface offers rather than shipped as a tab that
 * renders nothing. A view already saved as `timeline` falls back to the table.
 */
export const VIEW_KINDS: { kind: ViewKind; icon: string }[] = [
  { kind: 'table', icon: 'columns-3' },
  { kind: 'board', icon: 'kanban' },
  { kind: 'gallery', icon: 'layout-grid' },
  { kind: 'list', icon: 'list' },
  { kind: 'calendar', icon: 'calendar-days' },
]

export const viewIcon = (kind: ViewKind): string =>
  VIEW_KINDS.find((v) => v.kind === kind)?.icon ?? 'columns-3'
