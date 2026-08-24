/**
 * The ordering invariants a page tree depends on.
 *
 * This algorithm is duplicated from the tracker on purpose — modules do not import one another — so
 * it carries its own test rather than trusting that the original still holds.
 */
import { describe, expect, it } from 'vitest'
import { initialRank, isValidRank, rankBetween, rankSequence } from './rank.js'

describe('rankBetween', () => {
  it('lands strictly between its neighbours', () => {
    const a = initialRank()
    const c = rankBetween(a, null)
    const b = rankBetween(a, c)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it('opens either end', () => {
    const first = initialRank()
    expect(rankBetween(null, first) < first).toBe(true)
    expect(rankBetween(first, null) > first).toBe(true)
  })

  it('refuses neighbours that are the wrong way round', () => {
    const a = initialRank()
    const b = rankBetween(a, null)
    expect(() => rankBetween(b, a)).toThrow()
  })

  it('keeps finding room, however many times the same gap is split', () => {
    // The failure this guards against is a key that runs out of precision and starts colliding, so
    // two pages dropped in the same place end up in an order nobody chose.
    let lo = initialRank()
    const hi = rankBetween(lo, null)
    const seen = new Set<string>([lo, hi])
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(lo, hi)
      expect(lo < mid, `${lo} < ${mid} failed at split ${i}`).toBe(true)
      expect(mid < hi, `${mid} < ${hi} failed at split ${i}`).toBe(true)
      expect(seen.has(mid), `collision at split ${i}`).toBe(false)
      expect(isValidRank(mid)).toBe(true)
      seen.add(mid)
      lo = mid
    }
  })

  it('never mints a key ending in the lowest digit, so there is always room below', () => {
    let prev: string | null = null
    for (let i = 0; i < 50; i++) {
      const next: string = rankBetween(prev, null)
      expect(isValidRank(next)).toBe(true)
      prev = next
    }
  })
})

describe('rankSequence', () => {
  it('produces keys that already sort into the order they were asked for', () => {
    const keys = rankSequence(25)
    expect(keys).toHaveLength(25)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(25)
  })
})
