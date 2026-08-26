/**
 * `updateView` replaces `config` wholesale, so every one of these assertions is about the same
 * failure: a write that carried a fragment and silently deleted the rest of somebody's view.
 */
import { describe, expect, it } from 'vitest'
import type { Database, Filter, Property, Row, Sort, ViewConfig } from '../../contract/index.js'
import {
  columnTemplate,
  EMPTY_GROUP,
  groupsOf,
  groupValue,
  mergeConfig,
  visiblePropertiesOf,
} from './view-config.js'

const config = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  filters: [],
  filterMode: 'and',
  sorts: [],
  groupBy: null,
  dateProperty: null,
  visibleProperties: null,
  columnWidths: {},
  cardSize: 'medium',
  coverProperty: null,
  ...over,
})

const property = (key: string, over: Partial<Property> = {}): Property =>
  ({
    id: `p-${key}`,
    databaseId: 'db',
    key,
    name: key,
    type: 'text',
    config: {},
    position: key,
    hidden: false,
    ...over,
  }) as Property

const row = (id: string, props: Record<string, unknown>): Row =>
  ({
    id,
    databaseId: 'db',
    title: id,
    icon: null,
    props,
    computed: {},
    createdBy: null,
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
  }) as Row

describe('mergeConfig', () => {
  it('keeps everything the patch does not mention', () => {
    const filter: Filter = { propertyKey: 'status', operator: 'equals', value: 'done' }
    const merged = mergeConfig(config({ filters: [filter], groupBy: 'status', cardSize: 'large' }), {
      sorts: [],
    })
    expect(merged.filters, 'a partial write deleted the filters — the whole point of this helper').toEqual([
      filter,
    ])
    expect(merged.groupBy).toBe('status')
    expect(merged.cardSize).toBe('large')
  })

  it('lets a patch clear a nullable field rather than treating null as absent', () => {
    const merged = mergeConfig(config({ groupBy: 'status', coverProperty: 'cover' }), { groupBy: null })
    expect(merged.groupBy).toBeNull()
    expect(merged.coverProperty, 'only groupBy was cleared').toBe('cover')
  })

  it('replaces a list wholesale, because that is what removing a sort means', () => {
    const sort: Sort = { propertyKey: 'n', direction: 'asc' }
    expect(mergeConfig(config({ sorts: [sort] }), { sorts: [] }).sorts).toEqual([])
  })
})

describe('visiblePropertiesOf', () => {
  const database = {
    properties: [
      property('b', { position: 'b' }),
      property('a', { position: 'a' }),
      property('c', { position: 'c', hidden: true }),
    ],
  } as Database

  it('means every non-hidden column, in position order, when nobody has chosen', () => {
    const view = { config: config() } as never
    expect(visiblePropertiesOf(database, view).map((p) => p.key)).toEqual(['a', 'b'])
  })

  it('draws nothing but what was chosen once somebody has', () => {
    const view = { config: config({ visibleProperties: ['b'] }) } as never
    expect(visiblePropertiesOf(database, view).map((p) => p.key)).toEqual(['b'])
  })

  it('falls back to every column when there is no view yet', () => {
    expect(visiblePropertiesOf(database, null).map((p) => p.key)).toEqual(['a', 'b'])
  })
})

describe('columnTemplate', () => {
  it('gives the title the flexible track and every other column its stored width', () => {
    expect(columnTemplate([property('a'), property('b')], { a: 260 })).toBe(
      'minmax(240px, 1fr) 260px 180px 84px',
    )
  })

  it('refuses a width nobody could read', () => {
    expect(columnTemplate([property('a')], { a: 4 })).toContain('90px')
  })
})

describe('groupsOf', () => {
  const status = property('status', {
    type: 'status',
    config: {
      options: [
        { id: 'todo', label: 'To do', colour: 'slate' },
        { id: 'doing', label: 'Doing', colour: 'accent' },
      ],
    },
  })

  it('keeps the option lanes in declaration order and puts the uncategorised one last', () => {
    const lanes = groupsOf(status, [row('r1', { status: 'doing' }), row('r2', {})])
    expect(lanes.map((l) => l.id)).toEqual(['todo', 'doing', EMPTY_GROUP])
    expect(lanes[1]?.rows.map((r) => r.id)).toEqual(['r1'])
  })

  it('puts a row with no value in the uncategorised lane rather than dropping it', () => {
    const lanes = groupsOf(status, [row('r2', { status: null }), row('r3', {})])
    expect(lanes.at(-1)?.rows.map((r) => r.id)).toEqual(['r2', 'r3'])
  })

  it('puts a row whose value names no option in the uncategorised lane, never nowhere', () => {
    const lanes = groupsOf(status, [row('r4', { status: 'deleted-option' })])
    expect(lanes.at(-1)?.rows.map((r) => r.id)).toEqual(['r4'])
  })

  it('reads the uncategorised lane as clearing the value', () => {
    expect(groupValue(EMPTY_GROUP)).toBeNull()
    expect(groupValue('doing')).toBe('doing')
  })
})
