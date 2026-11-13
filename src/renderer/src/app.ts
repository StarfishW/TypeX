/**
 * Application controller for one window: owns the document, the two editors
 * (live preview and source), the chrome around them, and the command table
 * that menus, shortcuts and buttons all go through.
 */
import { selectAll } from 'prosemirror-commands'
import { liftListItem, sinkListItem } from 'prosemirror-schema-list'
import type { Command } from 'prosemirror-state'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable
} from 'prosemirror-tables'
import {
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  type ContextInfo,
  type ExportFormat,
  type ExportRequest,
  type FileData,
  type InitData,
  type Prefs,
  type ThemeInfo
} from '../../shared/types'
import { api } from './api'
import { insertMarkdown, selectionHtml, selectionMarkdown } from './editor/clipboard'
import * as ed from './editor/commands'
import { Editor, countText, type TextStats } from './editor/editor'
import { basename, dirname, env, extname, isAbsolutePath, joinPath, relativePath, samePath } from './editor/env'
import { pairOptions } from './editor/keymap'
import { parseMarkdown } from './editor/markdown'
import { loadMath } from './editor/math'
import { codeOptions } from './editor/nodeviews'
import { schema } from './editor/schema'
import { replaceAll, replaceCurrent, searchInfo, searchStep, setSearch } from './editor/search'
import { buildExportHtml } from './exporter'
import markdownReference from './help/markdown-reference.md?raw'
import quickStart from './help/quick-start.md?raw'
import { forPlatform } from './help/shortcuts'
import { currentLocale, setLocale, shortcut, t, tp } from './i18n'
import { SourceEditor } from './source'
import './styles/app.css'
import './styles/content.css'
import chalk from './styles/themes/chalk.css?inline'
import daylight from './styles/themes/daylight.css?inline'
import latte from './styles/themes/latte.css?inline'
import midnight from './styles/themes/midnight.css?inline'
import newsroom from './styles/themes/newsroom.css?inline'
import { aboutDialog, hasOverlay, promptDialog, quickOpenDialog, tableDialog, type QuickItem } from './ui/dialogs'
import { debounce, h, iconButton } from './ui/dom'
import { FindBar, type FindTarget } from './ui/findbar'
import { closePreferences, currentPrefsSection, openPreferences, prefsOpen } from './ui/prefs'
import { Sidebar } from './ui/sidebar'

const BUILTIN_CSS: Record<string, string> = { daylight, newsroom, midnight, latte, chalk }

interface DocInfo {
  path: string
  dirty: boolean
  eol: '\n' | '\r\n'
  bom: boolean
}

type CommandFn = (arg?: unknown) => unknown

/**
 * What a window keeps when it reloads itself in another language: the
 * document exactly as it is (saved or not), and where the user was.
 */
interface ReloadState {
  path: string
  text: string
  dirty: boolean
  eol: '\n' | '\r\n'
  bom: boolean
  folder: string
  sourceMode: boolean
  focusMode: boolean
  typewriter: boolean
  scrollTop: number
  anchor: number
  head: number
  prefsSection: string | null
}

const RELOAD_KEY = 'typex-reload-state'

function takeReloadState(): ReloadState | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY)
    sessionStorage.removeItem(RELOAD_KEY)
    return raw ? (JSON.parse(raw) as ReloadState) : null
  } catch {
    return null
  }
}

const slug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')

export class App {
  private init!: InitData
  private prefs!: Prefs
  private themes: ThemeInfo[] = []
  private editor!: Editor
  private source: SourceEditor | null = null
  private sidebar!: Sidebar
  private findbar!: FindBar
  private readonly commands: Record<string, CommandFn> = {}

  private doc: DocInfo = { path: '', dirty: false, eol: '\n', bom: false }
  private sourceMode = false
  private focusMode = false
  private typewriter = false
  private alwaysOnTop = false
  private themeCss = ''

  private writeEl!: HTMLElement
  private scrollEl!: HTMLElement
  private sourceEl!: HTMLElement
  private noticeEl!: HTMLElement
  private toastEl!: HTMLElement
  private tableBar!: HTMLElement
  private wordsEl!: HTMLElement
  private statsEl!: HTMLElement
  private sourceBtn!: HTMLButtonElement
  private themeStyle!: HTMLStyleElement
  private toastTimer = 0
  private autoSaveTimer = 0
  /** Preferences section to reopen once a reload for a language change has finished. */
  private reopenPrefs: string | null = null

  /* --------------------------------- startup -------------------------------- */

  async start(): Promise<void> {
    this.init = await api.init()
    setLocale(this.init.locale, this.init.platform)
    env.caseInsensitivePaths = this.init.platform !== 'linux'
    this.prefs = this.init.prefs
    this.themes = this.init.themes
    this.buildLayout()

    this.editor = new Editor(this.writeEl, {
      onChange: () => this.onEdit(),
      onSelection: () => this.onSelection(),
      onHeadings: (headings) => this.sidebar.setOutline(headings),
      onImages: (files) => void this.insertImageFiles(files),
      onDropFiles: (files, pos) => void this.handleDrop(files, pos)
    })
    env.openLink = (href) => void this.openLink(href)
    env.pastePlain = () => this.run('edit.pastePlain')

    this.registerCommands()
    this.registerEvents()
    await this.applyPrefs(this.prefs, true)

    const reloaded = takeReloadState()
    if (reloaded) {
      await this.restoreReloadState(reloaded)
    } else {
      if (this.init.folder) await this.sidebar.setFolder(this.init.folder)
      if (this.init.filePath) {
        await this.openFile(this.init.filePath)
      } else {
        this.newDocument(this.init.recovered ? '' : this.init.content)
      }
      if (this.init.recovered) {
        this.loadText(this.init.content)
        this.setDirty(true)
        this.saveDraft()
        this.showNotice(t('msg.recovered'), [[t('button.ok'), () => this.closeNotice()]])
      }
    }
    this.syncMenu()
    this.editor.focus()
    window.setTimeout(() => void loadMath(), 300)
    if (this.init.command) this.run(this.init.command)
    if (this.reopenPrefs) this.showPreferences(this.reopenPrefs)
  }

  /** Reloads the window so its interface appears in the new language; the document stays as it is. */
  private reloadInterface(): void {
    const { selection } = this.editor.view.state
    const state: ReloadState = {
      path: this.doc.path,
      text: this.getText(),
      dirty: this.doc.dirty,
      eol: this.doc.eol,
      bom: this.doc.bom,
      folder: this.sidebar.folder,
      sourceMode: this.sourceMode,
      focusMode: this.focusMode,
      typewriter: this.typewriter,
      scrollTop: this.scrollEl.scrollTop,
      anchor: selection.anchor,
      head: selection.head,
      prefsSection: currentPrefsSection()
    }
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(state))
    } catch {
      // Without somewhere to keep the document, reloading could lose unsaved work;
      // the menus have switched already and the rest follows on the next start.
      return
    }
    // The main process blocks navigation started by the page, so it does the reload.
    void api.reloadWindow()
  }

  private async restoreReloadState(s: ReloadState): Promise<void> {
    if (s.folder) await this.sidebar.setFolder(s.folder)
    this.doc = { path: s.path, dirty: s.dirty, eol: s.eol, bom: s.bom }
    env.docPath = s.path
    this.loadText(s.text)
    if (s.sourceMode) {
      this.toggleSource()
      // The exact text, not a re-serialization of it.
      this.source?.setText(s.text)
    } else {
      this.editor.restoreSelection(s.anchor, s.head)
      requestAnimationFrame(() => (this.scrollEl.scrollTop = s.scrollTop))
    }
    if (s.focusMode) this.run('view.focus')
    if (s.typewriter) this.run('view.typewriter')
    this.pushDocState()
    if (s.path) this.sidebar.setActiveFile(s.path)
    this.reopenPrefs = s.prefsSection
  }

  private buildLayout(): void {
    const root = document.getElementById('app')!
    const sidebarEl = h('aside', { id: 'sidebar' })
    const resizer = h('div', { id: 'sidebar-resizer' })
    this.noticeEl = h('div', { id: 'notice' })
    const findEl = h('div', { id: 'findbar' })
    this.writeEl = h('div', { id: 'write' })
    this.scrollEl = h('div', { id: 'editor-scroll' }, this.writeEl)
    this.sourceEl = h('div', { id: 'source' })

    this.sourceBtn = iconButton('code', t('status.sourceMode', { key: shortcut('view.source') }), () => this.run('view.source'))
    this.wordsEl = h('span', { class: 'status-item', title: t('status.wordCount') }, tp('status.words', 0))
    this.statsEl = h('div', { id: 'stats-popover' })
    this.wordsEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.statsEl.classList.toggle('open')
    })
    const statusbar = h(
      'footer',
      { id: 'statusbar' },
      h(
        'div',
        { class: 'status-group' },
        iconButton('sidebar', t('status.toggleSidebar', { key: shortcut('view.sidebar') }), () => this.run('view.sidebar')),
        this.sourceBtn
      ),
      h('div', { class: 'status-group' }, this.wordsEl)
    )

    const divider = (): HTMLElement => h('span', { class: 'divider' })
    this.tableBar = h(
      'div',
      { id: 'table-toolbar' },
      iconButton('alignLeft', t('table.alignLeft'), () => this.run('table.alignLeft')),
      iconButton('alignCenter', t('table.alignCenter'), () => this.run('table.alignCenter')),
      iconButton('alignRight', t('table.alignRight'), () => this.run('table.alignRight')),
      divider(),
      iconButton('rowAdd', t('toolbar.rowAfter', { key: shortcut('table.rowAfter') }), () => this.run('table.rowAfter')),
      iconButton('colAdd', t('table.colAfter'), () => this.run('table.colAfter')),
      divider(),
      iconButton('rowDelete', t('table.deleteRow'), () => this.run('table.deleteRow')),
      iconButton('colDelete', t('table.deleteCol'), () => this.run('table.deleteCol')),
      iconButton('trash', t('table.delete'), () => this.run('table.delete'))
    )

    const content = h(
      'main',
      { id: 'content' },
      this.noticeEl,
      findEl,
      this.scrollEl,
      this.sourceEl,
      this.tableBar,
      this.statsEl,
      statusbar
    )
    root.append(sidebarEl, resizer, content)

    this.toastEl = h('div', { id: 'toast' })
    this.themeStyle = h('style', { id: 'typex-theme' })
    document.body.append(this.toastEl, this.themeStyle)

    this.sidebar = new Sidebar(sidebarEl, {
      openFile: (path, newWindow) => (newWindow ? void api.open(path, true) : void this.openInPlace(path)),
      revealHeading: (pos) => this.revealHeading(pos),
      chooseFolder: () => this.run('file.openFolder'),
      openHit: (path, query) => void this.openInPlace(path).then(() => this.findbar.search(query)),
      toast: (message) => this.toast(message),
      onLayout: () => this.syncMenu()
    })
    this.findbar = new FindBar(findEl, () => this.findTarget())

    // Sidebar resizing
    resizer.addEventListener('mousedown', (down) => {
      down.preventDefault()
      const move = (e: MouseEvent): void => {
        const width = Math.max(180, Math.min(520, e.clientX))
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
      }
      const up = (e: MouseEvent): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        void api.setPrefs({ sidebarWidth: Math.max(180, Math.min(520, e.clientX)) })
        this.updateTableToolbar()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  private registerEvents(): void {
    api.on('command', (id: string, arg?: unknown) => this.run(id, arg))
    api.on('open-file', (path: string) => void this.openInPlace(path))
    api.on('open-folder', (path: string) => {
      void this.sidebar.setFolder(path)
      this.setSidebar(true, 'files')
    })
    api.on('file-changed', (path: string) => void this.onFileChanged(path))
    api.on('folder-changed', () => void this.sidebar.refresh())
    api.on('prefs-changed', (prefs: Prefs) => void this.applyPrefs(prefs))
    api.on('request-close', () => void this.closeWindow())

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') document.body.classList.add('ctrl-down')
      // An Escape the editor already used (to close a suggestion list) stops there.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (this.statsEl.classList.contains('open')) this.statsEl.classList.remove('open')
        else if (this.findbar.isOpen && !hasOverlay()) this.findbar.close()
      }
    })
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') document.body.classList.remove('ctrl-down')
    })
    window.addEventListener('blur', () => document.body.classList.remove('ctrl-down'))
    document.addEventListener('click', () => this.statsEl.classList.remove('open'))

    // Dropping a file anywhere outside the editor opens it rather than navigating the window.
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length || this.writeEl.contains(e.target as Node)) return
      e.preventDefault()
      for (const file of Array.from(e.dataTransfer.files)) {
        const path = api.pathForFile(file)
        if (path) void api.open(path)
      }
    })

    this.scrollEl.addEventListener('scroll', () => this.updateTableToolbar(), { passive: true })
    window.addEventListener('resize', () => this.updateTableToolbar())

    window.__typexContext = (x, y) => this.contextAt(x, y)
  }

  /* --------------------------------- settings ------------------------------- */

  private async applyPrefs(prefs: Prefs, first = false): Promise<void> {
    const prev = this.prefs
    this.prefs = prefs
    if (!first && prev.language !== prefs.language) {
      this.reloadInterface()
      return
    }
    const root = document.documentElement
    root.style.setProperty('--font-size', `${prefs.fontSize}px`)
    if (prefs.lineWidth > 0) root.style.setProperty('--write-width', `${prefs.lineWidth}px`)
    else root.style.removeProperty('--write-width')
    document.body.classList.toggle('no-statusbar', !prefs.statusBar)

    pairOptions.enabled = prefs.autoPair
    codeOptions.lineNumbers = prefs.codeLineNumbers
    codeOptions.lineWrapping = prefs.codeWrap
    this.editor.setSpellcheck(prefs.spellcheck)

    const inline = { math: prefs.inlineMath, sub: prefs.subscript, sup: prefs.superscript, mark: prefs.highlight }
    const inlineChanged = JSON.stringify(inline) !== JSON.stringify(env.inline)
    env.inline = inline

    if (first || prev.theme !== prefs.theme) await this.applyTheme(prefs.theme)
    if (inlineChanged && !first) this.editor.refresh()

    if (first) {
      root.style.setProperty('--sidebar-width', `${prefs.sidebarWidth}px`)
      document.body.classList.toggle('sidebar-open', prefs.sidebar)
      this.sidebar.setTab(prefs.sidebarTab)
    }
    this.syncMenu()
  }

  private async applyTheme(id: string): Promise<void> {
    const info = this.themes.find((t) => t.id === id) || this.themes[0]
    let css = ''
    if (info) {
      if (info.builtin) css = BUILTIN_CSS[info.id] || ''
      else {
        try {
          css = await api.readTheme(info.id)
        } catch {
          css = ''
        }
      }
    }
    this.themeCss = css
    this.themeStyle.textContent = css
    // Keep the theme last in the document so it wins over the base styles.
    document.body.appendChild(this.themeStyle)
    env.dark = !!info?.dark
    document.documentElement.classList.toggle('dark', env.dark)
  }

  private syncMenu(): void {
    // Called from component constructors too, before everything is wired up.
    if (!this.prefs || !this.sidebar || !this.editor) return
    this.sourceBtn?.classList.toggle('active', this.sourceMode)
    void api.setMenu({
      sidebar: document.body.classList.contains('sidebar-open'),
      sidebarTab: this.sidebar.tab,
      sourceMode: this.sourceMode,
      focusMode: this.focusMode,
      typewriter: this.typewriter,
      statusBar: this.prefs.statusBar,
      theme: this.prefs.theme,
      hasFile: !!this.doc.path,
      alwaysOnTop: this.alwaysOnTop
    })
  }

  private setSidebar(open: boolean, tab?: 'outline' | 'files'): void {
    document.body.classList.toggle('sidebar-open', open)
    if (tab) this.sidebar.setTab(tab)
    void api.setPrefs({ sidebar: open, sidebarTab: this.sidebar.tab })
    this.syncMenu()
    this.updateTableToolbar()
  }

  private toggleSidebarTab(tab: 'outline' | 'files'): void {
    const open = document.body.classList.contains('sidebar-open')
    if (open && this.sidebar.tab === tab) this.setSidebar(false)
    else this.setSidebar(true, tab)
  }

  /* --------------------------------- document ------------------------------- */

  private title(): string {
    return this.doc.path ? basename(this.doc.path) : t('doc.untitled')
  }

  private pushDocState(): void {
    void api.setDoc({ path: this.doc.path, dirty: this.doc.dirty, title: this.title() })
    // Nothing unsaved means nothing to recover.
    if (!this.doc.dirty) void api.clearDraft()
  }

  /** Mirrors unsaved text to a draft file so it survives a crash or power loss. */
  private readonly saveDraft = debounce(() => {
    if (this.doc.dirty) void api.saveDraft(this.getText())
  }, 2000)

  private setDirty(dirty: boolean): void {
    if (this.doc.dirty === dirty) return
    this.doc.dirty = dirty
    this.pushDocState()
  }

  /** The document as Markdown text, from whichever editor is active. */
  getText(): string {
    return this.sourceMode && this.source ? this.source.getText() : this.editor.getMarkdown()
  }

  private loadText(text: string): void {
    if (this.sourceMode && this.source) this.source.setText(text)
    else this.editor.setMarkdown(text)
    this.scrollEl.scrollTop = 0
    this.updateStats()
    this.updateTableToolbar()
  }

  private newDocument(content = ''): void {
    this.doc = { path: '', dirty: false, eol: this.prefs.eol === 'crlf' ? '\r\n' : '\n', bom: false }
    env.docPath = ''
    this.loadText(content)
    this.pushDocState()
    this.sidebar.setActiveFile('')
    this.closeNotice()
    this.syncMenu()
  }

  async openFile(path: string): Promise<void> {
    let data: FileData | null = null
    try {
      data = await api.read(path)
    } catch (err) {
      if (await api.exists(path)) {
        this.toast(t('msg.openFailed', { name: basename(path), error: err instanceof Error ? err.message : String(err) }))
        return
      }
    }
    this.doc = {
      path,
      dirty: false,
      eol: data ? data.eol : this.prefs.eol === 'crlf' ? '\r\n' : '\n',
      bom: data ? data.bom : false
    }
    env.docPath = path
    this.loadText(data ? data.content : '')
    this.pushDocState()
    if (!this.sidebar.folder) await this.sidebar.setFolder(dirname(path))
    this.sidebar.setActiveFile(path)
    this.closeNotice()
    this.syncMenu()
    if (this.sourceMode) this.source?.focus()
    else this.editor.focus()
    if (data && data.encoding !== 'utf-8') {
      this.toast(t('msg.readAs', { encoding: data.encoding.toUpperCase() }))
    }
  }

  /** Opens a file in this window, after giving the user a chance to save the current one. */
  private async openInPlace(path: string): Promise<void> {
    if (this.doc.path && samePath(this.doc.path, path)) return
    if (!(await this.ensureSaved())) return
    await this.openFile(path)
  }

  private suggestName(): string {
    const text = this.getText()
    const line = text.split('\n').find((l) => l.replace(/^#+\s*/, '').trim() && !/^(---|```|\$\$)/.test(l))
    const name = (line || '')
      .replace(/^#+\s*/, '')
      .replace(/[\\/:*?"<>|#*_`[\]]/g, '')
      .trim()
      .slice(0, 60)
    return name || t('doc.untitled')
  }

  async save(): Promise<boolean> {
    if (!this.doc.path) return this.saveAs()
    try {
      await api.write(this.doc.path, this.getText(), { eol: this.doc.eol, bom: this.doc.bom })
    } catch (err) {
      await api.message({
        type: 'error',
        message: t('msg.saveFailed'),
        detail: err instanceof Error ? err.message : String(err),
        buttons: [t('button.ok')]
      })
      return false
    }
    this.doc.dirty = false
    this.pushDocState()
    return true
  }

  async saveAs(): Promise<boolean> {
    const base = this.doc.path || joinPath(this.sidebar.folder || '', `${this.suggestName()}.md`)
    const chosen = await api.saveDialog(this.doc.path ? base : this.sidebar.folder ? base : `${this.suggestName()}.md`)
    if (!chosen) return false
    const path = /\.[^\\/.]+$/.test(chosen) ? chosen : `${chosen}.md`
    const previous = this.doc.path
    this.doc.path = path
    env.docPath = path
    if (!(await this.save())) {
      this.doc.path = previous
      env.docPath = previous
      return false
    }
    // Relative image paths now resolve against the new location.
    if (!this.sourceMode) this.editor.refresh()
    if (!this.sidebar.folder) await this.sidebar.setFolder(dirname(path))
    await this.sidebar.refresh()
    this.sidebar.setActiveFile(path)
    this.syncMenu()
    return true
  }

  /** Resolves to false when the user cancels; true when it is safe to discard the document. */
  private async ensureSaved(): Promise<boolean> {
    if (!this.doc.dirty) return true
    const choice = await api.message({
      type: 'question',
      message: t('msg.saveChanges', { name: this.title() }),
      detail: t('msg.saveChangesDetail'),
      buttons: [t('button.save'), t('button.dontSave'), t('button.cancel')],
      defaultId: 0,
      cancelId: 2
    })
    if (choice === 0) return this.save()
    return choice === 1
  }

  private async closeWindow(): Promise<void> {
    if (await this.ensureSaved()) await api.closeWindow()
    else await api.closeCanceled()
  }

  private onEdit(): void {
    this.setDirty(true)
    this.saveDraft()
    this.updateStats()
    this.refreshFindCount()
    if (this.prefs.autoSave && this.doc.path) {
      window.clearTimeout(this.autoSaveTimer)
      this.autoSaveTimer = window.setTimeout(() => {
        if (this.doc.dirty && this.doc.path) void this.save()
      }, 1500)
    }
  }

  private onSelection(): void {
    this.updateStats()
    this.sidebar.setActivePosition(this.editor.view.state.selection.head)
    requestAnimationFrame(() => this.updateTableToolbar())
  }

  private async onFileChanged(path: string): Promise<void> {
    if (!this.doc.path || !samePath(path, this.doc.path)) return
    let data: FileData
    try {
      data = await api.read(this.doc.path)
    } catch {
      return
    }
    const disk = data.content.replace(/\r\n?/g, '\n')
    if (disk === this.getText()) return
    const reload = (): void => {
      const top = this.scrollEl.scrollTop
      this.doc.eol = data.eol
      this.doc.bom = data.bom
      this.loadText(data.content)
      this.scrollEl.scrollTop = top
      this.doc.dirty = false
      this.pushDocState()
      this.closeNotice()
    }
    if (!this.doc.dirty) {
      reload()
      return
    }
    this.showNotice(t('msg.changedOnDisk', { name: this.title() }), [
      [t('button.reload'), reload],
      [t('button.keepMine'), () => this.closeNotice()]
    ])
  }

  /* ----------------------------------- modes -------------------------------- */

  private toggleSource(): void {
    if (!this.sourceMode) {
      const text = this.editor.getMarkdown()
      const lines = this.editor.blockLines()
      const index = this.editor.topBlockIndex()
      if (!this.source) {
        this.source = new SourceEditor(this.sourceEl, {
          onChange: () => this.onEdit(),
          onSelection: () => this.updateStats()
        })
      }
      this.source.setText(text)
      this.sourceMode = true
      document.body.classList.add('source-mode')
      this.source.gotoLine(lines[index] ?? 0)
      this.source.focus()
    } else if (this.source) {
      const text = this.source.getText()
      const line = this.source.currentLine()
      this.sourceMode = false
      document.body.classList.remove('source-mode')
      const lines = this.editor.setMarkdown(text)
      let index = 0
      for (let i = 0; i < lines.length; i++) if (lines[i] <= line) index = i
      this.editor.focusTopBlock(index)
      this.editor.focus()
    }
    if (this.findbar.isOpen) this.findbar.reapply()
    this.updateStats()
    this.updateTableToolbar()
    this.syncMenu()
  }

  private findTarget(): FindTarget {
    if (this.sourceMode && this.source) {
      const source = this.source
      let replacement = ''
      return {
        setSearch: (query, repl) => {
          replacement = repl
          source.setSearch(query, repl)
        },
        step: (dir) => source.searchStep(dir),
        replace: (repl) => {
          if (repl !== replacement) return
          source.replaceCurrent()
        },
        replaceAll: (repl) => {
          if (repl !== replacement) return
          source.replaceAll()
        },
        info: () => source.searchInfo(),
        focus: () => source.focus()
      }
    }
    const view = this.editor.view
    return {
      setSearch: (query) => setSearch(view, query),
      step: (dir) => void searchStep(view, dir),
      replace: (repl) => void replaceCurrent(view, repl),
      replaceAll: (repl) => void replaceAll(view, repl),
      info: () => searchInfo(view.state),
      focus: () => view.focus()
    }
  }

  private readonly refreshFindCount = debounce(() => this.findbar.updateCount(), 150)

  /* ---------------------------------- status -------------------------------- */

  private readonly updateStats = debounce(() => {
    let total: TextStats
    let selection: TextStats | null = null
    if (this.sourceMode && this.source) {
      const text = this.source.getText()
      const c = countText(text)
      total = { words: c.words, chars: c.chars, lines: text ? text.split('\n').length : 0 }
      if (this.source.hasSelection()) {
        const sel = this.source.selectedText()
        const s = countText(sel)
        selection = { words: s.words, chars: s.chars, lines: sel.split('\n').length }
      }
    } else {
      ;({ total, selection } = this.editor.stats())
    }
    const fmt = (n: number): string => n.toLocaleString(currentLocale())
    this.wordsEl.textContent = selection
      ? tp('status.selectedWords', total.words, { selected: fmt(selection.words), n: fmt(total.words) })
      : tp('status.words', total.words, { n: fmt(total.words) })
    const minutes = total.words ? Math.max(1, Math.round(total.words / 250)) : 0
    const rows: [string, string][] = [
      [t('stats.words'), fmt(total.words)],
      [t('stats.characters'), fmt(total.chars)],
      [t('stats.lines'), fmt(total.lines)],
      [t('stats.readingTime'), t('stats.minutes', { n: fmt(minutes) })]
    ]
    if (selection) {
      rows.push([t('stats.selectedWords'), fmt(selection.words)], [t('stats.selectedCharacters'), fmt(selection.chars)])
    }
    this.statsEl.replaceChildren(
      ...rows.map(([k, v]) => h('div', { class: 'stats-row' }, h('span', null, k), h('span', null, v)))
    )
  }, 200)

  private updateTableToolbar(): void {
    const bar = this.tableBar
    if (this.sourceMode || !this.editor.context().inTable) {
      bar.classList.remove('open')
      return
    }
    const table = this.writeEl.querySelector<HTMLElement>('table.md-focus')
    if (!table) {
      bar.classList.remove('open')
      return
    }
    const host = bar.parentElement!.getBoundingClientRect()
    const scroll = this.scrollEl.getBoundingClientRect()
    const rect = table.getBoundingClientRect()
    if (rect.bottom < scroll.top + 20 || rect.top > scroll.bottom - 20) {
      bar.classList.remove('open')
      return
    }
    const top = Math.max(rect.top - 38, scroll.top + 4)
    bar.style.top = `${top - host.top}px`
    bar.style.left = `${Math.max(rect.left - host.left, 8)}px`
    bar.classList.add('open')
  }

  private showNotice(text: string, actions: [string, () => void][]): void {
    this.noticeEl.replaceChildren(
      h('span', { class: 'notice-text' }, text),
      ...actions.map(([label, fn]) => h('button', { class: 'text-button', type: 'button', onclick: fn }, label))
    )
    this.noticeEl.classList.add('open')
  }

  private closeNotice(): void {
    this.noticeEl.classList.remove('open')
  }

  toast(message: string): void {
    this.toastEl.textContent = message
    this.toastEl.classList.add('show')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 3200)
  }

  private contextAt(x: number, y: number): ContextInfo | null {
    const target = document.elementFromPoint(x, y)
    if (!target) return null
    const tree = this.sidebar.contextAt(target)
    if (tree) return tree
    if (this.writeEl.contains(target)) {
      const ctx = this.editor.contextAtCoords(x, y)
      return { area: 'editor', inTable: ctx.inTable, inCode: ctx.inCode, hasSelection: ctx.hasSelection }
    }
    if (this.sourceEl.contains(target)) {
      return { area: 'source', inTable: false, inCode: false, hasSelection: !!this.source?.hasSelection() }
    }
    return { area: 'other', inTable: false, inCode: false, hasSelection: false }
  }

  /* --------------------------------- navigation ----------------------------- */

  private revealHeading(pos: number): void {
    if (this.sourceMode && this.source) {
      const headings = this.editor.headings()
      const index = headings.findIndex((x) => x.pos === pos)
      // The outline reflects the last live-preview state; find the heading by its order in the source.
      const lines = this.source.getText().split('\n')
      let seen = -1
      let inFence = false
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
        if (!inFence && /^#{1,6}\s/.test(lines[i]) && ++seen === index) {
          this.source.gotoLine(i)
          this.source.focus()
          return
        }
      }
      return
    }
    this.editor.revealBlock(pos)
  }

  private async openLink(href: string): Promise<void> {
    if (href.startsWith('#')) {
      let target = href.slice(1)
      try {
        target = decodeURIComponent(target)
      } catch {
        /* use the literal fragment */
      }
      const wanted = slug(target)
      const hit = this.editor.headings().find((x) => slug(x.text) === wanted)
      if (hit) this.editor.revealBlock(hit.pos)
      else this.toast(t('msg.noHeading', { name: target }))
      return
    }
    if (/^(https?:|mailto:)/i.test(href)) return api.openExternal(href)
    if (/^www\./i.test(href)) return api.openExternal('http://' + href)

    let path = href.replace(/^file:\/\/\/?/i, '').split('#')[0]
    try {
      path = decodeURIComponent(path)
    } catch {
      /* keep the literal path */
    }
    const abs = isAbsolutePath(path) ? path : this.doc.path ? joinPath(dirname(this.doc.path), path) : ''
    if (!abs) {
      this.toast(t('msg.saveFirst'))
      return
    }
    if (!(await api.exists(abs))) {
      this.toast(t('msg.fileNotFound', { path: abs }))
      return
    }
    if (MARKDOWN_EXTENSIONS.includes(extname(abs).slice(1).toLowerCase())) await api.open(abs)
    else {
      const res = await api.openPath(abs)
      if (res === 'shown') this.toast(t('msg.programShown'))
      else if (res) this.toast(res)
    }
  }

  /* ----------------------------------- images ------------------------------- */

  /** The path to write into the document for an image stored at `abs`. */
  private imageRef(abs: string): string {
    let ref = abs.replace(/\\/g, '/')
    if (this.prefs.imageRelative && this.doc.path) {
      const rel = relativePath(dirname(this.doc.path), abs)
      if (!isAbsolutePath(rel) && !rel.startsWith('../../../')) ref = rel
    }
    return ref.replace(/ /g, '%20')
  }

  private insertText(text: string, pos?: number): void {
    if (this.sourceMode && this.source) this.source.insert(text)
    else this.editor.insertAt(text, pos)
  }

  private async insertImageFiles(files: File[], pos?: number): Promise<void> {
    const parts: string[] = []
    for (const file of files) {
      try {
        let path = api.pathForFile(file)
        let alt = ''
        if (path) {
          alt = basename(path).replace(/\.[^.]+$/, '')
          path = await api.importImage({ src: path, docPath: this.doc.path })
        } else {
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
          const name = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : `image-${stamp}.${ext}`
          const data = new Uint8Array(await file.arrayBuffer())
          path = await api.saveImage({ data, name, docPath: this.doc.path })
        }
        parts.push(`![${alt}](${this.imageRef(path)})`)
      } catch (err) {
        this.toast(t('msg.imageFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    }
    if (parts.length) this.insertText(parts.join('\n'), pos)
  }

  private async insertImagePaths(paths: string[]): Promise<void> {
    const parts: string[] = []
    for (const src of paths) {
      try {
        const path = await api.importImage({ src, docPath: this.doc.path })
        parts.push(`![${basename(src).replace(/\.[^.]+$/, '')}](${this.imageRef(path)})`)
      } catch (err) {
        this.toast(t('msg.imageFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    }
    if (parts.length) this.insertText(parts.join('\n'))
  }

  private async handleDrop(files: File[], pos: number): Promise<void> {
    const images: File[] = []
    for (const file of files) {
      const path = api.pathForFile(file)
      const ext = extname(path || file.name).slice(1).toLowerCase()
      if (IMAGE_EXTENSIONS.includes(ext) || file.type.startsWith('image/')) images.push(file)
      else if (path && MARKDOWN_EXTENSIONS.includes(ext)) void api.open(path)
      else if (path) this.editor.insertAt(`[${file.name}](${this.imageRef(path)})`, pos)
    }
    if (images.length) await this.insertImageFiles(images, pos)
  }

  /* ----------------------------------- export ------------------------------- */

  private exportStyles(): string {
    const overrides = [`--font-size: ${this.prefs.fontSize}px;`]
    if (this.prefs.lineWidth > 0) overrides.push(`--write-width: ${this.prefs.lineWidth}px;`)
    return `${this.themeCss}\n:root { ${overrides.join(' ')} }`
  }

  private currentDoc(): ReturnType<typeof parseMarkdown>['doc'] {
    return this.sourceMode && this.source ? parseMarkdown(this.source.getText()).doc : this.editor.doc
  }

  private exportTitle(): string {
    return this.doc.path ? basename(this.doc.path).replace(/\.[^.]+$/, '') : this.suggestName()
  }

  /** The standalone HTML document used by HTML and PDF export and by printing. */
  exportHtml(styled = true, absoluteImages = false): Promise<string> {
    return buildExportHtml(this.currentDoc(), {
      title: this.exportTitle(),
      themeCss: this.exportStyles(),
      styled,
      absoluteImages
    })
  }

  private async exportDoc(format: ExportFormat): Promise<void> {
    const title = this.exportTitle()
    const req: ExportRequest = { format, docPath: this.doc.path, title }
    if (format === 'html' || format === 'html-plain' || format === 'pdf') {
      req.html = await this.exportHtml(format !== 'html-plain', format === 'pdf')
    } else {
      req.markdown = this.getText()
    }
    const res = await api.exportDoc(req)
    if (res.ok) this.toast(t('msg.exported', { path: res.path || '' }))
    else if (!res.canceled) {
      await api.message({ type: 'error', message: t('msg.exportFailed'), detail: res.error || '', buttons: [t('button.ok')] })
    }
  }

  private async print(): Promise<void> {
    const html = await this.exportHtml(true, true)
    const res = await api.print(html)
    if (!res.ok && res.error) this.toast(t('msg.printFailed', { error: res.error }))
  }

  private showPreferences(section?: string): void {
    openPreferences(
      {
        prefs: () => this.prefs,
        themes: () => this.themes,
        change: (patch) => void api.setPrefs(patch),
        openThemesFolder: () => void api.openThemesFolder(),
        pandoc: () => api.hasPandoc(),
        themesDir: this.init.themesDir
      },
      section
    )
  }

  /* ---------------------------------- commands ------------------------------ */

  run(id: string, arg?: unknown): void {
    const fn = this.commands[id]
    if (!fn) return
    try {
      void Promise.resolve(fn(arg)).catch((err: unknown) => this.toast(err instanceof Error ? err.message : String(err)))
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err))
    }
  }

  /** A command that only makes sense in the live editor. */
  private live(command: Command): CommandFn {
    return () => {
      if (this.sourceMode || hasOverlay()) return
      this.editor.exec(command)
      this.editor.focus()
    }
  }

  /** An inline style: toggled in the live editor, or wrapped around the selection in source mode. */
  private inline(kind: ed.InlineKind, open: string, close: string): CommandFn {
    return () => {
      if (hasOverlay()) return
      if (this.sourceMode) this.source?.wrap(open, close)
      else if (!this.editor.context().inCode) {
        this.editor.exec(ed.toggleInline(kind))
        this.editor.focus()
      }
    }
  }

  /** A block type: applied in the live editor, or as a line prefix in source mode. */
  private block(command: Command, prefix: string, strip: RegExp): CommandFn {
    return () => {
      if (hasOverlay()) return
      if (this.sourceMode) this.source?.setLinePrefix(prefix, strip)
      else {
        this.editor.exec(command)
        this.editor.focus()
      }
    }
  }

  private registerCommands(): void {
    const c = this.commands
    const li = schema.nodes.list_item
    const HEADING = /^#{1,6}\s+/
    const LIST = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/

    /* File */
    c['file.new'] = () => api.newWindow()
    c['file.newWindow'] = () => api.newWindow()
    c['file.open'] = async () => {
      const paths = await api.openDialog()
      if (paths) for (const p of paths) await api.open(p)
    }
    c['file.openFolder'] = async () => {
      const folder = await api.openFolderDialog()
      if (!folder) return
      await this.sidebar.setFolder(folder)
      this.setSidebar(true, 'files')
    }
    c['file.quickOpen'] = async () => {
      if (hasOverlay()) return
      const items: QuickItem[] = []
      const seen = new Set<string>()
      const add = (path: string): void => {
        const key = path.replace(/\\/g, '/').toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        items.push({ name: basename(path), path })
      }
      this.prefs.recentFiles.forEach(add)
      if (this.sidebar.folder) {
        try {
          for (const f of await api.listAll(this.sidebar.folder)) add(f.path)
        } catch {
          /* the folder became unreadable; recent files are still offered */
        }
      }
      const path = await quickOpenDialog(items)
      if (path) await api.open(path)
    }
    c['file.reopenClosed'] = () => api.reopenClosed()
    c['file.save'] = () => this.save()
    c['file.saveAs'] = () => this.saveAs()
    c['file.rename'] = async () => {
      if (!this.doc.path) return
      const name = await promptDialog(t('rename.title'), basename(this.doc.path))
      if (!name || name === basename(this.doc.path)) return
      const next = await api.rename(this.doc.path, name)
      this.doc.path = next
      env.docPath = next
      this.pushDocState()
      await this.sidebar.refresh()
      this.sidebar.setActiveFile(next)
    }
    c['file.reveal'] = () => (this.doc.path ? api.reveal(this.doc.path) : undefined)
    c['file.delete'] = async () => {
      if (!this.doc.path) return
      const choice = await api.message({
        type: 'warning',
        message: t(this.init.platform === 'win32' ? 'msg.confirmRecycle' : 'msg.confirmTrash', { name: this.title() }),
        buttons: [t(this.init.platform === 'win32' ? 'button.moveToRecycleBin' : 'button.moveToTrash'), t('button.cancel')],
        defaultId: 0,
        cancelId: 1
      })
      if (choice !== 0) return
      await api.trash(this.doc.path)
      this.newDocument()
      await this.sidebar.refresh()
    }
    c['file.export'] = (format) => this.exportDoc(format as ExportFormat)
    c['file.print'] = () => this.print()
    c['file.close'] = () => this.closeWindow()
    c['app.preferences'] = () => {
      if (prefsOpen()) return closePreferences()
      this.showPreferences()
    }

    /* Edit */
    const inField = (): boolean => {
      const a = document.activeElement
      return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement
    }
    c['edit.undo'] = () => {
      if (inField()) document.execCommand('undo')
      else if (this.sourceMode) this.source?.undo()
      else this.editor.undo()
    }
    c['edit.redo'] = () => {
      if (inField()) document.execCommand('redo')
      else if (this.sourceMode) this.source?.redo()
      else this.editor.redo()
    }
    c['edit.copyMarkdown'] = () => {
      const text = this.sourceMode ? this.source?.selectedText() || '' : selectionMarkdown(this.editor.view.state)
      return api.writeClipboard({ text: text || this.getText() })
    }
    c['edit.copyHtml'] = () => {
      if (this.sourceMode) return
      return api.writeClipboard({ text: selectionHtml(this.editor.view.state) })
    }
    c['edit.pastePlain'] = async () => {
      const text = await api.readClipboard()
      if (!text) return
      if (inField()) document.execCommand('insertText', false, text)
      else if (this.sourceMode) this.source?.insert(text)
      else insertMarkdown(this.editor.view, text)
    }
    c['edit.selectAll'] = () => {
      if (inField() || this.sourceMode) document.execCommand('selectAll')
      else this.editor.exec(selectAll)
    }
    c['edit.selectLine'] = this.live(ed.selectLine)
    c['edit.selectScope'] = this.live(ed.selectScope)
    c['edit.selectWord'] = this.live(ed.selectWord)
    c['edit.deleteWord'] = this.live(ed.deleteWord)
    c['edit.jumpTop'] = () => {
      if (this.sourceMode) this.source?.gotoLine(0)
      else this.live(ed.jumpToTop)()
    }
    c['edit.jumpBottom'] = () => {
      if (this.sourceMode) this.source?.gotoLine(Number.MAX_SAFE_INTEGER)
      else this.live(ed.jumpToBottom)()
    }
    c['edit.jumpSelection'] = this.live(ed.jumpToSelection)
    const selectedText = (): string => {
      if (this.sourceMode) return this.source?.selectedText() || ''
      const { state } = this.editor.view
      return state.selection.empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, '\n')
    }
    c['edit.find'] = () => this.findbar.open(false, selectedText())
    c['edit.replace'] = () => this.findbar.open(true, selectedText())
    c['edit.findNext'] = () => this.findbar.step(1)
    c['edit.findPrevious'] = () => this.findbar.step(-1)

    /* Paragraph */
    for (let n = 1; n <= 6; n++) c[`paragraph.heading${n}`] = this.block(ed.setHeading(n), '#'.repeat(n) + ' ', HEADING)
    c['paragraph.paragraph'] = this.block(ed.setHeading(0), '', HEADING)
    c['paragraph.headingUp'] = this.live(ed.changeHeadingLevel(1))
    c['paragraph.headingDown'] = this.live(ed.changeHeadingLevel(-1))
    c['paragraph.code'] = () => {
      if (this.sourceMode) this.source?.wrap('```\n', '\n```')
      else this.live(ed.insertCodeBlock)()
    }
    c['paragraph.math'] = () => {
      if (this.sourceMode) this.source?.wrap('$$\n', '\n$$')
      else this.live(ed.insertMathBlock)()
    }
    c['paragraph.quote'] = this.block(ed.toggleBlockquote, '> ', /^>\s?/)
    c['paragraph.orderedList'] = this.block(ed.toggleList('ordered'), '1. ', LIST)
    c['paragraph.bulletList'] = this.block(ed.toggleList('bullet'), '- ', LIST)
    c['paragraph.taskList'] = this.block(ed.toggleList('task'), '- [ ] ', LIST)
    c['paragraph.indent'] = this.live(sinkListItem(li))
    c['paragraph.outdent'] = this.live(liftListItem(li))
    c['paragraph.insertBefore'] = this.live(ed.insertParagraph('before'))
    c['paragraph.insertAfter'] = this.live(ed.insertParagraph('after'))
    c['paragraph.linkReference'] = this.live(ed.insertLinkReference)
    c['paragraph.footnote'] = this.live(ed.insertFootnote)
    c['paragraph.hr'] = () => {
      if (this.sourceMode) this.source?.insert('\n---\n')
      else this.live(ed.insertHorizontalRule)()
    }
    c['paragraph.toc'] = () => {
      if (this.sourceMode) this.source?.insert('[toc]\n')
      else this.live(ed.insertToc)()
    }
    c['paragraph.frontMatter'] = this.live(ed.insertFrontMatter)

    /* Tables */
    c['table.insert'] = async () => {
      if (hasOverlay() || this.sourceMode) return
      const size = await tableDialog()
      if (!size) {
        this.editor.focus()
        return
      }
      this.editor.exec(ed.insertTable(size.rows, size.cols))
      this.editor.focus()
    }
    c['table.rowBefore'] = this.live(addRowBefore)
    c['table.rowAfter'] = this.live(addRowAfter)
    c['table.colBefore'] = this.live(addColumnBefore)
    c['table.colAfter'] = this.live(addColumnAfter)
    c['table.deleteRow'] = this.live(deleteRow)
    c['table.deleteCol'] = this.live(deleteColumn)
    c['table.delete'] = this.live(deleteTable)
    c['table.alignLeft'] = this.live(ed.setColumnAlign('left'))
    c['table.alignCenter'] = this.live(ed.setColumnAlign('center'))
    c['table.alignRight'] = this.live(ed.setColumnAlign('right'))

    /* Format */
    c['format.strong'] = this.inline('strong', '**', '**')
    c['format.em'] = this.inline('em', '*', '*')
    c['format.underline'] = this.inline('underline', '<u>', '</u>')
    c['format.code'] = this.inline('code', '`', '`')
    c['format.del'] = this.inline('del', '~~', '~~')
    c['format.comment'] = this.inline('comment', '<!--', '-->')
    c['format.math'] = this.inline('math', '$', '$')
    c['format.sub'] = this.inline('sub', '~', '~')
    c['format.sup'] = this.inline('sup', '^', '^')
    c['format.mark'] = this.inline('mark', '==', '==')
    c['format.link'] = () => {
      if (this.sourceMode) this.source?.wrap('[', ']()')
      else this.live(ed.insertLink)()
    }
    c['format.image'] = () => {
      if (this.sourceMode) this.source?.wrap('![', ']()')
      else this.live(ed.insertImage())()
    }
    c['format.imageLocal'] = async () => {
      const paths = await api.imagesDialog()
      if (paths) await this.insertImagePaths(paths)
    }
    c['format.clear'] = this.live(ed.clearFormat)

    /* View */
    c['view.sidebar'] = () => this.setSidebar(!document.body.classList.contains('sidebar-open'))
    c['view.outline'] = () => this.toggleSidebarTab('outline')
    c['view.files'] = () => {
      this.sidebar.setFilesView('tree')
      this.toggleSidebarTab('files')
    }
    c['view.articles'] = () => {
      this.setSidebar(true, 'files')
      this.sidebar.setFilesView('list')
    }
    c['view.search'] = () => {
      this.setSidebar(true, 'files')
      this.sidebar.toggleSearch(true)
    }
    c['view.source'] = () => {
      if (!hasOverlay()) this.toggleSource()
    }
    c['view.focus'] = () => {
      this.focusMode = !this.focusMode
      this.editor.setFocusMode(this.focusMode)
      this.syncMenu()
    }
    c['view.typewriter'] = () => {
      this.typewriter = !this.typewriter
      this.editor.setTypewriter(this.typewriter)
      this.syncMenu()
    }
    c['view.statusBar'] = () => api.setPrefs({ statusBar: !this.prefs.statusBar })
    c['view.alwaysOnTop'] = async () => {
      this.alwaysOnTop = !this.alwaysOnTop
      await api.alwaysOnTop(this.alwaysOnTop)
      this.syncMenu()
    }
    c['view.switchWindow'] = () => api.switchWindow()

    /* Help */
    const showHelp = (content: string): unknown => {
      if (!this.doc.path && !this.doc.dirty && !this.getText().trim()) {
        this.newDocument(content)
        return undefined
      }
      return api.newWindowWith(content)
    }
    c['help.quickStart'] = () => showHelp(forPlatform(quickStart, this.init.platform))
    c['help.markdown'] = () => showHelp(forPlatform(markdownReference, this.init.platform))
    c['help.themeFolder'] = () => api.openThemesFolder()
    c['help.about'] = () =>
      aboutDialog({
        version: this.init.version,
        electron: this.init.versions.electron,
        chrome: this.init.versions.chrome,
        node: this.init.versions.node
      })

    /* File tree (context menu) */
    c['tree.open'] = (path) => this.openInPlace(String(path))
    c['tree.openNew'] = (path) => api.open(String(path), true)
    c['tree.newFile'] = (path) => this.sidebar.newFile(String(path || ''))
    c['tree.newFolder'] = (path) => this.sidebar.newFolder(String(path || ''))
    c['tree.rename'] = (path) => this.sidebar.startRename(String(path))
    c['tree.delete'] = (path) => this.sidebar.remove(String(path))
    c['tree.copyPath'] = (path) => api.writeClipboard({ text: String(path) })
    c['tree.reveal'] = (path) => api.reveal(String(path))
    c['tree.refresh'] = () => this.sidebar.refresh()
  }
}
