/**
 * Inline Markdown tokenizer.
 *
 * A text block in TypeX stores its inline content as raw Markdown source. This
 * module turns that source into a tree of tokens that carry exact source
 * ranges, including the ranges of the syntax markers, so the editor can style
 * the text in place and hide or reveal the markers around the caret.
 *
 * The emphasis and link handling follow the CommonMark delimiter algorithm,
 * extended with GFM strikethrough and autolinks, plus highlight, subscript,
 * superscript, inline math, emoji and footnote references.
 */

export type TokType =
  | 'text'
  | 'strong'
  | 'em'
  | 'del'
  | 'mark'
  | 'sub'
  | 'sup'
  | 'code'
  | 'math'
  | 'link'
  | 'reflink'
  | 'image'
  | 'autolink'
  | 'url'
  | 'html'
  | 'htmltag'
  | 'comment'
  | 'br'
  | 'escape'
  | 'entity'
  | 'emoji'
  | 'footnote'
  | 'defmark'
  | 'hardbreak'

export interface Tok {
  type: TokType
  from: number
  to: number
  /** Length of the opening marker, counted forward from `from`. */
  open?: number
  /** Length of the closing marker, counted back from `to`. */
  close?: number
  children?: Tok[]
  attrs?: Record<string, string>
}

export interface InlineOptions {
  math?: boolean
  sub?: boolean
  sup?: boolean
  mark?: boolean
  /** Returns the emoji character for a shortcode name, if it exists. */
  emoji?: (name: string) => string | undefined
  /** Whether a link reference definition with this label exists in the document. */
  hasRef?: (label: string) => boolean
}

interface Delim {
  kind: 'delim'
  ch: string
  from: number
  to: number
  count: number
  orig: number
  canOpen: boolean
  canClose: boolean
}

interface Bracket {
  kind: 'bracket'
  from: number
  to: number
  image: boolean
  active: boolean
}

type Item = Tok | Delim | Bracket

const isDelim = (i: Item): i is Delim => (i as Delim).kind === 'delim'
const isTok = (i: Item): i is Tok => (i as Delim).kind === undefined

const ESCAPABLE = /[!-/:-@[-`{-~]/
const PUNCT = /[\p{P}\p{S}]/u
const SPACE = /\s/
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

const ENTITY_RE = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y
const AUTOLINK_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y
const EMAIL_RE =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y
const COMMENT_RE = /<!--[\s\S]*?-->/y
const ATTR = '(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"\'=<>`\\x00-\\x20]+|\'[^\']*\'|"[^"]*"))?)'
const OPEN_TAG_RE = new RegExp('<([A-Za-z][A-Za-z0-9-]*)(' + ATTR + '*)\\s*(/?)>', 'y')
const CLOSE_TAG_RE = /<\/([A-Za-z][A-Za-z0-9-]*)\s*>/y
const EMOJI_RE = /:([a-z0-9_+-]+):/y
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/y
const DEF_RE = /\[(\^?)([^\]\n]+)\]:/y
const REF_LABEL_RE = /\[([^[\]\n]*)\]/y
const SUB_RE = /~((?:[^~\s\\]|\\.)+)~/y
const SUP_RE = /\^((?:[^^\s\\]|\\.)+)\^/y
const URL_RE = /(?:https?:\/\/|www\.)[^\s<\u3000-\u303f\uff00-\uffef]+/iy

export const VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'wbr', 'source', 'track', 'embed', 'area', 'col', 'meta', 'link', 'base', 'param'
])

function at(re: RegExp, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(src)
}

/** The full code point that ends just before `pos`. */
function charBefore(src: string, pos: number): string {
  if (pos <= 0) return '\n'
  const lo = src.charCodeAt(pos - 1)
  if (lo >= 0xdc00 && lo <= 0xdfff && pos >= 2) return src.slice(pos - 2, pos)
  return src[pos - 1]
}

/** The full code point that starts at `pos`. */
function charAfter(src: string, pos: number): string {
  if (pos >= src.length) return '\n'
  return String.fromCodePoint(src.codePointAt(pos)!)
}

function delimFlags(src: string, from: number, to: number, ch: string): { canOpen: boolean; canClose: boolean } {
  const before = charBefore(src, from)
  const after = charAfter(src, to)
  const wsB = SPACE.test(before)
  const wsA = SPACE.test(after)
  const pB = PUNCT.test(before)
  const pA = PUNCT.test(after)
  // CJK text has no spaces between words, so a delimiter run that touches a
  // CJK character is treated as if it were next to punctuation. Without this,
  // strong emphasis around quoted CJK phrases fails to open or close.
  const left = !wsA && (!pA || wsB || pB || CJK.test(before))
  const right = !wsB && (!pB || wsA || pA || CJK.test(after))
  if (ch === '_') return { canOpen: left && (!right || pB), canClose: right && (!left || pA) }
  return { canOpen: left, canClose: right }
}

function findBacktickClose(src: string, start: number, run: number): number {
  let i = start
  const n = src.length
  while (i < n) {
    if (src[i] !== '`') {
      i++
      continue
    }
    let len = 1
    while (src[i + len] === '`') len++
    if (len === run) return i
    i += len
  }
  return -1
}

function matchMath(src: string, pos: number): Tok | null {
  const n = src.length
  if (src[pos + 1] === '$') {
    const end = src.indexOf('$$', pos + 2)
    if (end > pos + 2) return { type: 'math', from: pos, to: end + 2, open: 2, close: 2, attrs: { display: '1' } }
    return null
  }
  const next = src[pos + 1]
  if (!next || SPACE.test(next)) return null
  let i = pos + 1
  while (i < n) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '$') break
    i++
  }
  if (i >= n || i === pos + 1) return null
  if (SPACE.test(src[i - 1])) return null
  if (/\d/.test(src[i + 1] || '')) return null
  return { type: 'math', from: pos, to: i + 1, open: 1, close: 1 }
}

function matchAngle(src: string, pos: number): Tok | null {
  let m = at(AUTOLINK_RE, src, pos)
  if (m) return { type: 'autolink', from: pos, to: pos + m[0].length, open: 1, close: 1, attrs: { href: m[1] } }
  m = at(EMAIL_RE, src, pos)
  if (m) {
    return { type: 'autolink', from: pos, to: pos + m[0].length, open: 1, close: 1, attrs: { href: 'mailto:' + m[1] } }
  }
  m = at(COMMENT_RE, src, pos)
  if (m) return { type: 'comment', from: pos, to: pos + m[0].length }
  m = at(CLOSE_TAG_RE, src, pos)
  if (m) return { type: 'htmltag', from: pos, to: pos + m[0].length, attrs: { tag: m[1].toLowerCase(), kind: 'close' } }
  m = at(OPEN_TAG_RE, src, pos)
  if (m) {
    const tag = m[1].toLowerCase()
    const to = pos + m[0].length
    if (tag === 'br') return { type: 'br', from: pos, to }
    const kind = m[3] === '/' || VOID_TAGS.has(tag) ? 'void' : 'open'
    return { type: 'htmltag', from: pos, to, attrs: { tag, kind, raw: m[2] || '' } }
  }
  return null
}

function matchBareUrl(src: string, pos: number): Tok | null {
  if (pos > 0 && /[A-Za-z0-9/:.@-]/.test(src[pos - 1])) return null
  const m = at(URL_RE, src, pos)
  if (!m) return null
  let url = m[0]
  for (;;) {
    const last = url[url.length - 1]
    if (/[?!.,:;*_~'"]/.test(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ')') {
      let depth = 0
      for (const c of url) depth += c === '(' ? 1 : c === ')' ? -1 : 0
      if (depth < 0) {
        url = url.slice(0, -1)
        continue
      }
    }
    break
  }
  const www = /^www\./i.test(url)
  if (www) {
    if (!/^www\.[^\s./]+\.[^\s./]/i.test(url)) return null
  } else if (!/^https?:\/\/[^\s/]/i.test(url)) {
    return null
  }
  return { type: 'url', from: pos, to: pos + url.length, attrs: { href: www ? 'http://' + url : url } }
}

interface Dest {
  end: number
  href: string
  title: string
}

const TITLE_RE = /^([\s\S]*?)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))\s*$/
/** After a line break inside the parentheses only a title and the closing parenthesis may follow. */
const TAIL_RE = /^\s*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))\s*)?\)/
const ESCAPED_PUNCT = /\\([!-/:-@[-`{-~])/g

/** Removes backslash escapes from a link destination. Absolute Windows paths keep their separators. */
function unescapeDest(dest: string): string {
  if (/^[a-zA-Z]:\\|^\\\\/.test(dest)) return dest
  return dest.replace(ESCAPED_PUNCT, '$1')
}

/**
 * Parses `(destination "title")` starting at the opening parenthesis. This is
 * deliberately more lenient than CommonMark: destinations may contain spaces,
 * which is how local paths are commonly written.
 */
function parseDest(src: string, start: number): Dest | null {
  const n = src.length
  let i = start + 1
  let depth = 0
  let closed = false
  while (i < n) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '\n') {
      const tail = TAIL_RE.exec(src.slice(i))
      if (!tail) return null
      i += tail[0].length - 1
      closed = true
      break
    }
    if (c === '<' && src.slice(start + 1, i).trim() === '') {
      const gt = src.indexOf('>', i)
      const nl = src.indexOf('\n', i)
      if (gt > 0 && (nl < 0 || gt < nl)) {
        i = gt + 1
        continue
      }
    }
    if ((c === '"' || c === "'") && i > start + 1 && SPACE.test(src[i - 1])) {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      if (j < n && src[j] === c) {
        i = j + 1
        continue
      }
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) {
        closed = true
        break
      }
      depth--
    }
    i++
  }
  if (!closed) return null
  const inner = src.slice(start + 1, i)
  let href = inner
  let title = ''
  const tm = TITLE_RE.exec(inner)
  if (tm) {
    href = tm[1]
    title = tm[2].slice(1, -1).replace(ESCAPED_PUNCT, '$1')
  }
  href = href.trim()
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
  return { end: i + 1, href: unescapeDest(href), title }
}

interface LinkTail {
  end: number
  type: 'link' | 'reflink'
  attrs: Record<string, string>
}

function matchLinkTail(src: string, pos: number, opener: Bracket, opt: InlineOptions): LinkTail | null {
  const next = src[pos + 1]
  if (next === '(') {
    const d = parseDest(src, pos + 1)
    if (d) return { end: d.end, type: 'link', attrs: d.title ? { href: d.href, title: d.title } : { href: d.href } }
  }
  const label = src.slice(opener.to, pos)
  if (next === '[') {
    const m = at(REF_LABEL_RE, src, pos + 1)
    if (m) {
      // With a known set of definitions, an undefined label is not a link.
      const ref = m[1] || label
      if (!opt.hasRef || opt.hasRef(ref)) return { end: pos + 1 + m[0].length, type: 'reflink', attrs: { ref } }
    }
  }
  if (opt.hasRef && label.trim() && opt.hasRef(label)) return { end: pos + 1, type: 'reflink', attrs: { ref: label } }
  return null
}

/** Converts leftover delimiters and brackets to text and merges adjacent text. */
function finalize(items: Item[]): Tok[] {
  const out: Tok[] = []
  for (const item of items) {
    const tok: Tok = isTok(item) ? item : { type: 'text', from: item.from, to: item.to }
    if (tok.from === tok.to) continue
    const prev = out[out.length - 1]
    if (tok.type === 'text' && prev && prev.type === 'text' && prev.to === tok.from) prev.to = tok.to
    else out.push(tok)
  }
  return out
}

function processEmphasis(items: Item[]): void {
  let i = 0
  while (i < items.length) {
    const closer = items[i]
    if (!isDelim(closer) || !closer.canClose) {
      i++
      continue
    }
    let found = -1
    for (let j = i - 1; j >= 0; j--) {
      const o = items[j]
      if (!isDelim(o) || o.ch !== closer.ch || !o.canOpen) continue
      if (o.ch === '*' || o.ch === '_') {
        const bothWays = o.canClose || closer.canOpen
        if (bothWays && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue
      }
      found = j
      break
    }
    if (found < 0) {
      i++
      continue
    }
    const opener = items[found] as Delim
    const emphasis = opener.ch === '*' || opener.ch === '_'
    const use = emphasis ? (opener.count >= 2 && closer.count >= 2 ? 2 : 1) : 2
    const type: TokType = opener.ch === '~' ? 'del' : opener.ch === '=' ? 'mark' : use === 2 ? 'strong' : 'em'
    const tok: Tok = {
      type,
      from: opener.to - use,
      to: closer.from + use,
      open: use,
      close: use,
      children: finalize(items.slice(found + 1, i))
    }
    opener.to -= use
    opener.count -= use
    closer.from += use
    closer.count -= use
    items.splice(found + 1, i - found - 1, tok)
    let ci = found + 2
    if (opener.count === 0) {
      items.splice(found, 1)
      ci--
    }
    if (closer.count === 0) items.splice(ci, 1)
    i = ci
  }
}

/** Pairs sibling HTML open and close tags into `html` container tokens. */
function pairHtml(toks: Tok[]): Tok[] {
  const out: Tok[] = []
  for (const t of toks) {
    if (t.children) t.children = pairHtml(t.children)
    if (t.type === 'htmltag' && t.attrs!.kind === 'close') {
      let k = out.length - 1
      for (; k >= 0; k--) {
        const o = out[k]
        if (o.type === 'htmltag' && o.attrs!.kind === 'open' && o.attrs!.tag === t.attrs!.tag) break
      }
      if (k >= 0) {
        const o = out[k]
        const children = out.splice(k + 1)
        out.pop()
        out.push({
          type: 'html',
          from: o.from,
          to: t.to,
          open: o.to - o.from,
          close: t.to - t.from,
          children,
          attrs: { tag: o.attrs!.tag, raw: o.attrs!.raw || '' }
        })
        continue
      }
    }
    out.push(t)
  }
  return out
}

export function tokenizeInline(src: string, opt: InlineOptions = {}): Tok[] {
  const items: Item[] = []
  const brackets: number[] = []
  const n = src.length
  let pos = 0
  let textFrom = 0

  const flush = (end: number): void => {
    if (end > textFrom) items.push({ type: 'text', from: textFrom, to: end })
  }
  const atom = (tok: Tok): void => {
    flush(tok.from)
    items.push(tok)
    pos = tok.to
    textFrom = pos
  }
  const demote = (index: number): void => {
    const b = items[index] as Bracket
    items[index] = { type: 'text', from: b.from, to: b.to }
  }

  while (pos < n) {
    const c = src[pos]
    switch (c) {
      case '\\': {
        const next = src[pos + 1]
        if (next === '\n') {
          // A backslash at the end of a line is a hard line break.
          atom({ type: 'hardbreak', from: pos, to: pos + 1 })
          continue
        }
        if (next && ESCAPABLE.test(next)) {
          atom({ type: 'escape', from: pos, to: pos + 2, open: 1 })
          continue
        }
        break
      }
      case '`': {
        let run = 1
        while (src[pos + run] === '`') run++
        const close = findBacktickClose(src, pos + run, run)
        if (close >= 0) {
          atom({ type: 'code', from: pos, to: close + run, open: run, close: run })
          continue
        }
        pos += run
        continue
      }
      case '$': {
        if (opt.math !== false) {
          const m = matchMath(src, pos)
          if (m) {
            atom(m)
            continue
          }
        }
        break
      }
      case '<': {
        const t = matchAngle(src, pos)
        if (t) {
          atom(t)
          continue
        }
        break
      }
      case '&': {
        const m = at(ENTITY_RE, src, pos)
        if (m) {
          atom({ type: 'entity', from: pos, to: pos + m[0].length })
          continue
        }
        break
      }
      case ':': {
        if (opt.emoji) {
          const m = at(EMOJI_RE, src, pos)
          const char = m && opt.emoji(m[1])
          if (m && char) {
            atom({ type: 'emoji', from: pos, to: pos + m[0].length, attrs: { char, name: m[1] } })
            continue
          }
        }
        break
      }
      case '!': {
        if (src[pos + 1] === '[') {
          flush(pos)
          items.push({ kind: 'bracket', from: pos, to: pos + 2, image: true, active: true })
          brackets.push(items.length - 1)
          pos += 2
          textFrom = pos
          continue
        }
        break
      }
      case '[': {
        if (src.slice(src.lastIndexOf('\n', pos - 1) + 1, pos).trim() === '') {
          const dm = at(DEF_RE, src, pos)
          if (dm) {
            atom({
              type: 'defmark',
              from: pos,
              to: pos + dm[0].length,
              attrs: { label: dm[2], footnote: dm[1] ? '1' : '' }
            })
            continue
          }
        }
        const fm = at(FOOTNOTE_RE, src, pos)
        if (fm) {
          atom({ type: 'footnote', from: pos, to: pos + fm[0].length, open: 2, close: 1, attrs: { label: fm[1] } })
          continue
        }
        flush(pos)
        items.push({ kind: 'bracket', from: pos, to: pos + 1, image: false, active: true })
        brackets.push(items.length - 1)
        pos++
        textFrom = pos
        continue
      }
      case ']': {
        if (!brackets.length) break
        const bi = brackets.pop()!
        const opener = items[bi] as Bracket
        const tail = opener.active ? matchLinkTail(src, pos, opener, opt) : null
        if (!tail) {
          demote(bi)
          break
        }
        flush(pos)
        const inner = items.splice(bi + 1)
        items.pop()
        if (opener.image) {
          items.push({
            type: 'image',
            from: opener.from,
            to: tail.end,
            attrs: { ...tail.attrs, alt: src.slice(opener.to, pos) }
          })
        } else {
          processEmphasis(inner)
          items.push({
            type: tail.type,
            from: opener.from,
            to: tail.end,
            open: 1,
            close: tail.end - pos,
            children: finalize(inner),
            attrs: tail.attrs
          })
          for (const i of brackets) {
            const b = items[i] as Bracket
            if (!b.image) b.active = false
          }
        }
        pos = tail.end
        textFrom = pos
        continue
      }
      case '*':
      case '_': {
        let run = 1
        while (src[pos + run] === c) run++
        flush(pos)
        items.push({
          kind: 'delim',
          ch: c,
          from: pos,
          to: pos + run,
          count: run,
          orig: run,
          ...delimFlags(src, pos, pos + run, c)
        })
        pos += run
        textFrom = pos
        continue
      }
      case '~':
      case '=': {
        let run = 1
        while (src[pos + run] === c) run++
        if (run === 2 && (c === '~' || opt.mark !== false)) {
          flush(pos)
          items.push({
            kind: 'delim',
            ch: c,
            from: pos,
            to: pos + 2,
            count: 2,
            orig: 2,
            ...delimFlags(src, pos, pos + 2, c)
          })
          pos += 2
          textFrom = pos
          continue
        }
        if (run === 1 && c === '~' && opt.sub !== false) {
          const m = at(SUB_RE, src, pos)
          if (m) {
            const to = pos + m[0].length
            atom({ type: 'sub', from: pos, to, open: 1, close: 1, children: [{ type: 'text', from: pos + 1, to: to - 1 }] })
            continue
          }
        }
        pos += run
        continue
      }
      case '^': {
        if (opt.sup !== false) {
          const m = at(SUP_RE, src, pos)
          if (m) {
            const to = pos + m[0].length
            atom({ type: 'sup', from: pos, to, open: 1, close: 1, children: [{ type: 'text', from: pos + 1, to: to - 1 }] })
            continue
          }
        }
        break
      }
      case 'h':
      case 'H':
      case 'w':
      case 'W': {
        const u = matchBareUrl(src, pos)
        if (u) {
          atom(u)
          continue
        }
        break
      }
    }
    pos++
  }
  flush(n)
  processEmphasis(items)
  return pairHtml(finalize(items))
}

/** Parses the attribute source of an HTML open tag into a name/value map. */
export function parseTagAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][a-zA-Z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

/** The visible text of a token tree, with all Markdown syntax removed. */
export function plainText(src: string, toks: Tok[]): string {
  let out = ''
  for (const t of toks) {
    switch (t.type) {
      case 'text':
      case 'url':
        out += src.slice(t.from, t.to)
        break
      case 'escape':
        out += src.slice(t.from + 1, t.to)
        break
      case 'entity':
        out += src.slice(t.from, t.to)
        break
      case 'code':
      case 'math':
        out += src.slice(t.from + t.open!, t.to - t.close!).trim()
        break
      case 'autolink':
        out += src.slice(t.from + 1, t.to - 1)
        break
      case 'image':
        out += t.attrs!.alt || ''
        break
      case 'emoji':
        out += t.attrs!.char
        break
      case 'br':
        out += ' '
        break
      case 'htmltag':
      case 'comment':
      case 'footnote':
      case 'defmark':
        break
      default:
        if (t.children) out += plainText(src, t.children)
    }
  }
  return out
}
