import { describe, expect, it } from 'vitest'
import { plainText, tokenizeInline, type Tok } from '../src/renderer/src/editor/inline'

const emoji = (name: string): string | undefined => ({ smile: '😄', '+1': '👍' })[name]

/** Compact, readable shape of a token tree for assertions. */
function shape(src: string, toks: Tok[]): string {
  return toks
    .map((t) => {
      const body = t.children ? shape(src, t.children) : src.slice(t.from + (t.open || 0), t.to - (t.close || 0))
      return t.type === 'text' ? body : `${t.type}(${body})`
    })
    .join('')
}

const tok = (src: string, opt = {}): string => shape(src, tokenizeInline(src, { emoji, ...opt }))

describe('emphasis', () => {
  it('parses strong and em', () => {
    expect(tok('a **b** c')).toBe('a strong(b) c')
    expect(tok('a *b* c')).toBe('a em(b) c')
    expect(tok('__b__ _c_')).toBe('strong(b) em(c)')
  })

  it('nests', () => {
    expect(tok('***b***')).toBe('em(strong(b))')
    expect(tok('**a *b* c**')).toBe('strong(a em(b) c)')
    expect(tok('*a **b** c*')).toBe('em(a strong(b) c)')
  })

  it('leaves unmatched delimiters as text', () => {
    expect(tok('a * b * c')).toBe('a * b * c')
    expect(tok('**unclosed')).toBe('**unclosed')
    expect(tok('snake_case_name')).toBe('snake_case_name')
  })

  it('records marker ranges', () => {
    const [t] = tokenizeInline('**bold**')
    expect(t).toMatchObject({ type: 'strong', from: 0, to: 8, open: 2, close: 2 })
    expect(t.children![0]).toMatchObject({ type: 'text', from: 2, to: 6 })
  })

  it('handles CJK text next to punctuation', () => {
    expect(tok('这是**「强调」**文字')).toBe('这是strong(「强调」)文字')
    expect(tok('中文**加粗**中文')).toBe('中文strong(加粗)中文')
  })

  it('parses strikethrough, highlight, sub and sup', () => {
    expect(tok('~~gone~~ ==hi== H~2~O x^2^')).toBe('del(gone) mark(hi) Hsub(2)O xsup(2)')
    expect(tok('==hi==', { mark: false })).toBe('==hi==')
    expect(tok('a ~ b ~ c')).toBe('a ~ b ~ c')
  })
})

describe('code and math', () => {
  it('parses code spans with any backtick run', () => {
    expect(tok('`a` ``b`c``')).toBe('code(a) code(b`c)')
    expect(tok('`unclosed')).toBe('`unclosed')
    expect(tok('`**not bold**`')).toBe('code(**not bold**)')
  })

  it('parses inline math but not prices', () => {
    expect(tok('$x^2$ and $$y$$')).toBe('math(x^2) and math(y)')
    expect(tok('$5 and $10')).toBe('$5 and $10')
    expect(tok('$x$', { math: false })).toBe('$x$')
  })
})

describe('links and images', () => {
  it('parses inline links', () => {
    const toks = tokenizeInline('[a *b*](http://x.y "T")')
    expect(toks).toHaveLength(1)
    expect(toks[0]).toMatchObject({ type: 'link', open: 1, attrs: { href: 'http://x.y', title: 'T' } })
    expect(toks[0].close).toBe('](http://x.y "T")'.length)
    expect(shape('[a *b*](http://x.y "T")', toks)).toBe('link(a em(b))')
  })

  it('allows spaces and parentheses in destinations', () => {
    const [t] = tokenizeInline('![shot](C:\\My Pictures\\a (1).png)')
    expect(t).toMatchObject({ type: 'image', attrs: { href: 'C:\\My Pictures\\a (1).png', alt: 'shot' } })
  })

  it('removes escapes from destinations but not from Windows paths', () => {
    expect(tokenizeInline('[a](foo\\(bar\\) "ti\\"tle")')[0].attrs).toEqual({ href: 'foo(bar)', title: 'ti"tle' })
    expect(tokenizeInline('![x](C:\\Users\\_me\\a.png)')[0].attrs!.href).toBe('C:\\Users\\_me\\a.png')
  })

  it('lets a title wrap onto the next line', () => {
    const src = '[a](/uri\n  "title")'
    const [t] = tokenizeInline(src)
    expect(t).toMatchObject({ type: 'link', from: 0, to: src.length, attrs: { href: '/uri', title: 'title' } })
    expect(tok('[a](/uri\nnot a title)')).toBe('[a](/uri\nnot a title)')
  })

  it('needs a definition for full references when definitions are known', () => {
    const hasRef = (l: string): boolean => l === 'b'
    expect(tok('[a][b]', { hasRef })).toBe('reflink(a)')
    expect(tok('[a][c]', { hasRef })).toBe('[a][c]')
    expect(tok('[x][y][b]', { hasRef })).toBe('[x]reflink(y)')
  })

  it('does not nest links', () => {
    expect(tok('[a [b](c) d](e)')).toBe('[a link(b) d](e)')
  })

  it('parses reference links and footnotes', () => {
    expect(tok('[a][b] [c][] [^1]')).toBe('reflink(a) reflink(c) footnote(1)')
    expect(tok('[a]')).toBe('[a]')
    expect(tok('[a]', { hasRef: (l: string) => l === 'a' })).toBe('reflink(a)')
  })

  it('marks definitions at the start of a line', () => {
    const toks = tokenizeInline('[id]: http://x.y\n[^n]: note')
    expect(toks[0]).toMatchObject({ type: 'defmark', attrs: { label: 'id', footnote: '' } })
    expect(toks.find((t) => t.attrs?.label === 'n')).toMatchObject({ type: 'defmark', attrs: { footnote: '1' } })
  })

  it('autolinks', () => {
    expect(tok('<http://a.b> see https://c.d/e. And www.f.g!')).toBe('autolink(http://a.b) see url(https://c.d/e). And url(www.f.g)!')
    expect(tok('(https://a.b/c_(d))')).toBe('(url(https://a.b/c_(d)))')
    expect(tok('**https://a.b**')).toBe('strong(url(https://a.b))')
  })
})

describe('html, escapes and entities', () => {
  it('pairs inline html tags', () => {
    const src = '<u>**x**</u> <span style="color:red">y</span><br/>'
    const toks = tokenizeInline(src)
    expect(shape(src, toks)).toBe('html(strong(x)) html(y)br(<br/>)')
    expect(toks[2]).toMatchObject({ type: 'html', attrs: { tag: 'span', raw: ' style="color:red"' } })
  })

  it('keeps unpaired tags as tags', () => {
    expect(tok('a <b> c')).toBe('a htmltag(<b>) c')
    expect(tok('1 < 2 > 1')).toBe('1 < 2 > 1')
  })

  it('treats a backslash at the end of a line as a hard break', () => {
    const src = 'one\\\ntwo'
    const toks = tokenizeInline(src)
    expect(toks.map((t) => t.type)).toEqual(['text', 'hardbreak', 'text'])
    expect(toks[1]).toMatchObject({ from: 3, to: 4 })
  })

  it('handles escapes, entities and emoji', () => {
    expect(tok('\\*not em\\* &amp; :smile: :nope:')).toBe('escape(*)not emescape(*) entity(&amp;) emoji(:smile:) :nope:')
  })
})

describe('plainText', () => {
  it('strips syntax', () => {
    const src = '**Bold** [link](x) `code` ![alt](y) :smile: \\*'
    expect(plainText(src, tokenizeInline(src, { emoji }))).toBe('Bold link code alt 😄 *')
  })
})
