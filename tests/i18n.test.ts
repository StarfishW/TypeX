import { describe, expect, it } from 'vitest'
import { CATALOGS, LOCALES, createTranslator, matchLocale, resolveLocale } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'

const PLURAL = /\.(zero|one|two|few|many|other)$/
const placeholders = (text: string): string =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',')

const english = en as Record<string, string>
const enKeys = Object.keys(en)
const plainKeys = enKeys.filter((k) => !PLURAL.test(k))
const pluralBases = [...new Set(enKeys.filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))]
const TOP_LEVEL = ['menu.file', 'menu.edit', 'menu.paragraph', 'menu.format', 'menu.view', 'menu.themes', 'menu.help']

describe('catalogs', () => {
  for (const { id } of LOCALES) {
    const catalog = CATALOGS[id] as Record<string, string | undefined>

    it(`${id}: translates every message`, () => {
      expect(plainKeys.filter((k) => !catalog[k]?.trim())).toEqual([])
    })

    it(`${id}: has no unknown keys`, () => {
      const stray = Object.keys(catalog).filter((k) =>
        PLURAL.test(k) ? !pluralBases.includes(k.replace(PLURAL, '')) : !(k in en)
      )
      expect(stray).toEqual([])
    })

    it(`${id}: keeps every placeholder`, () => {
      const wrong: string[] = []
      for (const [key, text] of Object.entries(catalog)) {
        if (!text) continue
        const reference = PLURAL.test(key) ? english[`${key.replace(PLURAL, '')}.other`] : english[key]
        if (placeholders(text) !== placeholders(reference)) wrong.push(key)
      }
      expect(wrong).toEqual([])
    })

    it(`${id}: has the plural forms its grammar needs`, () => {
      const rules = new Intl.PluralRules(id)
      const needed = new Set<string>()
      for (let n = 0; n <= 200; n++) needed.add(rules.select(n))
      const missing: string[] = []
      for (const base of pluralBases) {
        for (const category of needed) if (!catalog[`${base}.${category}`]) missing.push(`${base}.${category}`)
        if (!catalog[`${base}.other`]) missing.push(`${base}.other`)
      }
      expect(missing).toEqual([])
    })

    it(`${id}: menu bar labels each mark one access key, all different`, () => {
      const keys = TOP_LEVEL.map((k) => {
        const label = catalog[k] || ''
        expect(label.split('&').length - 1).toBe(1)
        return label[label.indexOf('&') + 1].toLowerCase()
      })
      expect(new Set(keys).size).toBe(keys.length)
    })
  }
})

describe('choosing a language', () => {
  it('matches system language tags', () => {
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('zh-SG')).toBe('zh-CN')
    expect(matchLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(matchLocale('zh-HK')).toBe('zh-TW')
    expect(matchLocale('pt-PT')).toBe('pt-BR')
    expect(matchLocale('fr-CA')).toBe('fr')
    expect(matchLocale('de_DE')).toBe('de')
    expect(matchLocale('en-GB')).toBe('en')
    expect(matchLocale('nl-NL')).toBe(null)
  })

  it('prefers the setting, then the system languages in order, then English', () => {
    expect(resolveLocale('ja', ['de-DE'])).toBe('ja')
    expect(resolveLocale('system', ['nl-NL', 'fr-FR', 'de-DE'])).toBe('fr')
    expect(resolveLocale('system', ['nl-NL'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
    expect(resolveLocale('klingon', ['ko-KR'])).toBe('ko')
  })
})

describe('translator', () => {
  it('fills placeholders', () => {
    expect(createTranslator('en')('app.about', { app: 'TypeX' })).toBe('About TypeX')
    expect(createTranslator('zh-CN')('app.about', { app: 'TypeX' })).toBe('关于 TypeX')
  })

  it('chooses plural forms by the language rules', () => {
    const en = createTranslator('en')
    expect(en.plural('status.words', 1)).toBe('1 Word')
    expect(en.plural('status.words', 2)).toBe('2 Words')
    const ru = createTranslator('ru')
    expect(ru.plural('status.words', 1)).toBe('1 слово')
    expect(ru.plural('status.words', 3)).toBe('3 слова')
    expect(ru.plural('status.words', 5)).toBe('5 слов')
    expect(ru.plural('status.words', 21)).toBe('21 слово')
    expect(createTranslator('fr').plural('status.words', 0)).toBe('0 mot')
    expect(createTranslator('zh-CN').plural('status.words', 1)).toBe('1 词')
    expect(createTranslator('de').plural('status.selectedWords', 2, { selected: 1 })).toBe('1 / 2 Wörter')
  })
})
