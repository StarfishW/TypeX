/**
 * The interface language inside the window. The main process resolves the
 * language and passes it in at startup; switching languages reloads the
 * window, so it is set once per page.
 */
import { createTranslator, type Locale, type MessageKey, type Params, type Translator } from '../../shared/i18n'
import { displayKey } from '../../shared/keys'

let translator: Translator = createTranslator('en')
let platform = 'win32'

export function setLocale(locale: Locale, os: string): void {
  translator = createTranslator(locale)
  platform = os
  document.documentElement.lang = locale
}

export const t = (key: MessageKey, params?: Params): string => translator(key, params)

/** A count-dependent message, such as "1 Word" or "5 Words". */
export const tp = (key: string, n: number, params?: Params): string => translator.plural(key, n, params)

/** The shortcut of a command as this platform writes it, e.g. `Ctrl+Shift+L` or `⇧⌘L`. */
export const shortcut = (command: string): string => displayKey(command, platform)

export const currentLocale = (): Locale => translator.locale

/** Windows has a Recycle Bin; macOS and Linux have a Trash. */
export const trashMessages = (): { confirm: 'msg.confirmRecycle' | 'msg.confirmTrash'; button: 'button.moveToRecycleBin' | 'button.moveToTrash' } =>
  platform === 'win32'
    ? { confirm: 'msg.confirmRecycle', button: 'button.moveToRecycleBin' }
    : { confirm: 'msg.confirmTrash', button: 'button.moveToTrash' }
