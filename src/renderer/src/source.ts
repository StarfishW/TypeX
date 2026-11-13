/**
 * Source code mode: the whole document as plain Markdown text.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  SearchQuery as CMSearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery
} from '@codemirror/search'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import type { SearchQuery } from './editor/search'

const BLOCKED_KEYS = new Set(['Mod-/', 'Mod-Enter', 'Shift-Mod-k', 'Mod-i', 'Alt-A', 'Shift-Alt-a'])

export class SourceEditor {
  readonly view: EditorView
  private readonly extensions: Extension[]
  private silent = false

  constructor(mount: HTMLElement, events: { onChange: () => void; onSelection?: () => void }) {
    this.extensions = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(classHighlighter),
      // The application supplies its own find bar; this panel only switches match highlighting on.
      search({ createPanel: () => ({ dom: document.createElement('div') }) }),
      keymap.of([...defaultKeymap.filter((b) => !b.key || !BLOCKED_KEYS.has(b.key)), ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (this.silent) return
        if (u.docChanged) events.onChange()
        if (u.docChanged || u.selectionSet) events.onSelection?.()
      })
    ]
    this.view = new EditorView({ parent: mount, state: EditorState.create({ doc: '', extensions: this.extensions }) })
  }

  setText(text: string): void {
    this.silent = true
    this.view.setState(EditorState.create({ doc: text, extensions: this.extensions }))
    this.silent = false
  }

  getText(): string {
    return this.view.state.doc.toString()
  }

  focus(): void {
    this.view.focus()
  }

  hasFocus(): boolean {
    return this.view.hasFocus
  }

  /** Zero-based line of the caret. */
  currentLine(): number {
    const { state } = this.view
    return state.doc.lineAt(state.selection.main.head).number - 1
  }

  gotoLine(line: number): void {
    const doc = this.view.state.doc
    const pos = doc.line(Math.max(1, Math.min(doc.lines, line + 1))).from
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 60 })
    })
  }

  undo(): void {
    undo(this.view)
  }

  redo(): void {
    redo(this.view)
  }

  hasSelection(): boolean {
    return !this.view.state.selection.main.empty
  }

  selectedText(): string {
    const { from, to } = this.view.state.selection.main
    return this.view.state.sliceDoc(from, to)
  }

  insert(text: string): void {
    this.view.dispatch(this.view.state.replaceSelection(text))
  }

  /** Wraps the selection in a pair of markers, or removes them when they are already there. */
  wrap(open: string, close: string): void {
    const { state } = this.view
    this.view.dispatch(
      state.changeByRange((range) => {
        const before = state.sliceDoc(Math.max(0, range.from - open.length), range.from)
        const after = state.sliceDoc(range.to, range.to + close.length)
        if (before === open && after === close) {
          return {
            changes: [
              { from: range.from - open.length, to: range.from },
              { from: range.to, to: range.to + close.length }
            ],
            range: EditorSelection.range(range.from - open.length, range.to - open.length)
          }
        }
        return {
          changes: [
            { from: range.from, insert: open },
            { from: range.to, insert: close }
          ],
          range: EditorSelection.range(range.from + open.length, range.to + open.length)
        }
      })
    )
  }

  /** Replaces the block prefix (heading marks, quote, list marker) of every selected line. */
  setLinePrefix(prefix: string, strip: RegExp): void {
    const { state } = this.view
    const { from, to } = state.selection.main
    const changes: { from: number; to: number; insert: string }[] = []
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
      const line = state.doc.line(n)
      const m = strip.exec(line.text)
      const old = m ? m[0] : ''
      const next = old === prefix ? '' : prefix
      changes.push({ from: line.from, to: line.from + old.length, insert: next })
    }
    this.view.dispatch({ changes })
  }

  /* --------------------------------- search -------------------------------- */

  setSearch(q: SearchQuery | null, replace = ''): void {
    if (!q || !q.text) {
      closeSearchPanel(this.view)
      this.view.dispatch({ effects: setSearchQuery.of(new CMSearchQuery({ search: '' })) })
      return
    }
    openSearchPanel(this.view)
    this.view.dispatch({
      effects: setSearchQuery.of(
        new CMSearchQuery({
          search: q.text,
          caseSensitive: q.caseSensitive,
          regexp: q.regex,
          wholeWord: q.wholeWord,
          replace
        })
      )
    })
  }

  searchStep(dir: 1 | -1): void {
    if (dir > 0) findNext(this.view)
    else findPrevious(this.view)
  }

  replaceCurrent(): void {
    replaceNext(this.view)
  }

  replaceAll(): void {
    replaceAll(this.view)
  }

  searchInfo(): { count: number; current: number } {
    const { state } = this.view
    const query = getSearchQuery(state)
    if (!query.valid || !query.search) return { count: 0, current: -1 }
    const cursor = query.getCursor(state)
    const { from, to } = state.selection.main
    let count = 0
    let current = -1
    for (let r = cursor.next(); !r.done && count < 10000; r = cursor.next()) {
      if (r.value.from === from && r.value.to === to) current = count
      count++
    }
    return { count, current }
  }
}
