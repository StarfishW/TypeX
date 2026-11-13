/**
 * Slash commands: typing "/" at the start of a line or after a space opens a
 * list of blocks to insert (headings, lists, tables, code, math...). Typing on
 * filters the list; arrow keys choose, Enter or Tab inserts, Escape dismisses.
 */
import { closeHistory, isHistoryTransaction } from 'prosemirror-history'
import { Plugin, PluginKey, type Command, type Transaction } from 'prosemirror-state'
import { Mapping } from 'prosemirror-transform'
import type { EditorView } from 'prosemirror-view'
import { t } from '../i18n'
import { icon } from '../ui/dom'
import * as ed from './commands'
import { isInlineBlock, schema } from './schema'

const { nodes } = schema

/** Preferences > Editor > Slash commands. */
export const slashOptions = { enabled: true }

export interface SlashItem {
  id: string
  /** The icon in front of the label: a name from the icon set, or `glyph` text instead. */
  icon?: string
  glyph?: string
  label: () => string
  /** The Markdown the block is written as, shown on the right. */
  hint: string
  /** English words the item can also be found by (the label works in every language). */
  keywords: string
  command: () => Command
  /** Inserts text at the caret (link, image...) rather than acting on the whole block. */
  inline?: boolean
}

const headings: SlashItem[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `h${n}`,
  glyph: `H${n}`,
  label: () => t('paragraph.heading', { n }),
  hint: '#'.repeat(n),
  keywords: `h${n} heading${n} heading title header`,
  command: () => ed.setHeading(n)
}))

export const SLASH_ITEMS: SlashItem[] = [
  ...headings,
  { id: 'paragraph', icon: 'paragraph', label: () => t('paragraph.paragraph'), hint: '', keywords: 'p paragraph text plain body', command: () => ed.setHeading(0) },
  { id: 'bullet', icon: 'bulletList', label: () => t('paragraph.bulletList'), hint: '-', keywords: 'ul bullet unordered list dash', command: () => ed.toggleList('bullet') },
  { id: 'ordered', icon: 'orderedList', label: () => t('paragraph.orderedList'), hint: '1.', keywords: 'ol ordered numbered list number', command: () => ed.toggleList('ordered') },
  { id: 'task', icon: 'taskList', label: () => t('paragraph.taskList'), hint: '- [ ]', keywords: 'todo task checkbox checklist check list', command: () => ed.toggleList('task') },
  { id: 'quote', icon: 'quote', label: () => t('paragraph.quote'), hint: '>', keywords: 'quote blockquote citation', command: () => ed.toggleBlockquote },
  { id: 'code', icon: 'code', label: () => t('paragraph.code'), hint: '```', keywords: 'code fence codeblock snippet pre', command: () => ed.insertCodeFence() },
  { id: 'math', icon: 'math', label: () => t('paragraph.math'), hint: '$$', keywords: 'math formula equation latex tex', command: () => ed.insertMathBlock },
  { id: 'table', icon: 'table', label: () => t('paragraph.table'), hint: '| |', keywords: 'table grid', command: () => ed.insertTable(3, 3) },
  { id: 'diagram', icon: 'diagram', label: () => t('slash.diagram'), hint: 'mermaid', keywords: 'diagram mermaid chart flowchart graph sequence', command: () => ed.insertCodeFence('mermaid') },
  { id: 'hr', icon: 'rule', label: () => t('paragraph.hr'), hint: '---', keywords: 'hr horizontal rule line divider separator', command: () => ed.insertHorizontalRule },
  { id: 'toc', icon: 'toc', label: () => t('paragraph.toc'), hint: '[toc]', keywords: 'toc table of contents outline', command: () => ed.insertToc },
  { id: 'image', icon: 'image', label: () => t('format.image'), hint: '![]()', keywords: 'image picture img photo', command: () => ed.insertImage(), inline: true },
  { id: 'link', icon: 'link', label: () => t('format.link'), hint: '[]()', keywords: 'link url hyperlink href', command: () => ed.insertLink, inline: true },
  { id: 'footnote', icon: 'footnote', label: () => t('ctx.footnote'), hint: '[^1]', keywords: 'footnote note', command: () => ed.insertFootnote, inline: true },
  { id: 'frontMatter', icon: 'frontMatter', label: () => t('paragraph.frontMatter'), hint: '---', keywords: 'yaml front matter frontmatter metadata', command: () => ed.insertFrontMatter }
]

/** Chinese, Japanese and Korean, where a word does not have to start after a space. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Items for a query, best match first: the id, then a name or keyword that
 * starts with the query. A CJK query also matches anywhere in the name.
 */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS.slice()
  const anywhere = CJK.test(q)
  const scored: { item: SlashItem; score: number; order: number }[] = []
  SLASH_ITEMS.forEach((item, order) => {
    const label = item.label().toLowerCase()
    const words = `${label} ${item.keywords}`.split(/\s+/)
    let score = 0
    if (item.id.toLowerCase() === q) score = 3
    else if (words.some((w) => w.startsWith(q))) score = 2
    // "标题" is in "1 级标题".
    else if (anywhere && label.replace(/\s+/g, '').includes(q)) score = 1
    if (score) scored.push({ item, score, order })
  })
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.item)
}

interface SlashState {
  /** Position of the typed "/", or -1 when the list is closed. */
  from: number
  /** End of the query typed after the slash, which is the caret. */
  to: number
  /** The blocks matching the query. The list is hidden while there are none. */
  items: SlashItem[]
  index: number
}

const CLOSED: SlashState = { from: -1, to: -1, items: [], index: 0 }

/**
 * A "/" at the start of the block, after whitespace, or after CJK text or
 * punctuation (which has no spaces between words), then the query so far.
 * After other text a slash is a path, a URL or "and/or", and nothing opens.
 */
const TRIGGER = /(?:^|\s|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?!\p{ASCII})\p{P})\/([^\s/]{0,24})$/u

const key = new PluginKey<SlashState>('md-slash')

/** Whether the transaction typed the "/" at `pos`, rather than left one that was already there. */
function typedSlashAt(tr: Transaction, pos: number): boolean {
  const back = tr.mapping.invert()
  return tr.before.textBetween(back.map(pos, -1), back.map(pos + 1, -1)) !== '/'
}

/**
 * Removes the typed "/query" and runs the item's command as one change, so a
 * single undo brings the typed text back.
 */
function choose(view: EditorView, item: SlashItem): void {
  const st = key.getState(view.state)
  if (!st || st.from < 0) return
  let from = st.from
  if (!item.inline) {
    // "Intro /h2" becomes "## Intro", without a dangling space.
    const $to = view.state.doc.resolve(st.to)
    const before = $to.parent.textBetween(0, from - $to.start())
    const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size)
    const spaces = before.length - before.replace(/[^\S\n]+$/, '').length
    if (spaces && !after) from -= spaces
    else if (spaces && /^[^\S\n]/.test(after)) from -= 1
  }
  // Start a new undo step, so that undo stops at the typed "/query".
  const tr = closeHistory(view.state.tr.delete(from, st.to)).setMeta(key, 'close')
  const mid = view.state.apply(tr)
  let inner: Transaction | null = null
  if (!item.command()(mid, (next) => (inner = next), view)) {
    // The block cannot go here: keep the typed text and close the list.
    view.dispatch(view.state.tr.setMeta(key, 'close'))
    return
  }
  const result = inner as Transaction | null
  if (result && mid.doc.eq(tr.doc)) {
    for (const step of result.steps) tr.step(step)
    tr.setSelection(result.selection.map(tr.doc, new Mapping()))
    view.dispatch(tr.scrollIntoView())
  } else {
    // Another plugin adjusted the document after the deletion; run the command on the result.
    view.dispatch(tr)
    item.command()(view.state, view.dispatch, view)
  }
  view.focus()
}

export function slashPlugin(): Plugin<SlashState> {
  return new Plugin<SlashState>({
    key,
    state: {
      init: () => CLOSED,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(key) as Partial<SlashState> | 'close' | undefined
        if (meta === 'close') return CLOSED
        if (meta) return { ...prev, ...meta }
        // Typing opens and updates the list; moving the caret closes it.
        if (!tr.docChanged) return tr.selectionSet ? CLOSED : prev
        if (!slashOptions.enabled) return CLOSED
        const sel = state.selection
        if (!sel.empty) return CLOSED
        const $head = sel.$head
        const parent = $head.parent
        // Block commands make no sense inside a table cell.
        if (!isInlineBlock(parent) || parent.type === nodes.table_cell || parent.type === nodes.table_header) return CLOSED
        const start = Math.max(0, $head.parentOffset - 32)
        const before = (start > 0 ? 'x' : '') + parent.textBetween(start, $head.parentOffset)
        const m = TRIGGER.exec(before)
        if (!m) return CLOSED
        const from = $head.pos - m[1].length - 1
        const sameSlash = prev.from >= 0 && tr.mapping.map(prev.from, 1) === from
        // Only typing a "/" opens the list: not a slash brought back by undo,
        // pasted, or reached by deleting what followed it.
        if (!sameSlash && (m[1] || isHistoryTransaction(tr) || tr.getMeta('uiEvent') || !typedSlashAt(tr, from))) return CLOSED
        return { from, to: $head.pos, items: filterSlashItems(m[1]), index: 0 }
      }
    },
    props: {
      handleKeyDown(view, event) {
        const st = key.getState(view.state)!
        // While nothing matches the list is hidden, and keys do what they always do.
        if (st.from < 0 || !st.items.length || view.composing) return false
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowUp': {
            const n = st.items.length
            view.dispatch(view.state.tr.setMeta(key, { index: (st.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n }))
            return true
          }
          case 'Enter':
          case 'Tab':
            choose(view, st.items[st.index])
            return true
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(key, 'close'))
            return true
        }
        return false
      },
      handleDOMEvents: {
        blur(view) {
          if (key.getState(view.state)!.from >= 0) view.dispatch(view.state.tr.setMeta(key, 'close'))
          return false
        }
      }
    },
    view(editorView) {
      const dom = document.createElement('div')
      dom.className = 'md-autocomplete md-slash-menu'
      dom.setAttribute('role', 'listbox')
      dom.style.display = 'none'
      document.body.appendChild(dom)
      const rowAt = (e: MouseEvent): number => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
        return row ? Number(row.dataset.index) : -1
      }
      dom.addEventListener('mousedown', (e) => {
        // Keep the focus in the editor; clicking an entry inserts it.
        e.preventDefault()
        const st = key.getState(editorView.state)!
        const item = st.from >= 0 ? st.items[rowAt(e)] : undefined
        if (item) choose(editorView, item)
      })
      dom.addEventListener('mousemove', (e) => {
        const st = key.getState(editorView.state)!
        const i = rowAt(e)
        if (st.from >= 0 && st.items[i] && i !== st.index) editorView.dispatch(editorView.state.tr.setMeta(key, { index: i }))
      })

      let shownItems: SlashItem[] | null = null
      const render = (): void => {
        const st = key.getState(editorView.state)!
        if (st.from < 0 || !st.items.length) {
          dom.style.display = 'none'
          shownItems = null
          return
        }
        if (shownItems !== st.items) {
          shownItems = st.items
          dom.replaceChildren(
            ...st.items.map((item, i) => {
              const row = document.createElement('div')
              row.className = 'md-autocomplete-item md-slash-item'
              row.setAttribute('role', 'option')
              row.dataset.index = String(i)
              row.dataset.id = item.id
              const glyph = document.createElement('span')
              glyph.className = 'md-slash-icon'
              if (item.icon) glyph.appendChild(icon(item.icon))
              else glyph.textContent = item.glyph ?? ''
              const label = document.createElement('span')
              label.className = 'md-slash-label'
              label.textContent = item.label()
              const hint = document.createElement('span')
              hint.className = 'md-slash-hint'
              hint.textContent = item.hint
              row.append(glyph, label, hint)
              return row
            })
          )
          dom.scrollTop = 0
        }
        Array.from(dom.children).forEach((row, i) => {
          row.classList.toggle('active', i === st.index)
          row.setAttribute('aria-selected', String(i === st.index))
        })
        let coords: { left: number; top: number; bottom: number }
        try {
          coords = editorView.coordsAtPos(st.from)
        } catch {
          dom.style.display = 'none'
          return
        }
        dom.style.display = 'block'
        dom.style.left = `${Math.round(coords.left)}px`
        dom.style.top = `${Math.round(coords.bottom + 4)}px`
        const rect = dom.getBoundingClientRect()
        // Open upwards when there is no room below the line, and stay inside the window.
        if (rect.bottom > window.innerHeight - 8) dom.style.top = `${Math.max(8, Math.round(coords.top - rect.height - 4))}px`
        if (rect.right > window.innerWidth - 8) dom.style.left = `${Math.max(8, Math.round(window.innerWidth - rect.width - 8))}px`
        // Keep the highlighted entry visible without scrolling anything else.
        const active = dom.children[st.index] as HTMLElement
        if (active.offsetTop < dom.scrollTop) dom.scrollTop = active.offsetTop
        else if (active.offsetTop + active.offsetHeight > dom.scrollTop + dom.clientHeight) {
          dom.scrollTop = active.offsetTop + active.offsetHeight - dom.clientHeight
        }
      }
      // Follow the line when the document scrolls or the window is resized (not when the list scrolls).
      const follow = (e: Event): void => {
        if (shownItems && e.target !== dom) render()
      }
      document.addEventListener('scroll', follow, true)
      window.addEventListener('resize', follow)
      return {
        update: render,
        destroy() {
          document.removeEventListener('scroll', follow, true)
          window.removeEventListener('resize', follow)
          dom.remove()
        }
      }
    }
  })
}
