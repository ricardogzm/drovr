import { describe, expect, it } from 'vitest'
import { mergeExactLine } from '../src/merge-line'

describe('mergeExactLine', () => {
  it('appends a missing line to empty content', () => {
    expect(mergeExactLine('', 'state.sqlite*')).toBe('state.sqlite*\n')
  })

  it('appends a missing line after content without a trailing newline', () => {
    expect(mergeExactLine('existing', 'state.sqlite*')).toBe('existing\nstate.sqlite*\n')
  })

  it('appends a missing line after content with a trailing newline', () => {
    expect(mergeExactLine('existing\n', 'state.sqlite*')).toBe('existing\nstate.sqlite*\n')
  })

  it('does not duplicate an existing exact line', () => {
    expect(mergeExactLine('state.sqlite*\n', 'state.sqlite*')).toBe('state.sqlite*\n')
  })

  it('preserves unrelated existing content', () => {
    expect(mergeExactLine('notes\n', '/.worktrees/')).toBe('notes\n/.worktrees/\n')
  })
})
