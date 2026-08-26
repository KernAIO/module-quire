/**
 * The property-type table is what every branch in the database interface reads instead of
 * re-switching on the type. These assertions are about the two ways it can be wrong and nothing
 * will say so: a type with no entry (which draws nothing), and an operator offered for a column
 * that cannot answer it (which silently matches no rows).
 */
import { describe, expect, it } from 'vitest'
import { PropertyType } from '../../contract/index.js'
import {
  CREATABLE_TYPES,
  descriptorFor,
  isReadOnly,
  operatorsFor,
  PROPERTY_TYPES,
  VIEW_KINDS,
} from './property-types.js'

describe('the property type table', () => {
  it('describes every type the contract declares', () => {
    for (const type of PropertyType.options) {
      const descriptor = descriptorFor(type)
      expect(descriptor, `${type} has no descriptor, so its column draws nothing`).toBeDefined()
      expect(descriptor.icon.length, `${type} icon`).toBeGreaterThan(0)
    }
    expect(Object.keys(PROPERTY_TYPES).sort()).toEqual([...PropertyType.options].sort())
  })

  it('marks exactly the server-written types read-only', () => {
    const readOnly = PropertyType.options.filter((t) => isReadOnly(t)).sort()
    expect(readOnly).toEqual(
      ['created_by', 'created_time', 'edited_by', 'edited_time', 'files', 'formula', 'rollup'].sort(),
    )
  })

  it('offers a checkbox equality and not a substring', () => {
    expect(operatorsFor('checkbox')).toContain('equals')
    expect(operatorsFor('checkbox')).not.toContain('contains')
  })

  it('offers a multi-select membership and not a prefix', () => {
    expect(operatorsFor('multi_select')).toContain('is_any_of')
    expect(operatorsFor('multi_select')).not.toContain('starts_with')
  })

  it('never offers an operator with no value editor for a type that needs one', () => {
    for (const type of PropertyType.options)
      expect(operatorsFor(type).length, `${type} can be filtered by nothing at all`).toBeGreaterThan(0)
  })

  it('keeps files out of the picker, because nothing can fill one', () => {
    expect(CREATABLE_TYPES).not.toContain('files')
    expect(CREATABLE_TYPES).toContain('text')
  })

  it('only groups a board by a column whose values are a closed set', () => {
    const groupable = PropertyType.options.filter((t) => descriptorFor(t).canGroup).sort()
    expect(groupable).toEqual(['checkbox', 'select', 'status'])
  })

  it('leaves timeline out of the kinds it offers, because none of it is built', () => {
    expect(VIEW_KINDS.map((v) => v.kind)).not.toContain('timeline')
    expect(VIEW_KINDS.map((v) => v.kind)).toEqual(['table', 'board', 'gallery', 'list', 'calendar'])
  })
})
