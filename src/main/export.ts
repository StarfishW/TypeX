/**
 * Export and printing. HTML and PDF are produced from HTML the renderer has
 * already built; every other format is delegated to Pandoc when it is
 * installed.
 */
import { BrowserWindow, app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MessageKey } from '../shared/i18n'
import type { ExportFormat, ExportRequest, ExportResult } from '../shared/types'
import { t } from './i18n'

/** Export formats. `nameKey` names formats whose description is translated; the rest are proper names. */
const TARGETS: Record<ExportFormat, { name: string; nameKey?: MessageKey; ext: string; pandoc?: string }> = {
  html: { name: 'HTML', ext: 'html' },
  'html-plain': { name: 'HTML', ext: 'html' },
  pdf: { name: 'PDF', ext: 'pdf' },
  docx: { name: 'Word Document', nameKey: 'export.formatWord', ext: 'docx', pandoc: 'docx' },
  odt: { name: 'OpenDocument Text', nameKey: 'export.formatOdt', ext: 'odt', pandoc: 'odt' },
  rtf: { name: 'Rich Text Format', nameKey: 'export.formatRtf', ext: 'rtf', pandoc: 'rtf' },
  epub: { name: 'EPUB', ext: 'epub', pandoc: 'epub' },
  latex: { name: 'LaTeX', ext: 'tex', pandoc: 'latex' },
  rst: { name: 'reStructuredText', ext: 'rst', pandoc: 'rst' },
  mediawiki: { name: 'MediaWiki', ext: 'wiki', pandoc: 'mediawiki' },
  textile: { name: 'Textile', ext: 'textile', pandoc: 'textile' },
  opml: { name: 'OPML', ext: 'opml', pandoc: 'opml' }
}

function run(file: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : '') })
    })
  })
}

/**
 * Where Pandoc's installers put it. Apps started from Finder or a Linux
 * desktop get a minimal PATH that leaves out Homebrew and per-user folders, and
 * Windows only sees a PATH change made by the installer after logging in again.
 */
function pandocCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return ['pandoc', join(local, 'Pandoc', 'pandoc.exe'), join(process.env.ProgramFiles || 'C:\\Program Files', 'Pandoc', 'pandoc.exe')]
  }
  return [
    'pandoc',
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    '/usr/bin/pandoc',
    join(home, '.local', 'bin', 'pandoc'),
    join(home, '.cabal', 'bin', 'pandoc'),
    '/snap/bin/pandoc'
  ]
}

let pandocPath: string | null | undefined

/** The Pandoc executable, or null when it is not installed. */
async function findPandoc(): Promise<string | null> {
  if (pandocPath === undefined) {
    pandocPath = null
    for (const candidate of pandocCandidates()) {
      if ((await run(candidate, ['--version'])).code === 0) {
        pandocPath = candidate
        break
      }
    }
  }
  return pandocPath
}

export async function hasPandoc(): Promise<boolean> {
  return (await findPandoc()) !== null
}

/** Loads HTML into an off-screen window that cannot run scripts. */
async function withRenderWindow<T>(html: string, use: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'typex-export-'))
  const file = join(dir, 'document.html')
  await fs.writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true }
  })
  try {
    await win.loadFile(file)
    return await use(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function runExport(parent: BrowserWindow, req: ExportRequest): Promise<ExportResult> {
  const target = TARGETS[req.format]
  if (!target) return { ok: false, error: `Unknown export format: ${req.format}` }

  if (target.pandoc && !(await hasPandoc())) return { ok: false, error: t('export.needsPandoc') }

  const name = target.nameKey ? t(target.nameKey) : target.name
  const baseDir = req.docPath ? dirname(req.docPath) : app.getPath('documents')
  const fileName = `${req.title || t('doc.untitled')}.${target.ext}`
  let out: string
  if (process.env.TYPEX_TEST === '1' && process.env.TYPEX_EXPORT_DIR) {
    // Automated tests cannot drive a native save dialog.
    out = join(process.env.TYPEX_EXPORT_DIR, fileName)
  } else {
    const chosen = await dialog.showSaveDialog(parent, {
      title: t('export.title', { format: name }),
      defaultPath: join(baseDir, fileName),
      filters: [{ name, extensions: [target.ext] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    out = chosen.filePath
  }

  try {
    if (req.format === 'html' || req.format === 'html-plain') {
      await fs.writeFile(out, req.html || '', 'utf8')
    } else if (req.format === 'pdf') {
      const pdf = await withRenderWindow(req.html || '', (win) =>
        win.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          generateTaggedPDF: true,
          generateDocumentOutline: true
        })
      )
      await fs.writeFile(out, pdf)
    } else {
      const dir = await fs.mkdtemp(join(tmpdir(), 'typex-pandoc-'))
      const input = join(dir, 'input.md')
      try {
        await fs.writeFile(input, req.markdown || '', 'utf8')
        const args = [
          input,
          '-f',
          'gfm+tex_math_dollars+footnotes+yaml_metadata_block',
          '-t',
          target.pandoc!,
          '-s',
          '-o',
          out,
          '--resource-path',
          baseDir
        ]
        const res = await run((await findPandoc()) || 'pandoc', args, baseDir)
        if (res.code !== 0) return { ok: false, error: res.stderr.trim() || t('export.pandocExit', { code: res.code }) }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    return { ok: true, path: out }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function printHtml(html: string): Promise<ExportResult> {
  try {
    await withRenderWindow(
      html,
      (win) =>
        new Promise<void>((resolve) => {
          win.webContents.print({ printBackground: true }, () => resolve())
        })
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
