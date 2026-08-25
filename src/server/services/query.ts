import { KernError } from '@kernhq/kernel'
import { type SQL, sql } from 'drizzle-orm'
import type { Filter, Property, Sort } from '../../contract/index.js'

/**
 * Turning a view's filters and sorts into SQL over a row's `props` column.
 *
 * Done in SQL rather than in memory, because filtering after the fact breaks pagination: a page of
 * fifty rows filtered down to three is not a page of three, and the caller has no way to ask for
 * the rest. That means every comparison has to be expressible against `jsonb`.
 *
 * **A property key is never interpolated before it is looked up.** The key comes from the request,
 * and `props->>'…'` is a string in the query text rather than a parameter — so the only safe path is
 * to find the property first and use the key the *database* already knows about. An unknown key is
 * refused rather than passed through.
 */

const numeric = (key: string) => sql`nullif(props->>${key}, '')::numeric`
const timestamp = (key: string) => sql`nullif(props->>${key}, '')::timestamptz`
const text = (key: string) => sql`props->>${key}`

/** Whether a value is "nothing" — absent, null, empty string, or an empty array. */
const emptyExpr = (key: string) =>
  sql`(props->${key} is null or props->>${key} = '' or props->${key} = '[]'::jsonb or props->${key} = 'null'::jsonb)`

export function filterToSql(filter: Filter, property: Property): SQL | null {
  const key = property.key
  const value = filter.value

  switch (filter.operator) {
    case 'is_empty':
      return emptyExpr(key)
    case 'is_not_empty':
      return sql`not ${emptyExpr(key)}`
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
          return sql`${numeric(key)} = ${n}`
        case 'not_equals':
          return sql`${numeric(key)} is distinct from ${n}`
        case 'greater_than':
          return sql`${numeric(key)} > ${n}`
        case 'less_than':
          return sql`${numeric(key)} < ${n}`
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
          return sql`date_trunc('day', ${timestamp(key)}) = date_trunc('day', ${at}::timestamptz)`
        case 'on_or_before':
          return sql`${timestamp(key)} <= ${at}::timestamptz`
        case 'on_or_after':
          return sql`${timestamp(key)} >= ${at}::timestamptz`
        case 'greater_than':
          return sql`${timestamp(key)} > ${at}::timestamptz`
        case 'less_than':
          return sql`${timestamp(key)} < ${at}::timestamptz`
        default:
          return null
      }
    }

    case 'checkbox': {
      const wanted = value === true || value === 'true'
      // An unset checkbox is false, not null: a filter for "not done" must include rows nobody has
      // touched, which is most of them.
      return wanted
        ? sql`(props->>${key})::boolean is true`
        : sql`coalesce((props->>${key})::boolean, false) is false`
    }

    case 'multi_select':
    case 'person':
    case 'files':
    case 'relation': {
      // Array-valued. `?` asks whether the array contains a string; `?|` whether it contains any.
      const many = Array.isArray(value) ? value.map(String) : [String(value)]
      switch (filter.operator) {
        case 'contains':
        case 'is_any_of':
          return sql`props->${key} ?| ${sql.param(many)}::text[]`
        case 'not_contains':
        case 'is_none_of':
          return sql`not (props->${key} ?| ${sql.param(many)}::text[])`
        default:
          return null
      }
    }

    default: {
      // Everything else compares as text.
      const v = value === null || value === undefined ? '' : String(value)
      switch (filter.operator) {
        case 'equals':
          return sql`${text(key)} = ${v}`
        case 'not_equals':
          return sql`${text(key)} is distinct from ${v}`
        case 'contains':
          return sql`${text(key)} ilike ${`%${v}%`}`
        case 'not_contains':
          return sql`coalesce(${text(key)}, '') not ilike ${`%${v}%`}`
        case 'starts_with':
          return sql`${text(key)} ilike ${`${v}%`}`
        case 'ends_with':
          return sql`${text(key)} ilike ${`%${v}`}`
        case 'is_any_of':
          return sql`${text(key)} = any(${sql.param(Array.isArray(value) ? value.map(String) : [v])}::text[])`
        case 'is_none_of':
          return sql`coalesce(${text(key)}, '') <> all(${sql.param(Array.isArray(value) ? value.map(String) : [v])}::text[])`
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
  const key = property.key
  const direction = sort.direction === 'desc' ? sql`desc` : sql`asc`
  switch (property.type) {
    case 'number':
    case 'formula':
    case 'rollup':
      return sql`${numeric(key)} ${direction} nulls last`
    case 'date':
    case 'created_time':
    case 'edited_time':
      return sql`${timestamp(key)} ${direction} nulls last`
    case 'checkbox':
      return sql`coalesce((props->>${key})::boolean, false) ${direction}`
    default:
      return sql`${text(key)} ${direction} nulls last`
  }
}

/** The property a filter or sort names, or a refusal. Never trust the key that arrived. */
export function propertyFor(properties: Property[], key: string): Property {
  const found = properties.find((p) => p.key === key)
  if (!found) throw KernError.badRequest(`No such property: ${key}`)
  return found
}
