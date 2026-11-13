/** File-system operations for documents, the file tree and folder search. */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { MARKDOWN_EXTENSIONS, type DirEntry, type FileData, type SearchHit } from '../shared/types'
import { t } from './i18n'

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN', 'System Volume Information'])

export const isMarkdownFile = (path: string): boolean =>
  MARKDOWN_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())

function decode(buf: Buffer): { text: string; bom: boolean; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), bom: true, encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), bom: false, encoding: 'utf-16le' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), bom: false, encoding: 'utf-8' }
  } catch {
    // Not valid UTF-8. GB18030 covers the most common legacy encoding for CJK text.
    try {
      return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf), bom: false, encoding: 'gb18030' }
    } catch {
      return { text: buf.toString('latin1'), bom: false, encoding: 'latin1' }
    }
  }
}

export async function readDoc(path: string): Promise<FileData> {
  const [buf, stat] = await Promise.all([fs.readFile(path), fs.stat(path)])
  const { text, bom, encoding } = decode(buf)
  const i = text.indexOf('\n')
  const eol = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
  return { path, content: text, eol, bom, encoding, mtime: stat.mtimeMs }
}

/** Writes through a temporary file so a crash mid-write cannot truncate the document. */
export async function writeDoc(
  path: string,
  content: string,
  opts: { eol: '\n' | '\r\n'; bom: boolean }
): Promise<{ mtime: number }> {
  let text = content.replace(/\r\n?/g, '\n')
  if (opts.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  const data = Buffer.from((opts.bom ? '﻿' : '') + text, 'utf8')
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    // Some locations (network shares, files held open by sync tools) refuse the rename.
    if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY') {
      await fs.writeFile(path, data)
    } else {
      throw err
    }
  }
  const stat = await fs.stat(path)
  return { mtime: stat.mtimeMs }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: DirEntry[] = []
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) return
      const path = join(dir, e.name)
      const isDir = e.isDirectory()
      if (!isDir && !(e.isFile() && isMarkdownFile(e.name))) return
      try {
        const stat = await fs.stat(path)
        out.push({ name: e.name, path, dir: isDir, mtime: stat.mtimeMs, size: stat.size })
      } catch {
        /* entry vanished or is unreadable */
      }
    })
  )
  return out.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
}

/** All Markdown files under `root`, for quick open and the article list. */
export async function listMarkdownFiles(root: string, limit = 5000): Promise<DirEntry[]> {
  const out: DirEntry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 8) return
    let entries: DirEntry[]
    try {
      entries = await listDir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.dir) await walk(e.path, depth + 1)
      else out.push(e)
    }
  }
  await walk(root, 0)
  return out
}

export async function searchFolder(
  root: string,
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean } = {}
): Promise<SearchHit[]> {
  if (!query.trim()) return []
  let source = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])${source}(?![\\p{L}\\p{N}_])`
  const re = new RegExp(source, opts.caseSensitive ? 'u' : 'iu')
  const hits: SearchHit[] = []
  for (const file of await listMarkdownFiles(root)) {
    if (hits.length >= 500) break
    if (file.size > 4 * 1024 * 1024) continue
    let text: string
    try {
      text = decode(await fs.readFile(file.path)).text
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < 500; i++) {
      if (re.test(lines[i])) hits.push({ path: file.path, line: i, text: lines[i].trim().slice(0, 200) })
    }
  }
  return hits
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** A path that does not exist yet, derived from `wanted` by appending a counter. */
export async function uniquePath(wanted: string): Promise<string> {
  if (!(await exists(wanted))) return wanted
  const ext = extname(wanted)
  const stem = wanted.slice(0, wanted.length - ext.length)
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!(await exists(candidate))) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

export async function createFile(dir: string, name: string): Promise<string> {
  const path = await uniquePath(join(dir, name))
  await fs.writeFile(path, '', { flag: 'wx' })
  return path
}

export async function createFolder(dir: string, name: string): Promise<string> {
  const path = await uniquePath(join(dir, name))
  await fs.mkdir(path)
  return path
}

export async function renamePath(path: string, newName: string): Promise<string> {
  const clean = newName.replace(/[\\/:*?"<>|]/g, '').trim()
  if (!clean) throw new Error(t('msg.nameEmpty'))
  const target = join(dirname(path), clean)
  if (target === path) return path
  if (await exists(target)) {
    // Renaming only the letter case of a name is fine on case-insensitive volumes.
    if (target.toLowerCase() !== path.toLowerCase()) throw new Error(t('msg.nameExists', { name: clean }))
  }
  await fs.rename(path, target)
  return target
}

/** Resolves the folder that inserted images are copied into. */
export function imageFolderFor(docPath: string, template: string, fallback: string): string {
  if (!docPath) return fallback
  const stem = basename(docPath, extname(docPath))
  const folder = template.replace(/\$\{filename\}/g, stem)
  return isAbsolute(folder) ? folder : resolve(dirname(docPath), folder)
}

export async function saveImageData(dir: string, name: string, data: Uint8Array): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const path = await uniquePath(join(dir, name.replace(/[\\/:*?"<>|]/g, '_')))
  await fs.writeFile(path, data)
  return path
}

export async function copyImageFile(src: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  if (resolve(dirname(src)).toLowerCase() === resolve(dir).toLowerCase()) return src
  const path = await uniquePath(join(dir, basename(src)))
  await fs.copyFile(src, path)
  return path
}
