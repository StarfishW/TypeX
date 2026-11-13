/**
 * Shared, mutable editor environment: the document location, syntax options
 * and the hooks the editor uses to reach the rest of the application.
 */
import { nameToEmoji } from 'gemoji'
import type { InlineOptions } from './inline'

export interface EditorEnv {
  /** Absolute path of the open document, or '' while it is untitled. */
  docPath: string
  inline: Required<Pick<InlineOptions, 'math' | 'sub' | 'sup' | 'mark'>>
  /** Opens a link the user Ctrl+clicked. */
  openLink: (href: string) => void
  /** Pastes the clipboard's plain text, without converting rich content. */
  pastePlain: () => void
  /** Dark themes switch diagram rendering to a dark palette. */
  dark: boolean
  /** Whether the file system ignores letter case (Windows and macOS; not Linux). */
  caseInsensitivePaths: boolean
}

export const env: EditorEnv = {
  docPath: '',
  inline: { math: true, sub: true, sup: true, mark: true },
  openLink: () => {},
  pastePlain: () => {},
  dark: false,
  caseInsensitivePaths: true
}

const pathKey = (p: string): string => {
  const s = p.replace(/\\/g, '/')
  return env.caseInsensitivePaths ? s.toLowerCase() : s
}

/** Whether two paths name the same file, following the platform's rules for letter case. */
export const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b)

export const emojiFor = (name: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(nameToEmoji, name) ? nameToEmoji[name] : undefined

/* ---------------------------- path helpers ---------------------------- */

export const isAbsolutePath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')

export function dirname(p: string): string {
  const s = p.replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  if (i < 0) return ''
  if (i === 0) return '/'
  return /^[a-zA-Z]:$/.test(s.slice(0, i)) ? s.slice(0, i) + '/' : s.slice(0, i)
}

export function basename(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i) : ''
}

/** Joins and normalizes, resolving `.` and `..` segments. Uses forward slashes. */
export function joinPath(base: string, rel: string): string {
  const full = isAbsolutePath(rel) ? rel : base.replace(/[\\/]+$/, '') + '/' + rel
  const s = full.replace(/\\/g, '/')
  const unc = s.startsWith('//')
  const lead = unc ? '//' : s.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const part of s.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..' && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop()
      continue
    }
    out.push(part)
  }
  return lead + out.join('/')
}

/** A relative path from `fromDir` to `to`, or `to` itself when they share no root. */
export function relativePath(fromDir: string, to: string): string {
  const a = joinPath(fromDir, '.').split('/')
  const b = joinPath(to, '.').split('/')
  const same = (x: string, y: string): boolean => (env.caseInsensitivePaths ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (!a.length || !b.length || !same(a[0], b[0])) return to.replace(/\\/g, '/')
  let i = 0
  while (i < a.length && i < b.length && same(a[i], b[i])) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.'
}

export const localUrl = (absPath: string): string => 'typex-file://local/' + encodeURIComponent(absPath.replace(/\\/g, '/'))

/** Turns an image or media source from the document into a loadable URL. */
export function resolveUrl(src: string): string {
  const s = src.trim()
  if (!s) return ''
  if (/^(https?:|data:|blob:|typex-file:)/i.test(s)) return s
  if (/^\/\//.test(s)) return 'https:' + s
  let path = s
  if (/^file:\/\//i.test(s)) {
    path = s.replace(/^file:\/\/\/?/i, '')
    if (!/^[a-zA-Z]:/.test(path)) path = '/' + path
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    /* keep the literal text when it is not valid percent-encoding */
  }
  // Drop a query or fragment after the file name, but leave such characters alone inside the path itself.
  path = path.replace(/(\.[a-zA-Z0-9]{2,5})[?#][^\\/]*$/, '$1')
  if (isAbsolutePath(path)) return localUrl(joinPath(path, '.'))
  if (!env.docPath) return ''
  return localUrl(joinPath(dirname(env.docPath), path))
}
