/**
 * Emoji autocomplete: typing a colon followed by a few letters offers matching
 * shortcodes. Arrow keys choose, Enter or Tab inserts, Escape dismisses.
 */
import { nameToEmoji } from 'gemoji'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { isInlineBlock } from './schema'

export interface Suggestion {
  name: string
  char: string
}

interface AcState {
  /** Document range of the typed `:query`. */
  from: number
  to: number
  items: Suggestion[]
  index: number
}

const CLOSED: AcState = { from: -1, to: -1, items: [], index: 0 }
const LIMIT = 8
/** A colon at the start of a word, followed by the shortcode typed so far. */
const TRIGGER = /(?:^|[\s([{"'　-〿（，])(:([a-z0-9_+-]{1,32}))$/

const key = new PluginKey<AcState>('md-emoji-complete')

let names: string[] | null = null

/** Shortcodes that start with `query` (shortest first), then ones that contain it. */
export function emojiMatches(query: string): Suggestion[] {
  if (!names) names = Object.keys(nameToEmoji).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  const q = query.toLowerCase()
  const out: string[] = []
  for (const n of names) {
    if (n.startsWith(q)) {
      out.push(n)
      if (out.length >= LIMIT) break
    }
  }
  if (out.length < LIMIT && q.length >= 2) {
    for (const n of names) {
      if (!n.startsWith(q) && n.includes(q)) {
        out.push(n)
        if (out.length >= LIMIT) break
      }
    }
  }
  return out.map((name) => ({ name, char: nameToEmoji[name] }))
}

function accept(view: EditorView, index: number): void {
  const st = key.getState(view.state)
  const item = st?.items[index]
  if (!st || !item) return
  view.dispatch(view.state.tr.insertText(`:${item.name}:`, st.from, st.to).setMeta(key, 'close').scrollIntoView())
  view.focus()
}

export function emojiCompletePlugin(): Plugin<AcState> {
  return new Plugin<AcState>({
    key,
    state: {
      init: () => CLOSED,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(key) as Partial<AcState> | 'close' | undefined
        if (meta === 'close') return CLOSED
        if (meta) return { ...prev, ...meta }
        // Only typing opens or updates the list; moving the caret closes it.
        if (!tr.docChanged) return tr.selectionSet ? CLOSED : prev
        const sel = state.selection
        if (!sel.empty) return CLOSED
        const $head = sel.$head
        if (!isInlineBlock($head.parent)) return CLOSED
        const start = Math.max(0, $head.parentOffset - 64)
        // When the window starts mid-line, a leading character keeps `^` from matching there.
        const before = (start > 0 ? 'x' : '') + $head.parent.textBetween(start, $head.parentOffset)
        const m = TRIGGER.exec(before)
        if (!m) return CLOSED
        const items = emojiMatches(m[2])
        if (!items.length) return CLOSED
        return { from: $head.pos - m[1].length, to: $head.pos, items, index: 0 }
      }
    },
    props: {
      handleKeyDown(view, event) {
        const st = key.getState(view.state)!
        if (!st.items.length || view.composing) return false
        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowUp': {
            const n = st.items.length
            const index = (st.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n
            view.dispatch(view.state.tr.setMeta(key, { index }))
            return true
          }
          case 'Enter':
          case 'Tab':
            accept(view, st.index)
            return true
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(key, 'close'))
            return true
        }
        return false
      },
      handleDOMEvents: {
        blur(view) {
          if (key.getState(view.state)!.items.length) view.dispatch(view.state.tr.setMeta(key, 'close'))
          return false
        }
      }
    },
    view(editorView) {
      const dom = document.createElement('div')
      dom.className = 'md-autocomplete'
      dom.style.display = 'none'
      document.body.appendChild(dom)
      dom.addEventListener('mousedown', (e) => {
        // Keep focus in the editor; clicking an entry inserts it.
        e.preventDefault()
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
        if (row) accept(editorView, Number(row.dataset.index))
      })

      let shown: AcState | null = null
      const render = (): void => {
        const st = key.getState(editorView.state)!
        if (!st.items.length) {
          dom.style.display = 'none'
          shown = null
          return
        }
        if (shown !== st) {
          dom.replaceChildren(
            ...st.items.map((item, i) => {
              const row = document.createElement('div')
              row.className = 'md-autocomplete-item' + (i === st.index ? ' active' : '')
              row.dataset.index = String(i)
              const char = document.createElement('span')
              char.className = 'md-autocomplete-char'
              char.textContent = item.char
              const name = document.createElement('span')
              name.textContent = `:${item.name}:`
              row.append(char, name)
              return row
            })
          )
          shown = st
        }
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
        if (rect.bottom > window.innerHeight - 8) dom.style.top = `${Math.round(coords.top - rect.height - 4)}px`
        if (rect.right > window.innerWidth - 8) dom.style.left = `${Math.max(8, Math.round(window.innerWidth - rect.width - 8))}px`
      }
      const onScroll = (): void => {
        if (shown) render()
      }
      document.addEventListener('scroll', onScroll, true)
      return {
        update: render,
        destroy() {
          document.removeEventListener('scroll', onScroll, true)
          dom.remove()
        }
      }
    }
  })
}
