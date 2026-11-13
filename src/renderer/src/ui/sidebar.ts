/**
 * Sidebar: the outline of the open document, and the files of the open
 * folder shown as a tree, as a flat list of articles, or as search results.
 */
import type { ContextInfo, DirEntry, SearchHit } from '../../../shared/types'
import { api } from '../api'
import { basename, dirname, samePath } from '../editor/env'
import type { Heading } from '../editor/nodeviews'
import { currentLocale, shortcut, t, trashMessages } from '../i18n'
import { debounce, h, icon, iconButton } from './dom'

export interface SidebarHost {
  openFile: (path: string, newWindow?: boolean) => void
  revealHeading: (pos: number) => void
  chooseFolder: () => void
  /** Opens `path` and highlights `query` in it. */
  openHit: (path: string, query: string) => void
  toast: (message: string) => void
  onLayout: () => void
}

type FilesView = 'tree' | 'list' | 'search'


export class Sidebar {
  tab: 'outline' | 'files' = 'outline'
  folder = ''
  private filesView: FilesView = 'tree'
  private readonly outlinePanel: HTMLElement
  private readonly filesPanel: HTMLElement
  private readonly searchBox: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly footer: HTMLElement
  private readonly folderName: HTMLElement
  private readonly tabButtons: Record<'outline' | 'files', HTMLButtonElement>
  private readonly viewButton: HTMLButtonElement
  private readonly searchButton: HTMLButtonElement

  private headings: Heading[] = []
  private activeHeading = -1
  private activeFile = ''
  private readonly expanded = new Set<string>()
  private readonly cache = new Map<string, DirEntry[]>()
  private renaming = ''
  private lastQuery = ''

  constructor(
    private readonly el: HTMLElement,
    private readonly host: SidebarHost
  ) {
    this.tabButtons = {
      files: h('button', { class: 'sidebar-tab', type: 'button', onclick: () => this.setTab('files') }, t('sidebar.files')),
      outline: h('button', { class: 'sidebar-tab', type: 'button', onclick: () => this.setTab('outline') }, t('sidebar.outline'))
    }
    this.searchButton = iconButton('search', t('sidebar.search', { key: shortcut('view.search') }), () => this.toggleSearch())
    const tabs = h('div', { class: 'sidebar-tabs' }, this.tabButtons.files, this.tabButtons.outline, this.searchButton)

    this.searchInput = h('input', { type: 'text', placeholder: t('sidebar.searchPlaceholder'), spellcheck: 'false' })
    const runSearch = debounce(() => void this.runSearch(), 250)
    this.searchInput.addEventListener('input', runSearch)
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleSearch(false)
      if (e.key === 'Enter') void this.runSearch()
    })
    this.searchBox = h('div', { class: 'sidebar-search' }, this.searchInput)

    this.filesPanel = h('div', { class: 'sidebar-panel', 'data-panel': 'files' })
    this.outlinePanel = h('div', { class: 'sidebar-panel', 'data-panel': 'outline' })

    this.folderName = h('span', { class: 'folder-name' })
    this.viewButton = iconButton('list', t('sidebar.switchView'), () => {
      this.setFilesView(this.filesView === 'tree' ? 'list' : 'tree')
    })
    this.footer = h(
      'div',
      { class: 'sidebar-footer' },
      this.folderName,
      iconButton('plus', t('sidebar.newFile'), () => void this.newFile(this.folder)),
      this.viewButton,
      iconButton('folder', t('sidebar.openFolder'), () => this.host.chooseFolder())
    )

    el.append(tabs, this.searchBox, this.filesPanel, this.outlinePanel, this.footer)
    this.setTab('outline')
  }

  /* ---------------------------------- tabs --------------------------------- */

  setTab(tab: 'outline' | 'files'): void {
    this.tab = tab
    for (const key of ['outline', 'files'] as const) this.tabButtons[key].classList.toggle('active', key === tab)
    this.outlinePanel.classList.toggle('active', tab === 'outline')
    this.filesPanel.classList.toggle('active', tab === 'files')
    this.footer.style.display = tab === 'files' ? '' : 'none'
    this.searchBox.classList.toggle('active', tab === 'files' && this.filesView === 'search')
    if (tab === 'files') void this.renderFiles()
    this.host.onLayout()
  }

  setFilesView(view: FilesView): void {
    this.filesView = view
    this.viewButton.replaceChildren(icon(view === 'list' ? 'tree' : 'list'))
    this.searchButton.classList.toggle('active', view === 'search')
    this.searchBox.classList.toggle('active', this.tab === 'files' && view === 'search')
    void this.renderFiles()
  }

  toggleSearch(on?: boolean): void {
    const next = on ?? !(this.tab === 'files' && this.filesView === 'search')
    if (next) {
      this.setTab('files')
      this.setFilesView('search')
      this.searchInput.focus()
      this.searchInput.select()
    } else {
      this.setFilesView('tree')
    }
  }

  /* --------------------------------- outline ------------------------------- */

  setOutline(headings: Heading[]): void {
    this.headings = headings
    this.activeHeading = -1
    this.outlinePanel.textContent = ''
    if (!headings.length) {
      this.outlinePanel.appendChild(h('div', { class: 'sidebar-empty' }, t('sidebar.noHeadings')))
      return
    }
    const min = Math.min(...headings.map((x) => x.level))
    headings.forEach((heading, i) => {
      const item = h('div', { class: 'outline-item', 'data-index': i, title: heading.text }, heading.text || t('doc.untitled'))
      item.style.paddingLeft = `${12 + (heading.level - min) * 14}px`
      item.addEventListener('click', () => this.host.revealHeading(this.headings[i].pos))
      this.outlinePanel.appendChild(item)
    })
  }

  /** Highlights the heading that the position `pos` falls under. */
  setActivePosition(pos: number): void {
    let index = -1
    for (let i = 0; i < this.headings.length; i++) {
      if (this.headings[i].pos <= pos) index = i
      else break
    }
    if (index === this.activeHeading) return
    this.activeHeading = index
    this.outlinePanel.querySelectorAll('.outline-item.active').forEach((n) => n.classList.remove('active'))
    if (index >= 0) {
      const item = this.outlinePanel.children[index] as HTMLElement | undefined
      if (item) {
        item.classList.add('active')
        if (this.tab === 'outline') item.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  /* ---------------------------------- files -------------------------------- */

  async setFolder(folder: string): Promise<void> {
    if (this.folder && samePath(this.folder, folder)) return
    this.folder = folder
    this.cache.clear()
    this.expanded.clear()
    this.folderName.textContent = folder ? basename(folder) || folder : t('sidebar.noFolderName')
    this.folderName.title = folder
    void api.watchFolder(folder)
    await this.renderFiles()
  }

  setActiveFile(path: string): void {
    this.activeFile = path
    if (path && this.folder) {
      // Reveal the file by expanding its ancestors inside the open folder.
      let dir = dirname(path)
      const root = this.folder.replace(/\\/g, '/').toLowerCase()
      while (dir && dir.replace(/\\/g, '/').toLowerCase().startsWith(root) && !samePath(dir, this.folder)) {
        this.expanded.add(dir.replace(/\\/g, '/').toLowerCase())
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    if (this.tab === 'files') void this.renderFiles()
  }

  /** Reloads directory listings after something changed on disk. */
  async refresh(): Promise<void> {
    this.cache.clear()
    if (this.tab === 'files') await this.renderFiles()
  }

  private async entries(dir: string): Promise<DirEntry[]> {
    const key = dir.replace(/\\/g, '/').toLowerCase()
    let list = this.cache.get(key)
    if (!list) {
      try {
        list = await api.list(dir)
      } catch {
        list = []
      }
      this.cache.set(key, list)
    }
    return list
  }

  private async renderFiles(): Promise<void> {
    if (this.tab !== 'files') return
    const panel = this.filesPanel
    if (!this.folder) {
      panel.textContent = ''
      const open = h('button', { class: 'text-button', type: 'button', onclick: () => this.host.chooseFolder() }, t('file.openFolder'))
      panel.appendChild(h('div', { class: 'sidebar-empty' }, t('sidebar.noFolder'), h('div', null, open)))
      return
    }
    if (this.filesView === 'search') {
      if (!this.lastQuery) panel.replaceChildren(h('div', { class: 'sidebar-empty' }, t('sidebar.searchHint')))
      return
    }
    const frag = document.createDocumentFragment()
    if (this.filesView === 'tree') {
      await this.renderDir(this.folder, 0, frag)
      if (!frag.childNodes.length) frag.appendChild(h('div', { class: 'sidebar-empty' }, t('sidebar.empty')))
    } else {
      let files: DirEntry[] = []
      try {
        files = await api.listAll(this.folder)
      } catch {
        files = []
      }
      files.sort((a, b) => b.mtime - a.mtime)
      for (const f of files) {
        const rel = dirname(f.path).slice(this.folder.length).replace(/^[\\/]+/, '')
        const item = h(
          'div',
          { class: 'list-item' + (samePath(f.path, this.activeFile) ? ' active' : ''), 'data-path': f.path, title: f.path },
          h('div', { class: 'list-item-title' }, f.name.replace(/\.[^.]+$/, '')),
          h('div', { class: 'list-item-meta' }, `${new Date(f.mtime).toLocaleDateString(currentLocale())}${rel ? '  ·  ' + rel : ''}`)
        )
        item.addEventListener('click', () => this.host.openFile(f.path))
        frag.appendChild(item)
      }
      if (!files.length) frag.appendChild(h('div', { class: 'sidebar-empty' }, t('sidebar.empty')))
    }
    panel.replaceChildren(frag)
    panel.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  private async renderDir(dir: string, depth: number, out: DocumentFragment): Promise<void> {
    for (const entry of await this.entries(dir)) {
      const key = entry.path.replace(/\\/g, '/').toLowerCase()
      const open = entry.dir && this.expanded.has(key)
      const row = h('div', {
        class: 'tree-row' + (open ? ' open' : '') + (!entry.dir && samePath(entry.path, this.activeFile) ? ' active' : ''),
        'data-path': entry.path,
        'data-dir': entry.dir ? '1' : '',
        title: entry.path
      })
      row.style.paddingLeft = `${8 + depth * 14}px`
      if (entry.dir) {
        const chevron = icon('chevron')
        chevron.classList.add('tree-chevron')
        row.append(chevron, icon('folder'))
      } else {
        row.append(h('span', { style: 'width:14px;flex:none' }), icon('file'))
      }
      if (this.renaming && samePath(this.renaming, entry.path)) {
        row.appendChild(this.renameInput(entry))
      } else {
        row.appendChild(h('span', { class: 'tree-name' }, entry.name))
        row.addEventListener('click', () => {
          if (entry.dir) {
            if (this.expanded.has(key)) this.expanded.delete(key)
            else this.expanded.add(key)
            void this.renderFiles()
          } else {
            this.host.openFile(entry.path)
          }
        })
      }
      out.appendChild(row)
      if (open) await this.renderDir(entry.path, depth + 1, out)
    }
  }

  private renameInput(entry: DirEntry): HTMLInputElement {
    const input = h('input', { class: 'tree-rename', type: 'text', value: entry.name, spellcheck: 'false' })
    let done = false
    const finish = async (commit: boolean): Promise<void> => {
      if (done) return
      done = true
      this.renaming = ''
      const name = input.value.trim()
      if (commit && name && name !== entry.name) {
        try {
          const next = await api.rename(entry.path, name)
          if (samePath(entry.path, this.activeFile)) this.host.openFile(next)
        } catch (err) {
          this.host.toast(err instanceof Error ? err.message : String(err))
        }
      }
      await this.refresh()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') void finish(true)
      if (e.key === 'Escape') void finish(false)
    })
    input.addEventListener('blur', () => void finish(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    queueMicrotask(() => {
      input.focus()
      const dot = entry.dir ? -1 : entry.name.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
    })
    return input
  }

  /* ------------------------------- file actions ---------------------------- */

  private targetDir(path: string): string {
    if (!path) return this.folder
    const row = this.filesPanel.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    return row && row.dataset.dir ? path : dirname(path)
  }

  async newFile(near: string): Promise<void> {
    const dir = this.targetDir(near)
    if (!dir) {
      this.host.chooseFolder()
      return
    }
    try {
      const path = await api.createFile(dir, `${t('doc.untitled')}.md`)
      this.expanded.add(dir.replace(/\\/g, '/').toLowerCase())
      this.setTab('files')
      if (this.filesView !== 'tree') this.setFilesView('tree')
      this.renaming = path
      await this.refresh()
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err))
    }
  }

  async newFolder(near: string): Promise<void> {
    const dir = this.targetDir(near)
    if (!dir) return
    try {
      const path = await api.createFolder(dir, t('ctx.newFolder'))
      this.expanded.add(dir.replace(/\\/g, '/').toLowerCase())
      this.renaming = path
      await this.refresh()
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err))
    }
  }

  startRename(path: string): void {
    this.renaming = path
    void this.renderFiles()
  }

  async remove(path: string): Promise<void> {
    const choice = await api.message({
      type: 'warning',
      message: t(trashMessages().confirm, { name: basename(path) }),
      buttons: [t(trashMessages().button), t('button.cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (choice !== 0) return
    try {
      await api.trash(path)
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err))
    }
    await this.refresh()
  }

  /* ---------------------------------- search ------------------------------- */

  private async runSearch(): Promise<void> {
    const query = this.searchInput.value.trim()
    this.lastQuery = query
    if (!query || !this.folder) {
      void this.renderFiles()
      return
    }
    let hits: SearchHit[] = []
    try {
      hits = await api.search(this.folder, query, {})
    } catch {
      hits = []
    }
    if (this.searchInput.value.trim() !== query || this.filesView !== 'search') return
    const frag = document.createDocumentFragment()
    let current = ''
    for (const hit of hits) {
      if (hit.path !== current) {
        current = hit.path
        frag.appendChild(h('div', { class: 'search-file', title: hit.path }, basename(hit.path)))
      }
      const row = h('div', { class: 'search-hit', title: hit.text }, hit.text)
      row.addEventListener('click', () => this.host.openHit(hit.path, query))
      frag.appendChild(row)
    }
    if (!hits.length) frag.appendChild(h('div', { class: 'sidebar-empty' }, t('sidebar.noResults')))
    this.filesPanel.replaceChildren(frag)
  }

  /* ------------------------------- context info ---------------------------- */

  contextAt(target: Element): ContextInfo | null {
    if (!this.el.contains(target) || this.tab !== 'files' || this.filesView === 'search') return null
    const row = target.closest<HTMLElement>('[data-path]')
    return {
      area: 'tree',
      inTable: false,
      inCode: false,
      hasSelection: false,
      path: row ? row.dataset.path : '',
      dir: row ? !!row.dataset.dir : true
    }
  }
}
