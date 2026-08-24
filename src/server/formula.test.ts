/**
 * The formula language.
 *
 * The first test is the one that matters: a formula is text a workspace member types and the server
 * evaluates. If it ever reaches `eval` or `new Function`, everything else here is irrelevant.
 */
import { describe, expect, it } from 'vitest'
import { evaluateFormula, type FormulaValue, formulaDependencies, parseFormula } from './formula.js'

const run = (src: string, props: Record<string, FormulaValue> = {}) =>
  evaluateFormula(parseFormula(src), { prop: (n) => props[n] ?? null })

describe('what a formula cannot do', () => {
  it('refuses anything that is not in the function table', () => {
    for (const attack of [
      'constructor("return 1")()',
      'process.exit(1)',
      'require("fs")',
      'globalThis',
      'eval("1")',
    ]) {
      expect(() => parseFormula(attack), attack).toThrow()
    }
  })

  it('refuses a formula that nests beyond the limit rather than blowing the stack', () => {
    const deep = `${'abs('.repeat(200)}1${')'.repeat(200)}`
    expect(() => run(deep)).toThrow(/nests too deeply/i)
  })

  it('refuses an unterminated string and a stray character', () => {
    expect(() => parseFormula('concat("oops')).toThrow()
    expect(() => parseFormula('1 § 2')).toThrow()
  })
})

describe('arithmetic and precedence', () => {
  it('binds multiplication tighter than addition', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
  })

  it('treats ^ as right-associative', () => {
    expect(run('2 ^ 3 ^ 2')).toBe(512)
  })

  it('gives a blank rather than Infinity when dividing by nothing', () => {
    expect(run('1 / 0')).toBeNull()
    expect(run('1 % 0')).toBeNull()
  })

  it('negates', () => {
    expect(run('-3 + 1')).toBe(-2)
  })
})

describe('text and numbers together', () => {
  it('concatenates when either side is text, and adds when neither is', () => {
    expect(run('"a" + 1')).toBe('a1')
    expect(run('1 + 1')).toBe(2)
  })

  it('reads a property by the name somebody typed', () => {
    expect(run('prop("Estimate") * 2', { Estimate: 4 })).toBe(8)
    expect(run('prop("Nothing") + 1')).toBe(1)
  })
})

describe('logic', () => {
  it('short-circuits, so the right side of a false && is never evaluated', () => {
    let touched = false
    const ast = parseFormula('false && prop("x")')
    evaluateFormula(ast, {
      prop: () => {
        touched = true
        return 1
      },
    })
    expect(touched).toBe(false)
  })

  it('chooses with if()', () => {
    expect(run('if(prop("Done"), "yes", "no")', { Done: true })).toBe('yes')
    expect(run('if(prop("Done"), "yes", "no")', { Done: false })).toBe('no')
  })

  it('treats = and == the same, because both are what people type', () => {
    expect(run('1 = 1')).toBe(true)
    expect(run('1 == 1')).toBe(true)
  })
})

describe('functions', () => {
  it('does text', () => {
    expect(run('upper(concat("ab", "c"))')).toBe('ABC')
    expect(run('length("hello")')).toBe(5)
    expect(run('replace("a-b", "-", "+")')).toBe('a+b')
  })

  it('does numbers', () => {
    expect(run('round(3.14159, 2)')).toBe(3.14)
    expect(run('max(1, 9, 3)')).toBe(9)
    expect(run('sum(1, 2, 3)')).toBe(6)
  })

  it('counts days between two dates', () => {
    expect(run('dateBetween("2026-01-01", "2026-01-11")')).toBe(10)
  })

  it('finds a function whatever case it was typed in', () => {
    // Names are camelCase for readability but a person typing one should not have to remember
    // that. Lowercasing at the lookup rather than at the key is what keeps them reachable.
    expect(run('datebetween("2026-01-01", "2026-01-03")')).toBe(2)
    expect(run('DATEBETWEEN("2026-01-01", "2026-01-03")')).toBe(2)
    expect(run('toNumber("42") + 1')).toBe(43)
    expect(run('isEmpty(prop("nothing"))')).toBe(true)
  })
})

describe('dependencies', () => {
  it('reports every property a formula reads, so a change recomputes only what depends on it', () => {
    const ast = parseFormula('if(prop("A") > 1, prop("B"), prop("C") + prop("A"))')
    expect([...formulaDependencies(ast)].sort()).toEqual(['A', 'B', 'C'])
  })
})
