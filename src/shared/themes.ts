import type { ThemeInfo } from './types'

/** Themes that ship with the app. Their CSS lives in src/renderer/src/styles/themes. */
export const BUILTIN_THEMES: ThemeInfo[] = [
  { id: 'daylight', name: 'Daylight', builtin: true, dark: false },
  { id: 'newsroom', name: 'Newsroom', builtin: true, dark: false },
  { id: 'midnight', name: 'Midnight', builtin: true, dark: true },
  { id: 'latte', name: 'Latte', builtin: true, dark: false },
  { id: 'chalk', name: 'Chalk', builtin: true, dark: false }
]
