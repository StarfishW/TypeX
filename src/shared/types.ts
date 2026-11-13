/** Types shared by the main process, the preload bridge and the renderer. */
import type { Locale } from './i18n'

export interface Prefs {
  /** Interface language: a locale id from shared/i18n, or 'system' to follow the operating system. */
  language: string
  /** The language last chosen in the Windows installer, so a later change in Preferences is not overridden. */
  installerLanguage: string
  theme: string
  /** Base font size of the writing area, in pixels. */
  fontSize: number
  /** Maximum width of the writing column, in pixels (0 = theme default). */
  lineWidth: number
  autoSave: boolean
  /** What a fresh launch opens: an empty document or the last one. */
  startup: 'new' | 'restore'
  sidebar: boolean
  sidebarTab: 'outline' | 'files'
  sidebarWidth: number
  statusBar: boolean
  spellcheck: boolean
  autoPair: boolean
  /** Typing "/" opens a list of blocks to insert. */
  slashCommands: boolean
  inlineMath: boolean
  subscript: boolean
  superscript: boolean
  highlight: boolean
  codeLineNumbers: boolean
  codeWrap: boolean
  /** What to do with a local image when it is inserted. */
  imageAction: 'none' | 'copy'
  /** Folder images are copied to; may be relative to the document and use ${filename}. */
  imageFolder: string
  imageRelative: boolean
  /** Line ending used for new files; existing files keep their own. */
  eol: 'lf' | 'crlf'
  zoom: number
  recentFiles: string[]
  recentFolders: string[]
  lastFile: string
  lastFolder: string
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean }
}

export const DEFAULT_PREFS: Prefs = {
  language: 'system',
  installerLanguage: '',
  theme: 'daylight',
  fontSize: 16,
  lineWidth: 0,
  autoSave: false,
  startup: 'new',
  sidebar: false,
  sidebarTab: 'outline',
  sidebarWidth: 260,
  statusBar: true,
  spellcheck: true,
  autoPair: true,
  slashCommands: true,
  inlineMath: true,
  subscript: true,
  superscript: true,
  highlight: true,
  codeLineNumbers: false,
  codeWrap: true,
  imageAction: 'none',
  imageFolder: './assets',
  imageRelative: true,
  eol: 'lf',
  zoom: 1,
  recentFiles: [],
  recentFolders: [],
  lastFile: '',
  lastFolder: '',
  window: { width: 1040, height: 760, maximized: false }
}

export interface FileData {
  path: string
  content: string
  eol: '\n' | '\r\n'
  bom: boolean
  encoding: string
  mtime: number
}

export interface DirEntry {
  name: string
  path: string
  dir: boolean
  mtime: number
  size: number
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface ThemeInfo {
  id: string
  name: string
  /** Built-in themes ship with the app; user themes live in the themes folder. */
  builtin: boolean
  dark: boolean
}

export interface InitData {
  prefs: Prefs
  /** The interface language, resolved from the preference and the system languages. */
  locale: Locale
  filePath: string
  folder: string
  /** Text to show as an untitled document (used for the built-in help pages). */
  content: string
  /** `content` is unsaved work recovered after a crash; it replaces the file's text and is marked unsaved. */
  recovered: boolean
  /** A menu command to run once the window has started ('' for none). */
  command: string
  themes: ThemeInfo[]
  platform: string
  version: string
  versions: { electron: string; chrome: string; node: string }
  themesDir: string
  test: boolean
}

/** View state the renderer reports so the menu can show check marks. */
export interface MenuState {
  sidebar: boolean
  sidebarTab: 'outline' | 'files'
  sourceMode: boolean
  focusMode: boolean
  typewriter: boolean
  statusBar: boolean
  theme: string
  hasFile: boolean
  alwaysOnTop: boolean
}

export interface DocState {
  path: string
  dirty: boolean
  title: string
}

/** What the renderer tells the main process about the place that was right-clicked. */
export interface ContextInfo {
  area: 'editor' | 'source' | 'tree' | 'other'
  inTable: boolean
  inCode: boolean
  hasSelection: boolean
  /** Path of the file-tree entry under the pointer, when `area` is 'tree'. */
  path?: string
  dir?: boolean
}

export interface MessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export type ExportFormat =
  | 'html'
  | 'html-plain'
  | 'pdf'
  | 'docx'
  | 'odt'
  | 'rtf'
  | 'epub'
  | 'latex'
  | 'rst'
  | 'mediawiki'
  | 'textile'
  | 'opml'

export interface ExportRequest {
  format: ExportFormat
  /** Complete HTML document, for the html and pdf formats. */
  html?: string
  /** Markdown source, for formats that go through Pandoc. */
  markdown?: string
  docPath: string
  title: string
}

export interface ExportResult {
  ok: boolean
  path?: string
  error?: string
  canceled?: boolean
}

export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mmd', 'mdwn', 'mdtxt', 'text', 'txt']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff']
