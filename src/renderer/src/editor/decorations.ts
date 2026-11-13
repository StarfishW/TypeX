/**
 * Live inline rendering.
 *
 * Text blocks hold raw inline Markdown. This plugin tokenizes each block and
 * lays decorations over it: styling for the content, hidden spans for the
 * syntax markers, and widgets for things that render as something other than
 * their source (images, math, emoji, line breaks). A token whose range touches
 * the selection is "expanded": its markers become visible so it can be edited.
 */
import DOMPurify from 'dompurify'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { emojiFor, env, resolveUrl } from './env'
import { parseTagAttrs, tokenizeInline, type Tok } from './inline'
import { t } from '../i18n'
import { renderMathInto } from './math'
import { isInlineBlock } from './schema'

/* ------------------------------ token cache ------------------------------ */

let cache = new WeakMap<PMNode, Tok[]>()
let refs = new Map<string, string>()
const refCache = new WeakMap<PMNode, [string, string][]>()

const normLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

export function tokensFor(node: PMNode): Tok[] {
  let toks = cache.get(node)
  if (!toks) {
    toks = tokenizeInline(node.textContent, {
      ...env.inline,
      emoji: emojiFor,
      hasRef: (label) => refs.has(normLabel(label))
    })
    cache.set(node, toks)
  }
  return toks
}

/** The destination of a link reference definition, if the document has one. */
export const refTarget = (label: string): string | undefined => refs.get(normLabel(label))

const DEF_LINE = /^[ \t]*\[([^\]^\n][^\]\n]*)\]:[ \t]*<?([^\s>]*)>?/gm

function collectRefs(doc: PMNode): { map: Map<string, string>; sig: string } {
  const map = new Map<string, string>()
  let sig = ''
  doc.descendants((node) => {
    if (node.type.name !== 'paragraph') return !node.isTextblock
    let own = refCache.get(node)
    if (!own) {
      own = []
      const text = node.textContent
      if (text.includes(']:')) {
        DEF_LINE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = DEF_LINE.exec(text))) own.push([normLabel(m[1]), m[2]])
      }
      refCache.set(node, own)
    }
    for (const [label, url] of own) {
      if (!map.has(label)) map.set(label, url)
      sig += label + '\u0000' + url + '\u0001'
    }
    return false
  })
  return { map, sig }
}

/* ------------------------------ sanitizing ------------------------------- */

const STYLE_PROPS = new Set([
  'color', 'background', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family',
  'font-variant', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-transform', 'letter-spacing', 'word-spacing', 'opacity', 'border', 'border-bottom', 'border-radius',
  'padding', 'vertical-align', 'text-shadow'
])
const IMG_PROPS = new Set(['zoom', 'width', 'height', 'max-width', 'max-height', 'float', 'border-radius', 'margin'])

function safeStyle(style: string, allowed: Set<string> = STYLE_PROPS): string {
  let out = ''
  for (const part of style.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const prop = part.slice(0, i).trim().toLowerCase()
    const value = part.slice(i + 1).trim()
    if (!allowed.has(prop) || !value) continue
    if (!/^[#\w\s.,%()'"+-]+$/.test(value) || /url|expression|javascript|var\(/i.test(value)) continue
    out += `${prop}:${value};`
  }
  return out
}

function imgStyle(attrs: Record<string, string>): string {
  let style = safeStyle(attrs.style || '', IMG_PROPS)
  for (const dim of ['width', 'height'] as const) {
    const v = attrs[dim]
    if (v && /^\d+(\.\d+)?(%|px)?$/.test(v)) style += `${dim}:${/\d$/.test(v) ? v + 'px' : v};`
  }
  return style
}

const PURIFY_CONFIG = {
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['allowfullscreen', 'frameborder', 'scrolling', 'target', 'controls', 'autoplay', 'loop', 'muted', 'poster'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  ALLOW_UNKNOWN_PROTOCOLS: true
}

/** Sanitizes user HTML and rewrites local media sources so they load. */
export function sanitizeHtml(raw: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = DOMPurify.sanitize(raw, PURIFY_CONFIG) as string
  tpl.content.querySelectorAll<HTMLElement>('[src], [poster]').forEach((el) => {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr)
      if (!v) continue
      if (el.tagName === 'IFRAME') {
        if (!/^https?:\/\//i.test(v)) el.removeAttribute(attr)
      } else {
        el.setAttribute(attr, resolveUrl(v))
      }
    }
  })
  // Embedded pages (video players and the like) run in a sandbox of their own.
  tpl.content.querySelectorAll('iframe').forEach((frame) => {
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation')
  })
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('data-href', a.getAttribute('href') || '')
    a.removeAttribute('href')
  })
  return tpl.content
}

const entityCache = new Map<string, string>()
function decodeEntity(entity: string): string {
  let v = entityCache.get(entity)
  if (v === undefined) {
    const t = document.createElement('textarea')
    t.innerHTML = entity
    v = t.value
    entityCache.set(entity, v)
  }
  return v
}

/* -------------------------------- widgets -------------------------------- */

const INLINE_SPEC = { md: true }

/** Puts the caret inside the source of the token that ends at the widget. */
function caretIntoSource(view: EditorView, getPos: () => number | undefined, back: number): void {
  const pos = getPos()
  if (pos == null) return
  const target = Math.max(0, pos - back)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
  view.focus()
}

function imageWidget(pos: number, src: string, alt: string, title: string, block: boolean, style: string): Decoration {
  const url = resolveUrl(src)
  return Decoration.widget(
    pos,
    (view, getPos) => {
      const wrap = document.createElement('span')
      wrap.className = 'md-image' + (block ? ' md-image-block' : '')
      const img = document.createElement('img')
      img.alt = alt
      if (title) img.title = title
      if (style) img.setAttribute('style', style)
      img.draggable = false
      const fail = (): void => {
        wrap.classList.add('md-image-error')
        wrap.setAttribute('data-label', t('editor.imageNotFound', { name: alt || src || '?' }))
      }
      img.addEventListener('error', fail)
      if (url) img.src = url
      else fail()
      wrap.appendChild(img)
      wrap.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        caretIntoSource(view, getPos, 1)
      })
      return wrap
    },
    {
      ...INLINE_SPEC,
      side: -1,
      key: `img|${url}|${alt}|${title}|${block}|${style}`,
      ignoreSelection: true,
      stopEvent: (e: Event) => e.type === 'mousedown'
    }
  )
}

function mathWidget(pos: number, tex: string, display: boolean, preview: boolean): Decoration {
  return Decoration.widget(
    pos,
    (view, getPos) => {
      const el = document.createElement('span')
      if (preview) {
        el.className = 'md-math-preview'
        const pop = document.createElement('span')
        pop.className = 'md-math-popup'
        renderMathInto(pop, tex, display)
        el.appendChild(pop)
        return el
      }
      el.className = 'md-math' + (display ? ' md-math-display' : '')
      renderMathInto(el, tex, display)
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        caretIntoSource(view, getPos, display ? 2 : 1)
      })
      return el
    },
    {
      ...INLINE_SPEC,
      side: preview ? 1 : -1,
      key: `math|${preview}|${display}|${tex}`,
      ignoreSelection: true,
      stopEvent: (e: Event) => e.type === 'mousedown'
    }
  )
}

function charWidget(pos: number, char: string, cls: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const el = document.createElement('span')
      el.className = cls
      el.textContent = char
      return el
    },
    { ...INLINE_SPEC, side: -1, key: `${cls}|${char}` }
  )
}

function brWidget(pos: number): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const el = document.createElement('span')
      el.className = 'md-br'
      el.appendChild(document.createElement('br'))
      return el
    },
    { ...INLINE_SPEC, side: -1, key: 'br' }
  )
}

function htmlWidget(pos: number, raw: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const el = document.createElement('span')
      el.className = 'md-html-widget'
      el.appendChild(sanitizeHtml(raw))
      return el
    },
    { ...INLINE_SPEC, side: -1, key: `html|${env.docPath}|${raw}`, ignoreSelection: true, stopEvent: () => true }
  )
}

/* ------------------------------ decorations ------------------------------ */

const WRAP: Partial<Record<Tok['type'], string>> = {
  strong: 'strong',
  em: 'em',
  del: 'del',
  mark: 'mark',
  sub: 'sub',
  sup: 'sup'
}
const SAFE_TAGS = new Set([
  'u', 'b', 'i', 's', 'em', 'strong', 'del', 'ins', 'mark', 'sub', 'sup', 'kbd', 'small', 'big', 'span', 'font',
  'code', 'abbr', 'cite', 'q', 'var', 'samp', 'a'
])
const MEDIA_TAGS = new Set(['video', 'audio', 'iframe'])

interface Range {
  from: number
  to: number
}

function blockDecorations(node: PMNode, pos: number, sel: Range): Decoration[] {
  const text = node.textContent
  if (!text) return []
  const base = pos + 1
  const toks = tokensFor(node)
  if (toks.length === 1 && toks[0].type === 'text') return []

  const out: Decoration[] = []
  const a = sel.from - base
  const b = sel.to - base
  const touched = (t: Tok): boolean => a <= t.to && b >= t.from
  const alone = toks.length === 1

  const span = (from: number, to: number, attrs: Record<string, string>): void => {
    if (from < to) out.push(Decoration.inline(base + from, base + to, attrs, INLINE_SPEC))
  }
  const meta = (from: number, to: number, show: boolean, extra = ''): void =>
    span(from, to, { class: 'md-meta' + (show ? ' md-show' : '') + extra })

  const htmlPair = (t: Tok, exp: boolean, cf: number, ct: number): void => {
    const tag = t.attrs!.tag
    if (MEDIA_TAGS.has(tag)) {
      meta(t.from, t.to, exp, ' md-html-tag')
      out.push(htmlWidget(base + t.to, text.slice(t.from, t.to)))
      return
    }
    if (!SAFE_TAGS.has(tag)) {
      span(t.from, cf, { class: 'md-html-tag' })
      span(ct, t.to, { class: 'md-html-tag' })
      walk(t.children!)
      return
    }
    meta(t.from, cf, exp, ' md-html-tag')
    meta(ct, t.to, exp, ' md-html-tag')
    const attrs = parseTagAttrs(t.attrs!.raw)
    const deco: Record<string, string> = { nodeName: tag === 'font' ? 'span' : tag, class: 'md-html' }
    let style = safeStyle(attrs.style || '')
    if (tag === 'font' && attrs.color && /^[#\w]+$/.test(attrs.color)) style += `color:${attrs.color};`
    if (style) deco.style = style
    if (attrs.title) deco.title = attrs.title
    if (tag === 'a') {
      deco.class = 'md-link'
      if (attrs.href) deco['data-href'] = attrs.href
    }
    span(cf, ct, deco)
    walk(t.children!)
  }

  const htmlTag = (t: Tok, exp: boolean): void => {
    const { tag, kind } = t.attrs!
    if (kind === 'void' && tag === 'img') {
      const attrs = parseTagAttrs(t.attrs!.raw || '')
      span(t.from, t.to, { class: 'md-meta md-image-src' + (exp ? ' md-show' : '') })
      out.push(imageWidget(base + t.to, attrs.src || '', attrs.alt || '', attrs.title || '', alone, imgStyle(attrs)))
      return
    }
    if (kind === 'void' && MEDIA_TAGS.has(tag)) {
      meta(t.from, t.to, exp, ' md-html-tag')
      out.push(htmlWidget(base + t.to, text.slice(t.from, t.to)))
      return
    }
    span(t.from, t.to, { class: 'md-html-tag' })
  }

  const one = (t: Tok): void => {
    if (t.type === 'text') return
    const exp = touched(t)
    const cf = t.from + (t.open || 0)
    const ct = t.to - (t.close || 0)
    switch (t.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'mark':
      case 'sub':
      case 'sup':
        meta(t.from, cf, exp)
        meta(ct, t.to, exp)
        span(cf, ct, { nodeName: WRAP[t.type]!, class: 'md-' + t.type })
        walk(t.children!)
        break
      case 'code':
        meta(t.from, cf, exp, ' md-code-mark')
        meta(ct, t.to, exp, ' md-code-mark')
        span(cf, ct, { nodeName: 'code', class: 'md-code', spellcheck: 'false' })
        break
      case 'link':
      case 'reflink':
        meta(t.from, cf, exp)
        meta(ct, t.to, exp, ' md-url')
        span(cf, ct, {
          nodeName: 'a',
          class: 'md-link',
          'data-href': t.type === 'link' ? t.attrs!.href : '\u0000ref:' + t.attrs!.ref
        })
        walk(t.children!)
        break
      case 'image': {
        const src = t.attrs!.href ?? refTarget(t.attrs!.ref || '') ?? ''
        span(t.from, t.to, { class: 'md-meta md-image-src' + (exp ? ' md-show' : '') })
        out.push(imageWidget(base + t.to, src, t.attrs!.alt || '', t.attrs!.title || '', alone, ''))
        break
      }
      case 'math': {
        const tex = text.slice(cf, ct)
        const display = !!t.attrs?.display
        if (exp) span(t.from, t.to, { class: 'md-math-src', spellcheck: 'false' })
        else meta(t.from, t.to, false)
        out.push(mathWidget(base + t.to, tex, display, exp))
        break
      }
      case 'emoji':
        meta(t.from, t.to, exp)
        if (!exp) out.push(charWidget(base + t.to, t.attrs!.char, 'md-emoji'))
        break
      case 'entity':
        meta(t.from, t.to, exp)
        if (!exp) out.push(charWidget(base + t.to, decodeEntity(text.slice(t.from, t.to)), 'md-entity'))
        break
      case 'br':
        meta(t.from, t.to, exp, ' md-html-tag')
        out.push(brWidget(base + t.to))
        break
      case 'escape':
        meta(t.from, t.from + 1, exp)
        break
      case 'hardbreak':
        meta(t.from, t.to, exp)
        break
      case 'autolink':
        meta(t.from, cf, exp)
        meta(ct, t.to, exp)
        span(cf, ct, { nodeName: 'a', class: 'md-link md-autolink', 'data-href': t.attrs!.href })
        break
      case 'url':
        span(t.from, t.to, { nodeName: 'a', class: 'md-link md-autolink', 'data-href': t.attrs!.href })
        break
      case 'footnote':
        meta(t.from, cf, exp)
        meta(ct, t.to, exp)
        span(cf, ct, { nodeName: 'sup', class: 'md-footnote', 'data-footnote': t.attrs!.label })
        break
      case 'defmark':
        span(t.from, t.to, { class: 'md-def' })
        break
      case 'comment':
        span(t.from, t.to, { class: 'md-comment' })
        break
      case 'html':
        htmlPair(t, exp, cf, ct)
        break
      case 'htmltag':
        htmlTag(t, exp)
        break
    }
  }

  function walk(list: Tok[]): void {
    for (const t of list) one(t)
  }

  walk(toks)
  return out
}

function buildAll(state: EditorState): DecorationSet {
  const sel: Range = { from: state.selection.from, to: state.selection.to }
  const all: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (isInlineBlock(node)) {
      for (const d of blockDecorations(node, pos, sel)) all.push(d)
    }
    return false
  })
  return DecorationSet.create(state.doc, all)
}

/* --------------------------------- plugin -------------------------------- */

interface InlineState {
  deco: DecorationSet
  /** Decorations were only position-mapped (during IME composition) and need a rebuild. */
  stale: boolean
  refSig: string
}

export const inlineKey = new PluginKey<InlineState>('md-inline')

export function inlinePlugin(): Plugin<InlineState> {
  let view: EditorView | null = null

  return new Plugin<InlineState>({
    key: inlineKey,
    state: {
      init(_config, state) {
        const r = collectRefs(state.doc)
        refs = r.map
        return { deco: buildAll(state), stale: false, refSig: r.sig }
      },
      apply(tr, prev, oldState, newState) {
        let refSig = prev.refSig
        let rebuild = tr.getMeta(inlineKey) === 'rebuild'
        if (tr.docChanged) {
          const r = collectRefs(newState.doc)
          if (r.sig !== prev.refSig) {
            refs = r.map
            refSig = r.sig
            cache = new WeakMap()
            rebuild = true
          }
        }
        if (rebuild) return { deco: buildAll(newState), stale: false, refSig }

        // Restyling the text under an active IME composition would cancel it.
        if (view?.composing) {
          if (!tr.docChanged && !tr.selectionSet) return prev
          return { deco: prev.deco.map(tr.mapping, tr.doc), stale: true, refSig }
        }
        if (prev.stale) return { deco: buildAll(newState), stale: false, refSig }
        if (!tr.docChanged && oldState.selection.eq(newState.selection)) return prev

        const doc = newState.doc
        const size = doc.content.size
        const dirty = new Map<number, PMNode>()
        const mark = (from: number, to: number): void => {
          doc.nodesBetween(Math.max(0, from - 1), Math.min(size, to + 1), (node, pos) => {
            if (!node.isTextblock) return true
            if (isInlineBlock(node)) dirty.set(pos, node)
            return false
          })
        }
        let deco = prev.deco
        if (tr.docChanged) {
          deco = deco.map(tr.mapping, tr.doc)
          const maps = tr.mapping.maps
          for (let i = 0; i < maps.length; i++) {
            const rest = tr.mapping.slice(i + 1)
            maps[i].forEach((_os, _oe, ns, ne) => mark(rest.map(ns, -1), rest.map(ne, 1)))
          }
        }
        mark(tr.mapping.map(oldState.selection.from, -1), tr.mapping.map(oldState.selection.to, 1))
        mark(newState.selection.from, newState.selection.to)

        const sel: Range = { from: newState.selection.from, to: newState.selection.to }
        const remove: Decoration[] = []
        const add: Decoration[] = []
        dirty.forEach((node, pos) => {
          const end = pos + node.nodeSize
          for (const d of deco.find(pos, end)) {
            if ((d.spec as { md?: boolean }).md && d.from >= pos && d.to <= end) remove.push(d)
          }
          for (const d of blockDecorations(node, pos, sel)) add.push(d)
        })
        if (remove.length) deco = deco.remove(remove)
        if (add.length) deco = deco.add(doc, add)
        return { deco, stale: false, refSig }
      }
    },
    props: {
      decorations(state) {
        return inlineKey.getState(state)!.deco
      },
      handleDOMEvents: {
        compositionend(v) {
          setTimeout(() => {
            if (v.isDestroyed || v.composing) return
            if (inlineKey.getState(v.state)!.stale) {
              v.dispatch(v.state.tr.setMeta(inlineKey, 'rebuild').setMeta('addToHistory', false))
            }
          }, 60)
          return false
        }
      }
    },
    view(v) {
      view = v
      return {
        destroy() {
          view = null
        }
      }
    }
  })
}

/** Re-tokenizes and re-renders everything, after syntax options or the document path change. */
export function refreshInline(view: EditorView): void {
  cache = new WeakMap()
  view.dispatch(view.state.tr.setMeta(inlineKey, 'rebuild').setMeta('addToHistory', false))
}
