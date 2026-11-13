/** The interface language of the main process: menus, system dialogs and the Dock. */
import { app } from 'electron'
import { createTranslator, resolveLocale, type Locale, type MessageKey, type Params, type Translator } from '../shared/i18n'

let translator: Translator = createTranslator('en')

/**
 * Applies a language preference: a locale id, or 'system' to follow the
 * operating system. Automated test runs use English unless a language is set.
 */
export function applyLocale(preference: string): Locale {
  const system = process.env.TYPEX_TEST === '1' ? [] : app.getPreferredSystemLanguages()
  translator = createTranslator(resolveLocale(preference, system))
  return translator.locale
}

export const currentLocale = (): Locale => translator.locale

export const t = (key: MessageKey, params?: Params): string => translator(key, params)
