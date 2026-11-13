/**
 * Interface languages. The main process (menus, system dialogs) and the
 * renderer (everything inside the window) share these catalogs.
 */
import { de } from './de'
import { en, type MessageKey, type Messages } from './en'
import { es } from './es'
import { fr } from './fr'
import { ja } from './ja'
import { ko } from './ko'
import { ptBR } from './pt-BR'
import { ru } from './ru'
import { zhCN } from './zh-CN'
import { zhTW } from './zh-TW'

export type { MessageKey, Messages }

/** Supported languages, each named in itself. */
export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-TW', name: '繁體中文' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'de', name: 'Deutsch' },
  { id: 'fr', name: 'Français' },
  { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'ru', name: 'Русский' }
] as const

export type Locale = (typeof LOCALES)[number]['id']

export const CATALOGS: Record<Locale, Messages> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  'pt-BR': ptBR,
  ru
}

const isLocale = (id: string): id is Locale => LOCALES.some((l) => l.id === id)

/** The supported language closest to a BCP 47 tag such as `zh-Hans-CN` or `fr-CA`. */
export function matchLocale(tag: string): Locale | null {
  const t = tag.trim().replace(/_/g, '-').toLowerCase()
  if (!t) return null
  if (t === 'zh' || t.startsWith('zh-')) return /hant|-tw|-hk|-mo/.test(t) ? 'zh-TW' : 'zh-CN'
  if (t === 'pt' || t.startsWith('pt-')) return 'pt-BR'
  const primary = t.split('-')[0]
  return isLocale(primary) ? primary : null
}

/**
 * The language to use. `preference` is a locale id or 'system'; for 'system'
 * the first supported language in the system's list wins, then English.
 */
export function resolveLocale(preference: string, systemLanguages: readonly string[]): Locale {
  if (preference && preference !== 'system' && isLocale(preference)) return preference
  for (const tag of systemLanguages) {
    const match = matchLocale(tag)
    if (match) return match
  }
  return 'en'
}

export type Params = Record<string, string | number>

export interface Translator {
  (key: MessageKey, params?: Params): string
  /** A count-dependent message: picks `<key>.one`, `.few`, `.many` or `.other` by the language's plural rules. */
  plural(key: string, n: number, params?: Params): string
  readonly locale: Locale
}

function fill(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

const englishRules = new Intl.PluralRules('en')

export function createTranslator(locale: Locale): Translator {
  const own = (CATALOGS[locale] || {}) as Record<string, string | undefined>
  const base = en as Record<string, string | undefined>
  const rules = new Intl.PluralRules(locale)
  const t = ((key: MessageKey, params?: Params) => fill(own[key] ?? base[key] ?? key, params)) as Translator
  t.plural = (key, n, params) => {
    // The language's own forms first, so a missing form never falls back to English mid-sentence.
    const text =
      own[`${key}.${rules.select(n)}`] ??
      own[`${key}.other`] ??
      base[`${key}.${englishRules.select(n)}`] ??
      base[`${key}.other`] ??
      key
    return fill(text, { n, ...params })
  }
  Object.defineProperty(t, 'locale', { value: locale })
  return t
}
