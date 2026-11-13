/**
 * Application menu and context menus. Menu items do not act themselves: they
 * send a command id to the window's renderer, which owns the editor.
 *
 * Windows and Linux get a menu bar per window. macOS has one menu bar for the
 * whole application, led by the application menu, and follows its own
 * shortcut conventions (see shared/keys.ts). Labels come from the interface
 * language's catalog.
 */
import { Menu, app, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import type { MessageKey } from '../shared/i18n'
import { acceleratorFor } from '../shared/keys'
import type { ContextInfo, MenuState, Prefs, ThemeInfo } from '../shared/types'
import { t } from './i18n'

type Item = MenuItemConstructorOptions
export type Send = (command: string, arg?: unknown) => void

export interface MenuActions {
  send: Send
  setTheme: (id: string) => void
  zoom: (direction: -1 | 0 | 1) => void
  openRecent: (path: string) => void
  clearRecent: () => void
  /** macOS: a new window added as a tab of the current one. */
  newTab: () => void
  /** Used when no window is open (macOS keeps running without one). */
  newWindow: () => void
  openDialog: () => void
  openFolderDialog: () => void
}

const sep: Item = { type: 'separator' }

export { acceleratorFor }

/** What revealing a file in the system file manager is called on each platform. */
export const revealLabel = (platform: string): string =>
  t(platform === 'darwin' ? 'reveal.darwin' : platform === 'win32' ? 'reveal.win32' : 'reveal.linux')

/**
 * The menu template for `platform`. With no window (macOS only, after the
 * last window closes) it is the short menu that can open or create documents.
 */
export function menuTemplate(
  platform: string,
  win: BrowserWindow | null,
  state: MenuState,
  prefs: Prefs,
  themes: ThemeInfo[],
  actions: MenuActions
): Item[] {
  const mac = platform === 'darwin'
  const { send } = actions
  const appName = app.name
  const key = (id: string): string | undefined => acceleratorFor(id, platform)
  /** Top-level labels carry access keys (Alt+F) on Windows and Linux only; macOS shows them without. */
  const top = (k: MessageKey): string => {
    const label = t(k)
    return mac ? label.replace(/\s*\(&.\)/, '').replace('&', '') : label
  }

  /** A command with an accelerator registered by the menu. */
  const cmd = (k: MessageKey, id: string, extra: Item = {}): Item => ({
    label: t(k),
    accelerator: key(id),
    click: () => send(id),
    ...extra
  })
  /** A command whose key is handled inside the editor; the menu only displays it. */
  const shown = (k: MessageKey, id: string, extra: Item = {}): Item => cmd(k, id, { registerAccelerator: false, ...extra })
  const check = (k: MessageKey, id: string, checked: boolean): Item => ({
    label: t(k),
    accelerator: key(id),
    type: 'checkbox',
    checked,
    click: () => send(id)
  })

  const recent: Item[] = prefs.recentFiles.length
    ? [
        ...prefs.recentFiles.slice(0, 12).map(
          (path): Item => ({ label: mac ? path : path.replace(/&/g, '&&'), click: () => actions.openRecent(path) })
        ),
        sep,
        { label: t('file.clearRecent'), click: () => actions.clearRecent() }
      ]
    : [{ label: t('file.noRecent'), enabled: false }]

  const appMenu: Item = {
    label: appName,
    submenu: [
      { role: 'about', label: t('app.about', { app: appName }) },
      sep,
      {
        label: t('app.preferences'),
        accelerator: key('app.preferences'),
        click: () => (win ? send('app.preferences') : undefined),
        enabled: !!win
      },
      sep,
      { role: 'services', label: t('app.services') },
      sep,
      // ⌘H is Replace in Typora's macOS shortcuts, so Hide goes without one.
      { label: t('app.hide', { app: appName }), click: () => app.hide() },
      { role: 'hideOthers', label: t('app.hideOthers') },
      { role: 'unhide', label: t('app.showAll') },
      sep,
      { role: 'quit', label: t('app.quit', { app: appName }) }
    ]
  }

  // macOS adds the window list and the tab commands to a menu with the Window role.
  const windowMenu: Item = {
    label: top('menu.window'),
    role: 'window',
    submenu: [
      { role: 'minimize', label: t('window.minimize') },
      { role: 'zoom', label: t('window.zoom') },
      sep,
      { role: 'front', label: t('window.front') }
    ]
  }

  if (!win) {
    return [
      appMenu,
      {
        label: top('menu.file'),
        submenu: [
          { label: t('file.new'), accelerator: key('file.new'), click: () => actions.newWindow() },
          sep,
          { label: t('idle.open'), accelerator: key('file.open'), click: () => actions.openDialog() },
          { label: t('idle.openFolder'), click: () => actions.openFolderDialog() },
          { label: t('file.openRecent'), submenu: recent }
        ]
      },
      windowMenu
    ]
  }

  const hasFile = state.hasFile
  const exportItem = (label: string, format: string): Item => ({ label, click: () => send('file.export', format) })

  const file: Item = {
    label: top('menu.file'),
    submenu: [
      cmd('file.new', 'file.new'),
      cmd('file.newWindow', 'file.newWindow'),
      ...(mac ? [{ label: t('file.newTab'), accelerator: key('file.newTab'), click: () => actions.newTab() }] : []),
      sep,
      cmd('file.open', 'file.open'),
      cmd('file.openFolder', 'file.openFolder'),
      sep,
      cmd('file.quickOpen', 'file.quickOpen'),
      { label: t('file.openRecent'), submenu: recent },
      cmd('file.reopenClosed', 'file.reopenClosed'),
      sep,
      cmd('file.save', 'file.save'),
      cmd('file.saveAs', 'file.saveAs'),
      sep,
      cmd('file.rename', 'file.rename', { enabled: hasFile }),
      { label: `${revealLabel(platform)}...`, click: () => send('file.reveal'), enabled: hasFile },
      cmd(mac ? 'file.moveToTrash' : 'file.delete', 'file.delete', { enabled: hasFile }),
      sep,
      {
        label: t('file.export'),
        submenu: [
          exportItem('PDF', 'pdf'),
          exportItem('HTML', 'html'),
          exportItem(t('export.htmlPlain'), 'html-plain'),
          sep,
          exportItem(t('export.word'), 'docx'),
          exportItem('OpenOffice', 'odt'),
          exportItem('RTF', 'rtf'),
          exportItem('Epub', 'epub'),
          exportItem('LaTeX', 'latex'),
          exportItem('Media Wiki', 'mediawiki'),
          exportItem('reStructuredText', 'rst'),
          exportItem('Textile', 'textile'),
          exportItem('OPML', 'opml')
        ]
      },
      cmd('file.print', 'file.print'),
      // On macOS, Preferences lives in the application menu.
      ...(mac ? [] : [sep, cmd('file.preferences', 'app.preferences')]),
      sep,
      cmd('file.close', 'file.close')
    ]
  }

  const edit: Item = {
    label: top('menu.edit'),
    submenu: [
      shown('edit.undo', 'edit.undo'),
      shown('edit.redo', 'edit.redo'),
      sep,
      { label: t('edit.cut'), role: 'cut' },
      { label: t('edit.copy'), role: 'copy' },
      { label: t('edit.paste'), role: 'paste' },
      sep,
      cmd('edit.copyMarkdown', 'edit.copyMarkdown'),
      cmd('edit.copyHtml', 'edit.copyHtml'),
      shown('edit.pastePlain', 'edit.pastePlain'),
      sep,
      shown('edit.selectAll', 'edit.selectAll'),
      cmd('edit.selectLine', 'edit.selectLine'),
      cmd('edit.selectScope', 'edit.selectScope'),
      cmd('edit.selectWord', 'edit.selectWord'),
      sep,
      cmd('edit.deleteWord', 'edit.deleteWord'),
      sep,
      cmd('edit.jumpTop', 'edit.jumpTop'),
      cmd('edit.jumpSelection', 'edit.jumpSelection'),
      cmd('edit.jumpBottom', 'edit.jumpBottom'),
      sep,
      {
        label: t('edit.findAndReplace'),
        submenu: [
          cmd('edit.find', 'edit.find'),
          cmd('edit.findNext', 'edit.findNext'),
          cmd('edit.findPrevious', 'edit.findPrevious'),
          sep,
          cmd('edit.replace', 'edit.replace')
        ]
      }
    ]
  }

  const heading = (n: number): Item => ({
    label: t('paragraph.heading', { n }),
    accelerator: key(`paragraph.heading${n}`),
    click: () => send(`paragraph.heading${n}`)
  })

  const paragraph: Item = {
    label: top('menu.paragraph'),
    submenu: [
      ...[1, 2, 3, 4, 5, 6].map(heading),
      sep,
      cmd('paragraph.paragraph', 'paragraph.paragraph'),
      sep,
      cmd('paragraph.headingUp', 'paragraph.headingUp'),
      cmd('paragraph.headingDown', 'paragraph.headingDown'),
      sep,
      {
        label: t('paragraph.table'),
        submenu: [
          cmd('table.insert', 'table.insert'),
          sep,
          cmd('table.rowBefore', 'table.rowBefore'),
          shown('table.rowAfter', 'table.rowAfter'),
          sep,
          cmd('table.colBefore', 'table.colBefore'),
          cmd('table.colAfter', 'table.colAfter'),
          sep,
          shown('table.deleteRow', 'table.deleteRow'),
          cmd('table.deleteCol', 'table.deleteCol'),
          cmd('table.delete', 'table.delete'),
          sep,
          cmd('table.alignLeft', 'table.alignLeft'),
          cmd('table.alignCenter', 'table.alignCenter'),
          cmd('table.alignRight', 'table.alignRight')
        ]
      },
      cmd('paragraph.code', 'paragraph.code'),
      cmd('paragraph.math', 'paragraph.math'),
      sep,
      cmd('paragraph.quote', 'paragraph.quote'),
      sep,
      cmd('paragraph.orderedList', 'paragraph.orderedList'),
      cmd('paragraph.bulletList', 'paragraph.bulletList'),
      cmd('paragraph.taskList', 'paragraph.taskList'),
      {
        label: t('paragraph.listIndentation'),
        submenu: [cmd('paragraph.indent', 'paragraph.indent'), cmd('paragraph.outdent', 'paragraph.outdent')]
      },
      sep,
      cmd('paragraph.insertBefore', 'paragraph.insertBefore'),
      cmd('paragraph.insertAfter', 'paragraph.insertAfter'),
      sep,
      cmd('paragraph.linkReference', 'paragraph.linkReference'),
      cmd('paragraph.footnotes', 'paragraph.footnote'),
      sep,
      cmd('paragraph.hr', 'paragraph.hr'),
      cmd('paragraph.toc', 'paragraph.toc'),
      cmd('paragraph.frontMatter', 'paragraph.frontMatter')
    ]
  }

  const format: Item = {
    label: top('menu.format'),
    submenu: [
      shown('format.strong', 'format.strong'),
      shown('format.em', 'format.em'),
      shown('format.underline', 'format.underline'),
      cmd('format.code', 'format.code'),
      sep,
      cmd('format.del', 'format.del'),
      cmd('format.comment', 'format.comment'),
      sep,
      cmd('format.math', 'format.math'),
      cmd('format.sub', 'format.sub'),
      cmd('format.sup', 'format.sup'),
      cmd('format.mark', 'format.mark'),
      sep,
      cmd('format.link', 'format.link'),
      {
        label: t('format.image'),
        submenu: [cmd('format.insertImage', 'format.image'), cmd('format.insertLocalImages', 'format.imageLocal')]
      },
      sep,
      cmd('format.clear', 'format.clear')
    ]
  }

  const view: Item = {
    label: top('menu.view'),
    submenu: [
      check('view.sidebar', 'view.sidebar', state.sidebar),
      check('view.outline', 'view.outline', state.sidebar && state.sidebarTab === 'outline'),
      cmd('view.articles', 'view.articles'),
      check('view.files', 'view.files', state.sidebar && state.sidebarTab === 'files'),
      cmd('view.search', 'view.search'),
      sep,
      check('view.source', 'view.source', state.sourceMode),
      sep,
      check('view.focus', 'view.focus', state.focusMode),
      check('view.typewriter', 'view.typewriter', state.typewriter),
      sep,
      check('view.statusBar', 'view.statusBar', state.statusBar),
      sep,
      { label: t('view.fullscreen'), accelerator: key('view.fullscreen'), click: () => win.setFullScreen(!win.isFullScreen()) },
      check('view.alwaysOnTop', 'view.alwaysOnTop', state.alwaysOnTop),
      sep,
      { label: t('view.zoomReset'), accelerator: key('view.zoomReset'), click: () => actions.zoom(0) },
      { label: t('view.zoomIn'), accelerator: key('view.zoomIn'), click: () => actions.zoom(1) },
      { label: t('view.zoomOut'), accelerator: key('view.zoomOut'), click: () => actions.zoom(-1) },
      sep,
      cmd('view.switchWindow', 'view.switchWindow'),
      sep,
      { label: t('view.devtools'), accelerator: key('view.devtools'), click: () => win.webContents.toggleDevTools() }
    ]
  }

  const themeMenu: Item = {
    label: top('menu.themes'),
    submenu: themes.map(
      (theme): Item => ({
        label: theme.name,
        type: 'radio',
        checked: theme.id === state.theme,
        click: () => actions.setTheme(theme.id)
      })
    )
  }

  const help: Item = {
    label: top('menu.help'),
    // macOS adds its own search field to a menu with the Help role.
    ...(mac ? { role: 'help' as const } : {}),
    submenu: [
      cmd('help.quickStart', 'help.quickStart'),
      cmd('help.markdown', 'help.markdown'),
      sep,
      cmd('help.themeFolder', 'help.themeFolder'),
      // On macOS, About lives in the application menu.
      ...(mac ? [] : [sep, { label: t('app.about', { app: appName }), click: () => send('help.about') }])
    ]
  }

  return mac
    ? [appMenu, file, edit, paragraph, format, view, themeMenu, windowMenu, help]
    : [file, edit, paragraph, format, view, themeMenu, help]
}

export function buildMenu(...args: Parameters<typeof menuTemplate>): Menu {
  return Menu.buildFromTemplate(menuTemplate(...args))
}

export interface MenuSummary {
  label?: string
  role?: string
  accelerator?: string
  submenu?: MenuSummary[]
}

/** A template without its click handlers, for tests that inspect another platform's menu. */
export function summarizeMenu(items: Item[]): MenuSummary[] {
  return items
    .filter((i) => i.type !== 'separator')
    .map((i) => {
      const out: MenuSummary = {}
      if (i.label) out.label = i.label
      if (i.role) out.role = i.role
      if (i.accelerator) out.accelerator = String(i.accelerator)
      if (Array.isArray(i.submenu)) out.submenu = summarizeMenu(i.submenu as Item[])
      return out
    })
}

/** Builds the right-click menu for the place described by `info`. */
export function buildContextMenu(
  params: ContextMenuParams,
  info: ContextInfo | null,
  send: Send,
  replaceMisspelling: (word: string) => void
): Menu | null {
  const cmd = (k: MessageKey, id: string, arg?: unknown, extra: Item = {}): Item => ({
    label: t(k),
    click: () => send(id, arg),
    ...extra
  })
  const items: Item[] = []

  if (info?.area === 'tree') {
    const path = info.path || ''
    if (path && !info.dir) {
      items.push(cmd('ctx.open', 'tree.open', path), cmd('ctx.openNew', 'tree.openNew', path), sep)
    }
    items.push(cmd('ctx.newFile', 'tree.newFile', path), cmd('ctx.newFolder', 'tree.newFolder', path))
    if (path) {
      items.push(
        sep,
        cmd('ctx.rename', 'tree.rename', path),
        cmd(process.platform === 'darwin' ? 'ctx.moveToTrash' : 'ctx.delete', 'tree.delete', path),
        sep,
        cmd('ctx.copyPath', 'tree.copyPath', path),
        { label: revealLabel(process.platform), click: () => send('tree.reveal', path) }
      )
    }
    items.push(sep, cmd('ctx.refresh', 'tree.refresh'))
    return Menu.buildFromTemplate(items)
  }

  if (!params.isEditable && !params.selectionText) return null

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 6)
    for (const s of suggestions) items.push({ label: s, click: () => replaceMisspelling(s) })
    if (!suggestions.length) items.push({ label: t('ctx.noSuggestions'), enabled: false })
    items.push(sep)
  }

  items.push(
    { label: t('edit.cut'), role: 'cut', enabled: params.editFlags.canCut },
    { label: t('edit.copy'), role: 'copy', enabled: params.editFlags.canCopy },
    { label: t('edit.paste'), role: 'paste', enabled: params.editFlags.canPaste }
  )

  if (info?.area !== 'editor') return Menu.buildFromTemplate(items)

  items.push(
    cmd('edit.copyMarkdown', 'edit.copyMarkdown', undefined, { enabled: info.hasSelection }),
    cmd('edit.copyHtml', 'edit.copyHtml', undefined, { enabled: info.hasSelection }),
    cmd('edit.pastePlain', 'edit.pastePlain')
  )
  if (info.inCode) return Menu.buildFromTemplate(items)

  items.push(sep, {
    label: t('ctx.format'),
    submenu: [
      cmd('format.strong', 'format.strong'),
      cmd('format.em', 'format.em'),
      cmd('format.underline', 'format.underline'),
      cmd('format.code', 'format.code'),
      cmd('format.del', 'format.del'),
      cmd('format.mark', 'format.mark'),
      sep,
      cmd('format.link', 'format.link'),
      cmd('format.clear', 'format.clear')
    ]
  })

  if (info.inTable) {
    items.push({
      label: t('paragraph.table'),
      submenu: [
        cmd('table.rowBefore', 'table.rowBefore'),
        cmd('table.rowAfter', 'table.rowAfter'),
        sep,
        cmd('table.colBefore', 'table.colBefore'),
        cmd('table.colAfter', 'table.colAfter'),
        sep,
        cmd('table.alignLeft', 'table.alignLeft'),
        cmd('table.alignCenter', 'table.alignCenter'),
        cmd('table.alignRight', 'table.alignRight'),
        sep,
        cmd('table.deleteRow', 'table.deleteRow'),
        cmd('table.deleteCol', 'table.deleteCol'),
        cmd('table.delete', 'table.delete')
      ]
    })
  } else {
    items.push(
      {
        label: t('paragraph.paragraph'),
        submenu: [
          ...[1, 2, 3, 4, 5, 6].map(
            (n): Item => ({ label: t('paragraph.heading', { n }), click: () => send(`paragraph.heading${n}`) })
          ),
          cmd('paragraph.paragraph', 'paragraph.paragraph'),
          sep,
          cmd('paragraph.quote', 'paragraph.quote'),
          cmd('paragraph.orderedList', 'paragraph.orderedList'),
          cmd('paragraph.bulletList', 'paragraph.bulletList'),
          cmd('paragraph.taskList', 'paragraph.taskList')
        ]
      },
      {
        label: t('ctx.insert'),
        submenu: [
          cmd('ctx.image', 'format.image'),
          cmd('ctx.footnote', 'paragraph.footnote'),
          cmd('paragraph.linkReference', 'paragraph.linkReference'),
          cmd('paragraph.hr', 'paragraph.hr'),
          sep,
          cmd('ctx.table', 'table.insert'),
          cmd('paragraph.code', 'paragraph.code'),
          cmd('paragraph.math', 'paragraph.math'),
          cmd('paragraph.toc', 'paragraph.toc'),
          cmd('paragraph.frontMatter', 'paragraph.frontMatter'),
          sep,
          cmd('ctx.paragraphBefore', 'paragraph.insertBefore'),
          cmd('ctx.paragraphAfter', 'paragraph.insertAfter')
        ]
      }
    )
  }
  return Menu.buildFromTemplate(items)
}
