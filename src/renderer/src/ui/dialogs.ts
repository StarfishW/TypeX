/** Modal dialogs: text prompt, table size, quick open and the about box. */
import { t } from '../i18n'
import { h } from './dom'

function overlay(content: HTMLElement, onDismiss: () => void): HTMLElement {
  const el = h('div', { class: 'overlay' }, content)
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) onDismiss()
  })
  // Escape must work even when keyboard focus has wandered outside the dialog.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !content.contains(e.target as Node)) {
      e.stopPropagation()
      onDismiss()
    }
  }
  document.addEventListener('keydown', onKey, true)
  const remove = el.remove.bind(el)
  el.remove = () => {
    document.removeEventListener('keydown', onKey, true)
    remove()
  }
  document.body.appendChild(el)
  return el
}

export const hasOverlay = (): boolean => !!document.querySelector('.overlay, .prefs')

/** Asks for the size of a new table. Resolves to null when cancelled. */
export function tableDialog(): Promise<{ rows: number; cols: number } | null> {
  return new Promise((resolve) => {
    const cols = h('input', { type: 'number', min: '1', max: '30', value: '3' })
    const rows = h('input', { type: 'number', min: '2', max: '200', value: '3' })
    let el: HTMLElement
    const finish = (ok: boolean): void => {
      el.remove()
      if (!ok) return resolve(null)
      resolve({
        cols: Math.max(1, Math.min(30, Number(cols.value) || 3)),
        rows: Math.max(2, Math.min(200, Number(rows.value) || 3))
      })
    }
    const dialog = h(
      'div',
      { class: 'dialog' },
      h('h3', null, t('table.dialogTitle')),
      h('div', { class: 'dialog-fields' }, h('label', null, t('table.columns'), cols), h('label', null, t('table.rows'), rows)),
      h(
        'div',
        { class: 'dialog-buttons' },
        h('button', { class: 'text-button', type: 'button', onclick: () => finish(false) }, t('button.cancel')),
        h('button', { class: 'text-button primary', type: 'button', onclick: () => finish(true) }, t('button.ok'))
      )
    )
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
    el = overlay(dialog, () => finish(false))
    cols.focus()
    cols.select()
  })
}

/** Asks for one line of text. Resolves to null when cancelled. */
export function promptDialog(title: string, value: string, hint = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, spellcheck: 'false' })
    let el: HTMLElement
    const finish = (ok: boolean): void => {
      el.remove()
      resolve(ok ? input.value : null)
    }
    const dialog = h(
      'div',
      { class: 'dialog' },
      h('h3', null, title),
      hint ? h('p', null, hint) : null,
      input,
      h(
        'div',
        { class: 'dialog-buttons' },
        h('button', { class: 'text-button', type: 'button', onclick: () => finish(false) }, t('button.cancel')),
        h('button', { class: 'text-button primary', type: 'button', onclick: () => finish(true) }, t('button.ok'))
      )
    )
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
    el = overlay(dialog, () => finish(false))
    input.focus()
    const dot = value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : value.length)
  })
}

export interface QuickItem {
  name: string
  path: string
}

/** Fuzzy score: characters of `query` must appear in order; contiguous runs and word starts score higher. */
function score(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 1
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 - direct
  let qi = 0
  let total = 0
  let run = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      run++
      total += run * 2 + (i === 0 || /[\s\\/_.-]/.test(t[i - 1]) ? 5 : 0)
      qi++
    } else {
      run = 0
    }
  }
  return qi === q.length ? total : 0
}

/** Quick open: filter a list of files by typing. Resolves to the chosen path or null. */
export function quickOpenDialog(items: QuickItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: t('quickOpen.placeholder'), spellcheck: 'false' })
    const list = h('div', { class: 'quick-list' })
    let shown: QuickItem[] = []
    let active = 0
    let el: HTMLElement

    const finish = (path: string | null): void => {
      el.remove()
      resolve(path)
    }
    const render = (): void => {
      const q = input.value.trim()
      shown = items
        .map((item) => ({ item, s: Math.max(score(q, item.name) * 2, score(q, item.path)) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
        .map((x) => x.item)
      active = Math.min(active, Math.max(0, shown.length - 1))
      list.replaceChildren(
        ...shown.map((item, i) => {
          const row = h(
            'div',
            { class: 'quick-item' + (i === active ? ' active' : '') },
            h('div', { class: 'quick-item-name' }, item.name),
            h('div', { class: 'quick-item-path' }, item.path)
          )
          row.addEventListener('click', () => finish(item.path))
          return row
        })
      )
      if (!shown.length) list.appendChild(h('div', { class: 'sidebar-empty' }, t('quickOpen.noMatch')))
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
    }
    input.addEventListener('input', () => {
      active = 0
      render()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (shown.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
        render()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish(shown[active] ? shown[active].path : null)
      } else if (e.key === 'Escape') {
        finish(null)
      }
    })
    const dialog = h('div', { class: 'dialog quick-open' }, input, list)
    el = overlay(dialog, () => finish(null))
    render()
    input.focus()
  })
}

export function aboutDialog(info: { version: string; electron: string; chrome: string; node: string }): void {
  let el: HTMLElement
  const close = (): void => el.remove()
  const dialog = h(
    'div',
    { class: 'dialog' },
    h('h3', null, 'TypeX'),
    h('p', null, t('about.version', { version: info.version })),
    h('p', null, t('about.description')),
    h('p', null, `Electron ${info.electron}  ·  Chromium ${info.chrome}  ·  Node ${info.node}`),
    h('p', null, t('about.license')),
    h('div', { class: 'dialog-buttons' }, h('button', { class: 'text-button primary', type: 'button', onclick: close }, t('button.close')))
  )
  dialog.tabIndex = -1
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') close()
  })
  el = overlay(dialog, close)
  dialog.focus()
}
