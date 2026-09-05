import type { MentionCandidate, PageCandidate } from '@kernhq/ui/editor'
import type { PageNode } from '../contract/index.js'
import type { Person } from './core-api.js'

/**
 * What the editor's `@` and `+` menus offer.
 *
 * The suggestion menus are installed by `@kernhq/ui`, but the *sources* are the host's: the design
 * system has no API client, so `mentionSource` and `pageSource` are the only way a candidate ever
 * reaches either list. Passing neither leaves both triggers installed and both menus empty — a
 * popup reading "Nothing matches that" on every `@` in the wiki, which is the state the page editor
 * shipped in. The lists themselves are here rather than in the component so they can be asserted
 * without a browser: a menu that returns nothing looks exactly like a menu nobody opened.
 *
 * `rankCandidates` in `@kernhq/ui` does the people half of this already, and is not used, for two
 * reasons: it ranks a `name`, not the `label` the editor speaks, and it has no notion of the second
 * line a page row carries. One ranking that serves both lists keeps the two menus behaving
 * identically, which is what somebody typing into them expects.
 */

/** How many rows either menu offers. A ninth match means typing another letter, not scrolling. */
export const SUGGEST_LIMIT = 8

/**
 * Case- and accent-insensitive, so `@jose` finds "José" and `+ubers` finds "Übersicht".
 *
 * The same fold `@kernhq/ui`'s `/` menu applies to its own labels. A wiki is written in five
 * languages here and a menu that only matches exact accents is a menu that fails for two of them.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
}

/**
 * How well one row answers the query — lower is better, and below zero is "not a match".
 *
 * A label that *starts* with what was typed beats one that merely contains it, because somebody
 * typing `@da` means Dan far more often than they mean Amanda; a word inside the label comes next,
 * so `@mir` finds "Navid Mirzaaghazadeh". The hint — a page's path, which is the only thing telling
 * two "Overview" pages apart — is matched too, but always below the label: a page whose *title*
 * matches is what was asked for, and one that matches only because of its grandparent's name is a
 * fallback.
 */
function score(label: string, hint: string | null, query: string): number {
  const l = fold(label)
  const h = hint ? fold(hint) : ''
  if (l.startsWith(query)) return 0
  if (l.split(/\s+/).some((word) => word.startsWith(query))) return 1
  if (l.includes(query)) return 2
  if (!h) return -1
  if (h.startsWith(query) || h.split(/[\s/]+/).some((word) => word.startsWith(query))) return 3
  if (h.includes(query)) return 4
  return -1
}

interface Row<T> {
  label: string
  hint: string | null
  item: T
}

/** Best first, then alphabetically, then cut. An empty query offers the list as it arrived. */
function rank<T>(rows: Array<Row<T>>, query: string, limit: number): T[] {
  const needle = fold(query.trim())
  if (!needle) return rows.slice(0, limit).map((row) => row.item)
  const scored: Array<{ row: Row<T>; score: number }> = []
  for (const row of rows) {
    const value = score(row.label, row.hint, needle)
    if (value >= 0) scored.push({ row, score: value })
  }
  scored.sort((a, b) => a.score - b.score || a.row.label.localeCompare(b.row.label))
  return scored.slice(0, limit).map((entry) => entry.row.item)
}

/**
 * The people an `@` offers, from the workspace's members.
 *
 * `Person` already carries the fallback that matters — a member with no display name is named by
 * their address rather than being unpickable — so this only has to rank and rename the fields the
 * editor speaks. The candidate's `id` is what ends up in the document, and it is a user id: a
 * mention is why somebody is notified, not a decoration on a name.
 */
export function personCandidates(
  people: readonly Person[],
  query: string,
  limit = SUGGEST_LIMIT,
): MentionCandidate[] {
  const rows = people.map((person) => ({
    label: person.name,
    hint: null,
    item: { id: person.id, label: person.name, avatarUrl: person.avatarUrl },
  }))
  return rank(rows, query, limit)
}

/** The icon a page row wears, chosen the way the sidebar chooses it — by kind, never by title. */
function iconFor(kind: PageNode['kind']): string {
  if (kind === 'live') return 'square-pen'
  if (kind === 'database') return 'database'
  return 'file-text'
}

export interface PageCandidateOptions {
  /** The page being written, which has no business linking to itself. */
  excludeId?: string | null
  /** What an unnamed page is called — `t('untitled')`, passed in so this file holds no strings. */
  untitled: string
  limit?: number
}

/**
 * The pages a `+` offers, from the tree of the space being written in.
 *
 * Every kind, not only a `page`: a link is not an include, so a database or a live doc is a
 * perfectly good thing to point at, and `pageHref` on the read side resolves all three. Archived
 * pages are left out — they are out of the sidebar, and linking one is how a reader reaches a
 * page nobody expects to be read.
 *
 * The scope is this space, because the space's tree is what the editor already holds and the
 * contract has no cross-space page search. A link to a page in another space is made through the
 * macro picker, which does have a space control.
 */
export function pageCandidates(
  nodes: readonly PageNode[],
  query: string,
  options: PageCandidateOptions,
): PageCandidate[] {
  const { excludeId = null, untitled, limit = SUGGEST_LIMIT } = options
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const rows = []
  for (const node of nodes) {
    if (node.archivedAt || node.id === excludeId) continue
    const title = node.title.trim() || untitled
    /*
     * The pages above it, so two "Overview" rows can be told apart. Bounded: a cycle would be a bug
     * in a move, and a menu that opens on every keystroke is not the place to hang on one.
     */
    const names: string[] = []
    let parent = node.parentId ? byId.get(node.parentId) : undefined
    for (let depth = 0; parent && depth < 8; depth++) {
      names.unshift(parent.title.trim() || untitled)
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    const hint = names.join(' / ') || null
    rows.push({
      label: title,
      hint,
      item: { id: node.id, label: title, hint, icon: iconFor(node.kind) },
    })
  }

  return rank(rows, query, limit)
}
