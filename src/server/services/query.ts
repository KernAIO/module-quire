import { KernError } from '@kernhq/kernel'
import { type SQL, sql } from 'drizzle-orm'
import type { Filter, Property, Sort } from '../../contract/index.js'
import { pages } from '../schema.js'

/**
 * Turning a view's filters and sorts into SQL over a row.
 *
 * Done in SQL rather than in memory, because filtering after the fact breaks pagination: a page of
 * fifty rows filtered down to three is not a page of three, and the caller has no way to ask for
 * the rest. That means every comparison has to be expressible against the row as it is stored.
 *
 * **A property key is never interpolated before it is looked up.** The key comes from the request,
 * and `props->>'…'` is a string in the query text rather than a parameter — so the only safe path is
 * to find the property first and use the key the *database* already knows about. An unknown key is
 * refused rather than passed through.
 *
 * **A column's value is not always in `props`.** A formula and a rollup are written to `computed`
 * by `recompute`, and the four audit types are real columns on the page. Reading `props` for those
 * six types matches nothing and sorts nothing — silently, because an absent key is a valid absent
 * value. `valueExpr` is the single place that knows where each type lives; nothing else may guess.
 */

/** The six types whose value is not in `props`. */
const COMPUTED = new Set<Property['type']>(['formula', 'rollup'])
const AUDIT = new Set<Property['type']>(['created_time', 'created_by', 'edited_time', 'edited_by'])

/** The raw value, as text, wherever it actually lives. */
function valueExpr(property: Property): SQL {
  switch (property.type) {
    case 'created_time':
      return sql`${pages.createdAt}`
    case 'edited_time':
      return sql`${pages.updatedAt}`
    case 'created_by':
      return sql`${pages.createdBy}`
    case 'edited_by':
      return sql`${pages.updatedBy}`
    default:
      return COMPUTED.has(property.type) ? sql`computed->>${property.key}` : sql`props->>${property.key}`
  }
}

/** The jsonb bag a property's value is stored in, for the containment and emptiness tests. */
const bagExpr = (property: Property): SQL => (COMPUTED.has(property.type) ? sql`computed` : sql`props`)

/**
 * Casts are guarded rather than bare.
 *
 * `props` and `computed` are untyped: a number column can hold the text somebody pasted into it,
 * and a broken formula stores `{"error":"…"}` where a number was expected. A bare `::numeric` on
 * either raises, and the row that raises is the one nobody can filter past — the whole view 500s.
 * A guard makes it null instead, which is what "no comparable value" means.
 */
const NUMBER_TEXT = String.raw`^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$`
const DATE_TEXT = String.raw`^\d{4}-\d{2}-\d{2}`

function numeric(property: Property): SQL {
  if (AUDIT.has(property.type)) return sql`null::numeric`
  const raw = valueExpr(property)
  return sql`(case when ${raw} ~ ${NUMBER_TEXT} then (${raw})::numeric end)`
}

function timestamp(property: Property): SQL {
  if (property.type === 'created_time' || property.type === 'edited_time') return valueExpr(property)
  if (AUDIT.has(property.type)) return sql`null::timestamptz`
  const raw = valueExpr(property)
  return sql`(case when ${raw} ~ ${DATE_TEXT} then (${raw})::timestamptz end)`
}

const text = (property: Property): SQL =>
  AUDIT.has(property.type) ? sql`(${valueExpr(property)})::text` : valueExpr(property)

function boolean(property: Property): SQL {
  const raw = valueExpr(property)
  return sql`coalesce((case when ${raw} in ('true','false') then (${raw})::boolean end), false)`
}

/** Whether a value is "nothing" — absent, null, empty string, or an empty array. */
function emptyExpr(property: Property): SQL {
  if (AUDIT.has(property.type)) return sql`${valueExpr(property)} is null`
  const bag = bagExpr(property)
  const key = property.key
  return sql`(${bag}->${key} is null or ${bag}->>${key} = '' or ${bag}->${key} = '[]'::jsonb or ${bag}->${key} = 'null'::jsonb)`
}

export function filterToSql(filter: Filter, property: Property): SQL | null {
  const value = filter.value

  switch (filter.operator) {
    case 'is_empty':
      return emptyExpr(property)
    case 'is_not_empty':
      return sql`not ${emptyExpr(property)}`
    default:
      break
  }

  switch (property.type) {
    case 'number':
    case 'formula':
    case 'rollup': {
      const n = Number(value)
      if (Number.isNaN(n)) return null
      switch (filter.operator) {
        case 'equals':
          return sql`${numeric(property)} = ${n}`
        case 'not_equals':
          return sql`${numeric(property)} is distinct from ${n}`
        case 'greater_than':
          return sql`${numeric(property)} > ${n}`
        case 'less_than':
          return sql`${numeric(property)} < ${n}`
        default:
          return null
      }
    }

    case 'date':
    case 'created_time':
    case 'edited_time': {
      const at = typeof value === 'string' ? value : null
      if (!at) return null
      switch (filter.operator) {
        case 'equals':
          return sql`date_trunc('day', ${timestamp(property)}) = date_trunc('day', ${at}::timestamptz)`
        case 'on_or_before':
          return sql`${timestamp(property)} <= ${at}::timestamptz`
        case 'on_or_after':
          return sql`${timestamp(property)} >= ${at}::timestamptz`
        case 'greater_than':
          return sql`${timestamp(property)} > ${at}::timestamptz`
        case 'less_than':
          return sql`${timestamp(property)} < ${at}::timestamptz`
        default:
          return null
      }
    }

    case 'checkbox': {
      const wanted = value === true || value === 'true'
      // An unset checkbox is false, not null: a filter for "not done" must include rows nobody has
      // touched, which is most of them.
      return wanted ? sql`${boolean(property)} is true` : sql`${boolean(property)} is false`
    }

    case 'multi_select':
    case 'person':
    case 'files':
    case 'relation': {
      // Array-valued. `?|` asks whether the array contains any of these strings.
      const many = Array.isArray(value) ? value.map(String) : [String(value)]
      const bag = bagExpr(property)
      switch (filter.operator) {
        case 'contains':
        case 'is_any_of':
          return sql`${bag}->${property.key} ?| ${sql.param(many)}::text[]`
        case 'not_contains':
        case 'is_none_of':
          return sql`not coalesce(${bag}->${property.key} ?| ${sql.param(many)}::text[], false)`
        default:
          return null
      }
    }

    default: {
      // Everything else compares as text.
      const v = value === null || value === undefined ? '' : String(value)
      const list = sql.param(Array.isArray(value) ? value.map(String) : [v])
      switch (filter.operator) {
        case 'equals':
          return sql`${text(property)} = ${v}`
        case 'not_equals':
          return sql`${text(property)} is distinct from ${v}`
        case 'contains':
          return sql`${text(property)} ilike ${`%${v}%`}`
        case 'not_contains':
          return sql`coalesce(${text(property)}, '') not ilike ${`%${v}%`}`
        case 'starts_with':
          return sql`${text(property)} ilike ${`${v}%`}`
        case 'ends_with':
          return sql`${text(property)} ilike ${`%${v}`}`
        case 'is_any_of':
          return sql`${text(property)} = any(${list}::text[])`
        case 'is_none_of':
          return sql`coalesce(${text(property)}, '') <> all(${list}::text[])`
        default:
          return null
      }
    }
  }
}

/**
 * The ordering expression for a sort.
 *
 * Typed rather than lexicographic: `props->>'estimate'` sorts 10 before 9, which is the sort of
 * thing nobody reports as a bug and everybody works around.
 */
export function sortToSql(sort: Sort, property: Property): SQL {
  const direction = sort.direction === 'desc' ? sql`desc` : sql`asc`
  switch (property.type) {
    case 'number':
    case 'formula':
    case 'rollup':
      return sql`${numeric(property)} ${direction} nulls last`
    case 'date':
    case 'created_time':
    case 'edited_time':
      return sql`${timestamp(property)} ${direction} nulls last`
    case 'checkbox':
      return sql`${boolean(property)} ${direction}`
    default:
      return sql`${text(property)} ${direction} nulls last`
  }
}

/** The property a filter or sort names, or a refusal. Never trust the key that arrived. */
export function propertyFor(properties: Property[], key: string): Property {
  const found = properties.find((p) => p.key === key)
  if (!found) throw KernError.badRequest(`No such property: ${key}`)
  return found
}
