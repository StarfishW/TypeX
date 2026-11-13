/** Typed wrapper around the preload bridge. */
import type {
  ContextInfo,
  DirEntry,
  DocState,
  ExportRequest,
  ExportResult,
  FileData,
  InitData,
  MenuState,
  MessageOptions,
  Prefs,
  SearchHit,
  ThemeInfo
} from '../../shared/types'

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, listener: (...args: any[]) => void): () => void
  pathForFile(file: File): string
}

declare global {
  interface Window {
    typex: Bridge
    __typexContext?: (x: number, y: number) => ContextInfo | null
    /** Test hook: the running application instance. */
    __typexApp?: unknown
  }
}

/**
 * Errors from the main process arrive as "Error invoking remote method 'x': Error: message".
 * Only the message is meant for people, and it is already in their language.
 */
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  (window.typex.invoke(channel, ...args) as Promise<T>).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
  })

export const api = {
  init: () => call<InitData>('app:init'),
  hasPandoc: () => call<boolean>('app:pandoc'),

  openDialog: () => call<string[] | null>('dialog:open'),
  openFolderDialog: () => call<string | null>('dialog:openFolder'),
  saveDialog: (defaultPath: string) => call<string | null>('dialog:save', defaultPath),
  imagesDialog: () => call<string[] | null>('dialog:images'),
  message: (opts: MessageOptions) => call<number>('dialog:message', opts),

  read: (path: string) => call<FileData>('fs:read', path),
  write: (path: string, content: string, opts: { eol: '\n' | '\r\n'; bom: boolean }) =>
    call<{ mtime: number }>('fs:write', path, content, opts),
  list: (dir: string) => call<DirEntry[]>('fs:list', dir),
  listAll: (root: string) => call<DirEntry[]>('fs:listAll', root),
  search: (root: string, query: string, opts: { caseSensitive?: boolean; wholeWord?: boolean }) =>
    call<SearchHit[]>('fs:search', root, query, opts),
  exists: (path: string) => call<boolean>('fs:exists', path),
  createFile: (dir: string, name: string) => call<string>('fs:create', dir, name),
  createFolder: (dir: string, name: string) => call<string>('fs:mkdir', dir, name),
  rename: (path: string, newName: string) => call<string>('fs:rename', path, newName),
  trash: (path: string) => call<void>('fs:trash', path),
  watchFolder: (folder: string) => call<void>('fs:watchFolder', folder),

  setDoc: (doc: DocState) => call<void>('win:doc', doc),
  setMenu: (menu: MenuState) => call<void>('win:menu', menu),
  open: (path: string, newWindow = false) => call<void>('win:open', path, newWindow),
  newWindow: () => call<void>('win:new'),
  newWindowWith: (content: string) => call<void>('win:newWith', content),
  closeWindow: () => call<void>('win:close'),
  /** Reloads this window's page (used to switch the interface language). */
  reloadWindow: () => call<void>('win:reload'),
  /** The user kept the window open when asked about unsaved changes (this also stops a quit in progress). */
  closeCanceled: () => call<void>('win:closeCanceled'),
  alwaysOnTop: (on: boolean) => call<void>('win:alwaysOnTop', on),
  switchWindow: () => call<void>('win:switch'),
  reopenClosed: () => call<void>('win:reopenClosed'),

  setPrefs: (patch: Partial<Prefs>) => call<Prefs>('prefs:set', patch),
  listThemes: () => call<ThemeInfo[]>('themes:list'),
  readTheme: (id: string) => call<string>('themes:read', id),
  openThemesFolder: () => call<void>('themes:openFolder'),

  openExternal: (url: string) => call<void>('shell:openExternal', url),
  reveal: (path: string) => call<void>('shell:reveal', path),
  openPath: (path: string) => call<string>('shell:openPath', path),

  readClipboard: () => call<string>('clipboard:readText'),
  writeClipboard: (data: { text?: string; html?: string }) => call<void>('clipboard:write', data),

  saveImage: (req: { data: Uint8Array; name: string; docPath: string }) => call<string>('image:save', req),
  importImage: (req: { src: string; docPath: string }) => call<string>('image:import', req),

  saveDraft: (content: string) => call<void>('draft:save', content),
  clearDraft: () => call<void>('draft:clear'),

  exportDoc: (req: ExportRequest) => call<ExportResult>('export:run', req),
  print: (html: string) => call<ExportResult>('export:print', html),

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (channel: string, listener: (...args: any[]) => void): (() => void) => window.typex.on(channel, listener),
  pathForFile: (file: File): string => window.typex.pathForFile(file)
}
