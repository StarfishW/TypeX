/**
 * Keyboard behaviour: structural Enter/Backspace/Tab handling, the Markdown
 * typing shortcuts that turn text into blocks, and bracket auto-pairing.
 *
 * Shortcuts that also appear in the application menu (Ctrl+B, Ctrl+1, ...)
 * are not bound here; the menu delivers those as commands.
 */
import {
  chainCommands,
  createParagraphNear,
  deleteSelection,
  joinBackward,
  joinForward,
  liftEmptyBlock,
  selectAll,
  selectNodeBackward,
  selectNodeForward,
  splitBlockAs
} from 'prosemirror-commands'
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { redo, undo } from 'prosemirror-history'
import { Plugin, Selection, TextSelection, type Command } from 'prosemirror-state'
import { addRowAfter, deleteRow, goToNextCell, isInTable } from 'prosemirror-tables'
import type { EditorView } from 'prosemirror-view'
import { buildTable, caretInCell, cellContext, toggleInline } from './commands'
import { env } from './env'
import { isInlineBlock, schema } from './schema'

const { nodes } = schema

/* --------------------------------- Enter ---------------------------------- */

/**
 * Pressing Enter at the end of a paragraph that consists only of block syntax
 * turns that paragraph into the block: fences, math, rules, tables, a table of
 * contents, front matter, or a heading typed in full.
 */
const enterTriggers: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== nodes.paragraph) return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  const text = $from.parent.textContent
  if (!text || text.includes('\n')) return false
  const pos = $from.before()
  const end = $from.after()
  const tr = state.tr
  let m: RegExpExecArray | null

  const withParagraphAfter = (node: PMNode): void => {
    tr.replaceWith(pos, end, [node, nodes.paragraph.create()])
    tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize + 1))
  }

  if ((m = /^(?:`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(text))) {
    tr.replaceWith(pos, end, nodes.code_block.create({ lang: m[1] }))
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  } else if (/^\$\$\s*$/.test(text)) {
    tr.replaceWith(pos, end, nodes.math_block.create())
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  } else if (pos === 0 && text === '---') {
    tr.replaceWith(pos, end, nodes.front_matter.create())
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  } else if (/^([-*_])( *\1){2,} *$/.test(text)) {
    withParagraphAfter(nodes.horizontal_rule.create())
  } else if (/^\[toc\]$/i.test(text.trim())) {
    withParagraphAfter(nodes.toc.create())
  } else if ((m = /^\|(.+)\|\s*$/.exec(text))) {
    const header = m[1].split(/(?<!\\)\|/).map((s) => s.trim())
    const table = buildTable(2, header.length, header)
    tr.replaceWith(pos, end, table)
    caretInCell(tr, pos + 1, table, 1, 0)
  } else if ((m = /^(#{1,6})[ \t]+(\S.*)$/.exec(text))) {
    const heading = nodes.heading.create({ level: m[1].length }, schema.text(m[2]))
    withParagraphAfter(heading)
  } else {
    return false
  }
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Enter in a table moves to the same column of the next row, or out below the table. */
const tableEnter: Command = (state, dispatch) => {
  const ctx = cellContext(state)
  if (!ctx) return false
  const tr = state.tr
  if (ctx.row + 1 < ctx.map.height) {
    caretInCell(tr, ctx.tableStart, ctx.table, ctx.row + 1, ctx.col)
  } else {
    const after = ctx.tableStart + ctx.table.nodeSize - 1
    const next = tr.doc.resolve(after).nodeAfter
    if (!next || next.type !== nodes.paragraph) tr.insert(after, nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
  }
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Ctrl+Enter in a table adds a row below and moves into it. */
const tableAddRow: Command = (state, dispatch) => {
  const ctx = cellContext(state)
  if (!ctx) return false
  return addRowAfter(
    state,
    dispatch &&
      ((tr) => {
        const table = tr.doc.nodeAt(ctx.tableStart - 1)
        if (table) caretInCell(tr, ctx.tableStart, table, ctx.row + 1, ctx.col)
        dispatch(tr.scrollIntoView())
      })
  )
}

const listEnter: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.depth < 2 || $from.node(-1).type !== nodes.list_item) return false
  return splitListItem(nodes.list_item)(
    state,
    dispatch &&
      ((tr) => {
        // A new task item starts unchecked.
        const $pos = tr.selection.$from
        for (let d = $pos.depth; d > 0; d--) {
          const n = $pos.node(d)
          if (n.type === nodes.list_item) {
            if (n.attrs.checked === true) tr.setNodeMarkup($pos.before(d), null, { checked: false })
            break
          }
        }
        dispatch(tr)
      })
  )
}

const splitBlock = splitBlockAs((node, atEnd) => (atEnd || node.type === nodes.heading ? { type: nodes.paragraph } : null))

const hardBreak: Command = (state, dispatch) => {
  const { $from } = state.selection
  if (!isInlineBlock($from.parent)) return false
  if ($from.parent.type === nodes.heading) return true
  const text = isInTable(state) ? '<br>' : '\n'
  dispatch?.(state.tr.insertText(text, state.selection.from, state.selection.to).scrollIntoView())
  return true
}

/* ------------------------------- Backspace -------------------------------- */

const isSourceBlock = (node: { type: { spec: { code?: boolean } } } | null | undefined): boolean => !!node && !!node.type.spec.code

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '“': '”',
  '‘': '’',
  '（': '）',
  '「': '」',
  '《': '》',
  '【': '】'
}
const CLOSERS = new Set(Object.values(PAIRS))

export const pairOptions = { enabled: true }

const backspaceSpecial: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false
  const parent = $from.parent

  // Between an empty auto-inserted pair: remove both halves.
  if (pairOptions.enabled && isInlineBlock(parent) && $from.parentOffset > 0) {
    const text = parent.textContent
    const prev = text[$from.parentOffset - 1]
    if (PAIRS[prev] && text[$from.parentOffset] === PAIRS[prev]) {
      dispatch?.(state.tr.delete($from.pos - 1, $from.pos + 1))
      return true
    }
  }
  if ($from.parentOffset > 0) return false

  if (parent.type === nodes.heading) {
    dispatch?.(state.tr.setNodeMarkup($from.before(), nodes.paragraph))
    return true
  }

  const d = $from.depth
  if (d >= 2 && $from.node(d - 1).type === nodes.list_item && $from.index(d - 1) === 0) {
    const item = $from.node(d - 1)
    if (item.attrs.checked !== null) {
      dispatch?.(state.tr.setNodeMarkup($from.before(d - 1), null, { checked: null }))
      return true
    }
    return liftListItem(nodes.list_item)(state, dispatch)
  }

  // Never merge prose into a preceding code/math block or table: step into it instead.
  if (d >= 1 && parent.type === nodes.paragraph) {
    const index = $from.index(d - 1)
    const before = index > 0 ? $from.node(d - 1).child(index - 1) : null
    if (before && (isSourceBlock(before) || before.type === nodes.table)) {
      const tr = state.tr
      const blockStart = $from.before()
      if (parent.content.size === 0) tr.delete(blockStart, $from.after())
      const sel = Selection.findFrom(tr.doc.resolve(blockStart), -1)
      if (sel) tr.setSelection(sel)
      dispatch?.(tr.scrollIntoView())
      return true
    }
  }
  return false
}

const deleteSpecial: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset < $from.parent.content.size) return false
  const d = $from.depth
  if (d < 1 || !isInlineBlock($from.parent)) return false
  const container = $from.node(d - 1)
  const index = $from.indexAfter(d - 1)
  const after = index < container.childCount ? container.child(index) : null
  if (after && (isSourceBlock(after) || after.type === nodes.table)) {
    const tr = state.tr
    const blockEnd = $from.after()
    if ($from.parent.content.size === 0) {
      tr.delete($from.before(), blockEnd)
      const sel = Selection.findFrom(tr.doc.resolve($from.before()), 1)
      if (sel) tr.setSelection(sel)
    } else {
      const sel = Selection.findFrom(tr.doc.resolve(blockEnd), 1)
      if (sel) tr.setSelection(sel)
    }
    dispatch?.(tr.scrollIntoView())
    return true
  }
  return false
}

/* ----------------------------------- Tab ---------------------------------- */

const tableTab: Command = (state, dispatch) => {
  if (!isInTable(state)) return false
  if (goToNextCell(1)(state, dispatch)) return true
  // Last cell: add a row and move into it.
  const ctx = cellContext(state)
  if (!ctx) return false
  return addRowAfter(
    state,
    dispatch &&
      ((tr) => {
        const table = tr.doc.nodeAt(ctx.tableStart - 1)
        if (table) caretInCell(tr, ctx.tableStart, table, ctx.row + 1, 0)
        dispatch(tr.scrollIntoView())
      })
  )
}

const consume: Command = () => true

/* ------------------------- arrows into source blocks ----------------------- */

function arrowInto(dir: 'left' | 'right' | 'up' | 'down'): Command {
  return (state, dispatch, view) => {
    if (!state.selection.empty || !view || !view.endOfTextblock(dir)) return false
    const side = dir === 'left' || dir === 'up' ? -1 : 1
    const { $head } = state.selection
    if ($head.depth < 1) return false
    const next = Selection.findFrom(state.doc.resolve(side > 0 ? $head.after() : $head.before()), side)
    if (next && next.$head.parent.type.spec.code) {
      dispatch?.(state.tr.setSelection(next))
      return true
    }
    return false
  }
}

export function editorKeymap(): Plugin {
  const li = nodes.list_item
  return keymap({
    Enter: chainCommands(enterTriggers, tableEnter, listEnter, createParagraphNear, liftEmptyBlock, splitBlock),
    'Mod-Enter': tableAddRow,
    'Shift-Enter': hardBreak,
    Backspace: chainCommands(undoInputRule, backspaceSpecial, deleteSelection, joinBackward, selectNodeBackward),
    'Mod-Backspace': chainCommands(deleteSelection, joinBackward, selectNodeBackward),
    Delete: chainCommands(deleteSpecial, deleteSelection, joinForward, selectNodeForward),
    'Mod-Delete': chainCommands(deleteSelection, joinForward, selectNodeForward),
    Tab: chainCommands(tableTab, sinkListItem(li), consume),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(li), consume),
    ArrowLeft: arrowInto('left'),
    ArrowRight: arrowInto('right'),
    ArrowUp: arrowInto('up'),
    ArrowDown: arrowInto('down'),
    'Mod-a': selectAll,
    // These keys have built-in rich-text behaviour in an editable region, so
    // they are handled here rather than by the application menu.
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': toggleInline('strong'),
    'Mod-i': toggleInline('em'),
    'Mod-u': toggleInline('underline'),
    'Shift-Mod-Backspace': deleteRow,
    'Shift-Mod-v': () => {
      env.pastePlain()
      return true
    }
  })
}

/* ------------------------------- input rules ------------------------------ */

const taskRule = new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start)
  if ($start.depth < 2 || $start.node(-1).type !== nodes.list_item || $start.index(-1) !== 0) return null
  return state.tr.delete(start, end).setNodeMarkup($start.before(-1), null, { checked: /x/i.test(match[1]) })
})

export function editorInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      wrappingInputRule(
        /^(\d+)([.)])\s$/,
        nodes.ordered_list,
        (m) => ({ start: Number(m[1]), delim: m[2] }),
        (m, node) => node.childCount + (node.attrs.start as number) === Number(m[1])
      ),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (m) => ({ marker: m[1] })),
      taskRule
    ]
  })
}

/* -------------------------------- auto pair ------------------------------- */

export function autoPairPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
        if (!pairOptions.enabled || text.length !== 1 || view.composing) return false
        const { state } = view
        const $from = state.doc.resolve(from)
        if (!isInlineBlock($from.parent)) return false
        const content = $from.parent.textContent
        const offset = $from.parentOffset
        const next = content[offset + (to - from)] || ''
        const prev = offset > 0 ? content[offset - 1] : ''

        // Typing a closer that is already there just steps over it.
        if (from === to && CLOSERS.has(text) && next === text) {
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from + 1)))
          return true
        }
        const close = PAIRS[text]
        if (!close) return false
        if (from !== to) {
          if (!$from.sameParent(state.doc.resolve(to))) return false
          const tr = state.tr.insertText(close, to).insertText(text, from)
          tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
          view.dispatch(tr)
          return true
        }
        if (next && !/[\s)\]}>,.;:!?'"、。，）」》】]/.test(next)) return false
        if ((text === '"' || text === "'") && /[\p{L}\p{N}]/u.test(prev)) return false
        const tr = state.tr.insertText(text + close, from)
        tr.setSelection(TextSelection.create(tr.doc, from + 1))
        view.dispatch(tr)
        return true
      }
    }
  })
}
