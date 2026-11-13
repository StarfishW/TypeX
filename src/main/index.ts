/**
 * Main process: application lifecycle, windows, and the IPC surface the
 * renderer uses for everything that needs the operating system.
 */
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import icon from '../../resources/icon.png?asset'
import {
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  type ContextInfo,
  type DocState,
  type ExportRequest,
  type InitData,
  type MenuState,
  type MessageOptions,
  type Prefs
} from '../shared/types'
import { draftFileFor, removeDraft, saveDraft, takeLeftoverDrafts } from './drafts'
import { applyLocale, currentLocale, t } from './i18n'
import { hasPandoc, printHtml, runExport } from './export'
import {
  copyImageFile,
  createFile,
  createFolder,
  exists,
  imageFolderFor,
  listDir,
  listMarkdownFiles,
  readDoc,
  renamePath,
  saveImageData,
  searchFolder,
  writeDoc
} from './files'
import { buildContextMenu, buildMenu, menuTemplate, summarizeMenu, type MenuActions } from './menu'
import {
  addRecentFile,
  addRecentFolder,
  flushPrefs,
  getPrefs,
  listThemes,
  loadPrefs,
  onPrefsChanged,
  readTheme,
  themesDir,
  updatePrefs
} from './prefs'

const TEST = process.env.TYPEX_TEST === '1'
const MAC = process.platform === 'darwin'
/** Set while the application is quitting, so closing a window after a save prompt carries the quit on. */
let quitting = false
if (process.env.TYPEX_USER_DATA) app.setPath('userData', process.env.TYPEX_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'typex-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

interface WinState {
  win: BrowserWindow
  /** Path of the document shown in the window ('' while untitled). */
  path: string
  dirty: boolean
  ready: boolean
  forceClose: boolean
  initialPath: string
  initialFolder: string
  initialContent: string
  /** The initial content is unsaved work recovered from a session that did not close cleanly. */
  recovered: boolean
  /** A command the window runs once it has started. */
  initialCommand: string
  draftFile: string
  menu: MenuState
  /** Modification times of files as this window last read or wrote them. */
  mtimes: Map<string, number>
  docWatcher: FSWatcher | null
  watchedDoc: string
  folderWatcher: FSWatcher | null
  watchedFolder: string
}

const windows = new Map<number, WinState>()
const closedFiles: string[] = []

/** File types that execute code when opened with their default program. */
const UNSAFE_EXTENSIONS = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'ws', 'scr', 'pif', 'cpl', 'hta', 'jar', 'lnk', 'reg', 'inf', 'url', 'scf', 'application', 'appref-ms', 'msc',
  'gadget', 'settingcontent-ms', 'library-ms', 'sh', 'bash', 'zsh', 'command', 'app', 'py', 'pyw', 'pl', 'rb',
  'appx', 'msix', 'appxbundle', 'msixbundle', 'diagcab', 'chm', 'iso', 'img', 'vhd', 'vhdx'
])

// Windows and macOS file systems ignore letter case by default; Linux does not.
const samePath = (a: string, b: string): boolean =>
  process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()

const stateOfWindow = (win: BrowserWindow | null | undefined): WinState | undefined => {
  if (!win || win.isDestroyed()) return undefined
  return windows.get(win.webContents.id)
}

function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/* ---------------------------------- menus --------------------------------- */

function actionsFor(st: WinState): MenuActions {
  return {
    send: (command, arg) => send(st.win, 'command', command, arg),
    setTheme: (id) => updatePrefs({ theme: id }),
    zoom: (direction) => {
      const current = getPrefs().zoom
      const next = direction === 0 ? 1 : Math.min(3, Math.max(0.5, Math.round((current + direction * 0.1) * 10) / 10))
      updatePrefs({ zoom: next })
    },
    openRecent: (path) => openPath(path, st.win),
    clearRecent: () => updatePrefs({ recentFiles: [] }),
    newTab: () => newTab(st.win),
    newWindow: () => void createWindow(),
    openDialog: () => void openWithDialog(st.win),
    openFolderDialog: () => void openFolderWithDialog(st.win)
  }
}

/** Menu actions while no window is open (macOS only). */
function idleActions(): MenuActions {
  return {
    send: () => {},
    setTheme: (id) => updatePrefs({ theme: id }),
    zoom: () => {},
    openRecent: (path) => openPath(path),
    clearRecent: () => updatePrefs({ recentFiles: [] }),
    newTab: () => void createWindow(),
    newWindow: () => void createWindow(),
    openDialog: () => void openWithDialog(null),
    openFolderDialog: () => void openFolderWithDialog(null)
  }
}

function defaultMenuState(prefs: Prefs): MenuState {
  return {
    sidebar: prefs.sidebar,
    sidebarTab: prefs.sidebarTab,
    sourceMode: false,
    focusMode: false,
    typewriter: false,
    statusBar: prefs.statusBar,
    theme: prefs.theme,
    hasFile: false,
    alwaysOnTop: false
  }
}

function refreshMenu(st: WinState): void {
  if (st.win.isDestroyed()) return
  const prefs = getPrefs()
  const menu = buildMenu(process.platform, st.win, { ...st.menu, theme: prefs.theme }, prefs, listThemes(), actionsFor(st))
  if (MAC) {
    // macOS has one menu bar for the whole application; it follows the focused window.
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused === st.win) Menu.setApplicationMenu(menu)
  } else {
    st.win.setMenu(menu)
  }
}

/** macOS keeps running with no window open; this menu can still open or create documents. */
function setIdleMenu(): void {
  const prefs = getPrefs()
  Menu.setApplicationMenu(buildMenu('darwin', null, defaultMenuState(prefs), prefs, listThemes(), idleActions()))
}

async function openWithDialog(parent: BrowserWindow | null): Promise<void> {
  const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>, filters: mdFilters() }
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (!res.canceled) for (const path of res.filePaths) openPath(path, parent)
}

async function openFolderWithDialog(parent: BrowserWindow | null): Promise<void> {
  const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (!res.canceled && res.filePaths.length) openPath(res.filePaths[0], parent)
}

/** macOS: opens a new window as a tab of `parent`. */
function newTab(parent: BrowserWindow): void {
  const win = createWindow()
  if (MAC && !parent.isDestroyed()) parent.addTabbedWindow(win)
}

/* --------------------------------- watching ------------------------------- */

function watchDoc(st: WinState): void {
  if (st.watchedDoc === st.path) return
  st.docWatcher?.close()
  st.docWatcher = null
  st.watchedDoc = st.path
  if (!st.path) return
  const path = st.path
  const base = basename(path).toLowerCase()
  let timer: NodeJS.Timeout | null = null
  try {
    // Watching the folder (not the file) survives editors that save by replacing the file.
    st.docWatcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== base) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          const mtime = statSync(path).mtimeMs
          if (mtime !== st.mtimes.get(path)) {
            st.mtimes.set(path, mtime)
            send(st.win, 'file-changed', path)
          }
        } catch {
          /* the file was removed; the open document simply stays in memory */
        }
      }, 200)
    })
  } catch {
    st.docWatcher = null
  }
}

function watchFolder(st: WinState, folder: string): void {
  if (st.watchedFolder === folder) return
  st.folderWatcher?.close()
  st.folderWatcher = null
  st.watchedFolder = folder
  if (!folder) return
  let timer: NodeJS.Timeout | null = null
  try {
    st.folderWatcher = watch(folder, { persistent: false, recursive: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => send(st.win, 'folder-changed', folder), 400)
    })
  } catch {
    st.folderWatcher = null
  }
}

/* --------------------------------- windows -------------------------------- */

function initialBounds(): { width: number; height: number; x?: number; y?: number } {
  const b = getPrefs().window
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    const [x, y] = focused.getPosition()
    const [width, height] = focused.isMaximized() ? [b.width, b.height] : focused.getSize()
    return { width, height, x: x + 30, y: y + 30 }
  }
  const out: { width: number; height: number; x?: number; y?: number } = { width: b.width, height: b.height }
  if (b.x != null && b.y != null) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width - 100 && b.y! < a.y + a.height - 100
    })
    if (visible) {
      out.x = b.x
      out.y = b.y
    }
  }
  return out
}

function createWindow(
  opts: { file?: string; folder?: string; content?: string; recovered?: boolean; command?: string } = {}
): BrowserWindow {
  const prefs = getPrefs()
  const hadFocused = !!BrowserWindow.getFocusedWindow()
  const win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'TypeX',
    icon,
    backgroundColor: '#ffffff',
    // macOS: windows of the app can be merged into native tabs.
    tabbingIdentifier: 'typex',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: prefs.spellcheck,
      backgroundThrottling: !TEST
    }
  })

  const st: WinState = {
    win,
    path: '',
    dirty: false,
    ready: false,
    forceClose: false,
    initialPath: opts.file || '',
    initialFolder: opts.folder || '',
    initialContent: opts.content || '',
    recovered: !!opts.recovered,
    initialCommand: opts.command || '',
    draftFile: draftFileFor(win.webContents.id),
    menu: defaultMenuState(prefs),
    mtimes: new Map(),
    docWatcher: null,
    watchedDoc: '',
    folderWatcher: null,
    watchedFolder: ''
  }
  const id = win.webContents.id
  windows.set(id, st)
  refreshMenu(st)

  win.once('ready-to-show', () => {
    if (prefs.window.maximized && !hadFocused && !TEST) win.maximize()
    if (TEST) win.showInactive()
    else win.show()
  })

  let boundsTimer: NodeJS.Timeout | null = null
  const rememberBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      const maximized = win.isMaximized()
      const current = getPrefs().window
      if (maximized) {
        updatePrefs({ window: { ...current, maximized: true } }, false)
      } else {
        const [width, height] = win.getSize()
        const [x, y] = win.getPosition()
        updatePrefs({ window: { width, height, x, y, maximized: false } }, false)
      }
    }, 500)
  }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)
  if (MAC) win.on('focus', () => refreshMenu(st))

  win.on('close', (event) => {
    if (st.forceClose || !st.ready) return
    if (st.dirty) {
      event.preventDefault()
      send(win, 'request-close')
    }
  })
  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    st.docWatcher?.close()
    st.folderWatcher?.close()
    if (st.path) closedFiles.push(st.path)
    // The window closed in an orderly way, so there is nothing left to recover.
    removeDraft(st.draftFile)
    windows.delete(id)
    if (MAC && windows.size === 0 && !quitting) setIdleMenu()
  })

  const contents = win.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    event.preventDefault()
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  })
  contents.on('did-finish-load', () => contents.setZoomFactor(getPrefs().zoom))
  contents.on('context-menu', (_event, params) => {
    void (async () => {
      let info: ContextInfo | null = null
      try {
        info = (await contents.executeJavaScript(
          `window.__typexContext ? window.__typexContext(${Math.round(params.x)}, ${Math.round(params.y)}) : null`
        )) as ContextInfo | null
      } catch {
        info = null
      }
      const menu = buildContextMenu(
        params,
        info,
        (command, arg) => send(win, 'command', command, arg),
        (word) => contents.replaceMisspelling(word)
      )
      if (TEST) {
        // A native popup would block an automated run; record what it would have shown.
        const labels = (m: Electron.Menu | null): unknown[] =>
          m ? m.items.map((i) => (i.submenu ? { [i.label]: labels(i.submenu) } : i.type === 'separator' ? '-' : i.label)) : []
        ;(globalThis as { __typexLastContextMenu?: unknown }).__typexLastContextMenu = labels(menu)
        return
      }
      if (menu && !win.isDestroyed()) menu.popup({ window: win })
    })()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * Opens a file or folder. A file that is already open is focused; an untouched
 * untitled window is reused; otherwise the file gets a window of its own.
 */
function openPath(target: string, from?: BrowserWindow | null, forceNew = false): void {
  const path = resolve(target)
  let isDir = false
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    /* the path does not exist yet; it is opened as a new file */
  }
  const origin = stateOfWindow(from) || stateOfWindow(BrowserWindow.getFocusedWindow())

  if (isDir) {
    addRecentFolder(path)
    if (origin && origin.ready) send(origin.win, 'open-folder', path)
    else createWindow({ folder: path })
    return
  }
  for (const st of windows.values()) {
    if (st.path && samePath(st.path, path)) {
      focusWindow(st.win)
      return
    }
  }
  if (!forceNew && origin && origin.ready && !origin.path && !origin.dirty) {
    send(origin.win, 'open-file', path)
    focusWindow(origin.win)
    return
  }
  createWindow({ file: path })
}

function pathsFromArgv(argv: string[], cwd: string): string[] {
  const appPath = resolve(app.getAppPath())
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const p = resolve(cwd, arg)
    if (samePath(p, appPath) || samePath(p, resolve(appPath, 'out/main/index.js'))) continue
    if (!existsSync(p)) continue
    const ext = extname(p).slice(1).toLowerCase()
    let dir = false
    try {
      dir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (dir || MARKDOWN_EXTENSIONS.includes(ext) || ext === '') out.push(p)
  }
  return out
}

/* ----------------------------------- IPC ---------------------------------- */

function handle<A extends unknown[], R>(channel: string, fn: (st: WinState, ...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const st = windows.get(event.sender.id)
    if (!st) throw new Error('Request from an unknown window')
    return fn(st, ...(args as A))
  })
}

const mdFilters = (): Electron.FileFilter[] => [
  { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS },
  { name: t('dialog.allFiles'), extensions: ['*'] }
]

function registerIpc(): void {
  handle('app:init', (st): InitData => {
    st.ready = true
    const data: InitData = {
      prefs: getPrefs(),
      locale: currentLocale(),
      filePath: st.initialPath,
      folder: st.initialFolder,
      content: st.initialContent,
      recovered: st.recovered,
      command: st.initialCommand,
      themes: listThemes(),
      platform: process.platform,
      version: app.getVersion(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      themesDir: themesDir(),
      test: TEST
    }
    // A window reloads itself (to switch language, for instance); one-time startup actions stay done.
    st.initialCommand = ''
    st.recovered = false
    return data
  })
  handle('app:pandoc', () => hasPandoc())

  handle('dialog:open', async (st) => {
    const res = await dialog.showOpenDialog(st.win, { properties: ['openFile', 'multiSelections'], filters: mdFilters() })
    return res.canceled ? null : res.filePaths
  })
  handle('dialog:openFolder', async (st) => {
    const res = await dialog.showOpenDialog(st.win, { properties: ['openDirectory'] })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  })
  handle('dialog:save', async (st, defaultPath: string) => {
    // Automated tests cannot drive native dialogs; they supply the answers instead.
    if (TEST && process.env.TYPEX_SAVE_PATH) return process.env.TYPEX_SAVE_PATH
    const res = await dialog.showSaveDialog(st.win, {
      defaultPath: isAbsolute(defaultPath || '') ? defaultPath : join(app.getPath('documents'), defaultPath || 'Untitled.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }, ...mdFilters().slice(1)]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
  handle('dialog:images', async (st) => {
    const res = await dialog.showOpenDialog(st.win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dialog.images'), extensions: IMAGE_EXTENSIONS }]
    })
    return res.canceled ? null : res.filePaths
  })
  handle('dialog:message', async (st, opts: MessageOptions) => {
    if (TEST && process.env.TYPEX_DIALOG_RESPONSE) return Number(process.env.TYPEX_DIALOG_RESPONSE)
    const res = await dialog.showMessageBox(st.win, { noLink: true, ...opts })
    return res.response
  })

  handle('fs:read', async (st, path: string) => {
    const data = await readDoc(path)
    st.mtimes.set(resolve(path), data.mtime)
    return data
  })
  handle('fs:write', async (st, path: string, content: string, opts: { eol: '\n' | '\r\n'; bom: boolean }) => {
    const res = await writeDoc(path, content, opts)
    st.mtimes.set(resolve(path), res.mtime)
    addRecentFile(path)
    return res
  })
  handle('fs:list', (_st, dir: string) => listDir(dir))
  handle('fs:listAll', (_st, root: string) => listMarkdownFiles(root))
  handle('fs:search', (_st, root: string, query: string, opts: { caseSensitive?: boolean; wholeWord?: boolean }) =>
    searchFolder(root, query, opts)
  )
  handle('fs:exists', (_st, path: string) => exists(path))
  handle('fs:create', (_st, dir: string, name: string) => createFile(dir, name))
  handle('fs:mkdir', (_st, dir: string, name: string) => createFolder(dir, name))
  handle('fs:rename', (_st, path: string, newName: string) => renamePath(path, newName))
  handle('fs:trash', (_st, path: string) => shell.trashItem(path))
  handle('fs:watchFolder', (st, folder: string) => {
    watchFolder(st, folder)
    if (folder) addRecentFolder(folder)
  })

  handle('win:doc', (st, doc: DocState) => {
    st.path = doc.path ? resolve(doc.path) : ''
    st.dirty = doc.dirty
    if (!st.win.isDestroyed()) {
      st.win.setTitle(MAC ? doc.title : `${doc.title}${doc.dirty ? ' •' : ''} - TypeX`)
      if (process.platform === 'darwin') {
        st.win.setRepresentedFilename(st.path)
        st.win.setDocumentEdited(doc.dirty)
      }
    }
    if (st.path) addRecentFile(st.path)
    watchDoc(st)
  })
  handle('win:menu', (st, menu: MenuState) => {
    st.menu = menu
    refreshMenu(st)
  })
  handle('win:open', (st, path: string, newWindow: boolean) => openPath(path, st.win, newWindow))
  handle('win:new', () => {
    createWindow()
  })
  handle('win:newWith', (_st, content: string) => {
    createWindow({ content })
  })
  handle('win:close', (st) => {
    st.forceClose = true
    st.win.close()
    // The window held up a quit to ask about unsaved changes; carry the quit on.
    if (quitting) setImmediate(() => app.quit())
  })
  handle('win:closeCanceled', () => {
    quitting = false
  })
  handle('win:reload', (st) => {
    if (!st.win.isDestroyed()) st.win.webContents.reload()
  })
  handle('win:alwaysOnTop', (st, on: boolean) => st.win.setAlwaysOnTop(on))
  handle('win:switch', (st) => {
    const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (all.length < 2) return
    const i = all.indexOf(st.win)
    focusWindow(all[(i + 1) % all.length])
  })
  handle('win:reopenClosed', (st) => {
    while (closedFiles.length) {
      const path = closedFiles.pop()!
      if (existsSync(path)) {
        openPath(path, st.win)
        return
      }
    }
  })

  handle('prefs:set', (_st, patch: Partial<Prefs>) => updatePrefs(patch))
  handle('themes:list', () => listThemes())
  handle('themes:read', (_st, id: string) => readTheme(id))
  handle('themes:openFolder', () => shell.openPath(themesDir()))

  handle('shell:openExternal', async (_st, url: string) => {
    if (/^(https?:|mailto:)/i.test(url)) await shell.openExternal(url)
  })
  handle('shell:reveal', (_st, path: string) => shell.showItemInFolder(path))
  // A document can link to any local file. Opening one that runs code would let
  // a downloaded document start a program with a single click, so such files
  // are only shown in their folder.
  handle('shell:openPath', async (_st, path: string) => {
    // On macOS and Linux a program needs no extension, only permission to run.
    let executable = false
    if (process.platform !== 'win32') {
      try {
        const info = statSync(path)
        executable = info.isFile() && (info.mode & 0o111) !== 0
      } catch {
        /* a missing file is reported by openPath itself */
      }
    }
    if (executable || UNSAFE_EXTENSIONS.has(extname(path).slice(1).toLowerCase())) {
      shell.showItemInFolder(path)
      return 'shown'
    }
    return shell.openPath(path)
  })

  handle('clipboard:readText', () => clipboard.readText())
  handle('clipboard:write', async (_st, data: { text?: string; html?: string }) => {
    const entries: Record<string, string> = {}
    if (data.text != null) entries['text/plain'] = data.text
    if (data.html != null) entries['text/html'] = data.html
    await clipboard.write([new ClipboardItem(entries)])
  })

  handle('image:save', async (_st, req: { data: Uint8Array; name: string; docPath: string }) => {
    const prefs = getPrefs()
    const fallback = join(app.getPath('userData'), 'images')
    const dir =
      prefs.imageAction === 'copy' && req.docPath ? imageFolderFor(req.docPath, prefs.imageFolder, fallback) : fallback
    return saveImageData(dir, req.name, req.data)
  })
  handle('image:import', async (_st, req: { src: string; docPath: string }) => {
    const prefs = getPrefs()
    if (prefs.imageAction !== 'copy' || !req.docPath) return req.src
    return copyImageFile(req.src, imageFolderFor(req.docPath, prefs.imageFolder, dirname(req.docPath)))
  })

  handle('draft:save', (st, content: string) => saveDraft(st.draftFile, { path: st.path, content, time: Date.now() }))
  handle('draft:clear', (st) => removeDraft(st.draftFile))

  handle('export:run', (st, req: ExportRequest) => runExport(st.win, req))
  handle('export:print', (_st, html: string) => printHtml(html))
}

/* -------------------------------- language -------------------------------- */

/**
 * The Windows installer records the language chosen at its start (see
 * build/installer.nsh). A new choice becomes the interface language; changing
 * the language in Preferences afterwards sticks until the next installation.
 */
function applyInstallerLanguage(): void {
  if (!app.isPackaged || process.platform !== 'win32') return
  let chosen: string
  try {
    chosen = readFileSync(join(process.resourcesPath, 'installer-language.txt'), 'utf8').trim()
  } catch {
    return
  }
  if (!chosen || chosen === getPrefs().installerLanguage) return
  updatePrefs({ language: chosen, installerLanguage: chosen }, false)
}

/** macOS: the About panel and the Dock menu, in the current language. */
function setMacAppInfo(): void {
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 TypeX contributors',
    credits: t('about.description')
  })
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: t('file.newWindow'), click: () => createWindow() }]))
}

/* -------------------------------- lifecycle ------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const paths = pathsFromArgv(argv, cwd)
    if (paths.length) for (const p of paths) openPath(p)
    else {
      const any = BrowserWindow.getAllWindows()[0]
      if (any) focusWindow(any)
      else createWindow()
    }
  })

  // macOS delivers files opened from Finder or dropped on the Dock icon as
  // events rather than command-line arguments, possibly before 'ready'.
  const pendingOpen: string[] = []
  let started = false
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (started) openPath(path)
    else pendingOpen.push(path)
  })

  void app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('app.typex.editor')

    protocol.handle('typex-file', async (request) => {
      try {
        const url = new URL(request.url)
        const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
        return await net.fetch(pathToFileURL(path).toString())
      } catch {
        return new Response(null, { status: 404 })
      }
    })

    loadPrefs()
    applyInstallerLanguage()
    const prefs = getPrefs()
    let language = prefs.language
    applyLocale(language)
    session.defaultSession.setSpellCheckerEnabled(prefs.spellcheck)
    registerIpc()
    if (MAC) {
      setIdleMenu()
      setMacAppInfo()
    }

    if (TEST) {
      // Lets the test suite inspect the menu of another platform.
      ;(globalThis as { __typexMenuTemplate?: unknown }).__typexMenuTemplate = (platform: string, idle = false) => {
        const st = [...windows.values()][0]
        const p = getPrefs()
        const template = menuTemplate(
          platform,
          idle || !st ? null : st.win,
          st ? st.menu : defaultMenuState(p),
          p,
          listThemes(),
          st ? actionsFor(st) : idleActions()
        )
        return summarizeMenu(template)
      }
    }

    onPrefsChanged((next) => {
      session.defaultSession.setSpellCheckerEnabled(next.spellcheck)
      if (next.language !== language) {
        // Menus follow at once; each window reloads its interface when it sees the change.
        language = next.language
        applyLocale(language)
        if (MAC) {
          setMacAppInfo()
          if (windows.size === 0) setIdleMenu()
        }
      }
      for (const st of windows.values()) {
        send(st.win, 'prefs-changed', next)
        if (!st.win.isDestroyed()) st.win.webContents.setZoomFactor(next.zoom)
        refreshMenu(st)
      }
    })

    // Unsaved work from a session that ended abnormally comes back first.
    for (const draft of takeLeftoverDrafts()) {
      createWindow({ file: draft.path || undefined, content: draft.content, recovered: true })
    }
    const recoveredAny = windows.size > 0

    const paths = [...pendingOpen.filter((p) => existsSync(p)), ...pathsFromArgv(process.argv, process.cwd())]
    const files = paths.filter((p) => !statSync(p).isDirectory())
    const folder = paths.find((p) => statSync(p).isDirectory())
    if (files.length) {
      files.forEach((file, i) => createWindow({ file, folder: i === 0 ? folder : undefined }))
    } else if (folder) {
      createWindow({ folder })
    } else if (recoveredAny) {
      // The recovered windows are the session; nothing else needs opening.
    } else if (prefs.startup === 'restore' && prefs.lastFile && existsSync(prefs.lastFile)) {
      createWindow({ file: prefs.lastFile, folder: prefs.lastFolder && existsSync(prefs.lastFolder) ? prefs.lastFolder : undefined })
    } else {
      createWindow()
    }
    started = true

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    flushPrefs()
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
    flushPrefs()
  })
}
