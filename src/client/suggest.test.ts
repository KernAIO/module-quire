/**
 * The two lists behind the editor's `@` and `+` menus.
 *
 * These assertions exist because of how this fails when it is wrong: the menus are installed by
 * `@kernhq/ui` whether or not a source is passed, so a missing source is not an error anywhere —
 * it is a popup that opens on every `@` in the wiki and says "Nothing matches that". A list that
 * returns nothing and a menu nobody wired up look identical from the outside, which is why the
 * lists are asserted here rather than left to a screenshot.
 */
import { describe, expect, it } from 'vitest'
import type { PageNode } from '../contract/index.js'
import { toPerson } from './core-api.js'
import { pageCandidates, personCandidates, SUGGEST_LIMIT } from './suggest.js'

const person = (id: string, name: string) => ({ id, name, avatarUrl: null })

const people = [
  person('u1', 'Ada Lovelace'),
  person('u2', 'Amanda Reyes'),
  person('u3', 'Dan Ortega'),
  person('u4', 'José Álvarez'),
]

const node = (over: Partial<PageNode> & { id: string; title: string }): PageNode => ({
  parentId: null,
  position: 'a',
  kind: 'page',
  icon: null,
  hasChildren: false,
  archivedAt: null,
  excludedFromPublic: false,
  hasPublishedVersion: false,
  ...over,
})

describe('the people an @ offers', () => {
  it('answers with the workspace members', () => {
    const found = personCandidates(people, 'ada')
    expect(found).toEqual([{ id: 'u1', label: 'Ada Lovelace', avatarUrl: null }])
  })

  it('offers everybody before anything is typed', () => {
    expect(personCandidates(people, '').map((c) => c.id)).toEqual(['u1', 'u2', 'u3', 'u4'])
  })

  it('puts the name that starts with the query above the one that contains it', () => {
    expect(personCandidates(people, 'da')[0]?.id).toBe('u3')
  })

  it('matches a surname, so @lov finds Ada', () => {
    expect(personCandidates(people, 'lov')[0]?.id).toBe('u1')
  })

  it('ignores accents in both directions', () => {
    expect(personCandidates(people, 'jose')[0]?.id).toBe('u4')
    expect(personCandidates(people, 'álv')[0]?.id).toBe('u4')
  })

  it('offers a member with no display name, under their address', () => {
    const nameless = toPerson({
      userId: 'u9',
      user: { id: 'u9', name: null, email: 'quiet@example.com' },
    })
    expect(personCandidates([nameless], 'quiet')).toEqual([
      { id: 'u9', label: 'quiet@example.com', avatarUrl: null },
    ])
  })

  it('stops at the row limit rather than filling the screen', () => {
    const many = Array.from({ length: 30 }, (_, i) => person(`u${i}`, `Person ${i}`))
    expect(personCandidates(many, 'person')).toHaveLength(SUGGEST_LIMIT)
  })

  it('answers with nothing only when nobody matches', () => {
    expect(personCandidates(people, 'zzz')).toEqual([])
  })
})

describe('the pages a + offers', () => {
  const tree: PageNode[] = [
    node({ id: 'p1', title: 'Handbook' }),
    node({ id: 'p2', title: 'Working here', parentId: 'p1' }),
    node({ id: 'p3', title: 'Overview', parentId: 'p2' }),
    node({ id: 'p4', title: '', parentId: 'p1' }),
    node({ id: 'p5', title: 'Old policy', archivedAt: '2026-01-01T00:00:00.000Z' }),
    node({ id: 'p6', title: 'Roadmap', kind: 'database' }),
    node({ id: 'p7', title: 'Standup', kind: 'live' }),
  ]
  const opts = { untitled: 'Untitled' }

  it('answers with the pages of the space', () => {
    expect(pageCandidates(tree, 'over', opts)).toEqual([
      { id: 'p3', label: 'Overview', hint: 'Handbook / Working here', icon: 'file-text' },
    ])
  })

  it('names an untitled page rather than dropping it', () => {
    expect(pageCandidates(tree, 'untitled', opts)[0]?.id).toBe('p4')
  })

  it('leaves out an archived page', () => {
    expect(pageCandidates(tree, 'policy', opts)).toEqual([])
  })

  it('leaves out the page being written', () => {
    expect(pageCandidates(tree, 'over', { ...opts, excludeId: 'p3' })).toEqual([])
  })

  it('offers a database and a live doc, with their own icons', () => {
    expect(pageCandidates(tree, 'roadmap', opts)[0]?.icon).toBe('database')
    expect(pageCandidates(tree, 'standup', opts)[0]?.icon).toBe('square-pen')
  })

  it('matches the path, so a page is findable by the section it is in', () => {
    expect(pageCandidates(tree, 'working', opts).map((c) => c.id)).toEqual(['p2', 'p3'])
  })

  it('ranks a title match above a path match', () => {
    const both = [node({ id: 'a', title: 'Notes' }), node({ id: 'b', title: 'Index', parentId: 'a' })]
    expect(pageCandidates(both, 'notes', opts).map((c) => c.id)).toEqual(['a', 'b'])
  })
})
