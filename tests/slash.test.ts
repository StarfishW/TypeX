import { history, undo } from 'prosemirror-history'
import { EditorState, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMarkdown, serializeMarkdown } from '../src/renderer/src/editor/markdown'
import { SLASH_ITEMS, filterSlashItems, slashOptions, slashPlugin } from '../src/renderer/src/editor/slash'
import { setLocale } from '../src/renderer/src/i18n'

const ids = (query: string): string[] => filterSlashItems(query).map((i) => i.id)

describe('slash command list', () => {
  afterEach(() => setLocale('en', 'win32'))

  it('offers every block for a bare slash, headings first', () => {
    expect(ids('')).toEqual(SLASH_ITEMS.map((i) => i.id))
    expect(ids('').slice(0, 3)).toEqual(['h1', 'h2', 'h3'])
  })

  it('puts an exact id first', () => {
    expect(ids('h2')[0]).toBe('h2')
    expect(ids('hr')[0]).toBe('hr')
    expect(ids('toc')[0]).toBe('toc')
  })

  it('finds blocks by name and by keyword', () => {
    expect(ids('table')[0]).toBe('table')
    expect(ids('todo')).toEqual(['task'])
    expect(ids('mermaid')).toEqual(['diagram'])
    expect(ids('quo')[0]).toBe('quote')
    expect(ids('list')).toEqual(expect.arrayContaining(['bullet', 'ordered', 'task']))
    expect(ids('MATH')[0]).toBe('math')
  })

  it('matches English keywords only at the start of a word', () => {
    // Not Quote ("citation"), Horizontal Line ("horizontal") or Front Matter ("metadata").
    expect(ids('ta')).toEqual(['task', 'table', 'toc'])
    // Not Unordered List.
    expect(ids('ordered')).toEqual(['ordered'])
  })

  it('offers nothing for an unknown word', () => {
    expect(ids('usr')).toEqual([])
    expect(ids('xyz')).toEqual([])
  })

  it('matches labels in the interface language', () => {
    setLocale('zh-CN', 'win32')
    expect(ids('标题')[0]).toBe('h1')
    expect(ids('表格')).toEqual(['table'])
    expect(filterSlashItems('')[0].label()).toBe('1 级标题')
    setLocale('de', 'win32')
    expect(ids('tabelle')).toEqual(['table'])
    // English keywords work in every language ("table" also finds "table of contents").
    expect(ids('table')[0]).toBe('table')
  })
})

/** A headless editor with the slash plugin and undo history, the caret at the end of the document. */
function editor(md: string) {
  const plugin = slashPlugin()
  const doc = parseMarkdown(md).doc
  let state = EditorState.create({ doc, plugins: [plugin, history()], selection: Selection.atEnd(doc) })
  const view = {
    get state() {
      return state
    },
    composing: false,
    dispatch: (tr: Transaction) => void (state = state.apply(tr)),
    focus: () => {}
  } as unknown as EditorView
  return {
    view,
    /** Types one character at a time, as the keyboard does. */
    type(text: string) {
      for (const ch of text) view.dispatch(state.tr.insertText(ch))
    },
    backspace() {
      view.dispatch(state.tr.delete(state.selection.from - 1, state.selection.from))
    },
    /** Whether the slash list handled the key. */
    press(key: string): boolean {
      const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent
      return !!plugin.props.handleKeyDown!.call(plugin, view, event)
    },
    /** Ids of the listed blocks, or null when the list is closed. */
    menu(): string[] | null {
      const st = plugin.getState(state)!
      return st.from < 0 ? null : st.items.map((i) => i.id)
    },
    blocks: () => state.doc.content.content.map((n) => n.type.name),
    markdown: () => serializeMarkdown(state.doc).text,
    undo: () => undo(state, view.dispatch)
  }
}

describe('slash command menu', () => {
  it('opens when "/" is typed at the start of a line, after a space or after CJK text', () => {
    for (const [md, typed] of [
      ['', '/'],
      ['Intro', ' /'],
      ['中文', '/'],
      ['日本語、', '/']
    ]) {
      const e = editor(md)
      e.type(typed)
      expect(e.menu(), `${md}${typed}`).toEqual(SLASH_ITEMS.map((i) => i.id))
    }
  })

  it('stays closed for paths, URLs, fractions and "and/or"', () => {
    for (const typed of ['and/', 'x./', '1/', 'http:/', '(/']) {
      const e = editor('')
      e.type(typed)
      expect(e.menu(), typed).toBeNull()
    }
  })

  it('filters while typing and closes on a space', () => {
    const e = editor('')
    e.type('/tab')
    expect(e.menu()).toEqual(['table', 'toc'])
    e.type(' ')
    expect(e.menu()).toBeNull()
  })

  it('hides while nothing matches, letting keys through, and comes back after a correction', () => {
    const e = editor('')
    e.type('/tablx')
    expect(e.menu()).toEqual([])
    expect(e.press('Enter')).toBe(false)
    expect(e.press('ArrowDown')).toBe(false)
    e.backspace()
    expect(e.menu()?.[0]).toBe('table')
  })

  it('turns the line into the chosen block, without the typed text or the space before it', () => {
    const e = editor('Intro')
    e.type(' /h2')
    expect(e.press('Enter')).toBe(true)
    expect(e.markdown()).toBe('## Intro\n')
    expect(e.menu()).toBeNull()
  })

  it('makes the insertion one undo step that brings back the typed text, without reopening', () => {
    const e = editor('Intro')
    e.type(' /h2')
    e.press('Enter')
    e.undo()
    expect(e.markdown()).toBe('Intro /h2\n')
    expect(e.menu()).toBeNull()
  })

  it('moves through the list with the arrow keys', () => {
    const e = editor('')
    e.type('/h')
    e.press('ArrowDown')
    e.press('ArrowDown')
    e.press('ArrowUp')
    e.press('Tab')
    const first = e.view.state.doc.child(0)
    expect(first.type.name).toBe('heading')
    expect(first.attrs.level).toBe(2)
  })

  it('replaces an empty line with a table, code fence or diagram', () => {
    const t = editor('')
    t.type('/table')
    t.press('Enter')
    expect(t.blocks()[0]).toBe('table')
    expect(t.view.state.selection.$from.parent.type.name).toBe('table_header')

    const c = editor('')
    c.type('/mermaid')
    c.press('Enter')
    expect(c.view.state.doc.child(0).type.name).toBe('code_block')
    expect(c.view.state.doc.child(0).attrs.lang).toBe('mermaid')
  })

  it('inserts code after a line with text instead of converting the text', () => {
    const e = editor('Intro')
    e.type(' /code')
    e.press('Enter')
    expect(e.blocks()).toEqual(['paragraph', 'code_block'])
    expect(e.view.state.doc.child(0).textContent).toBe('Intro')
    expect(e.view.state.selection.$from.parent.type.name).toBe('code_block')
  })

  it('inserts links and images at the caret, keeping the space before them', () => {
    const e = editor('see')
    e.type(' /link')
    e.press('Enter')
    expect(e.markdown()).toBe('see []()\n')
    expect(e.view.state.selection.from).toBe(1 + 'see ['.length)
  })

  it('stays closed after Escape until a new "/" is typed', () => {
    const e = editor('')
    e.type('/co')
    expect(e.press('Escape')).toBe(true)
    expect(e.menu()).toBeNull()
    e.type('de')
    expect(e.menu()).toBeNull()
    expect(e.press('Enter')).toBe(false)
    expect(e.markdown()).toBe('/code\n')
    e.type(' /')
    expect(e.menu()).not.toBeNull()
  })

  it('does not open for a slash that was pasted, restored by undo or reached with Backspace', () => {
    const pasted = editor('')
    pasted.view.dispatch(pasted.view.state.tr.insertText('/').setMeta('uiEvent', 'paste'))
    expect(pasted.menu()).toBeNull()

    const uncovered = editor('see /x')
    uncovered.backspace()
    expect(uncovered.menu()).toBeNull()
  })

  it('closes when the caret moves away', () => {
    const e = editor('abc')
    e.type(' /')
    expect(e.menu()).not.toBeNull()
    e.view.dispatch(e.view.state.tr.setSelection(TextSelection.create(e.view.state.doc, 1)))
    expect(e.menu()).toBeNull()
  })

  it('does not open in table cells or code', () => {
    const cell = editor('| a | b |\n| --- | --- |\n| c | d |')
    cell.type(' /')
    expect(cell.menu()).toBeNull()

    const code = editor('```\ncode\n```')
    code.type(' /')
    expect(code.menu()).toBeNull()
  })

  it('does nothing when turned off in Preferences', () => {
    slashOptions.enabled = false
    try {
      const e = editor('')
      e.type('/')
      expect(e.menu()).toBeNull()
      expect(e.press('Enter')).toBe(false)
    } finally {
      slashOptions.enabled = true
    }
  })
})
