/**
 * Markdown <-> document conversion.
 *
 * Parsing uses markdown-it's block parser only: block structure becomes
 * document nodes while inline content is kept as raw source text (see
 * schema.ts). Serializing writes block structure back out and copies the
 * inline source through untouched.
 */
import MarkdownIt, { type StateBlock, type Token } from 'markdown-it'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { schema } from './schema'

const { nodes } = schema

/* ------------------------------------------------------------------ */
/* Parser                                                             */
/* ------------------------------------------------------------------ */

function frontMatterRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.level !== 0 || state.blkIndent !== 0) return false
  const lineText = (line: number): string => state.src.slice(state.bMarks[line], state.eMarks[line])
  if (lineText(0).trimEnd() !== '---') return false
  let next = 1
  let found = false
  for (; next < endLine; next++) {
    const text = lineText(next).trimEnd()
    if (text === '---' || text === '...') {
      found = true
      break
    }
  }
  if (!found) return false
  if (silent) return true
  const token = state.push('front_matter', '', 0)
  token.block = true
  token.content = state.getLines(1, next, 0, false)
  token.map = [0, next + 1]
  token.markup = '---'
  state.line = next + 1
  return true
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const pos = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (pos + 2 > max) return false
  if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) return false

  const first = state.src.slice(pos + 2, max).trim()
  let content: string
  let next: number

  if (first.length >= 2 && first.endsWith('$$')) {
    // `$$ ... $$` alone on a single line
    const inner = first.slice(0, -2)
    if (inner.includes('$$')) return false
    content = inner.trim()
    next = startLine + 1
  } else {
    // `$$a$$ and more text` is inline math inside a paragraph, not a block.
    if (first.includes('$$')) return false
    const parts: string[] = first ? [first] : []
    let found = false
    for (next = startLine + 1; next < endLine; next++) {
      const lpos = state.bMarks[next] + state.tShift[next]
      const lmax = state.eMarks[next]
      if (lpos < lmax && state.sCount[next] < state.blkIndent) break
      const line = state.src.slice(lpos, lmax)
      const trimmed = line.trim()
      if (trimmed === '$$') {
        found = true
        break
      }
      if (trimmed.endsWith('$$')) {
        // The last line of the formula may carry the closing marker.
        const rest = line.trimEnd().slice(0, -2)
        if (rest.includes('$$')) return false
        parts.push(rest)
        found = true
        break
      }
      // A block that starts with text right after `$$` has to close before a blank line.
      if (first && !trimmed) return false
      parts.push(state.getLines(next, next + 1, state.blkIndent, false))
    }
    if (!found) return false
    content = parts.join('\n')
    next++
  }

  if (silent) return true
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = content
  token.map = [startLine, next]
  token.markup = '$$'
  state.line = next
  return true
}

const md = new MarkdownIt('commonmark', { html: true })
md.enable('table')
// Indented code is not supported (only fences are), and reference definitions
// stay in the document as ordinary editable lines.
md.disable(['code', 'reference'])
md.core.ruler.disable(['inline', 'text_join'])
md.block.ruler.before('table', 'front_matter', frontMatterRule)
md.block.ruler.before('fence', 'math_block', mathBlockRule, {
  alt: ['paragraph', 'reference', 'blockquote', 'list']
})

const textNode = (text: string): PMNode | undefined => (text ? schema.text(text) : undefined)

/** Width of leading whitespace in columns, with tabs advancing to the next multiple of four. */
function indentWidth(ws: string): number {
  let w = 0
  for (const ch of ws) w = ch === '\t' ? w + 4 - (w % 4) : w + 1
  return w
}

const ensureBlocks = (children: PMNode[]): PMNode[] => (children.length ? children : [nodes.paragraph.create()])

class Builder {
  private i = 0
  /** Whether the previous top-level block was a list. */
  private afterList = false
  constructor(
    private readonly tokens: Token[],
    private readonly srcLines: string[]
  ) {}

  /**
   * The text of a paragraph. Indentation of four or more columns does not make
   * a code block here (only fences do), so for top-level paragraphs it is kept
   * as part of the text: a file that uses indented code then survives being
   * opened and saved unchanged.
   */
  private paragraphText(open: Token): string {
    const text = this.tokens[this.i + 1].content
    // Right after a list the indentation cannot be kept: once the list is
    // rewritten with normal markers, indented text would be read as part of it.
    if (open.level !== 0 || !open.map || this.afterList) return text
    const lead = /^[ \t]+/.exec(this.srcLines[open.map[0]] || '')
    return lead && indentWidth(lead[0]) >= 4 ? lead[0] + text : text
  }

  blocks(closeType: string | null, lines?: number[]): PMNode[] {
    const out: PMNode[] = []
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i]
      if (closeType && t.type === closeType) {
        this.i++
        break
      }
      const line = t.map ? t.map[0] : 0
      const node = this.block(t)
      if (node) {
        out.push(node)
        lines?.push(line)
        if (t.level === 0) this.afterList = node.type === nodes.bullet_list || node.type === nodes.ordered_list
      }
    }
    return out
  }

  private block(t: Token): PMNode | null {
    switch (t.type) {
      case 'paragraph_open': {
        const text = this.paragraphText(t)
        this.i += 3
        if (/^\[toc\]$/i.test(text.trim())) return nodes.toc.create()
        return nodes.paragraph.create(null, textNode(text))
      }
      case 'heading_open': {
        const text = this.tokens[this.i + 1].content.replace(/\s*\n\s*/g, ' ')
        this.i += 3
        return nodes.heading.create({ level: Number(t.tag.slice(1)) || 1 }, textNode(text))
      }
      case 'blockquote_open':
        this.i++
        return nodes.blockquote.create(null, ensureBlocks(this.blocks('blockquote_close')))
      case 'bullet_list_open':
      case 'ordered_list_open':
        return this.list(t)
      case 'fence':
        this.i++
        return nodes.code_block.create(
          { lang: t.info.trim().split(/\s+/)[0] || '' },
          textNode(t.content.replace(/\n$/, ''))
        )
      case 'math_block':
        this.i++
        return nodes.math_block.create(null, textNode(t.content))
      case 'front_matter':
        this.i++
        return nodes.front_matter.create(null, textNode(t.content))
      case 'html_block':
        this.i++
        return nodes.html_block.create(null, textNode(t.content.replace(/\n+$/, '')))
      case 'hr':
        this.i++
        return nodes.horizontal_rule.create()
      case 'table_open':
        return this.table()
      default:
        this.i++
        return null
    }
  }

  private list(open: Token): PMNode {
    const ordered = open.type === 'ordered_list_open'
    const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close'
    this.i++
    const items: PMNode[] = []
    let tight = true
    while (this.i < this.tokens.length && this.tokens[this.i].type !== closeType) {
      const t = this.tokens[this.i]
      if (t.type !== 'list_item_open') {
        this.i++
        continue
      }
      // A list is loose when any direct paragraph of an item is not hidden.
      for (let k = this.i + 1; k < this.tokens.length; k++) {
        const c = this.tokens[k]
        if (c.type === 'list_item_close' && c.level === t.level) break
        if (c.type === 'paragraph_open' && c.level === t.level + 1 && !c.hidden) tight = false
      }
      this.i++
      const children = this.blocks('list_item_close')
      let checked: boolean | null = null
      const first = children[0]
      if (first && first.type === nodes.paragraph) {
        const m = /^\[([ xX])\](?:[ \t]+|$)/.exec(first.textContent)
        if (m) {
          checked = m[1] !== ' '
          children[0] = nodes.paragraph.create(null, textNode(first.textContent.slice(m[0].length)))
        }
      }
      items.push(nodes.list_item.create({ checked }, ensureBlocks(children)))
    }
    this.i++
    if (!items.length) items.push(nodes.list_item.create(null, nodes.paragraph.create()))
    if (ordered) {
      const start = Number(open.attrGet('start') ?? 1)
      return nodes.ordered_list.create(
        { tight, start: Number.isFinite(start) ? start : 1, delim: open.markup === ')' ? ')' : '.' },
        items
      )
    }
    return nodes.bullet_list.create({ tight, marker: /^[-+*]$/.test(open.markup) ? open.markup : '-' }, items)
  }

  private table(): PMNode {
    this.i++
    const rows: PMNode[] = []
    let cells: PMNode[] = []
    let header = false
    for (; this.i < this.tokens.length; this.i++) {
      const t = this.tokens[this.i]
      if (t.type === 'table_close') {
        this.i++
        break
      }
      if (t.type === 'thead_open') header = true
      else if (t.type === 'thead_close') header = false
      else if (t.type === 'tr_open') cells = []
      else if (t.type === 'tr_close') {
        if (cells.length) rows.push(nodes.table_row.create(null, cells))
      } else if (t.type === 'th_open' || t.type === 'td_open') {
        const m = /text-align:\s*(left|center|right)/.exec(String(t.attrGet('style') || ''))
        const inline = this.tokens[this.i + 1]
        const text = inline && inline.type === 'inline' ? inline.content : ''
        const type = header ? nodes.table_header : nodes.table_cell
        cells.push(type.create({ align: m ? m[1] : null }, textNode(text)))
      }
    }
    return nodes.table.create(null, rows)
  }
}

export interface ParseResult {
  doc: PMNode
  /** Source line on which each top-level block starts. */
  lines: number[]
}

export function parseMarkdown(source: string): ParseResult {
  const src = source.replace(/\r\n?/g, '\n')
  const tokens = md.parse(src, {})
  const lines: number[] = []
  const blocks = new Builder(tokens, src.split('\n')).blocks(null, lines)
  if (!blocks.length) {
    blocks.push(nodes.paragraph.create())
    lines.push(0)
  }
  return { doc: nodes.doc.create(null, blocks), lines }
}

/* ------------------------------------------------------------------ */
/* Serializer                                                         */
/* ------------------------------------------------------------------ */

const isList = (node: PMNode): boolean => node.type === nodes.bullet_list || node.type === nodes.ordered_list

function cellText(cell: PMNode): string {
  return cell.textContent.replace(/\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|')
}

/** Display width, counting wide (CJK, fullwidth) characters as two columns. */
function width(text: string): number {
  let w = 0
  for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

function tableLines(table: PMNode): string[] {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  table.forEach((row, _o, r) => {
    const cells: string[] = []
    row.forEach((cell) => {
      cells.push(cellText(cell))
      if (r === 0) aligns.push(cell.attrs.align as string | null)
    })
    rows.push(cells)
  })
  if (!rows.length) return []
  const cols = Math.max(...rows.map((r) => r.length))
  const widths: number[] = []
  for (let c = 0; c < cols; c++) widths.push(Math.max(3, ...rows.map((r) => width(r[c] || ''))))
  // Cells are padded the way their column is aligned, so the source reads like the table.
  const pad = (text: string, w: number, align: string | null): string => {
    const gap = Math.max(0, w - width(text))
    if (align === 'right') return ' '.repeat(gap) + text
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2))
    return text + ' '.repeat(gap)
  }
  const line = (cells: string[]): string =>
    '| ' + widths.map((w, c) => pad(cells[c] || '', w, aligns[c])).join(' | ') + ' |'
  const delim = widths.map((w, c) => {
    const a = aligns[c]
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':'
    if (a === 'right') return '-'.repeat(w - 1) + ':'
    if (a === 'left') return ':' + '-'.repeat(w - 1)
    return '-'.repeat(w)
  })
  return [line(rows[0]), '| ' + delim.join(' | ') + ' |', ...rows.slice(1).map(line)]
}

/** Blocks that end on their own line and so never absorb the line that follows them. */
const isClosed = (n: PMNode): boolean =>
  n.type === nodes.code_block || n.type === nodes.math_block || n.type === nodes.heading || n.type === nodes.horizontal_rule

/**
 * Whether `next` has to be separated from `prev` by a blank line to be read
 * back as a separate block. Only consulted inside tight lists, where blank
 * lines are otherwise left out.
 */
function needsBlank(prev: PMNode, next: PMNode): boolean {
  if (prev.type !== nodes.paragraph) return !isClosed(prev)
  if (isList(next)) {
    // An empty first item under a paragraph would read as a heading underline,
    // and only a list starting at 1 may interrupt a paragraph.
    if (next.firstChild!.textContent === '' && next.firstChild!.childCount <= 1) return true
    return next.type === nodes.ordered_list && next.attrs.start !== 1
  }
  return !(
    next.type === nodes.blockquote ||
    next.type === nodes.code_block ||
    next.type === nodes.heading ||
    next.type === nodes.math_block
  )
}

/** Lines of one list item, and whether any of its blocks had to be set apart by a blank line. */
function itemLines(item: PMNode, tight: boolean): { lines: string[]; spaced: boolean } {
  const lines: string[] = []
  let spaced = false
  let prev: PMNode | null = null
  item.forEach((child) => {
    const block = blockLines(child)
    if (!block.length) return
    if (prev && (!tight || needsBlank(prev, child))) {
      lines.push('')
      spaced = true
    }
    lines.push(...block)
    prev = child
  })
  return { lines, spaced }
}

function listLines(list: PMNode): string[] {
  const ordered = list.type === nodes.ordered_list
  const collect = (tight: boolean): { lines: string[]; spaced: boolean }[] => {
    const items: { lines: string[]; spaced: boolean }[] = []
    list.forEach((item) => items.push(itemLines(item, tight)))
    return items
  }
  // A list in which any item holds blank-separated blocks is loose by
  // definition, so it is written loose throughout rather than half and half.
  let tight = list.attrs.tight as boolean
  let items = collect(tight)
  if (tight && items.some((i) => i.spaced)) {
    tight = false
    items = collect(false)
  }

  const out: string[] = []
  list.forEach((item, _o, i) => {
    const marker = ordered ? `${(list.attrs.start as number) + i}${list.attrs.delim} ` : `${list.attrs.marker} `
    let lines = items[i].lines
    const checked = item.attrs.checked as boolean | null
    if (checked !== null) {
      const box = checked ? '[x]' : '[ ]'
      if (lines.length) lines[0] = `${box} ${lines[0]}`
      else lines = [box]
    } else if (lines.length && /^\[[ xX]\](?:[ \t]|$)/.test(lines[0])) {
      // Literal brackets at the start of a plain item must not turn it into a task.
      lines[0] = '\\' + lines[0]
    }
    if (!lines.length) lines = ['']
    // "- ---" and "- --" are thematic breaks, not list items: the marker joins the run.
    if (!ordered && HR_LINE.test((marker + lines[0]).trim())) {
      lines[0] = HR_LINE.test(lines[0]) ? (marker[0] === '*' ? '---' : '***') : '\\' + lines[0]
    }
    const indent = ' '.repeat(marker.length)
    if (i > 0 && !tight) out.push('')
    lines.forEach((l, k) => out.push(k === 0 ? (marker + l).trimEnd() : l ? indent + l : ''))
  })
  return out
}

function joinBlocks(parent: PMNode | Fragment): string[] {
  const out: string[] = []
  parent.forEach((child) => {
    const lines = blockLines(child)
    if (!lines.length) return
    if (out.length) out.push('')
    out.push(...lines)
  })
  return out
}

const HR_LINE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const MATH_LINE = /^\$\$(?:(?!\$\$).)*(?:\$\$)?[ \t]*$/
const ORDERED_START = /^(\d{1,9})[.)](?:[ \t]|$)/
const TABLE_DELIM = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
/** Block syntax that can open a paragraph's first line. */
const FIRST_LINE_BLOCK = /^(?:#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|`{3,}[^`]*$|~{3,})/
/** Block syntax that can interrupt a paragraph on a later line, plus heading underlines. */
const NEXT_LINE_BLOCK = /^(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+\S|`{3,}[^`]*$|~{3,}|(?:=+|-+)[ \t]*$)/

/**
 * Lines of a paragraph, with a backslash added wherever a line would
 * otherwise be read back as block syntax (a heading, list, quote, rule,
 * fence, table or math block). The file then holds the paragraph that was on
 * screen, not a different structure.
 */
function paragraphLines(text: string): string[] {
  return text.split('\n').map((line, i) => {
    const lead = /^[ \t]*/.exec(line)![0]
    // Text indented four columns or more is never block syntax.
    if (indentWidth(lead) >= 4) return line
    const body = line.slice(lead.length)
    // Shallow indentation on the first line means nothing, so it is dropped.
    const keep = i === 0 ? '' : lead
    const ordered = ORDERED_START.exec(body)
    if (ordered && (i === 0 || ordered[1] === '1')) return keep + ordered[1] + '\\' + body.slice(ordered[1].length)
    const block =
      HR_LINE.test(body) ||
      MATH_LINE.test(body) ||
      (i === 0 ? FIRST_LINE_BLOCK.test(body) : NEXT_LINE_BLOCK.test(body) || (body.includes('|') && TABLE_DELIM.test(body)))
    return block ? keep + '\\' + body : keep + body
  })
}

function fence(text: string): string {
  let f = '```'
  while (text.includes(f)) f += '`'
  return f
}

function blockLines(node: PMNode): string[] {
  switch (node.type) {
    case nodes.paragraph: {
      const text = node.textContent
      return text.trim() === '' ? [] : paragraphLines(text)
    }
    case nodes.heading: {
      // A trailing run of # would be read as the optional closing sequence and dropped.
      const text = node.textContent.replace(/\s*\n\s*/g, ' ').replace(/(^|[ \t])(#+[ \t]*)$/, '$1\\$2')
      return ['#'.repeat(node.attrs.level as number) + (text ? ' ' + text : '')]
    }
    case nodes.blockquote:
      return joinBlocks(node).map((l) => (l ? '> ' + l : '>'))
    case nodes.bullet_list:
    case nodes.ordered_list:
      return listLines(node)
    case nodes.code_block: {
      const text = node.textContent
      const f = fence(text)
      return [f + ((node.attrs.lang as string) || ''), ...text.split('\n'), f]
    }
    case nodes.math_block:
      return ['$$', ...node.textContent.split('\n'), '$$']
    case nodes.html_block:
      return node.textContent.split('\n')
    case nodes.front_matter:
      return ['---', ...node.textContent.split('\n'), '---']
    case nodes.horizontal_rule:
      return ['---']
    case nodes.toc:
      return ['[toc]']
    case nodes.table:
      return tableLines(node)
    case nodes.list_item:
      return listLines(nodes.bullet_list.create(null, node))
    case nodes.table_row:
      return tableLines(nodes.table.create(null, node))
    case nodes.table_cell:
    case nodes.table_header:
      return node.textContent ? [node.textContent] : []
    default:
      return node.isText ? (node.text || '').split('\n') : []
  }
}

export interface SerializeResult {
  text: string
  /** Output line on which each top-level block starts. */
  lines: number[]
}

export function serializeMarkdown(doc: PMNode): SerializeResult {
  const out: string[] = []
  const lines: number[] = []
  doc.forEach((node) => {
    const block = blockLines(node)
    if (!block.length) {
      lines.push(out.length)
      return
    }
    if (out.length) out.push('')
    lines.push(out.length)
    out.push(...block)
  })
  return { text: out.length ? out.join('\n') + '\n' : '', lines }
}

/** Markdown for an arbitrary slice of the document, used by copy and cut. */
export function fragmentToMarkdown(fragment: Fragment): string {
  if (!fragment.childCount) return ''
  const first = fragment.firstChild!
  if (first.isText) return fragment.textBetween(0, fragment.size, '\n')
  if (first.type === nodes.list_item) return listLines(nodes.bullet_list.create(null, fragment)).join('\n')
  if (first.type === nodes.table_row) return tableLines(nodes.table.create(null, fragment)).join('\n')
  if (first.type === nodes.table_cell || first.type === nodes.table_header) {
    const cells: string[] = []
    fragment.forEach((c) => cells.push(c.textContent))
    return cells.join('\t')
  }
  return joinBlocks(fragment).join('\n')
}

export function detectEol(source: string): '\r\n' | '\n' {
  const i = source.indexOf('\n')
  return i > 0 && source[i - 1] === '\r' ? '\r\n' : '\n'
}
