/**
 * Clipboard integration. Copy puts Markdown on the clipboard as plain text
 * and rendered HTML as rich text. Paste converts incoming HTML to Markdown and
 * parses plain text as Markdown.
 */
import { Slice } from 'prosemirror-model'
import { Plugin, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { renderHtml } from './html'
import { fragmentToMarkdown, parseMarkdown } from './markdown'
import { isInlineBlock, schema } from './schema'

const { nodes } = schema

let turndown: TurndownService | null = null

export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**'
    })
    turndown.use(gfm)
    turndown.remove(['script', 'style', 'title', 'head', 'noscript'])
    turndown.keep(['u', 'sub', 'sup', 'kbd', 'mark'])
  }
  return turndown.turndown(html).trim()
}

/** Whether pasted HTML carries formatting worth converting (as opposed to styled plain text). */
const isRichHtml = (html: string): boolean =>
  /<(a|b|strong|i|em|h[1-6]|ul|ol|li|table|img|blockquote|pre|code|del|s|u|hr)\b/i.test(html)

const OWN_MARK = 'data-typex-clip'

export const selectionMarkdown = (state: EditorState): string => fragmentToMarkdown(state.selection.content().content)

export const selectionHtml = (state: EditorState): string => renderHtml(state.selection.content().content)

/** Inserts Markdown source at the selection, inline when it is a single paragraph. */
export function insertMarkdown(view: EditorView, markdown: string): void {
  const md = markdown.replace(/\r\n?/g, '\n')
  if (!md) return
  const { state } = view
  const { $from, $to } = state.selection
  const tr = state.tr
  const parent = $from.parent

  if (parent.type.spec.code) {
    tr.insertText(md, state.selection.from, state.selection.to)
  } else if (parent.type === nodes.table_cell || parent.type === nodes.table_header) {
    tr.insertText(md.trim().replace(/\n+/g, '<br>'), state.selection.from, state.selection.to)
  } else {
    const { doc } = parseMarkdown(md)
    const first = doc.firstChild!
    const single = doc.childCount === 1 && first.type === nodes.paragraph
    if (single && isInlineBlock(parent) && $from.sameParent($to)) {
      tr.insertText(first.textContent, state.selection.from, state.selection.to)
    } else {
      const last = doc.lastChild!
      const mergeStart = first.type === nodes.paragraph && parent.type === nodes.paragraph && parent.content.size > 0
      const mergeEnd = last.type === nodes.paragraph && doc.childCount > 1 && $to.parent.type === nodes.paragraph
      tr.replaceSelection(new Slice(doc.content, mergeStart ? 1 : 0, mergeEnd ? 1 : 0))
    }
  }
  view.dispatch(tr.scrollIntoView())
}

export interface ClipboardHooks {
  /** Called with image files that were pasted or dropped. */
  onImages: (files: File[]) => void
}

function writeClipboard(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const { state } = view
  if (state.selection.empty || !event.clipboardData) return false
  const md = selectionMarkdown(state)
  const html = `<div ${OWN_MARK}="1">${selectionHtml(state)}</div>`
  event.clipboardData.setData('text/plain', md)
  event.clipboardData.setData('text/html', html)
  event.preventDefault()
  if (cut) view.dispatch(state.tr.deleteSelection().scrollIntoView())
  return true
}

export function clipboardPlugin(hooks: ClipboardHooks): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        copy: (view, event) => writeClipboard(view, event as ClipboardEvent, false),
        cut: (view, event) => writeClipboard(view, event as ClipboardEvent, true)
      },
      handlePaste(view, event) {
        const data = event.clipboardData
        if (!data) return false
        const text = data.getData('text/plain')
        const html = data.getData('text/html')
        const images = Array.from(data.files).filter((f) => f.type.startsWith('image/'))
        if (images.length && !text) {
          hooks.onImages(images)
          return true
        }
        if (!text && !html) return false
        let md = text
        const fromEditor = data.types.includes('vscode-editor-data')
        if (html && !html.includes(OWN_MARK) && !fromEditor && isRichHtml(html)) {
          try {
            md = htmlToMarkdown(html) || text
          } catch {
            md = text
          }
        }
        insertMarkdown(view, md)
        return true
      }
    }
  })
}
