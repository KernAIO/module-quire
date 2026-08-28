/**
 * A CSV as a Quire database: columns with guessed types, and rows carrying values of those types.
 *
 * A Notion export writes one `.csv` per database — the same file you would get from a spreadsheet —
 * and a CSV has no types at all. Importing every column as text is the safe answer and the useless
 * one: a date column you cannot sort by date and a number column that sorts 10 before 9 are the two
 * complaints a database import gets, and both are the same complaint.
 *
 * **So the type is guessed, and the guess is reported.** Every column contributes a sentence to the
 * import report saying what it was read as and on what evidence — "Due: read as a date, from 12 of 12
 * values" — because a guess nobody is told about is indistinguishable from a mistake. The rules are
 * ordered from most specific to least and every one of them demands *every* non-empty value in the
 * column agree; one stray `n/a` in a date column makes it text, which is the right way round. A
 * column that is text is not a failure and does not say "failed": it is a column whose values did not
 * all look like anything narrower.
 *
 * What this file does **not** do is guess a relation, a rollup, a formula or a person. Each of those
 * names something outside the file — another database, another column, a member of this workspace —
 * and inventing one from a string of text is how an import produces a database that looks right and
 * computes nothing. They stay text, and the report says so.
 */
import type { PropertyConfig, PropertyType, SelectOption } from '../../contract/index.js'

/** Enough rows for the guess to mean something without reading a whole spreadsheet twice. */
const SAMPLE = 500

/** Above this a column of distinct strings is prose, not a set of choices. */
const MAX_OPTIONS = 40

/** A choice longer than this is a sentence somebody typed, not a label. */
const MAX_OPTION_LENGTH = 60

/**
 * RFC 4180, with the two departures every real file needs.
 *
 * A quoted field may hold newlines and `""` for a literal quote — that part is the specification. The
 * departures are that a lone `\r` or a `\r\n` both end a record (Excel writes one, Notion the other)
 * and that a stray quote inside an unquoted field is a character rather than an error, because the
 * alternative is refusing a file every other reader opens.
 */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let sawField = false

  const endField = () => {
    row.push(field)
    field = ''
    sawField = false
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quoted) {
      if (ch !== '"') {
        field += ch
        continue
      }
      if (source[i + 1] === '"') {
        field += '"'
        i++
        continue
      }
      quoted = false
      continue
    }
    if (ch === '"' && !sawField) {
      quoted = true
      sawField = true
      continue
    }
    if (ch === ',') {
      endField()
      continue
    }
    if (ch === '\r') {
      if (source[i + 1] === '\n') i++
      endRow()
      continue
    }
    if (ch === '\n') {
      endRow()
      continue
    }
    field += ch
    sawField = true
  }
  // A file ending in a newline has already closed its last row; anything else is still open.
  if (field.length > 0 || row.length > 0) endRow()

  // A trailing empty record is what a file ending in a newline leaves behind, and it is not a row.
  while (rows.length > 0 && rows.at(-1)!.every((value) => value.trim() === '')) rows.pop()
  return rows
}

const TRUE_WORDS = new Set(['yes', 'true', 'checked', 'done', 'y', '✓', '✔'])
const FALSE_WORDS = new Set(['no', 'false', 'unchecked', 'n', '✗', '✘'])

const RE_NUMBER = /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d*\.?\d+$/
const RE_CURRENCY = /^\s*([$£€¥₹﷼])\s*/
const RE_EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/
const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const RE_LONG_DATE = /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?)?$/
const RE_SLASH_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/

/** A value nobody filled in. Notion writes an empty cell; a spreadsheet sometimes writes a dash. */
const isEmpty = (value: string): boolean => value.trim() === '' || value.trim() === '-'

/** `2026-01-05`, `January 5, 2026`, `05/01/2026` — as the ISO string a date cell stores. */
export function parseDateValue(raw: string): string | null {
  const value = raw.trim()
  if (RE_ISO_DATE.test(value)) {
    const at = new Date(value.length === 10 ? `${value}T00:00:00Z` : value.replace(' ', 'T'))
    return Number.isNaN(at.getTime()) ? null : value.length === 10 ? value : at.toISOString()
  }
  if (RE_LONG_DATE.test(value) || RE_SLASH_DATE.test(value)) {
    const at = new Date(value)
    if (Number.isNaN(at.getTime())) return null
    // Date-only input has no time to keep, and a `date` cell draws the first ten characters.
    return /\d{1,2}:\d{2}/.test(value) ? at.toISOString() : at.toISOString().slice(0, 10)
  }
  return null
}

/** `1,234.50`, `$99`, `12%` — as the number a numeric sort and a rollup can use. */
export function parseNumberValue(
  raw: string,
): { value: number; percent: boolean; currency: string | null } | null {
  let value = raw.trim()
  const currency = RE_CURRENCY.exec(value)?.[1] ?? null
  if (currency) value = value.replace(RE_CURRENCY, '')
  const percent = value.endsWith('%')
  if (percent) value = value.slice(0, -1).trim()
  if (!RE_NUMBER.test(value)) return null
  const parsed = Number(value.replaceAll(',', ''))
  return Number.isFinite(parsed) ? { value: parsed, percent, currency } : null
}

/** An option id derived from its label, so the same choice keeps the same id across two imports. */
function optionId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'option'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/**
 * The palette a select column's choices are coloured from.
 *
 * Cycled rather than random: two imports of the same file produce the same colours, and a person
 * re-running an import after fixing one row does not find their board repainted.
 */
const OPTION_COLOURS = ['slate', 'accent', 'success', 'warning', 'danger', 'info']

export interface GuessedColumn {
  name: string
  type: PropertyType
  config: PropertyConfig
  /**
   * What the guess was and what it was made from, in one sentence for the report.
   *
   * Written here rather than at the call site because only this function knows the evidence — how
   * many values agreed, how many distinct choices there were — and a reason assembled later would
   * either repeat the rules or say less than it could.
   */
  note: string
}

/**
 * One column's type, from its values.
 *
 * The order is the whole algorithm: checkbox before number (`1` and `0` are both), number before
 * date (a bare year is a number), url and email before select (a column of six addresses is not six
 * choices), multi-select before select (a comma is the only thing that separates them), and select
 * before text (the fallback that is always true).
 */
export function guessColumn(name: string, rawValues: string[]): GuessedColumn {
  const values = rawValues.slice(0, SAMPLE).filter((value) => !isEmpty(value))
  const total = values.length
  const from = `from ${total} of ${rawValues.length} value${rawValues.length === 1 ? '' : 's'}`
  const plain = (type: PropertyType, what: string, config: PropertyConfig = {}): GuessedColumn => ({
    name,
    type,
    config,
    note: `${name}: read as ${what}, ${from}`,
  })

  if (total === 0)
    return {
      name,
      type: 'text',
      config: {},
      note: `${name}: read as text — the column has no values to judge`,
    }

  const lower = values.map((value) => value.trim().toLowerCase())
  if (lower.every((value) => TRUE_WORDS.has(value) || FALSE_WORDS.has(value)))
    return plain('checkbox', 'a checkbox')

  const numbers = values.map(parseNumberValue)
  if (numbers.every((n) => n !== null)) {
    const percent = numbers.every((n) => n!.percent)
    const currency = numbers.find((n) => n!.currency)?.currency ?? null
    const decimals = values.map((value) => (value.split('.')[1] ?? '').replace(/[^\d]/g, '').length)
    const config: PropertyConfig = {
      format: percent ? 'percent' : currency ? 'currency' : 'plain',
      precision: Math.min(8, Math.max(...decimals, 0)),
    }
    return plain('number', percent ? 'a percentage' : currency ? 'an amount of money' : 'a number', config)
  }

  if (values.every((value) => parseDateValue(value) !== null)) {
    const withTime = values.some((value) => /\d{1,2}:\d{2}/.test(value))
    return plain('date', withTime ? 'a date and time' : 'a date', { includeTime: withTime })
  }

  if (values.every((value) => /^https?:\/\/\S+$/i.test(value.trim()))) return plain('url', 'a link')
  if (values.every((value) => RE_EMAIL.test(value.trim()))) return plain('email', 'an email address')

  const options = (labels: string[]): { options: SelectOption[]; ids: Map<string, string> } => {
    const taken = new Set<string>()
    const ids = new Map<string, string>()
    const out: SelectOption[] = []
    labels.forEach((label, index) => {
      const id = optionId(label, taken)
      ids.set(label, id)
      out.push({ id, label, colour: OPTION_COLOURS[index % OPTION_COLOURS.length]! })
    })
    return { options: out, ids }
  }

  // A multi-select is a select whose cells hold more than one choice, so it is only worth guessing
  // when at least one cell actually does — otherwise every select with a comma in one label becomes
  // one, and the column silently stops matching an `equals` filter.
  if (values.some((value) => value.includes(','))) {
    const parts = [...new Set(values.flatMap((value) => splitChoices(value)))]
    if (parts.length > 0 && parts.length <= MAX_OPTIONS && parts.every((p) => p.length <= MAX_OPTION_LENGTH))
      return {
        name,
        type: 'multi_select',
        config: { options: options(parts).options },
        note: `${name}: read as a multi-select with ${parts.length} choices, ${from}`,
      }
  }

  const distinct = [...new Set(values.map((value) => value.trim()))]
  if (
    distinct.length <= MAX_OPTIONS &&
    distinct.length < total &&
    distinct.every((value) => value.length <= MAX_OPTION_LENGTH)
  )
    return {
      name,
      type: 'select',
      config: { options: options(distinct).options },
      note: `${name}: read as a select with ${distinct.length} choices, ${from}`,
    }

  return plain('text', 'text')
}

/** `Design, Urgent` → `['Design', 'Urgent']`, which is how every exporter writes a multi-select. */
export const splitChoices = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

/**
 * One cell, as the value the column's type stores.
 *
 * Null means "leave the key out of `props`" rather than "write null": an absent key is what every
 * other writer in this module produces for an empty cell, and a null would make a `not_contains`
 * filter behave differently for an imported row than for one somebody typed.
 *
 * `select` stores a **scalar** option id and `multi_select` an **array** of them, and the difference
 * is load-bearing rather than cosmetic: `query.ts` compares a select as text through `props->>'key'`,
 * so an array there stringifies to `["done"]` and matches no filter anybody can write. The cell
 * component reads either shape, which is exactly why this is easy to get wrong and invisible on screen.
 */
export function coerceValue(column: GuessedColumn, raw: string): unknown {
  if (isEmpty(raw)) return null
  const value = raw.trim()
  switch (column.type) {
    case 'checkbox':
      return TRUE_WORDS.has(value.toLowerCase())
    case 'number':
      return parseNumberValue(value)?.value ?? null
    case 'date':
      return parseDateValue(value)
    case 'select': {
      const option = (column.config.options ?? []).find((o) => o.label === value)
      return option ? option.id : null
    }
    case 'multi_select': {
      const wanted = splitChoices(value)
      const ids = wanted
        .map((label) => (column.config.options ?? []).find((o) => o.label === label)?.id)
        .filter((id): id is string => id !== undefined)
      return ids.length > 0 ? ids : null
    }
    default:
      return value
  }
}
