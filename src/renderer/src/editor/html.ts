/**
 * Renders a document (or a slice of one) to HTML. Used for export, printing
 * and the rich-text half of the clipboard.
 */
import type { Fragment, Node as PMNode } from 'prosemirror-model'
import { emojiFor, env } from './env'
import { plainText, tokenizeInline, type Tok } from './inline'
import { schema } from './schema'

const { nodes } = schema

export interface HtmlContext {
  /** Highlighted HTML for a code block, or undefined to fall back to plain text. */
  highlight?: (code: string, lang: string) => string | undefined
  /** Rendered markup for a formula, or undefined to emit the TeX source. */
  math?: (tex: string, display: boolean) => string | undefined
  /** Rendered SVG for a diagram code block. */
  diagram?: (code: string) => string | undefined
  /** Rewrites image sources (for example to absolute file URLs). */
  image?: (src: string) => string
  /** Cleans raw HTML that the document embeds. */
  sanitize?: (html: string) => string
  /** Adds `id` attributes to headings so the table of contents can link to them. */
  headingIds?: boolean
}

interface RenderState {
  ctx: HtmlContext
  refs: Map<string, { href: string; title: string }>
  footnotes: Map<string, string>
  footnoteOrder: string[]
  slugs: Map<string, number>
  headings: { level: number; text: string; id: string }[]
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const normLabel = (l: string): string => l.trim().replace(/\s+/g, ' ').toLowerCase()

const REF_DEF = /^\[([^\]^\n][^\]\n]*)\]:[ \t]*<?([^\s>]*)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/
const FOOT_DEF = /^\[\^([^\]\s]+)\]:[ \t]*([\s\S]*)$/

function tokens(src: string, st: RenderState): Tok[] {
  return tokenizeInline(src, { ...env.inline, emoji: emojiFor, hasRef: (l) => st.refs.has(normLabel(l)) })
}

function slugify(text: string, st: RenderState): string {
  let base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
  if (!base) base = 'section'
  const n = st.slugs.get(base) || 0
  st.slugs.set(base, n + 1)
  return n ? `${base}-${n}` : base
}

function inline(src: string, toks: Tok[], st: RenderState): string {
  let out = ''
  for (const t of toks) {
    const cf = t.from + (t.open || 0)
    const ct = t.to - (t.close || 0)
    const kids = (): string => inline(src, t.children || [], st)
    switch (t.type) {
      case 'text':
        // Two trailing spaces make a hard break; a lone line break is only whitespace in the output.
        out += escapeHtml(src.slice(t.from, t.to))
          .replace(/ {2,}\n[ \t]*/g, '<br />\n')
          .replace(/ ?\n[ \t]*/g, '\n')
        break
      case 'hardbreak':
        out += '<br />'
        break
      case 'strong':
      case 'em':
      case 'del':
      case 'mark':
      case 'sub':
      case 'sup':
        out += `<${t.type}>${kids()}</${t.type}>`
        break
      case 'code': {
        let code = src.slice(cf, ct).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        out += `<code>${escapeHtml(code)}</code>`
        break
      }
      case 'math': {
        const tex = src.slice(cf, ct)
        const display = !!t.attrs?.display
        out += st.ctx.math?.(tex, display) ?? `<span class="math">${escapeHtml(src.slice(t.from, t.to))}</span>`
        break
      }
      case 'link':
      case 'reflink': {
        const ref = t.type === 'reflink' ? st.refs.get(normLabel(t.attrs!.ref)) : undefined
        if (t.type === 'reflink' && !ref) {
          // No such definition: the brackets are ordinary text.
          out += escapeHtml(src.slice(t.from, cf)) + kids() + escapeHtml(src.slice(ct, t.to))
          break
        }
        const href = t.type === 'link' ? t.attrs!.href : ref?.href || ''
        const title = t.type === 'link' ? t.attrs!.title : ref?.title
        out += `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${kids()}</a>`
        break
      }
      case 'image': {
        const ref = t.attrs!.ref ? st.refs.get(normLabel(t.attrs!.ref)) : undefined
        const raw = t.attrs!.href ?? ref?.href ?? ''
        const srcAttr = st.ctx.image ? st.ctx.image(raw) : raw
        const title = t.attrs!.title || ref?.title
        const altSrc = t.attrs!.alt || ''
        const alt = plainText(altSrc, tokens(altSrc, st))
        out += `<img src="${escapeHtml(srcAttr)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} />`
        break
      }
      case 'autolink':
      case 'url':
        out += `<a href="${escapeHtml(t.attrs!.href)}">${escapeHtml(src.slice(cf, ct))}</a>`
        break
      case 'html': {
        const raw = src.slice(t.from, cf) + kids() + src.slice(ct, t.to)
        out += st.ctx.sanitize ? st.ctx.sanitize(raw) : raw
        break
      }
      case 'htmltag': {
        let raw = src.slice(t.from, t.to)
        if (t.attrs!.tag === 'img' && st.ctx.image) {
          raw = raw.replace(/(\ssrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i, (_m, pre, _q, a, b, c) => {
            return `${pre}"${escapeHtml(st.ctx.image!(a ?? b ?? c ?? ''))}"`
          })
        }
        out += st.ctx.sanitize ? st.ctx.sanitize(raw) : raw
        break
      }
      case 'comment':
        out += src.slice(t.from, t.to)
        break
      case 'br':
        out += '<br />'
        break
      case 'escape':
        out += escapeHtml(src.slice(t.from + 1, t.to))
        break
      case 'entity':
        out += src.slice(t.from, t.to)
        break
      case 'emoji':
        out += t.attrs!.char
        break
      case 'footnote': {
        const label = t.attrs!.label
        let n = st.footnoteOrder.indexOf(label)
        if (n < 0) n = st.footnoteOrder.push(label) - 1
        const id = escapeHtml(label)
        out += `<sup class="footnote-ref"><a href="#fn-${id}" id="fnref-${id}">[${n + 1}]</a></sup>`
        break
      }
      case 'defmark':
        out += escapeHtml(src.slice(t.from, t.to))
        break
    }
  }
  return out
}

const inlineHtml = (src: string, st: RenderState): string => inline(src, tokens(src, st), st)

function listItem(item: PMNode, tight: boolean, st: RenderState): string {
  const checked = item.attrs.checked as boolean | null
  let body = ''
  item.forEach((child, _o, i) => {
    if (tight && child.type === nodes.paragraph) body += (i ? '\n' : '') + inlineHtml(child.textContent, st)
    else body += '\n' + block(child, st)
  })
  if (checked === null) return `<li>${body}</li>`
  const box = `<input type="checkbox" disabled${checked ? ' checked' : ''} /> `
  return `<li class="task-list-item${checked ? ' task-list-done' : ''}">${box}${body}</li>`
}

function table(node: PMNode, st: RenderState): string {
  const rows: string[] = []
  node.forEach((row, _o, r) => {
    const tag = r === 0 ? 'th' : 'td'
    const cells: string[] = []
    row.forEach((cell) => {
      const align = cell.attrs.align as string | null
      cells.push(`<${tag}${align ? ` style="text-align:${align}"` : ''}>${inlineHtml(cell.textContent, st)}</${tag}>`)
    })
    rows.push(`<tr>${cells.join('')}</tr>`)
  })
  const body = rows.length > 1 ? `\n<tbody>\n${rows.slice(1).join('\n')}\n</tbody>` : ''
  return `<table>\n<thead>\n${rows[0] || ''}\n</thead>${body}\n</table>`
}

function tocHtml(st: RenderState): string {
  if (!st.headings.length) return ''
  const min = Math.min(...st.headings.map((h) => h.level))
  const items = st.headings.map(
    (h) =>
      `<div class="toc-item toc-h${h.level}" style="padding-left:${(h.level - min) * 1.5}em"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></div>`
  )
  return `<div class="toc">\n${items.join('\n')}\n</div>`
}

/** Marker replaced by the table of contents once every heading id is known. */
const TOC_SLOT = '<!--typex-toc-->'

function block(node: PMNode, st: RenderState): string {
  switch (node.type) {
    case nodes.paragraph: {
      const text = node.textContent
      if (!text.trim()) return ''
      const foot = FOOT_DEF.exec(text)
      if (foot) {
        st.footnotes.set(foot[1], inlineHtml(foot[2], st))
        return ''
      }
      if (text.split('\n').every((l) => REF_DEF.test(l.trim()))) return ''
      return `<p>${inlineHtml(text, st)}</p>`
    }
    case nodes.heading: {
      const level = node.attrs.level as number
      const src = node.textContent
      if (!st.ctx.headingIds) return `<h${level}>${inlineHtml(src, st)}</h${level}>`
      const text = plainText(src, tokens(src, st)).trim()
      const id = slugify(text, st)
      st.headings.push({ level, text, id })
      return `<h${level} id="${escapeHtml(id)}">${inlineHtml(src, st)}</h${level}>`
    }
    case nodes.blockquote:
      return `<blockquote>\n${blocks(node.content, st)}\n</blockquote>`
    case nodes.bullet_list:
    case nodes.ordered_list: {
      const ordered = node.type === nodes.ordered_list
      const tight = node.attrs.tight as boolean
      const items: string[] = []
      node.forEach((item) => items.push(listItem(item, tight, st)))
      const hasTask = items.some((i) => i.startsWith('<li class="task'))
      const start = ordered && node.attrs.start !== 1 ? ` start="${node.attrs.start}"` : ''
      const cls = hasTask ? ' class="contains-task-list"' : ''
      return `<${ordered ? 'ol' : 'ul'}${start}${cls}>\n${items.join('\n')}\n</${ordered ? 'ol' : 'ul'}>`
    }
    case nodes.list_item:
      return `<ul>\n${listItem(node, true, st)}\n</ul>`
    case nodes.code_block: {
      const code = node.textContent
      const lang = (node.attrs.lang as string) || ''
      if (lang.toLowerCase() === 'mermaid') {
        const svg = st.ctx.diagram?.(code)
        if (svg) return `<div class="diagram">${svg}</div>`
      }
      const html = st.ctx.highlight?.(code, lang) ?? escapeHtml(code)
      return `<pre class="code-block"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${html}\n</code></pre>`
    }
    case nodes.math_block: {
      const tex = node.textContent
      const html = st.ctx.math?.(tex, true) ?? `<pre class="math">${escapeHtml(tex)}</pre>`
      return `<div class="math-block">${html}</div>`
    }
    case nodes.html_block: {
      const raw = node.textContent
      return st.ctx.sanitize ? st.ctx.sanitize(raw) : raw
    }
    case nodes.front_matter:
      return ''
    case nodes.horizontal_rule:
      return '<hr />'
    case nodes.toc:
      return TOC_SLOT
    case nodes.table:
      return table(node, st)
    case nodes.table_row:
      return table(nodes.table.create(null, node), st)
    case nodes.table_cell:
    case nodes.table_header:
      return inlineHtml(node.textContent, st)
    default:
      return node.isText ? inlineHtml(node.text || '', st) : ''
  }
}

function blocks(fragment: Fragment, st: RenderState): string {
  const out: string[] = []
  fragment.forEach((child) => {
    const html = block(child, st)
    if (html) out.push(html)
  })
  return out.join('\n')
}

function collectRefs(fragment: Fragment, st: RenderState): void {
  fragment.descendants((node) => {
    if (node.type !== nodes.paragraph) return !node.isTextblock
    for (const line of node.textContent.split('\n')) {
      const m = REF_DEF.exec(line.trim())
      if (m && !st.refs.has(normLabel(m[1]))) st.refs.set(normLabel(m[1]), { href: m[2], title: m[3] ?? m[4] ?? m[5] ?? '' })
    }
    return false
  })
}

/** Renders block content to an HTML string. */
export function renderHtml(content: Fragment, ctx: HtmlContext = {}): string {
  const st: RenderState = {
    ctx,
    refs: new Map(),
    footnotes: new Map(),
    footnoteOrder: [],
    slugs: new Map(),
    headings: []
  }
  collectRefs(content, st)
  let html = blocks(content, st)
  if (html.includes(TOC_SLOT)) html = html.split(TOC_SLOT).join(tocHtml(st))

  const labels = [...st.footnoteOrder, ...[...st.footnotes.keys()].filter((l) => !st.footnoteOrder.includes(l))]
  const notes = labels.filter((l) => st.footnotes.has(l))
  if (notes.length) {
    const items = notes.map((label) => {
      const id = escapeHtml(label)
      return `<li id="fn-${id}">${st.footnotes.get(label)} <a href="#fnref-${id}" class="footnote-backref">↩</a></li>`
    })
    html += `\n<hr class="footnotes-sep" />\n<section class="footnotes">\n<ol>\n${items.join('\n')}\n</ol>\n</section>`
  }
  return html
}
