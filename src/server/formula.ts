/**
 * The formula language.
 *
 * A hand-written Pratt parser to a typed AST, evaluated by walking it. **Never `eval`, never `new
 * Function`** — a formula is text a workspace member types, it is evaluated on the server, and
 * handing that to the JavaScript engine is arbitrary code execution with the database connection
 * already open.
 *
 * The language is deliberately small: numbers, strings, booleans, dates, `prop("Name")`, the usual
 * operators, and a fixed function table. Anything it cannot express is a column somebody can fill
 * in by hand, which is a better outcome than a language nobody can predict the cost of.
 */

export type FormulaValue = number | string | boolean | Date | null

export type Ast =
  | { kind: 'literal'; value: FormulaValue }
  | { kind: 'prop'; name: string }
  | { kind: 'unary'; op: '-' | 'not'; operand: Ast }
  | { kind: 'binary'; op: string; left: Ast; right: Ast }
  | { kind: 'call'; name: string; args: Ast[] }
  /**
   * Deliberately **not** named `then`/`else`.
   *
   * An object with a `then` property is *thenable*: `await` and `Promise.resolve()` call it as a
   * promise. This node's `then` would be an AST node rather than a function, so the moment one of
   * these is returned from an `async` function the runtime stops treating it as data — silently,
   * with no error where the mistake is. `consequent`/`alternate` is the standard naming and costs
   * nothing.
   */
  | { kind: 'if'; cond: Ast; consequent: Ast; alternate: Ast }

export class FormulaError extends Error {}

/** ---- lexer ---- */

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'end' }

const OPERATORS = [
  '>=',
  '<=',
  '!=',
  '==',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '>',
  '<',
  '=',
  '(',
  ')',
  ',',
]

function lex(input: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i] as string
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j++
      const raw = input.slice(i, j)
      const v = Number(raw)
      if (Number.isNaN(v)) throw new FormulaError(`Not a number: ${raw}`)
      out.push({ t: 'num', v })
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let v = ''
      while (j < input.length && input[j] !== c) {
        if (input[j] === '\\' && j + 1 < input.length) {
          v += input[j + 1]
          j += 2
          continue
        }
        v += input[j]
        j++
      }
      if (j >= input.length) throw new FormulaError('Unterminated string')
      out.push({ t: 'str', v })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j++
      out.push({ t: 'name', v: input.slice(i, j) })
      i = j
      continue
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i))
    if (!op) throw new FormulaError(`Unexpected character: ${c}`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  out.push({ t: 'end' })
  return out
}

/** ---- parser ---- */

/** Binding power per infix operator. Higher binds tighter. */
const BINDING: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '=': 3,
  '!=': 3,
  '>': 4,
  '<': 4,
  '>=': 4,
  '<=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 7,
}

export function parseFormula(input: string): Ast {
  const tokens = lex(input)
  let pos = 0
  const peek = () => tokens[pos] as Token
  const next = () => tokens[pos++] as Token

  function parseExpression(minBinding = 0): Ast {
    let left = parsePrefix()
    for (;;) {
      const token = peek()
      if (token.t !== 'op') break
      const binding = BINDING[token.v]
      if (binding === undefined || binding < minBinding) break
      next()
      // `^` is right-associative; everything else groups to the left.
      const right = parseExpression(token.v === '^' ? binding : binding + 1)
      left = { kind: 'binary', op: token.v === '=' ? '==' : token.v, left, right }
    }
    return left
  }

  function parsePrefix(): Ast {
    const token = next()
    if (token.t === 'num' || token.t === 'str') return { kind: 'literal', value: token.v }
    if (token.t === 'op' && token.v === '-') return { kind: 'unary', op: '-', operand: parseExpression(6) }
    if (token.t === 'op' && token.v === '(') {
      const inner = parseExpression()
      expect(')')
      return inner
    }
    if (token.t === 'name') {
      const name = token.v.toLowerCase()
      const after = peek()
      if (after.t !== 'op' || after.v !== '(') {
        if (name === 'true') return { kind: 'literal', value: true }
        if (name === 'false') return { kind: 'literal', value: false }
        if (name === 'null' || name === 'empty') return { kind: 'literal', value: null }
        throw new FormulaError(`Unknown name: ${token.v}`)
      }
      next()
      const args: Ast[] = []
      if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
        for (;;) {
          args.push(parseExpression())
          const sep = peek()
          if (sep.t === 'op' && sep.v === ',') {
            next()
            continue
          }
          break
        }
      }
      expect(')')
      if (name === 'not')
        return { kind: 'unary', op: 'not', operand: args[0] ?? { kind: 'literal', value: null } }
      if (name === 'if') {
        if (args.length !== 3) throw new FormulaError('if() takes a condition and two results')
        return { kind: 'if', cond: args[0]!, consequent: args[1]!, alternate: args[2]! }
      }
      if (name === 'prop') {
        const arg = args[0]
        if (!arg || arg.kind !== 'literal' || typeof arg.value !== 'string')
          throw new FormulaError('prop() takes the name of a property, in quotes')
        return { kind: 'prop', name: arg.value }
      }
      const fn = lookupFunction(name)
      if (!fn) throw new FormulaError(`Unknown function: ${token.v}`)
      return { kind: 'call', name: fn, args }
    }
    throw new FormulaError('Unexpected end of formula')
  }

  function expect(op: string) {
    const token = next()
    if (token.t !== 'op' || token.v !== op) throw new FormulaError(`Expected ${op}`)
  }

  const ast = parseExpression()
  if (peek().t !== 'end') throw new FormulaError('Unexpected trailing input')
  return ast
}

/** ---- evaluator ---- */

const num = (v: FormulaValue): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return 0
}
const str = (v: FormulaValue): string => {
  if (v === null) return ''
  if (v instanceof Date) return v.toISOString()
  return String(v)
}
const bool = (v: FormulaValue): boolean => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  return v !== null
}

/**
 * The function table.
 *
 * Looked up case-insensitively — `dateBetween`, `datebetween` and `DATEBETWEEN` are the same
 * function, because a formula is typed by a person and nobody should have to remember which of
 * these is a name and which is a typo. The names are written in camelCase here for readability and
 * normalised on lookup; keying the object directly by the lowercased name would have made every
 * camelCase function silently unreachable.
 */
const FUNCTIONS: Record<string, (args: FormulaValue[]) => FormulaValue> = {
  // text
  concat: (a) => a.map(str).join(''),
  join: (a) =>
    a
      .slice(1)
      .map(str)
      .join(str(a[0] ?? '')),
  length: (a) => str(a[0] ?? null).length,
  lower: (a) => str(a[0] ?? null).toLowerCase(),
  upper: (a) => str(a[0] ?? null).toUpperCase(),
  trim: (a) => str(a[0] ?? null).trim(),
  contains: (a) => str(a[0] ?? null).includes(str(a[1] ?? null)),
  replace: (a) =>
    str(a[0] ?? null)
      .split(str(a[1] ?? null))
      .join(str(a[2] ?? null)),
  slice: (a) => str(a[0] ?? null).slice(num(a[1] ?? 0), a[2] === undefined ? undefined : num(a[2])),
  format: (a) => str(a[0] ?? null),
  // number
  abs: (a) => Math.abs(num(a[0] ?? 0)),
  round: (a) => {
    const p = 10 ** num(a[1] ?? 0)
    return Math.round(num(a[0] ?? 0) * p) / p
  },
  floor: (a) => Math.floor(num(a[0] ?? 0)),
  ceil: (a) => Math.ceil(num(a[0] ?? 0)),
  sqrt: (a) => Math.sqrt(num(a[0] ?? 0)),
  min: (a) => (a.length ? Math.min(...a.map(num)) : 0),
  max: (a) => (a.length ? Math.max(...a.map(num)) : 0),
  sum: (a) => a.reduce<number>((t, v) => t + num(v), 0),
  average: (a) => (a.length ? a.reduce<number>((t, v) => t + num(v), 0) / a.length : 0),
  toNumber: (a) => num(a[0] ?? null),
  // logic
  and: (a) => a.every(bool),
  or: (a) => a.some(bool),
  equal: (a) => str(a[0] ?? null) === str(a[1] ?? null),
  // dates
  now: () => new Date(),
  today: () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  },
  year: (a) => asDate(a[0] ?? null)?.getFullYear() ?? 0,
  month: (a) => (asDate(a[0] ?? null)?.getMonth() ?? -1) + 1,
  day: (a) => asDate(a[0] ?? null)?.getDate() ?? 0,
  /** whole days between two dates; negative when the second is earlier */
  dateBetween: (a) => {
    const from = asDate(a[0] ?? null)
    const to = asDate(a[1] ?? null)
    if (!from || !to) return 0
    return Math.round((to.getTime() - from.getTime()) / 86_400_000)
  },
  dateAdd: (a) => {
    const d = asDate(a[0] ?? null)
    if (!d) return null
    return new Date(d.getTime() + num(a[1] ?? 0) * 86_400_000)
  },
  // general
  isEmpty: (a) => {
    const v = a[0] ?? null
    return v === null || v === '' || (Array.isArray(v) && v.length === 0)
  },
}

/** The canonical name of a function, whatever case it was typed in. */
const FUNCTION_NAMES = new Map<string, string>()
function lookupFunction(name: string): string | null {
  if (FUNCTION_NAMES.size === 0) {
    for (const key of Object.keys(FUNCTIONS)) FUNCTION_NAMES.set(key.toLowerCase(), key)
  }
  return FUNCTION_NAMES.get(name.toLowerCase()) ?? null
}

function asDate(v: FormulaValue): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'number') return new Date(v)
  return null
}

export interface FormulaContext {
  /** the value of a column by *name*, because that is what somebody types in a formula */
  prop(name: string): FormulaValue
}

/** How deep a formula may nest before it is refused, so a pathological one cannot blow the stack. */
const MAX_DEPTH = 64

export function evaluateFormula(ast: Ast, ctx: FormulaContext, depth = 0): FormulaValue {
  if (depth > MAX_DEPTH) throw new FormulaError('This formula nests too deeply')
  const evaluate = (node: Ast) => evaluateFormula(node, ctx, depth + 1)

  switch (ast.kind) {
    case 'literal':
      return ast.value
    case 'prop':
      return ctx.prop(ast.name)
    case 'unary':
      return ast.op === '-' ? -num(evaluate(ast.operand)) : !bool(evaluate(ast.operand))
    case 'if':
      return bool(evaluate(ast.cond)) ? evaluate(ast.consequent) : evaluate(ast.alternate)
    case 'call': {
      const fn = FUNCTIONS[ast.name]
      if (!fn) throw new FormulaError(`Unknown function: ${ast.name}`)
      return fn(ast.args.map(evaluate))
    }
    case 'binary': {
      // Short-circuit before evaluating the right side, so `false && prop("x")` never touches x.
      if (ast.op === '&&') return bool(evaluate(ast.left)) ? bool(evaluate(ast.right)) : false
      if (ast.op === '||') return bool(evaluate(ast.left)) ? true : bool(evaluate(ast.right))
      const l = evaluate(ast.left)
      const r = evaluate(ast.right)
      switch (ast.op) {
        case '+':
          // `+` concatenates when either side is text, which is what somebody writing a label wants.
          return typeof l === 'string' || typeof r === 'string' ? str(l) + str(r) : num(l) + num(r)
        case '-':
          return num(l) - num(r)
        case '*':
          return num(l) * num(r)
        case '/':
          // Dividing by nothing is a blank cell, not Infinity and not a crashed table.
          return num(r) === 0 ? null : num(l) / num(r)
        case '%':
          return num(r) === 0 ? null : num(l) % num(r)
        case '^':
          return num(l) ** num(r)
        case '==':
          return str(l) === str(r)
        case '!=':
          return str(l) !== str(r)
        case '>':
          return num(l) > num(r)
        case '<':
          return num(l) < num(r)
        case '>=':
          return num(l) >= num(r)
        case '<=':
          return num(l) <= num(r)
        default:
          throw new FormulaError(`Unknown operator: ${ast.op}`)
      }
    }
  }
}

/** Which columns a formula reads, so a change to one of them can recompute exactly what depends on it. */
export function formulaDependencies(ast: Ast, out = new Set<string>()): Set<string> {
  switch (ast.kind) {
    case 'prop':
      out.add(ast.name)
      break
    case 'unary':
      formulaDependencies(ast.operand, out)
      break
    case 'binary':
      formulaDependencies(ast.left, out)
      formulaDependencies(ast.right, out)
      break
    case 'if':
      formulaDependencies(ast.cond, out)
      formulaDependencies(ast.consequent, out)
      formulaDependencies(ast.alternate, out)
      break
    case 'call':
      for (const arg of ast.args) formulaDependencies(arg, out)
      break
  }
  return out
}
