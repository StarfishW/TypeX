/**
 * Builds a complete, self-contained HTML document from the editor content.
 * Code highlighting, formulas and diagrams are rendered up front (they are
 * asynchronous), then the synchronous HTML renderer stitches them in.
 */
import { classHighlighter, highlightTree } from '@lezer/highlight'
import DOMPurify from 'dompurify'
import type { Node as PMNode } from 'prosemirror-model'
import { tokensFor } from './editor/decorations'
import { dirname, env, isAbsolutePath, joinPath } from './editor/env'
import { escapeHtml, renderHtml } from './editor/html'
import type { Tok } from './editor/inline'
import { mathCss, mathToHtml } from './editor/math'
import { findLanguage, isDiagramLang, renderMermaid } from './editor/nodeviews'
import { isInlineBlock, schema } from './editor/schema'
import contentCss from './styles/content.css?inline'

const { nodes } = schema

const EXPORT_CSS = `
html, body { margin: 0; background: var(--bg-color); }
#write { max-width: var(--write-width); margin: 0 auto; padding: 32px 40px 60px; box-sizing: border-box; }
@page { size: A4; margin: 0; }
@media print {
  #write { max-width: none; padding: 18mm 18mm; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  pre, table, blockquote, img, svg, .math-block, .diagram { break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  #write pre.code-block { white-space: pre-wrap; overflow-wrap: anywhere; }
}
`

async function highlight(code: string, lang: string): Promise<string | undefined> {
  const desc = findLanguage(lang)
  if (!desc) return undefined
  try {
    const support = await desc.load()
    const tree = support.language.parser.parse(code)
    let out = ''
    let pos = 0
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (from > pos) out += escapeHtml(code.slice(pos, from))
      out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`
      pos = to
    })
    return out + escapeHtml(code.slice(pos))
  } catch {
    return undefined
  }
}

function fileUrl(abs: string): string {
  const parts = abs.replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  return 'file:///' + parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/')
}

function decodePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

export interface ExportOptions {
  title: string
  themeCss: string
  /** false produces bare HTML without any stylesheet. */
  styled: boolean
  /** Rewrites relative image paths to absolute file URLs (needed for PDF and print). */
  absoluteImages: boolean
}

export async function buildExportHtml(doc: PMNode, opts: ExportOptions): Promise<string> {
  const highlighted = new Map<string, string | undefined>()
  const formulas = new Map<string, string>()
  const diagrams = new Map<string, string>()
  const jobs: Promise<void>[] = []
  const key = (a: string, b: string | boolean): string => `${b}\u0000${a}`

  const wantMath = (tex: string, display: boolean): void => {
    const k = key(tex, display)
    if (formulas.has(k)) return
    formulas.set(k, '')
    jobs.push(mathToHtml(tex, display).then((html) => void formulas.set(k, html)))
  }
  const scanTokens = (src: string, toks: Tok[]): void => {
    for (const t of toks) {
      if (t.type === 'math') wantMath(src.slice(t.from + t.open!, t.to - t.close!), !!t.attrs?.display)
      if (t.children) scanTokens(src, t.children)
    }
  }

  doc.descendants((node) => {
    if (node.type === nodes.code_block) {
      const code = node.textContent
      const lang = (node.attrs.lang as string) || ''
      if (isDiagramLang(lang)) {
        if (!diagrams.has(code)) {
          diagrams.set(code, '')
          jobs.push(
            renderMermaid(code).then(
              (svg) => void diagrams.set(code, svg),
              () => void diagrams.delete(code)
            )
          )
        }
      } else if (lang) {
        const k = key(code, lang)
        if (!highlighted.has(k)) {
          highlighted.set(k, undefined)
          jobs.push(highlight(code, lang).then((html) => void highlighted.set(k, html)))
        }
      }
      return false
    }
    if (node.type === nodes.math_block) {
      wantMath(node.textContent, true)
      return false
    }
    if (node.isTextblock) {
      if (isInlineBlock(node)) scanTokens(node.textContent, tokensFor(node))
      return false
    }
    return true
  })
  await Promise.all(jobs)

  const body = renderHtml(doc.content, {
    headingIds: true,
    highlight: (code, lang) => highlighted.get(key(code, lang)),
    math: (tex, display) => formulas.get(key(tex, display)) || undefined,
    diagram: (code) => diagrams.get(code) || undefined,
    sanitize: (html) => DOMPurify.sanitize(html, { ADD_TAGS: ['iframe'], ADD_ATTR: ['allowfullscreen', 'frameborder', 'target'] }) as string,
    image: (src) => {
      const s = src.trim()
      if (!s || /^(https?:|data:|file:)/i.test(s)) return s
      const path = decodePath(s)
      if (isAbsolutePath(path)) return fileUrl(path)
      if (!opts.absoluteImages || !env.docPath) return s
      return fileUrl(joinPath(dirname(env.docPath), path))
    }
  })

  const style = opts.styled ? `<style>\n${contentCss}\n${opts.themeCss}\n${mathCss()}\n${EXPORT_CSS}</style>\n` : ''
  return (
    '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    `<title>${escapeHtml(opts.title)}</title>\n${style}</head>\n` +
    `<body>\n<div id="write">\n${body}\n</div>\n</body>\n</html>\n`
  )
}
