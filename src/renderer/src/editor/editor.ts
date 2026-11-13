/**
 * The live-preview editor: wires the schema, plugins and node views into a
 * view and exposes the operations the application shell needs.
 */
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { history, redo, undo } from 'prosemirror-history'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { EditorState, Selection, TextSelection, type Command, type Plugin, type Transaction } from 'prosemirror-state'
import { isInTable, tableEditing } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import { emojiCompletePlugin } from './autocomplete'
import { clipboardPlugin } from './clipboard'
import { inlinePlugin, refreshInline, tokensFor } from './decorations'
import { plainText } from './inline'
import { autoPairPlugin, editorInputRules, editorKeymap } from './keymap'
import { parseMarkdown, serializeMarkdown } from './markdown'
import { getHeadings, nodeViews, type Heading } from './nodeviews'
import {
  HOUSEKEEPING,
  focusPlugin,
  invariantsPlugin,
  linkPlugin,
  selectionSyncPlugin,
  taskPlugin,
  tocPlugin
} from './plugins'
import { isInlineBlock, schema } from './schema'
import { searchPlugin } from './search'
import { slashPlugin } from './slash'

const { nodes } = schema

export interface EditorEvents {
  /** The document content changed through editing. */
  onChange?: () => void
  /** The selection (or the content under it) changed. */
  onSelection?: () => void
  onHeadings?: (headings: Heading[]) => void
  /** Image files were pasted. */
  onImages?: (files: File[]) => void
  /** Files were dropped onto the editor at document position `pos`. */
  onDropFiles?: (files: File[], pos: number) => void
}

export interface TextStats {
  words: number
  chars: number
  lines: number
}

const WORD_RE =
  /[⺀-鿿가-힯豈-﫿]|(?:(?![⺀-鿿가-힯豈-﫿])[\p{L}\p{N}])+(?:['’-](?:(?![⺀-鿿가-힯豈-﫿])[\p{L}\p{N}])+)*/gu

export function countText(text: string): { words: number; chars: number } {
  const words = text.match(WORD_RE)
  return { words: words ? words.length : 0, chars: text.replace(/\s/g, '').length }
}

export interface EditorContext {
  inTable: boolean
  inCode: boolean
  hasSelection: boolean
  /** 0 for a paragraph, 1-6 for a heading, -1 for anything else. */
  heading: number
}

export class Editor {
  readonly view: EditorView
  private readonly plugins: Plugin[]
  private loading = false
  private typewriter = false

  constructor(
    private readonly mount: HTMLElement,
    private readonly events: EditorEvents = {}
  ) {
    this.plugins = [
      selectionSyncPlugin(),
      // Before the keymap, so Enter and Tab pick a suggestion while a list is open.
      slashPlugin(),
      emojiCompletePlugin(),
      editorInputRules(),
      autoPairPlugin(),
      editorKeymap(),
      history(),
      inlinePlugin(),
      focusPlugin(),
      taskPlugin(),
      invariantsPlugin(),
      tocPlugin((h) => this.events.onHeadings?.(h)),
      linkPlugin(),
      searchPlugin(),
      clipboardPlugin({ onImages: (files) => this.events.onImages?.(files) }),
      dropCursor({ class: 'md-dropcursor' }),
      gapCursor(),
      tableEditing()
    ]
    this.view = new EditorView(
      { mount },
      {
        state: this.createState(nodes.doc.create(null, nodes.paragraph.create())),
        nodeViews,
        dispatchTransaction: (tr) => this.dispatch(tr),
        scrollMargin: 80,
        scrollThreshold: 60,
        attributes: { spellcheck: 'true' },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files || [])
          if (!files.length) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          this.events.onDropFiles?.(files, at ? at.pos : view.state.selection.from)
          return true
        }
      }
    )
  }

  private createState(doc: PMNode): EditorState {
    // Start in the first block of the text rather than inside the front matter.
    const first = doc.firstChild
    const selection =
      first && first.type === nodes.front_matter && doc.childCount > 1
        ? Selection.findFrom(doc.resolve(first.nodeSize), 1) || undefined
        : undefined
    return EditorState.create({ doc, plugins: this.plugins, selection })
  }

  private dispatch(tr: Transaction): void {
    if (this.view.isDestroyed) return
    this.view.updateState(this.view.state.apply(tr))
    if (this.loading) return
    if (tr.docChanged && !tr.getMeta(HOUSEKEEPING)) this.events.onChange?.()
    if (tr.docChanged || tr.selectionSet) {
      this.events.onSelection?.()
      if (this.typewriter) this.centerCaret()
    }
  }

  /* -------------------------------- content -------------------------------- */

  /** Replaces the document. Returns the source line on which each top-level block starts. */
  setMarkdown(source: string): number[] {
    const parsed = parseMarkdown(source)
    let doc = parsed.doc
    const last = doc.lastChild!
    if (last.type !== nodes.paragraph && last.type !== nodes.heading) {
      doc = doc.copy(doc.content.append(Fragment.from(nodes.paragraph.create())))
    }
    this.loading = true
    try {
      this.view.updateState(this.createState(doc))
    } finally {
      this.loading = false
    }
    this.events.onSelection?.()
    return parsed.lines
  }

  getMarkdown(): string {
    return serializeMarkdown(this.view.state.doc).text
  }

  /** Output line on which each top-level block starts when serialized. */
  blockLines(): number[] {
    return serializeMarkdown(this.view.state.doc).lines
  }

  get doc(): PMNode {
    return this.view.state.doc
  }

  /* -------------------------------- commands ------------------------------- */

  exec(command: Command): boolean {
    return command(this.view.state, this.view.dispatch, this.view)
  }

  undo(): boolean {
    return this.exec(undo)
  }

  redo(): boolean {
    return this.exec(redo)
  }

  focus(): void {
    this.view.focus()
  }

  hasFocus(): boolean {
    return this.view.hasFocus() || this.mount.contains(document.activeElement)
  }

  context(): EditorContext {
    const { state } = this.view
    const parent = state.selection.$head.parent
    return {
      inTable: isInTable(state),
      inCode: !!parent.type.spec.code,
      hasSelection: !state.selection.empty,
      heading: parent.type === nodes.heading ? (parent.attrs.level as number) : parent.type === nodes.paragraph ? 0 : -1
    }
  }

  /**
   * Context for a right-click at window coordinates. A click outside the
   * current selection first moves the caret there, so menu commands act on
   * what was clicked rather than on wherever the caret happened to be.
   */
  contextAtCoords(x: number, y: number): EditorContext {
    const at = this.view.posAtCoords({ left: x, top: y })
    if (at) {
      const { selection, doc } = this.view.state
      if (at.pos < selection.from || at.pos > selection.to) {
        const $pos = doc.resolve(at.pos)
        const sel = $pos.parent.inlineContent ? TextSelection.create(doc, at.pos) : Selection.near($pos)
        this.view.dispatch(this.view.state.tr.setSelection(sel))
      }
    }
    return this.context()
  }

  /* ------------------------------- navigation ------------------------------ */

  headings(): Heading[] {
    return getHeadings(this.view.state.doc)
  }

  /** Puts the caret at the start of the block at `pos` and scrolls it to the top of the viewport. */
  revealBlock(pos: number): void {
    const { state } = this.view
    if (pos < 0 || pos > state.doc.content.size) return
    const sel = Selection.near(state.doc.resolve(Math.min(pos + 1, state.doc.content.size)))
    this.view.dispatch(state.tr.setSelection(sel))
    const dom = this.view.nodeDOM(pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
    this.view.focus()
  }

  /** Puts back a selection saved earlier, as close as the document allows. */
  restoreSelection(anchor: number, head: number): void {
    const { doc } = this.view.state
    const clamp = (n: number): number => Math.max(0, Math.min(n, doc.content.size))
    try {
      const sel = TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)))
      this.view.dispatch(this.view.state.tr.setSelection(sel))
    } catch {
      /* positions that no longer fit the document keep the default selection */
    }
  }

  /** Index of the top-level block that holds the selection. */
  topBlockIndex(): number {
    return this.view.state.selection.$head.index(0)
  }

  focusTopBlock(index: number): void {
    const { state } = this.view
    const doc = state.doc
    const target = Math.max(0, Math.min(index, doc.childCount - 1))
    let pos = 0
    for (let i = 0; i < target; i++) pos += doc.child(i).nodeSize
    const sel = Selection.findFrom(doc.resolve(pos), 1) || Selection.atStart(doc)
    this.view.dispatch(state.tr.setSelection(sel).scrollIntoView())
  }

  private centerCaret(): void {
    const scroller = this.mount.parentElement
    if (!scroller) return
    try {
      const coords = this.view.coordsAtPos(this.view.state.selection.head)
      const rect = scroller.getBoundingClientRect()
      scroller.scrollTop += coords.top - (rect.top + rect.height / 2)
    } catch {
      /* the caret is inside an embedded editor that manages its own geometry */
    }
  }

  /* --------------------------------- modes --------------------------------- */

  setTypewriter(on: boolean): void {
    this.typewriter = on
    this.mount.classList.toggle('md-typewriter-mode', on)
    if (on) this.centerCaret()
  }

  setFocusMode(on: boolean): void {
    this.mount.classList.toggle('md-focus-mode', on)
  }

  setSpellcheck(on: boolean): void {
    this.view.setProps({ attributes: { spellcheck: on ? 'true' : 'false' } })
  }

  /** Re-renders inline content after syntax options, the theme or the document path changed. */
  refresh(): void {
    refreshInline(this.view)
  }

  /* --------------------------------- stats --------------------------------- */

  stats(): { total: TextStats; selection: TextStats | null } {
    const { state } = this.view
    const total: TextStats = { words: 0, chars: 0, lines: 0 }
    state.doc.descendants((node) => {
      if (!node.isTextblock) return true
      const src = node.textContent
      if (src) {
        const c = countText(isInlineBlock(node) ? plainText(src, tokensFor(node)) : src)
        total.words += c.words
        total.chars += c.chars
        total.lines += src.split('\n').length
      }
      return false
    })
    let selection: TextStats | null = null
    if (!state.selection.empty) {
      const text = state.doc.textBetween(state.selection.from, state.selection.to, '\n')
      const c = countText(text)
      selection = { words: c.words, chars: c.chars, lines: text.split('\n').length }
    }
    return { total, selection }
  }

  /** Inserts raw Markdown text at document position `pos` (or at the selection). */
  insertAt(text: string, pos?: number): void {
    const { state } = this.view
    const tr = state.tr
    if (pos != null) {
      const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
      const sel = $pos.parent.isTextblock ? TextSelection.create(state.doc, $pos.pos) : Selection.near($pos)
      tr.setSelection(sel)
    }
    tr.insertText(text, tr.selection.from, tr.selection.to)
    this.view.dispatch(tr.scrollIntoView())
  }

  destroy(): void {
    this.view.destroy()
  }
}
