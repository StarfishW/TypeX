import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { parseMarkdown, serializeMarkdown } from '../src/renderer/src/editor/markdown'
import { schema } from '../src/renderer/src/editor/schema'

/** Compact structural dump of a document. */
function dump(node: PMNode): string {
  if (node.isText) return JSON.stringify(node.text)
  const attrs = Object.entries(node.attrs)
    .filter(([k, v]) => v !== null && v !== '' && !['colspan', 'rowspan', 'colwidth', 'tight', 'marker', 'delim'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  const kids: string[] = []
  node.forEach((c) => kids.push(dump(c)))
  return `${node.type.name}${attrs ? `[${attrs}]` : ''}(${kids.join(' ')})`
}

const parse = (src: string): string => {
  const kids: string[] = []
  parseMarkdown(src).doc.forEach((c) => kids.push(dump(c)))
  return kids.join(' ')
}
const roundTrip = (src: string): string => serializeMarkdown(parseMarkdown(src).doc).text

describe('parseMarkdown', () => {
  it('keeps inline source raw', () => {
    expect(parse('Hello **world** and `code`')).toBe('paragraph("Hello **world** and `code`")')
  })

  it('parses headings, quotes and rules', () => {
    expect(parse('# One\n\n## Two ##\n\nSetext\n---\n\n> quote\n\n***')).toBe(
      'heading[level=1]("One") heading[level=2]("Two") heading[level=2]("Setext") blockquote(paragraph("quote")) horizontal_rule()'
    )
  })

  it('parses nested and task lists', () => {
    expect(parse('- a\n  - b\n- [x] done\n- [ ] todo\n\n3. three')).toBe(
      'bullet_list(list_item(paragraph("a") bullet_list(list_item(paragraph("b")))) list_item[checked=true](paragraph("done")) list_item[checked=false](paragraph("todo"))) ordered_list[start=3](list_item(paragraph("three")))'
    )
  })

  it('parses fences, math and front matter', () => {
    expect(parse('---\ntitle: x\n---\n\n```js\nlet a = 1\n```\n\n$$\nx^2\n$$\n\n[toc]')).toBe(
      'front_matter("title: x") code_block[lang=js]("let a = 1") math_block("x^2") toc()'
    )
  })

  it('keeps indented text as a paragraph, indentation included', () => {
    expect(parse('    indented')).toBe('paragraph("    indented")')
    expect(parse('  shallow')).toBe('paragraph("shallow")')
  })

  it('only treats a closed $$ block as math', () => {
    expect(parse('$$a$$ is inline, and\n\nmore $$b$$')).toBe('paragraph("$$a$$ is inline, and") paragraph("more $$b$$")')
    expect(parse('$$ x = 1 $$')).toBe('math_block("x = 1")')
    expect(parse('$$\nx\n\ny\n$$')).toBe('math_block("x\\n\\ny")')
    expect(parse('$$\nnever closed')).toBe('paragraph("$$\\nnever closed")')
  })

  it('parses tables with alignment and escaped pipes', () => {
    expect(parse('| a | b |\n|:--|--:|\n| 1 | x \\| y |')).toBe(
      'table(table_row(table_header[align=left]("a") table_header[align=right]("b")) table_row(table_cell[align=left]("1") table_cell[align=right]("x | y")))'
    )
  })

  it('keeps reference and footnote definitions as editable text', () => {
    expect(parse('[id]: http://x.y "T"\n\n[^1]: note')).toBe('paragraph("[id]: http://x.y \\"T\\"") paragraph("[^1]: note")')
  })

  it('keeps soft line breaks', () => {
    expect(parse('one\ntwo  \n  three')).toBe('paragraph("one\\ntwo  \\n  three")')
  })

  it('reports the source line of each block', () => {
    expect(parseMarkdown('# a\n\ntext\n\n- x\n').lines).toEqual([0, 2, 4])
  })

  it('never returns an empty document', () => {
    expect(parse('')).toBe('paragraph()')
  })
})

describe('serializeMarkdown', () => {
  const stable = [
    '# Title\n\nSome *text* with `code`.\n',
    '- a\n  - b\n  - c\n- d\n',
    '- a\n\n- b\n\n  second paragraph\n',
    '1. one\n2. two\n   - nested\n',
    '5) five\n6) six\n',
    '- [ ] todo\n- [x] done\n',
    '> quote\n>\n> - item\n>\n> more\n',
    '```js\nconst a = 1\n\nconst b = 2\n```\n',
    '$$\n\\frac{1}{2}\n$$\n',
    '---\ntitle: x\ntags: [a, b]\n---\n\nBody\n',
    '| a   |  b  |   c |\n| --- | :-: | --: |\n| 1   |  2  |   3 |\n',
    'line one\nline two\n',
    '<div align="center">\n  <b>hi</b>\n</div>\n',
    '[toc]\n\n---\n\ntext\n',
    '* star\n* list\n',
    'Text\n\n[id]: http://example.com "T"\n\n[^1]: A footnote.\n'
  ]

  for (const src of stable) {
    it(`round-trips ${JSON.stringify(src.slice(0, 28))}`, () => {
      expect(roundTrip(src)).toBe(src)
    })
  }

  it('normalizes what it cannot keep', () => {
    expect(roundTrip('Setext\n===\n')).toBe('# Setext\n')
    expect(roundTrip('~~~\ncode\n~~~\n')).toBe('```\ncode\n```\n')
    expect(roundTrip('a\n\n\n\nb\n')).toBe('a\n\nb\n')
    expect(roundTrip('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('escapes pipes and line breaks in table cells', () => {
    expect(roundTrip('| a |\n| --- |\n| x \\| y |\n')).toBe('| a      |\n| ------ |\n| x \\| y |\n')
  })

  it('uses a longer fence when the code contains one', () => {
    expect(roundTrip('````\n```\ninner\n```\n````\n')).toBe('````\n```\ninner\n```\n````\n')
  })

  it('is stable after one normalization pass', () => {
    const messy = '# H\nText right after\n* a\n* b\n\n    indented\n1. x\n\n   y\n> q\n'
    const once = roundTrip(messy)
    expect(roundTrip(once)).toBe(once)
  })

  it('reports the output line of each block', () => {
    const { lines } = serializeMarkdown(parseMarkdown('# a\n\ntext\n\n- x\n- y\n\nend\n').doc)
    expect(lines).toEqual([0, 2, 4, 7])
  })

  describe('paragraph text that looks like block syntax', () => {
    const { nodes } = schema
    const para = (text: string): string =>
      serializeMarkdown(nodes.doc.create(null, nodes.paragraph.create(null, schema.text(text)))).text

    const escaped: [string, string][] = [
      ['# not a heading', '\\# not a heading'],
      ['- not a list', '\\- not a list'],
      ['1. not a list', '1\\. not a list'],
      ['> not a quote', '\\> not a quote'],
      ['---', '\\---'],
      ['* * *', '\\* * *'],
      ['```', '\\```'],
      ['$$', '\\$$'],
      ['text\n===', 'text\n\\==='],
      ['text\n- item', 'text\n\\- item'],
      ['text\n1. item', 'text\n1\\. item'],
      ['a | b\n--- | ---', 'a | b\n\\--- | ---'],
      ['  # shallow indent', '\\# shallow indent']
    ]
    for (const [text, want] of escaped) {
      it(`escapes ${JSON.stringify(text)}`, () => {
        const out = para(text)
        expect(out).toBe(want + '\n')
        // The escaped form reads back as one paragraph and does not change again.
        const doc = parseMarkdown(out).doc
        expect(doc.childCount).toBe(1)
        expect(doc.firstChild!.type.name).toBe('paragraph')
        expect(serializeMarkdown(doc).text).toBe(out)
      })
    }

    const untouched = [
      '#hashtag',
      '*emphasis* first',
      '**strong** first',
      '-dash without space',
      '$$a$$ and text',
      '```a``` code span',
      'The year was\n2023. It went well.',
      'text\n    - deeply indented',
      '    indented first line',
      '1.5 is a number'
    ]
    for (const text of untouched) {
      it(`leaves ${JSON.stringify(text)} alone`, () => {
        expect(para(text)).toBe(text + '\n')
      })
    }
  })

  it('protects heading and list item text', () => {
    const { nodes } = schema
    const doc = nodes.doc.create(null, [
      nodes.heading.create({ level: 1 }, schema.text('C #')),
      nodes.bullet_list.create(null, nodes.list_item.create(null, nodes.paragraph.create(null, schema.text('[x] not a task'))))
    ])
    const out = serializeMarkdown(doc).text
    expect(out).toBe('# C \\#\n\n- \\[x] not a task\n')
    expect(roundTrip(out)).toBe(out)
  })

  it('writes a list loose as soon as one item needs a blank line', () => {
    // The second item holds a quote followed by a fence, which cannot sit together without one.
    expect(roundTrip('- a\n  > b\n  ```\n  c\n  ```\n- d\n')).toBe('- a\n\n  > b\n\n  ```\n  c\n  ```\n\n- d\n')
  })

  describe('reaches a fixed point after one pass', () => {
    const tricky = [
      '    ***\n',
      'Foo\n    ***\n',
      '- Foo\n- * * *\n',
      'foo\n    # bar\n',
      'Foo\n    ---\n',
      '> foo\nbar\n===\n',
      '> foo\n    - bar\n',
      '- # Foo\n- Bar\n  ---\n  baz\n',
      '* a\n  > b\n  >\n* c\n',
      '- a\n  > b\n  ```\n  c\n  ```\n- d\n',
      '    def f(x):\n        return x\n    # comment\n',
      '1. a\n\n   b\n2. c\n   - d\n',
      '- a\n  -\n- b\n',
      'text\n$$\nx\n$$\nmore\n',
      '- [ ] a\n  1. b\n  2. c\n- d\n'
    ]
    for (const src of tricky) {
      it(JSON.stringify(src), () => {
        const once = roundTrip(src)
        expect(roundTrip(once)).toBe(once)
      })
    }
  })

  it('leaves indented text exactly as it was', () => {
    const src = 'Intro:\n\n    def f(x):\n        return x\n    # comment\n\nDone.\n'
    expect(roundTrip(src)).toBe(src)
  })
})
