/**
 * Find and replace over the document's text blocks.
 */
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

export interface SearchQuery {
  text: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface Match {
  from: number
  to: number
}

interface SearchState {
  query: SearchQuery | null
  matches: Match[]
  current: number
  deco: DecorationSet
}

const MAX_MATCHES = 10000

export const searchKey = new PluginKey<SearchState>('md-search')

export function buildRegex(q: SearchQuery): RegExp | null {
  if (!q.text) return null
  let source = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (q.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  try {
    return new RegExp(source, 'gu' + (q.caseSensitive ? '' : 'i'))
  } catch {
    return null
  }
}

function findMatches(doc: PMNode, q: SearchQuery | null): Match[] {
  const re = q && buildRegex(q)
  if (!re) return []
  const out: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return out.length < MAX_MATCHES
    const text = node.textContent
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++
        continue
      }
      out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length })
      if (out.length >= MAX_MATCHES) break
    }
    return false
  })
  return out
}

function decorate(doc: PMNode, matches: Match[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === current ? 'md-search-hit md-search-current' : 'md-search-hit' })
    )
  )
}

type Meta = { query: SearchQuery | null } | { current: number }

export function searchPlugin(): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => ({ query: null, matches: [], current: -1, deco: DecorationSet.empty }),
      apply(tr, prev) {
        const meta = tr.getMeta(searchKey) as Meta | undefined
        if (meta && 'query' in meta) {
          const matches = findMatches(tr.doc, meta.query)
          return { query: meta.query, matches, current: -1, deco: decorate(tr.doc, matches, -1) }
        }
        if (meta && 'current' in meta) {
          return { ...prev, current: meta.current, deco: decorate(tr.doc, prev.matches, meta.current) }
        }
        if (tr.docChanged && prev.query) {
          const matches = findMatches(tr.doc, prev.query)
          let current = -1
          if (prev.current >= 0 && prev.matches[prev.current]) {
            const at = tr.mapping.map(prev.matches[prev.current].from)
            current = matches.findIndex((m) => m.from >= at)
          }
          return { query: prev.query, matches, current, deco: decorate(tr.doc, matches, current) }
        }
        return prev
      }
    },
    props: {
      decorations: (state) => searchKey.getState(state)!.deco
    }
  })
}

export function setSearch(view: EditorView, query: SearchQuery | null): void {
  view.dispatch(view.state.tr.setMeta(searchKey, { query }).setMeta('addToHistory', false))
}

export function searchInfo(state: EditorState): { count: number; current: number } {
  const s = searchKey.getState(state)!
  return { count: s.matches.length, current: s.current }
}

/** Moves to the next (dir 1) or previous (dir -1) match relative to the selection. */
export function searchStep(view: EditorView, dir: 1 | -1): boolean {
  const s = searchKey.getState(view.state)!
  if (!s.matches.length) return false
  let index: number
  if (s.current >= 0) {
    index = (s.current + dir + s.matches.length) % s.matches.length
  } else {
    const head = view.state.selection.from
    index = dir > 0 ? s.matches.findIndex((m) => m.from >= head) : s.matches.findLastIndex((m) => m.to <= head)
    if (index < 0) index = dir > 0 ? 0 : s.matches.length - 1
  }
  const m = s.matches[index]
  const tr = view.state.tr.setMeta(searchKey, { current: index }).setMeta('addToHistory', false)
  tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView()
  view.dispatch(tr)
  return true
}

function replacementFor(state: EditorState, m: Match, q: SearchQuery, replacement: string): string {
  if (!q.regex) return replacement
  const re = buildRegex(q)
  if (!re) return replacement
  return state.doc.textBetween(m.from, m.to).replace(re, replacement)
}

export function replaceCurrent(view: EditorView, replacement: string): boolean {
  const s = searchKey.getState(view.state)!
  if (!s.query || !s.matches.length) return false
  if (s.current < 0) return searchStep(view, 1)
  const m = s.matches[s.current]
  const text = replacementFor(view.state, m, s.query, replacement)
  const tr = view.state.tr
  if (text) tr.insertText(text, m.from, m.to)
  else tr.delete(m.from, m.to)
  view.dispatch(tr)
  // The match list was recomputed by the transaction; land on the following match.
  const next = searchKey.getState(view.state)!
  if (next.matches.length) {
    const index = next.current >= 0 ? next.current : 0
    const n = next.matches[index]
    const tr2 = view.state.tr.setMeta(searchKey, { current: index }).setMeta('addToHistory', false)
    tr2.setSelection(TextSelection.create(tr2.doc, n.from, n.to)).scrollIntoView()
    view.dispatch(tr2)
  }
  return true
}

export function replaceAll(view: EditorView, replacement: string): number {
  const s = searchKey.getState(view.state)!
  if (!s.query || !s.matches.length) return 0
  const tr = view.state.tr
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i]
    const text = replacementFor(view.state, m, s.query, replacement)
    if (text) tr.insertText(text, m.from, m.to)
    else tr.delete(m.from, m.to)
  }
  view.dispatch(tr)
  return s.matches.length
}
