/**
 * Small editor plugins: focus tracking, task checkboxes, document invariants,
 * table-of-contents refresh and link activation.
 */
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { refTarget } from './decorations'
import { env } from './env'
import { getHeadings, refreshTocs } from './nodeviews'
import { schema } from './schema'

const { nodes } = schema

/* ---------------------------------- focus --------------------------------- */

/**
 * Marks the block that holds the selection (`md-focus`) and its top-level
 * ancestor (`md-focus-top`). Source blocks use the former to reveal their
 * editor; focus mode uses the latter to dim everything else.
 */
export function focusPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState) {
        const sel = state.selection
        const decos: Decoration[] = []
        if (sel instanceof NodeSelection) {
          const $pos = sel.$from
          const top = $pos.depth === 0
          decos.push(Decoration.node(sel.from, sel.to, { class: top ? 'md-focus md-focus-top' : 'md-focus' }, { focus: true }))
          if (!top) decos.push(Decoration.node($pos.before(1), $pos.after(1), { class: 'md-focus-top' }))
          return DecorationSet.create(state.doc, decos)
        }
        const $head = sel.$head
        const d = $head.depth
        if (d < 1) return null
        decos.push(
          Decoration.node($head.before(d), $head.after(d), { class: d === 1 ? 'md-focus md-focus-top' : 'md-focus' }, { focus: true })
        )
        for (let k = d - 1; k >= 1; k--) {
          const node = $head.node(k)
          const cls = (node.type === nodes.table ? 'md-focus ' : '') + (k === 1 ? 'md-focus-top' : '')
          if (cls.trim()) decos.push(Decoration.node($head.before(k), $head.after(k), { class: cls.trim() }))
        }
        return DecorationSet.create(state.doc, decos)
      }
    }
  })
}

/* ------------------------------ task checkboxes --------------------------- */

const taskKey = new PluginKey<DecorationSet>('md-tasks')

function taskDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type === nodes.list_item && node.attrs.checked !== null) {
      const checked = node.attrs.checked as boolean
      const first = node.firstChild
      const at = first && first.isTextblock && !first.type.spec.code ? pos + 2 : pos + 1
      decos.push(
        Decoration.widget(
          at,
          (view, getPos) => {
            const box = document.createElement('input')
            box.type = 'checkbox'
            box.className = 'md-task-checkbox'
            box.checked = checked
            box.tabIndex = -1
            box.addEventListener('mousedown', (e) => e.preventDefault())
            box.addEventListener('click', (e) => {
              e.preventDefault()
              const p = getPos()
              if (p == null) return
              const $p = view.state.doc.resolve(p)
              for (let d = $p.depth; d > 0; d--) {
                const n = $p.node(d)
                if (n.type === nodes.list_item) {
                  view.dispatch(view.state.tr.setNodeMarkup($p.before(d), null, { checked: !n.attrs.checked }))
                  return
                }
              }
            })
            return box
          },
          { side: -1, key: `task|${checked}`, ignoreSelection: true, stopEvent: () => true }
        )
      )
    }
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decos)
}

export function taskPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: taskKey,
    state: {
      init: (_c, state) => taskDecorations(state.doc),
      apply: (tr, prev) => (tr.docChanged ? taskDecorations(tr.doc) : prev)
    },
    props: {
      decorations: (state) => taskKey.getState(state)
    }
  })
}

/* --------------------------- document invariants --------------------------- */

/** Transactions carrying this meta are housekeeping and do not make the document dirty. */
export const HOUSEKEEPING = 'typex-housekeeping'

/**
 * Keeps two structural rules true after every change:
 *  - the document ends with a paragraph, so there is always somewhere to click
 *    and type below a table, fence or list;
 *  - the first row of every table is its header row and no other row is.
 */
export function invariantsPlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged)) return null
      const tr = state.tr
      let changed = false

      state.doc.descendants((node, pos) => {
        if (node.type !== nodes.table) return !node.isTextblock
        node.forEach((row, rowOffset, r) => {
          const want = r === 0 ? nodes.table_header : nodes.table_cell
          row.forEach((cell, cellOffset) => {
            if (cell.type !== want) {
              tr.setNodeMarkup(pos + 1 + rowOffset + 1 + cellOffset, want, cell.attrs)
              changed = true
            }
          })
        })
        return false
      })

      const last = tr.doc.lastChild
      if (!last || (last.type !== nodes.paragraph && last.type !== nodes.heading)) {
        tr.insert(tr.doc.content.size, nodes.paragraph.create())
        changed = true
      }
      return changed ? tr.setMeta('addToHistory', false).setMeta(HOUSEKEEPING, true) : null
    }
  })
}

/* ------------------------------ table of contents -------------------------- */

export function tocPlugin(onHeadings?: (headings: ReturnType<typeof getHeadings>) => void): Plugin {
  let signature = ''
  return new Plugin({
    view(view) {
      const sync = (doc: PMNode): void => {
        const headings = getHeadings(doc)
        const sig = headings.map((h) => `${h.level}:${h.pos}:${h.text}`).join('\n')
        if (sig === signature) return
        signature = sig
        refreshTocs(headings)
        onHeadings?.(headings)
      }
      sync(view.state.doc)
      return {
        update(v, prev) {
          if (v.state.doc !== prev.doc) sync(v.state.doc)
        }
      }
    }
  })
}

/* ----------------------------- selection sync ----------------------------- */

/**
 * The browser reports caret movement a frame after it happens. A key pressed
 * inside that frame (End then Enter, or a click followed at once by typing)
 * would otherwise be applied to the previous caret position. Reading pending
 * DOM state at the start of every key press closes that window.
 */
export function selectionSyncPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.keyCode === 229 || view.composing) return false
        const observer = (view as unknown as { domObserver?: { flush?: () => void } }).domObserver
        observer?.flush?.()
        return false
      }
    }
  })
}

/* ---------------------------------- links --------------------------------- */

/** Ctrl+click (or Cmd+click) follows a link; a plain click just places the caret. */
export function linkPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(_view, event) {
          const e = event as MouseEvent
          if (!(e.ctrlKey || e.metaKey)) return false
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-href]')
          if (!el) return false
          let href = el.getAttribute('data-href') || ''
          if (href.startsWith('\u0000ref:')) href = refTarget(href.slice(5)) || ''
          if (!href) return false
          e.preventDefault()
          env.openLink(href)
          return true
        },
        mousedown(view, event) {
          // Stop the browser from starting a drag or a new-window navigation on Ctrl+click.
          const e = event as MouseEvent
          if ((e.ctrlKey || e.metaKey) && (e.target as HTMLElement).closest('[data-href]')) {
            e.preventDefault()
            return true
          }
          // When focus arrives from outside (an embedded code editor, the find
          // bar), the editor only learns the new caret position a frame later.
          // Until then it would act on, and could even restore, the old
          // selection. Move the selection to the click point right away.
          if (e.button === 0 && !e.shiftKey && !view.hasFocus()) {
            const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
            if (at) {
              const { doc } = view.state
              const $pos = doc.resolve(at.pos)
              const sel = $pos.parent.inlineContent ? TextSelection.create(doc, at.pos) : Selection.near($pos)
              if (!sel.$head.parent.type.spec.code && !sel.eq(view.state.selection)) {
                view.dispatch(view.state.tr.setSelection(sel).setMeta('pointer', true))
              }
            }
          }
          return false
        }
      }
    }
  })
}
