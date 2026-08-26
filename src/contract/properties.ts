import { Id, Timestamp, UserId } from '@kernhq/contracts'
import { z } from 'zod'

/**
 * What a column can be.
 *
 * The set is closed on purpose. A property type is not just a input widget: it decides how a value
 * sorts, what a filter can ask of it, and whether a rollup can add it up. An open set would mean a
 * table view that can display something no filter can find.
 */
export const PropertyType = z.enum([
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'rollup',
  'formula',
  'created_time',
  'created_by',
  'edited_time',
  'edited_by',
])
export type PropertyType = z.infer<typeof PropertyType>

/** A choice in a select, a multi-select or a status. */
export const SelectOption = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  colour: z.string().max(32).default('slate'),
  /** status only: which band of the workflow this sits in */
  group: z.enum(['todo', 'doing', 'done']).optional(),
})
export type SelectOption = z.infer<typeof SelectOption>

/** How a rollup reduces the values it gathers from the other side of a relation. */
export const RollupFunction = z.enum([
  'count',
  'count_values',
  'count_unique',
  'sum',
  'average',
  'min',
  'max',
  'range',
  'show_original',
  'checked',
  'unchecked',
  'percent_checked',
])
export type RollupFunction = z.infer<typeof RollupFunction>

/**
 * Everything a type needs beyond its name.
 *
 * One permissive object rather than a discriminated union per type: the union would have to be
 * exhaustive at every boundary, and a column's configuration is read by code that already knows
 * which type it is holding. What matters is that adding a type never needs a migration.
 */
export const PropertyConfig = z.object({
  options: z.array(SelectOption).optional(),
  /** number: how it is drawn — plain, a percentage, a currency, a bar */
  format: z.string().max(32).optional(),
  precision: z.number().int().min(0).max(8).optional(),
  /** date: whether the value carries a time, and whether it is a range */
  includeTime: z.boolean().optional(),
  isRange: z.boolean().optional(),
  /** relation: the database on the other side, and the property that points back */
  relationDatabaseId: Id.optional(),
  relationPropertyId: Id.optional(),
  /** rollup: which relation to walk, which property to gather, and how to reduce it */
  rollupRelationPropertyId: Id.optional(),
  rollupTargetPropertyId: Id.optional(),
  rollupFunction: RollupFunction.optional(),
  /** formula: the expression, exactly as somebody typed it */
  expression: z.string().max(4000).optional(),
  /** person: whether more than one may be chosen */
  multiple: z.boolean().optional(),
})
export type PropertyConfig = z.infer<typeof PropertyConfig>

export const Property = z.object({
  id: Id,
  databaseId: Id,
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  type: PropertyType,
  config: PropertyConfig,
  position: z.string(),
  hidden: z.boolean(),
})
export type Property = z.infer<typeof Property>

/**
 * A cell.
 *
 * Deliberately loose: the shape depends on the column's type, and the server validates a value
 * against its own property before it is written. Typing it here as a union would put the same
 * exhaustive switch in every consumer that only ever renders one type at a time.
 */
export const PropertyValue = z.unknown()

export const ViewKind = z.enum(['table', 'board', 'calendar', 'gallery', 'list', 'timeline'])
export type ViewKind = z.infer<typeof ViewKind>

/** How a filter compares. Which of these a column accepts depends on its type. */
export const FilterOperator = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'on_or_before',
  'on_or_after',
  'is_any_of',
  'is_none_of',
])
export type FilterOperator = z.infer<typeof FilterOperator>

export const Filter = z.object({
  propertyKey: z.string(),
  operator: FilterOperator,
  value: z.unknown().optional(),
})
export type Filter = z.infer<typeof Filter>

export const Sort = z.object({
  propertyKey: z.string(),
  direction: z.enum(['asc', 'desc']).default('asc'),
})
export type Sort = z.infer<typeof Sort>

export const ViewConfig = z.object({
  filters: z.array(Filter).default([]),
  /** every filter must hold, or any one of them */
  filterMode: z.enum(['and', 'or']).default('and'),
  sorts: z.array(Sort).default([]),
  /** board: which property makes the columns; calendar: which date is plotted */
  groupBy: z.string().nullable().default(null),
  dateProperty: z.string().nullable().default(null),
  visibleProperties: z.array(z.string()).nullable().default(null),
  columnWidths: z.record(z.string(), z.number()).default({}),
  cardSize: z.enum(['small', 'medium', 'large']).default('medium'),
  /** gallery: which files property provides the picture */
  coverProperty: z.string().nullable().default(null),
})
export type ViewConfig = z.infer<typeof ViewConfig>

export const View = z.object({
  id: Id,
  databaseId: Id,
  name: z.string().min(1).max(120),
  kind: ViewKind,
  config: ViewConfig,
  position: z.string(),
  isDefault: z.boolean(),
})
export type View = z.infer<typeof View>

export const Database = z.object({
  id: Id,
  workspaceId: z.string(),
  spaceId: Id,
  pageId: Id,
  name: z.string(),
  description: z.string(),
  inline: z.boolean(),
  properties: z.array(Property),
  views: z.array(View),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Database = z.infer<typeof Database>

/** A row: the page, plus its cells and whatever the server computed from them. */
export const Row = z.object({
  id: Id,
  databaseId: Id,
  title: z.string(),
  icon: z.string().nullable(),
  props: z.record(z.string(), PropertyValue),
  computed: z.record(z.string(), PropertyValue),
  createdBy: UserId.nullable(),
  updatedBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Row = z.infer<typeof Row>

/**
 * A row named rather than identified.
 *
 * A relation cell holds page ids and nothing else, so drawing one without this shows a column of
 * uuids. `databases.lookup` answers in this shape for both jobs the cell has — resolving the ids it
 * already holds, and searching for the next one.
 */
export const RowRef = z.object({
  id: Id,
  title: z.string(),
  icon: z.string().nullable(),
})
export type RowRef = z.infer<typeof RowRef>

/**
 * A database named rather than identified.
 *
 * A relation column has to point at another database, and a rollup has to walk one — so the
 * property editor needs the list of them. `Database` itself carries every property and every view,
 * which is a large answer to "what may I link to".
 */
export const DatabaseRef = z.object({
  id: Id,
  pageId: Id,
  name: z.string(),
})
export type DatabaseRef = z.infer<typeof DatabaseRef>
