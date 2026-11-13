/**
 * Document schema.
 *
 * Block structure (headings, lists, quotes, tables, fences...) is modelled as
 * nodes. Inline content is NOT modelled: every text block holds its raw inline
 * Markdown source as plain text, and the editor styles it with decorations.
 * That keeps inline round-trips lossless and lets syntax markers be revealed
 * around the caret, the way a seamless live preview needs.
 */
import { Schema, type NodeSpec } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'text*',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `${(attrs.style as string) || ''}text-align: ${value};`
      }
    }
  }
})

// Cells hold raw inline source, so whitespace must survive DOM round-trips.
for (const name of ['table_cell', 'table_header'] as const) {
  ;(tables[name] as NodeSpec).whitespace = 'pre'
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'text*',
    group: 'block',
    whitespace: 'pre',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0]
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: 'text*',
    group: 'block',
    defining: true,
    whitespace: 'pre',
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + level, attrs: { level } })),
    toDOM: (node) => ['h' + node.attrs.level, 0]
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0]
  },

  bullet_list: {
    attrs: { tight: { default: true }, marker: { default: '-' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (node) => ['ul', { class: node.attrs.tight ? 'md-tight' : 'md-loose' }, 0]
  },

  ordered_list: {
    attrs: { tight: { default: true }, start: { default: 1 }, delim: { default: '.' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute('start') || 1) })
      }
    ],
    toDOM: (node) => [
      'ol',
      { class: node.attrs.tight ? 'md-tight' : 'md-loose', start: node.attrs.start === 1 ? null : node.attrs.start },
      0
    ]
  },

  list_item: {
    // `checked` is null for a plain item, or a boolean for a task item.
    attrs: { checked: { default: null } },
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: (node) => {
      const c = node.attrs.checked
      if (c === null) return ['li', 0]
      return ['li', { class: 'md-task-list-item task-list-item' + (c ? ' task-list-done' : '') }, 0]
    }
  },

  code_block: {
    attrs: { lang: { default: '' } },
    content: 'text*',
    group: 'block',
    code: true,
    defining: true,
    marks: '',
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (node) => ['pre', { class: 'md-fences', 'data-lang': node.attrs.lang || null }, ['code', 0]]
  },

  math_block: {
    content: 'text*',
    group: 'block',
    code: true,
    defining: true,
    marks: '',
    toDOM: () => ['div', { class: 'md-math-block' }, 0]
  },

  html_block: {
    content: 'text*',
    group: 'block',
    code: true,
    defining: true,
    marks: '',
    toDOM: () => ['div', { class: 'md-html-block' }, 0]
  },

  front_matter: {
    content: 'text*',
    group: 'block',
    code: true,
    defining: true,
    marks: '',
    toDOM: () => ['pre', { class: 'md-front-matter' }, 0]
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr']
  },

  toc: {
    group: 'block',
    atom: true,
    toDOM: () => ['div', { class: 'md-toc' }]
  },

  ...tables,

  text: { group: 'inline' }
}

export const schema = new Schema({ nodes })

export type NodeName = keyof typeof nodes

/** Text blocks whose content is inline Markdown (as opposed to code). */
export function isInlineBlock(node: { isTextblock: boolean; type: { spec: NodeSpec } }): boolean {
  return node.isTextblock && !node.type.spec.code
}
