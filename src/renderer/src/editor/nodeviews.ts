/**
 * Node views for blocks that are edited as source: code fences, math blocks,
 * HTML blocks and YAML front matter. Each hosts a small CodeMirror editor and
 * forwards every change into the main document, so undo history, saving and
 * search all keep working on one document.
 */
import { closeBrackets } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { LanguageDescription, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState as CMState, type Extension } from '@codemirror/state'
import { EditorView as CMView, drawSelection, keymap as cmKeymap, lineNumbers, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import type { Node as PMNode } from 'prosemirror-model'
import { redo, undo } from 'prosemirror-history'
import { Selection, TextSelection } from 'prosemirror-state'
import type { Decoration, EditorView, NodeView } from 'prosemirror-view'
import { sanitizeHtml, tokensFor } from './decorations'
import { env } from './env'
import { plainText } from './inline'
import { renderMathInto } from './math'
import { t } from '../i18n'
import { schema } from './schema'

export type SourceKind = 'code' | 'math' | 'html' | 'yaml'

export const codeOptions = { lineNumbers: false, lineWrapping: true }

/** A shared list of language names, offered as suggestions in the code fence language field. */
function languageListId(): string {
  const id = 'typex-languages'
  if (!document.getElementById(id)) {
    const list = document.createElement('datalist')
    list.id = id
    const names = new Set<string>(['mermaid'])
    for (const lang of languages) {
      names.add(lang.name.toLowerCase())
      for (const alias of lang.alias) names.add(alias.toLowerCase())
    }
    for (const name of [...names].sort()) {
      const option = document.createElement('option')
      option.value = name
      list.appendChild(option)
    }
    document.body.appendChild(list)
  }
  return id
}

export function findLanguage(name: string): LanguageDescription | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return LanguageDescription.matchLanguageName(languages, n, true)
}

/* -------------------------------- mermaid -------------------------------- */

type Mermaid = (typeof import('mermaid'))['default']
let mermaidLoading: Promise<Mermaid> | null = null
let mermaidSeq = 0
let mermaidDark: boolean | null = null

async function getMermaid(): Promise<Mermaid> {
  if (!mermaidLoading) mermaidLoading = import('mermaid').then((m) => m.default)
  const mermaid = await mermaidLoading
  if (mermaidDark !== env.dark) {
    mermaidDark = env.dark
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: env.dark ? 'dark' : 'default' })
  }
  return mermaid
}

/** Renders a mermaid diagram to SVG markup. Rejects with the parser's message on bad input. */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await getMermaid()
  await mermaid.parse(code)
  const id = 'typex-mermaid-' + ++mermaidSeq
  try {
    const { svg } = await mermaid.render(id, code)
    return svg
  } finally {
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
  }
}

export const isDiagramLang = (lang: string): boolean => lang.trim().toLowerCase() === 'mermaid'

/* ---------------------------- source block view --------------------------- */

const BLOCKED_KEYS = new Set(['Mod-/', 'Mod-Enter', 'Shift-Mod-k', 'Mod-i', 'Alt-A', 'Shift-Alt-a'])

export class SourceBlockView implements NodeView {
  dom: HTMLElement
  private readonly cm: CMView
  private readonly lang = new Compartment()
  private readonly preview: HTMLElement | null = null
  private readonly langInput: HTMLInputElement | null = null
  private updating = false
  private focused = false
  private previewTimer = 0
  private renderSeq = 0
  private loadedLang = ''

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly kind: SourceKind
  ) {
    const extensions: Extension[] = [
      cmKeymap.of([...this.keymap(), indentWithTab, ...defaultKeymap.filter((b) => !b.key || !BLOCKED_KEYS.has(b.key))]),
      drawSelection(),
      indentUnit.of('    '),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(classHighlighter),
      this.lang.of([]),
      CMState.tabSize.of(4),
      CMView.updateListener.of((u) => this.forwardUpdate(u))
    ]
    if (codeOptions.lineWrapping || kind !== 'code') extensions.push(CMView.lineWrapping)
    if (codeOptions.lineNumbers && kind === 'code') extensions.push(lineNumbers())

    this.cm = new CMView({ doc: node.textContent, extensions })

    const dom = document.createElement('div')
    dom.className =
      kind === 'code'
        ? 'md-fences md-source-block'
        : kind === 'math'
          ? 'md-math-block md-source-block'
          : kind === 'html'
            ? 'md-html-block md-source-block'
            : 'md-front-matter md-source-block'
    dom.spellcheck = false
    this.dom = dom

    const host = document.createElement('div')
    host.className = 'md-cm-host'
    host.appendChild(this.cm.dom)
    dom.appendChild(host)

    if (kind !== 'yaml') {
      const preview = document.createElement('div')
      preview.className = 'md-preview'
      preview.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('[data-href]')) return
        e.preventDefault()
        this.enter()
      })
      dom.appendChild(preview)
      this.preview = preview
    }

    if (kind === 'code') {
      const input = document.createElement('input')
      input.className = 'md-fence-lang'
      input.placeholder = t('editor.languagePlaceholder')
      input.spellcheck = false
      input.value = node.attrs.lang as string
      input.setAttribute('list', languageListId())
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault()
          this.commitLang()
          this.cm.focus()
        }
      })
      input.addEventListener('blur', () => this.commitLang())
      dom.appendChild(input)
      this.langInput = input
    }

    this.applyLanguage()
    this.renderPreview()
  }

  /* --------------------------- language & preview --------------------------- */

  private languageName(): string {
    if (this.kind === 'math') return 'latex'
    if (this.kind === 'html') return 'html'
    if (this.kind === 'yaml') return 'yaml'
    return (this.node.attrs.lang as string) || ''
  }

  private applyLanguage(): void {
    const name = this.languageName()
    this.dom.classList.toggle('md-has-preview', this.hasPreview())
    if (this.kind === 'code') this.dom.setAttribute('data-lang', name)
    if (name === this.loadedLang) return
    this.loadedLang = name
    const desc = findLanguage(name)
    if (!desc) {
      this.cm.dispatch({ effects: this.lang.reconfigure([]) })
      return
    }
    void desc.load().then((support) => {
      if (this.loadedLang === name) this.cm.dispatch({ effects: this.lang.reconfigure(support) })
    })
  }

  private hasPreview(): boolean {
    return this.kind === 'math' || this.kind === 'html' || (this.kind === 'code' && isDiagramLang(this.node.attrs.lang))
  }

  private schedulePreview(): void {
    if (!this.preview) return
    window.clearTimeout(this.previewTimer)
    this.previewTimer = window.setTimeout(() => this.renderPreview(), this.kind === 'code' ? 300 : 120)
  }

  private renderPreview(): void {
    const preview = this.preview
    if (!preview) return
    const text = this.node.textContent
    if (!this.hasPreview()) {
      preview.textContent = ''
      return
    }
    if (!text.trim()) {
      preview.className = 'md-preview md-preview-empty'
      preview.textContent = t(this.kind === 'math' ? 'editor.emptyMath' : this.kind === 'html' ? 'editor.emptyHtml' : 'editor.emptyDiagram')
      return
    }
    preview.className = 'md-preview'
    if (this.kind === 'math') {
      renderMathInto(preview, text, true)
    } else if (this.kind === 'html') {
      preview.replaceChildren(sanitizeHtml(text))
    } else {
      const seq = ++this.renderSeq
      renderMermaid(text).then(
        (svg) => {
          if (seq !== this.renderSeq) return
          preview.className = 'md-preview md-diagram'
          preview.innerHTML = svg
        },
        (err: unknown) => {
          if (seq !== this.renderSeq) return
          preview.className = 'md-preview md-preview-error'
          preview.textContent = err instanceof Error ? err.message : String(err)
        }
      )
    }
  }

  private commitLang(): void {
    const input = this.langInput
    const pos = this.getPos()
    if (!input || pos == null) return
    const lang = input.value.trim()
    if (lang === this.node.attrs.lang) return
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, lang }))
  }

  /* ------------------------------ editing glue ------------------------------ */

  /** Moves the selection into this block, which also reveals its editor. */
  private enter(): void {
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1 + this.node.content.size)))
    this.cm.focus()
  }

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !this.cm.hasFocus) return
    const pos = this.getPos()
    if (pos == null) return
    const base = pos + 1
    const { main } = update.state.selection
    const pmSel = this.view.state.selection
    if (!update.docChanged && pmSel.anchor === base + main.anchor && pmSel.head === base + main.head) return

    const tr = this.view.state.tr
    let offset = base
    update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
      if (text.length) tr.replaceWith(offset + fromA, offset + toA, schema.text(text.toString()))
      else tr.delete(offset + fromA, offset + toA)
      offset += toB - fromB - (toA - fromA)
    })
    tr.setSelection(TextSelection.create(tr.doc, base + main.anchor, base + main.head))
    this.view.dispatch(tr)
  }

  private keymap(): KeyBinding[] {
    const view = this.view
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      { key: 'Mod-Enter', run: () => this.exitAfter() },
      { key: 'Backspace', run: () => this.deleteIfEmpty() },
      { key: 'Mod-z', run: () => undo(view.state, view.dispatch) },
      { key: 'Mod-y', run: () => redo(view.state, view.dispatch) },
      { key: 'Mod-Shift-z', run: () => redo(view.state, view.dispatch) }
    ]
  }

  /** Leaves the editor when the caret is on its first/last line (or character) and keeps moving. */
  private maybeEscape(unit: 'line' | 'char', dir: -1 | 1): boolean {
    const { state } = this.cm
    const main = state.selection.main
    if (!main.empty) return false
    const length = state.doc.length
    if (unit === 'char') {
      if (dir < 0 ? main.head > 0 : main.head < length) return false
    } else {
      const here = this.cm.coordsAtPos(main.head)
      const edge = this.cm.coordsAtPos(dir < 0 ? 0 : length)
      if (here && edge) {
        if (dir < 0 ? here.top > edge.top + 2 : here.bottom < edge.bottom - 2) return false
      } else {
        const line = state.doc.lineAt(main.head)
        if (dir < 0 ? line.from > 0 : line.to < length) return false
      }
    }
    const pos = this.getPos()
    if (pos == null) return false
    const pm = this.view.state
    const target = pm.doc.resolve(pos + (dir < 0 ? 0 : this.node.nodeSize))
    const sel = Selection.findFrom(target, dir)
    if (!sel) return dir > 0 ? this.exitAfter() : this.exitBefore()
    this.view.dispatch(pm.tr.setSelection(sel).scrollIntoView())
    this.view.focus()
    return true
  }

  private exitAfter(): boolean {
    const pos = this.getPos()
    if (pos == null) return false
    const after = pos + this.node.nodeSize
    const tr = this.view.state.tr.insert(after, schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
    this.view.dispatch(tr)
    this.view.focus()
    return true
  }

  private exitBefore(): boolean {
    const pos = this.getPos()
    if (pos == null) return false
    const tr = this.view.state.tr.insert(pos, schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView()
    this.view.dispatch(tr)
    this.view.focus()
    return true
  }

  private deleteIfEmpty(): boolean {
    if (this.cm.state.doc.length > 0) return false
    const pos = this.getPos()
    if (pos == null) return false
    const tr = this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize, schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
    this.view.dispatch(tr)
    this.view.focus()
    return true
  }

  /* ------------------------------ NodeView API ------------------------------ */

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false
    const langChanged = node.attrs.lang !== this.node.attrs.lang
    const textChanged = node.textContent !== this.node.textContent
    this.node = node

    const focused = decorations.some((d) => (d.spec as { focus?: boolean }).focus)
    if (focused !== this.focused) {
      this.focused = focused
      if (focused) this.cm.requestMeasure()
    }
    if (langChanged) {
      if (this.langInput && document.activeElement !== this.langInput) this.langInput.value = node.attrs.lang as string
      this.applyLanguage()
    }
    if (!this.updating) {
      const next = node.textContent
      const cur = this.cm.state.doc.toString()
      if (next !== cur) {
        let start = 0
        let curEnd = cur.length
        let nextEnd = next.length
        while (start < curEnd && cur.charCodeAt(start) === next.charCodeAt(start)) start++
        while (curEnd > start && nextEnd > start && cur.charCodeAt(curEnd - 1) === next.charCodeAt(nextEnd - 1)) {
          curEnd--
          nextEnd--
        }
        this.updating = true
        this.cm.dispatch({ changes: { from: start, to: curEnd, insert: next.slice(start, nextEnd) } })
        this.updating = false
      }
    }
    if (textChanged || langChanged) this.schedulePreview()
    return true
  }

  setSelection(anchor: number, head: number): void {
    const max = this.cm.state.doc.length
    this.updating = true
    this.cm.focus()
    this.cm.dispatch({ selection: { anchor: Math.min(anchor, max), head: Math.min(head, max) } })
    this.updating = false
  }

  selectNode(): void {
    this.cm.focus()
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    window.clearTimeout(this.previewTimer)
    this.renderSeq++
    this.cm.destroy()
  }
}

/* ------------------------------ table of contents ------------------------- */

export interface Heading {
  level: number
  text: string
  pos: number
}

export function getHeadings(doc: PMNode): Heading[] {
  const out: Heading[] = []
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.heading) {
      const src = node.textContent
      out.push({ level: node.attrs.level as number, text: plainText(src, tokensFor(node)).trim(), pos })
      return false
    }
    return !node.isTextblock
  })
  return out
}

const tocViews = new Set<TocView>()

export class TocView implements NodeView {
  dom: HTMLElement

  constructor(
    private readonly node: PMNode,
    private readonly view: EditorView
  ) {
    this.dom = document.createElement('div')
    this.dom.className = 'md-toc'
    this.dom.contentEditable = 'false'
    this.dom.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]')
      if (!item || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const pos = Number(item.dataset.pos)
      const { state } = this.view
      if (pos >= state.doc.content.size) return
      this.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))).scrollIntoView())
      this.view.focus()
    })
    tocViews.add(this)
    this.render(getHeadings(view.state.doc))
  }

  render(headings: Heading[]): void {
    this.dom.textContent = ''
    if (!headings.length) {
      const empty = document.createElement('div')
      empty.className = 'md-toc-empty'
      empty.textContent = t('editor.tocEmpty')
      this.dom.appendChild(empty)
      return
    }
    const min = Math.min(...headings.map((h) => h.level))
    for (const h of headings) {
      const item = document.createElement('div')
      item.className = `md-toc-item md-toc-h${h.level}`
      item.style.paddingLeft = `${(h.level - min) * 1.5}em`
      item.dataset.pos = String(h.pos)
      const a = document.createElement('a')
      a.className = 'md-toc-inner'
      a.textContent = h.text || t('doc.untitled')
      item.appendChild(a)
      this.dom.appendChild(item)
    }
  }

  update(node: PMNode): boolean {
    return node.type === this.node.type
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    tocViews.delete(this)
  }
}

export function refreshTocs(headings: Heading[]): void {
  for (const v of tocViews) v.render(headings)
}

export const nodeViews = {
  code_block: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SourceBlockView(node, view, getPos, 'code'),
  math_block: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SourceBlockView(node, view, getPos, 'math'),
  html_block: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SourceBlockView(node, view, getPos, 'html'),
  front_matter: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SourceBlockView(node, view, getPos, 'yaml'),
  toc: (node: PMNode, view: EditorView): NodeView => new TocView(node, view)
}
