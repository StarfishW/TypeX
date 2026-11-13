/** Preferences store (a JSON file in the user-data folder) and the theme catalogue. */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { BUILTIN_THEMES } from '../shared/themes'
import { DEFAULT_PREFS, type Prefs, type ThemeInfo } from '../shared/types'

let prefs: Prefs = { ...DEFAULT_PREFS }
let saveTimer: NodeJS.Timeout | null = null
const listeners = new Set<(prefs: Prefs) => void>()

const prefsFile = (): string => join(app.getPath('userData'), 'preferences.json')

export const themesDir = (): string => join(app.getPath('userData'), 'themes')

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(prefsFile(), 'utf8')) as Partial<Prefs>
    prefs = { ...DEFAULT_PREFS, ...raw, window: { ...DEFAULT_PREFS.window, ...(raw.window || {}) } }
  } catch {
    prefs = { ...DEFAULT_PREFS }
  }
  try {
    mkdirSync(themesDir(), { recursive: true })
  } catch {
    /* a read-only profile only loses user themes */
  }
  return prefs
}

export const getPrefs = (): Prefs => prefs

export function flushPrefs(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2), 'utf8')
  } catch {
    /* preferences are best-effort */
  }
}

export function updatePrefs(patch: Partial<Prefs>, notify = true): Prefs {
  prefs = { ...prefs, ...patch }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushPrefs, 400)
  if (notify) for (const l of listeners) l(prefs)
  return prefs
}

export function onPrefsChanged(listener: (prefs: Prefs) => void): void {
  listeners.add(listener)
}

// Windows and macOS file systems ignore letter case by default; Linux does not.
const samePath = (a: string, b: string): boolean =>
  process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()

export function addRecentFile(path: string): void {
  const recentFiles = [path, ...prefs.recentFiles.filter((p) => !samePath(p, path))].slice(0, 20)
  updatePrefs({ recentFiles, lastFile: path })
}

export function addRecentFolder(path: string): void {
  const recentFolders = [path, ...prefs.recentFolders.filter((p) => !samePath(p, path))].slice(0, 10)
  updatePrefs({ recentFolders, lastFolder: path })
}

export function listThemes(): ThemeInfo[] {
  const out = [...BUILTIN_THEMES]
  try {
    for (const file of readdirSync(themesDir())) {
      if (extname(file).toLowerCase() !== '.css') continue
      const id = 'user:' + file
      const name = basename(file, extname(file)).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      let dark = /dark|night|black/i.test(file)
      try {
        const head = readFileSync(join(themesDir(), file), 'utf8').slice(0, 2000)
        if (/typex:\s*dark/i.test(head) || /color-scheme:\s*dark/i.test(head)) dark = true
      } catch {
        /* unreadable theme files are still listed */
      }
      out.push({ id, name, builtin: false, dark })
    }
  } catch {
    /* no themes folder */
  }
  return out
}

export function readTheme(id: string): string {
  if (!id.startsWith('user:')) return ''
  const file = join(themesDir(), basename(id.slice(5)))
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
