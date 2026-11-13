/**
 * Editing commands. Block commands operate on document structure; inline
 * commands edit the raw Markdown source of the current text block.
 */
import { wrapIn } from 'prosemirror-commands'
import type { Node as PMNode, NodeType, ResolvedPos } from 'prosemirror-model'
import { liftListItem, wrapInList } from 'prosemirror-schema-list'
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state'
import { CellSelection, TableMap, isInTable, selectedRect, selectionCell } from 'prosemirror-tables'
import { liftTarget } from 'prosemirror-transform'
import { tokensFor } from './decorations'
import type { Tok } from './inline'
import { isInlineBlock, schema } from './schema'

const { nodes } = schema

type Dispatch = ((tr: Transaction) => void) | undefined

export const inCode = (state: EditorState): boolean => !!state.selection.$head.parent.type.spec.code

/* ------------------------------ block commands ----------------------------- */

/** Sets the selected text blocks to a heading of `level`, or to paragraphs when `level` is 0. */
export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    if (inCode(state)) return false
    const first = $from.parent
    const toggleOff = level > 0 && first.type === nodes.heading && first.attrs.level === level
    const type = level === 0 || toggleOff ? nodes.paragraph : nodes.heading
    const attrs = type === nodes.heading ? { level } : null
    const tr = state.tr
    let changed = false
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type === nodes.paragraph || node.type === nodes.heading) {
        tr.setNodeMarkup(pos, type, attrs)
        changed = true
        return false
      }
      return !node.isTextblock
    })
    if (!changed) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** `delta` of +1 makes the heading more prominent (H2 -> H1); -1 less (H1 -> H2, H6 -> paragraph). */
export function changeHeadingLevel(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const node = $from.parent
    if (node.type !== nodes.paragraph && node.type !== nodes.heading) return false
    const current = node.type === nodes.heading ? (node.attrs.level as number) : 7
    const next = current - delta
    if (next < 1 || next > 7) return false
    return setHeading(next === 7 ? 0 : next)(state, dispatch)
  }
}

export const toggleBlockquote: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  const inner = $from.blockRange($to, (n) => n.type === nodes.blockquote)
  if (inner) {
    const target = liftTarget(inner)
    if (target == null) return false
    dispatch?.(state.tr.lift(inner, target).scrollIntoView())
    return true
  }
  return wrapIn(nodes.blockquote)(state, dispatch)
}

export function toggleList(kind: 'bullet' | 'ordered' | 'task'): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const listType = kind === 'ordered' ? nodes.ordered_list : nodes.bullet_list
    let depth = -1
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes.list_item) {
        depth = d
        break
      }
    }
    if (depth > 0) {
      const list = $from.node(depth - 1)
      const listPos = $from.before(depth - 1)
      const isTask = $from.node(depth).attrs.checked !== null
      const same = kind === 'task' ? isTask : list.type === listType && !isTask
      if (same) return liftListItem(nodes.list_item)(state, dispatch)
      if (dispatch) {
        const tr = state.tr
        if (list.type !== listType) tr.setNodeMarkup(listPos, listType, { tight: list.attrs.tight })
        list.forEach((item, offset) => {
          const checked = kind === 'task' ? ((item.attrs.checked as boolean | null) ?? false) : null
          if (checked !== item.attrs.checked) tr.setNodeMarkup(listPos + 1 + offset, null, { checked })
        })
        dispatch(tr.scrollIntoView())
      }
      return true
    }
    return wrapInList(listType)(
      state,
      dispatch &&
        ((tr) => {
          if (kind === 'task') {
            const doc = tr.doc
            doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
              if (node.type === nodes.list_item && node.attrs.checked === null) tr.setNodeMarkup(pos, null, { checked: false })
              return !node.isTextblock
            })
          }
          dispatch(tr.scrollIntoView())
        })
    )
  }
}

/**
 * Inserts a block near the selection: in place of an empty paragraph, or
 * after the closest ancestor whose parent accepts it.
 */
function insertBlock(state: EditorState, dispatch: Dispatch, node: PMNode, cursor: 'inside' | 'after'): boolean {
  const { $from } = state.selection
  const tr = state.tr
  const parent = $from.parent
  let pos = -1
  const d0 = $from.depth
  if (
    d0 > 0 &&
    parent.type === nodes.paragraph &&
    parent.content.size === 0 &&
    $from.node(d0 - 1).canReplaceWith($from.index(d0 - 1), $from.index(d0 - 1) + 1, node.type)
  ) {
    pos = $from.before()
    tr.replaceWith(pos, $from.after(), node)
  } else {
    for (let d = d0; d > 0; d--) {
      const index = $from.indexAfter(d - 1)
      if ($from.node(d - 1).canReplaceWith(index, index, node.type)) {
        pos = $from.after(d)
        break
      }
    }
    if (pos < 0) return false
    tr.insert(pos, node)
  }
  if (cursor === 'inside') {
    tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)))
  } else {
    const after = pos + node.nodeSize
    const next = tr.doc.resolve(after).nodeAfter
    if (!next || !next.isTextblock || next.type.spec.code) tr.insert(after, nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
  }
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Turns the selected paragraphs into a code fence, or inserts an empty one. */
export const insertCodeBlock: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (inCode(state)) return false
  const parent = $from.parent
  const convertible = (n: PMNode): boolean => n.type === nodes.paragraph || n.type === nodes.heading
  if (convertible(parent) && parent.content.size > 0) {
    const range = $from.blockRange($to)
    if (range) {
      let ok = true
      for (let i = range.startIndex; i < range.endIndex; i++) if (!convertible(range.parent.child(i))) ok = false
      if (ok && range.parent.canReplaceWith(range.startIndex, range.endIndex, nodes.code_block)) {
        const text = state.doc.textBetween(range.start, range.end, '\n')
        const tr = state.tr.replaceWith(range.start, range.end, nodes.code_block.create(null, schema.text(text)))
        tr.setSelection(TextSelection.create(tr.doc, range.start + 1 + text.length))
        dispatch?.(tr.scrollIntoView())
        return true
      }
    }
  }
  return insertBlock(state, dispatch, nodes.code_block.create(), 'inside')
}

/**
 * Inserts an empty code fence with the given language (`mermaid` makes a
 * diagram): in place of an empty paragraph, otherwise after the current block.
 * Unlike insertCodeBlock, it never turns existing text into code.
 */
export function insertCodeFence(lang = ''): Command {
  return (state, dispatch) => !inCode(state) && insertBlock(state, dispatch, nodes.code_block.create({ lang }), 'inside')
}

export const insertMathBlock: Command = (state, dispatch) =>
  !inCode(state) && insertBlock(state, dispatch, nodes.math_block.create(), 'inside')

export const insertHorizontalRule: Command = (state, dispatch) =>
  insertBlock(state, dispatch, nodes.horizontal_rule.create(), 'after')

export const insertToc: Command = (state, dispatch) => insertBlock(state, dispatch, nodes.toc.create(), 'after')

export const insertFrontMatter: Command = (state, dispatch) => {
  const first = state.doc.firstChild
  const tr = state.tr
  if (!first || first.type !== nodes.front_matter) tr.insert(0, nodes.front_matter.create())
  tr.setSelection(TextSelection.create(tr.doc, 1))
  dispatch?.(tr.scrollIntoView())
  return true
}

export function buildTable(rows: number, cols: number, header: string[] = []): PMNode {
  const out: PMNode[] = []
  for (let r = 0; r < Math.max(2, rows); r++) {
    const cells: PMNode[] = []
    for (let c = 0; c < Math.max(1, cols); c++) {
      const text = r === 0 ? header[c] || '' : ''
      cells.push((r === 0 ? nodes.table_header : nodes.table_cell).create(null, text ? schema.text(text) : undefined))
    }
    out.push(nodes.table_row.create(null, cells))
  }
  return nodes.table.create(null, out)
}

export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => !inCode(state) && insertBlock(state, dispatch, buildTable(rows, cols), 'inside')
}

export function insertParagraph(where: 'before' | 'after'): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    if ($from.depth < 1) return false
    const pos = where === 'before' ? $from.before(1) : $from.after(1)
    const tr = state.tr.insert(pos, nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** Inserts a footnote reference at the caret and its definition at the end of the document. */
export const insertFootnote: Command = (state, dispatch) => {
  const { $from } = state.selection
  if (!isInlineBlock($from.parent)) return false
  let n = 1
  const used = new Set<string>()
  state.doc.descendants((node) => {
    if (!node.isTextblock) return true
    for (const m of node.textContent.matchAll(/\[\^([^\]\s]+)\]/g)) used.add(m[1])
    return false
  })
  while (used.has(String(n))) n++
  const tr = state.tr.insertText(`[^${n}]`, state.selection.to)
  const end = tr.doc.content.size
  tr.insert(end, nodes.paragraph.create(null, schema.text(`[^${n}]: `)))
  tr.setSelection(TextSelection.atEnd(tr.doc))
  dispatch?.(tr.scrollIntoView())
  return true
}

export const insertLinkReference: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (!$from.sameParent($to) || !isInlineBlock($from.parent)) return false
  const text = state.doc.textBetween($from.pos, $to.pos)
  let n = 1
  const body = state.doc.textContent
  while (body.includes(`[${n}]:`)) n++
  const tr = state.tr.insertText(`[${text}][${n}]`, $from.pos, $to.pos)
  tr.insert(tr.doc.content.size, nodes.paragraph.create(null, schema.text(`[${n}]: `)))
  tr.setSelection(TextSelection.atEnd(tr.doc))
  dispatch?.(tr.scrollIntoView())
  return true
}

/* ------------------------------ inline commands ---------------------------- */

export type InlineKind = 'strong' | 'em' | 'underline' | 'code' | 'del' | 'mark' | 'math' | 'sub' | 'sup' | 'comment'

const MARKERS: Record<InlineKind, [string, string]> = {
  strong: ['**', '**'],
  em: ['*', '*'],
  underline: ['<u>', '</u>'],
  code: ['`', '`'],
  del: ['~~', '~~'],
  mark: ['==', '=='],
  math: ['$', '$'],
  sub: ['~', '~'],
  sup: ['^', '^'],
  comment: ['<!--', '-->']
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/** The word that contains or touches `offset`. */
export function wordAt(text: string, offset: number): { from: number; to: number } | null {
  for (const s of segmenter.segment(text)) {
    if (s.index > offset) break
    const end = s.index + s.segment.length
    if (s.isWordLike && offset <= end) return { from: s.index, to: end }
  }
  return null
}

function matchesKind(t: Tok, kind: InlineKind): boolean {
  if (kind === 'underline') return t.type === 'html' && t.attrs!.tag === 'u'
  return t.type === kind
}

/** The innermost token of `kind` whose range contains [a, b]. */
function findEnclosing(toks: Tok[], kind: InlineKind, a: number, b: number): Tok | null {
  for (const t of toks) {
    if (t.from > a || t.to < b) continue
    const inner = t.children ? findEnclosing(t.children, kind, a, b) : null
    if (inner) return inner
    if (matchesKind(t, kind)) return t
  }
  return null
}

const markerLengths = (t: Tok): [number, number] => (t.type === 'comment' ? [4, 3] : [t.open || 0, t.close || 0])

export function toggleInline(kind: InlineKind): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    if (!$from.sameParent($to) || !isInlineBlock($from.parent)) return false
    const block = $from.parent
    const base = $from.start()
    const text = block.textContent
    let a = $from.parentOffset
    let b = $to.parentOffset
    const [open, close] = MARKERS[kind]
    const tr = state.tr

    const hit = findEnclosing(tokensFor(block), kind, a, b)
    if (hit) {
      const [ol, cl] = markerLengths(hit)
      tr.delete(base + hit.to - cl, base + hit.to).delete(base + hit.from, base + hit.from + ol)
      dispatch?.(tr.scrollIntoView())
      return true
    }

    const collapsed = a === b
    const caret = a
    if (collapsed) {
      const w = wordAt(text, a)
      if (w) {
        a = w.from
        b = w.to
      }
    }
    if (a === b) {
      tr.insertText(open + close, base + a)
      tr.setSelection(TextSelection.create(tr.doc, base + a + open.length))
      dispatch?.(tr.scrollIntoView())
      return true
    }
    while (a < b && /\s/.test(text[a])) a++
    while (b > a && /\s/.test(text[b - 1])) b--
    if (a === b) return false
    tr.insertText(close, base + b).insertText(open, base + a)
    tr.setSelection(
      collapsed
        ? TextSelection.create(tr.doc, base + caret + open.length)
        : TextSelection.create(tr.doc, base + a + open.length, base + b + open.length)
    )
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

const CLEARABLE = new Set(['strong', 'em', 'del', 'mark', 'sub', 'sup', 'code', 'html'])

/** Removes the markers of every style that overlaps the selection. */
export const clearFormat: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (!$from.sameParent($to) || !isInlineBlock($from.parent)) return false
  const base = $from.start()
  const a = $from.parentOffset
  const b = $to.parentOffset
  const cuts: [number, number][] = []
  const visit = (toks: Tok[]): void => {
    for (const t of toks) {
      if (t.to < a || t.from > b) continue
      if (CLEARABLE.has(t.type)) {
        const [ol, cl] = markerLengths(t)
        if (ol) cuts.push([t.from, t.from + ol])
        if (cl) cuts.push([t.to - cl, t.to])
      }
      if (t.children) visit(t.children)
    }
  }
  visit(tokensFor($from.parent))
  if (!cuts.length) return false
  const tr = state.tr
  cuts.sort((x, y) => y[0] - x[0])
  for (const [from, to] of cuts) tr.delete(base + from, base + to)
  dispatch?.(tr.scrollIntoView())
  return true
}

export const insertLink: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (!$from.sameParent($to) || !isInlineBlock($from.parent)) return false
  const text = state.doc.textBetween($from.pos, $to.pos)
  const tr = state.tr
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
    tr.insertText(`[](${text})`, $from.pos, $to.pos)
    tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1))
  } else {
    tr.insertText(`[${text}]()`, $from.pos, $to.pos)
    tr.setSelection(TextSelection.create(tr.doc, text ? $from.pos + text.length + 3 : $from.pos + 1))
  }
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Inserts image syntax; with no `src` the caret is left inside the parentheses. */
export function insertImage(src = '', alt = ''): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    if (!isInlineBlock($from.parent) || !$from.sameParent($to)) return false
    const label = alt || state.doc.textBetween($from.pos, $to.pos)
    const md = `![${label}](${src})`
    const tr = state.tr.insertText(md, $from.pos, $to.pos)
    tr.setSelection(TextSelection.create(tr.doc, src ? $from.pos + md.length : $from.pos + md.length - 1))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** Inserts raw inline Markdown at the selection. */
export function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text, state.selection.from, state.selection.to).scrollIntoView())
    return true
  }
}

/* -------------------------------- selection -------------------------------- */

export const selectWord: Command = (state, dispatch) => {
  const { $head } = state.selection
  if (!$head.parent.isTextblock) return false
  const w = wordAt($head.parent.textContent, $head.parentOffset)
  if (!w) return false
  const base = $head.start()
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, base + w.from, base + w.to)))
  return true
}

/** Selects the current line of the text block, or the current row inside a table. */
export const selectLine: Command = (state, dispatch) => {
  if (isInTable(state)) {
    const $cell = selectionCell(state)
    dispatch?.(state.tr.setSelection(CellSelection.rowSelection($cell)))
    return true
  }
  const { $head } = state.selection
  if (!$head.parent.isTextblock) return false
  const text = $head.parent.textContent
  const offset = $head.parentOffset
  const from = text.lastIndexOf('\n', offset - 1) + 1
  let to = text.indexOf('\n', offset)
  if (to < 0) to = text.length
  const base = $head.start()
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, base + from, base + to)))
  return true
}

/** Selects the content of the innermost styled span around the caret, or the table cell. */
export const selectScope: Command = (state, dispatch) => {
  const { $head } = state.selection
  if (!$head.parent.isTextblock) return false
  const base = $head.start()
  if (isInlineBlock($head.parent)) {
    const offset = $head.parentOffset
    let best: Tok | null = null
    const visit = (toks: Tok[]): void => {
      for (const t of toks) {
        if (t.type === 'text' || t.from > offset || t.to < offset) continue
        best = t
        if (t.children) visit(t.children)
      }
    }
    visit(tokensFor($head.parent))
    if (best) {
      const t = best as Tok
      const [ol, cl] = markerLengths(t)
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, base + t.from + ol, base + t.to - cl)))
      return true
    }
  }
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, base, base + $head.parent.content.size)))
  return true
}

export const deleteWord: Command = (state, dispatch) => {
  if (!selectWord(state)) return false
  let tr: Transaction | null = null
  selectWord(state, (t) => (tr = t))
  if (!tr) return false
  dispatch?.((tr as Transaction).deleteSelection().scrollIntoView())
  return true
}

export const jumpToTop: Command = (state, dispatch) => {
  dispatch?.(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView())
  return true
}

export const jumpToBottom: Command = (state, dispatch) => {
  dispatch?.(state.tr.setSelection(Selection.atEnd(state.doc)).scrollIntoView())
  return true
}

export const jumpToSelection: Command = (state, dispatch) => {
  dispatch?.(state.tr.scrollIntoView())
  return true
}

/* ---------------------------------- tables --------------------------------- */

export function setColumnAlign(align: 'left' | 'center' | 'right' | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    const rect = selectedRect(state)
    if (dispatch) {
      const tr = state.tr
      const seen = new Set<number>()
      for (let col = rect.left; col < rect.right; col++) {
        for (let row = 0; row < rect.map.height; row++) {
          const cellPos = rect.map.map[row * rect.map.width + col]
          if (seen.has(cellPos)) continue
          seen.add(cellPos)
          const cell = rect.table.nodeAt(cellPos)
          if (cell) tr.setNodeMarkup(rect.tableStart + cellPos, null, { ...cell.attrs, align })
        }
      }
      dispatch(tr)
    }
    return true
  }
}

/** Position info for the cell that holds the selection head. */
export function cellContext(state: EditorState): {
  $cell: ResolvedPos
  table: PMNode
  tableStart: number
  map: TableMap
  row: number
  col: number
} | null {
  if (!isInTable(state)) return null
  const $cell = selectionCell(state)
  const table = $cell.node(-1)
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const rect = map.findCell($cell.pos - tableStart)
  return { $cell, table, tableStart, map, row: rect.top, col: rect.left }
}

/** Places the caret at the end of the cell at (row, col). */
export function caretInCell(tr: Transaction, tableStart: number, table: PMNode, row: number, col: number): Transaction {
  const map = TableMap.get(table)
  const cellPos = map.map[row * map.width + col]
  const cell = table.nodeAt(cellPos)
  return tr.setSelection(TextSelection.create(tr.doc, tableStart + cellPos + 1 + (cell ? cell.content.size : 0)))
}

export const typeFor = (name: string): NodeType => nodes[name]
