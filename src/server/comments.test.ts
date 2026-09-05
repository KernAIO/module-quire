/**
 * What a comment body becomes once it is stored.
 *
 * Both of these read a `mention` node, and until the composers had a source to offer nothing in
 * the product could produce one — so both were written against a node that never arrived. The
 * margin draws `bodyText` and the notification that tells somebody they were named leads with it,
 * so a mention the flattener drops is a name missing from the two places it matters most.
 */
import { describe, expect, it } from 'vitest'
import { flattenBody, mentionsIn } from './services/comments.js'

const body = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] })
const mention = (id: string, label: string) => ({ type: 'mention', attrs: { id, label } })
const text = (value: string) => ({ type: 'text', text: value })

describe('a comment body flattened to text', () => {
  it('keeps the name of somebody who was mentioned', () => {
    expect(flattenBody(body(mention('u1', 'Ada Lovelace'), text(' is this still true?')))).toBe(
      '@Ada Lovelace is this still true?',
    )
  })

  it('is not empty when the whole comment is a mention', () => {
    expect(flattenBody(body(mention('u1', 'Ada Lovelace')))).toBe('@Ada Lovelace')
  })

  it('says nothing about a mention with no label rather than writing a bare @', () => {
    expect(flattenBody(body({ type: 'mention', attrs: { id: 'u1' } }, text('look')))).toBe('look')
  })
})

describe('the people a comment names', () => {
  it('finds every mention once, in a nested body', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention('u1', 'Ada'), text(' and '), mention('u2', 'Dan')] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [mention('u1', 'Ada')] }] },
      ],
    }
    expect(mentionsIn(doc)).toEqual(['u1', 'u2'])
  })

  it('answers with nothing for a body that only says a name in prose', () => {
    expect(mentionsIn(body(text('@Ada what do you think')))).toEqual([])
  })
})
