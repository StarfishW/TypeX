/** Preferences panel: a full-window overlay with sections on the left. */
import { LOCALES, type MessageKey } from '../../../shared/i18n'
import type { Prefs, ThemeInfo } from '../../../shared/types'
import { t } from '../i18n'
import { h, iconButton } from './dom'

export interface PrefsHost {
  prefs: () => Prefs
  themes: () => ThemeInfo[]
  change: (patch: Partial<Prefs>) => void
  openThemesFolder: () => void
  pandoc: () => Promise<boolean>
  themesDir: string
}

type BoolKey = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never
}[keyof Prefs]

let panel: HTMLElement | null = null
let activeSection: string | null = null

export const prefsOpen = (): boolean => !!panel

/** The section on display, or null when the panel is closed. */
export const currentPrefsSection = (): string | null => (panel ? activeSection : null)

// Registered on the document so Escape closes the panel wherever focus is.
const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closePreferences()
  }
}

export function closePreferences(): void {
  document.removeEventListener('keydown', onKey, true)
  panel?.remove()
  panel = null
}

export function openPreferences(host: PrefsHost, section = 'general'): void {
  if (panel) return
  const prefs = host.prefs()

  const checkbox = (key: BoolKey, label: MessageKey, hint = ''): HTMLElement => {
    const input = h('input', { type: 'checkbox', checked: prefs[key] })
    input.addEventListener('change', () => host.change({ [key]: input.checked } as Partial<Prefs>))
    return h('div', { class: 'prefs-row' }, h('label', null, input, t(label)), hint ? h('span', { class: 'hint' }, hint) : null)
  }

  const select = <K extends keyof Prefs>(key: K, label: string, options: [string, string][], id = ''): HTMLElement => {
    const input = h(
      'select',
      { id: id || null },
      options.map(([value, text]) => {
        const opt = h('option', { value }, text)
        opt.selected = String(prefs[key]) === value
        return opt
      })
    )
    input.addEventListener('change', () => host.change({ [key]: input.value } as unknown as Partial<Prefs>))
    return h('div', { class: 'prefs-row' }, h('span', null, label), input)
  }

  const number = (key: 'fontSize' | 'lineWidth', label: MessageKey, min: number, max: number, hint = ''): HTMLElement => {
    const input = h('input', { type: 'number', min, max, value: prefs[key] })
    input.addEventListener('change', () => {
      const raw = Number(input.value)
      const value = key === 'lineWidth' && raw === 0 ? 0 : Math.max(min, Math.min(max, raw || min))
      input.value = String(value)
      host.change({ [key]: value } as Partial<Prefs>)
    })
    return h('div', { class: 'prefs-row' }, h('span', null, t(label), hint ? h('span', { class: 'hint' }, '  ' + hint) : null), input)
  }

  const text = (key: 'imageFolder', label: MessageKey): HTMLElement => {
    const input = h('input', { type: 'text', value: prefs[key], spellcheck: 'false' })
    input.addEventListener('change', () => host.change({ [key]: input.value.trim() || './assets' }))
    return h('div', { class: 'prefs-row' }, h('span', null, t(label)), input)
  }

  const note = (key: MessageKey): HTMLElement => h('p', { class: 'prefs-note' }, t(key))

  const group = (title: MessageKey, ...rows: (HTMLElement | null)[]): HTMLElement =>
    h('div', { class: 'prefs-group' }, h('h4', null, t(title)), rows)

  const pandocNote = h('p', { class: 'prefs-note' }, t('prefs.pandocChecking'))
  void host.pandoc().then((ok) => {
    pandocNote.textContent = t(ok ? 'prefs.pandocFound' : 'prefs.pandocMissing')
  })

  // Language names are written in their own language, so everyone can find theirs.
  const languages: [string, string][] = [['system', t('prefs.languageSystem')], ...LOCALES.map((l): [string, string] => [l.id, l.name])]

  const sections: [string, MessageKey, HTMLElement[]][] = [
    [
      'general',
      'prefs.general',
      [
        group('prefs.language', select('language', t('prefs.language'), languages, 'prefs-language'), note('prefs.languageNote')),
        group(
          'prefs.startup',
          select('startup', t('prefs.onLaunch'), [
            ['new', t('prefs.startupNew')],
            ['restore', t('prefs.startupRestore')]
          ])
        ),
        group(
          'prefs.saving',
          checkbox('autoSave', 'prefs.autoSave', t('prefs.autoSaveHint')),
          select('eol', t('prefs.eol'), [
            ['lf', t('prefs.eolLf')],
            ['crlf', t('prefs.eolCrlf')]
          ])
        )
      ]
    ],
    [
      'appearance',
      'prefs.appearance',
      [
        group(
          'prefs.theme',
          select(
            'theme',
            t('prefs.theme'),
            host.themes().map((theme): [string, string] => [theme.id, theme.name])
          ),
          h(
            'div',
            { class: 'prefs-row' },
            h('span', null, t('prefs.customThemes')),
            h('button', { class: 'text-button', type: 'button', onclick: () => host.openThemesFolder() }, t('help.themeFolder'))
          ),
          note('prefs.themeNote')
        ),
        group(
          'prefs.text',
          number('fontSize', 'prefs.fontSize', 10, 32, t('prefs.pixels')),
          number('lineWidth', 'prefs.lineWidth', 400, 2400, t('prefs.lineWidthHint'))
        ),
        group('prefs.window', checkbox('statusBar', 'prefs.statusBar'))
      ]
    ],
    [
      'editor',
      'prefs.editor',
      [
        group('prefs.typing', checkbox('autoPair', 'prefs.autoPair'), checkbox('spellcheck', 'prefs.spellcheck')),
        group(
          'prefs.codeFences',
          checkbox('codeLineNumbers', 'prefs.lineNumbers'),
          checkbox('codeWrap', 'prefs.wrap'),
          note('prefs.codeNote')
        )
      ]
    ],
    [
      'image',
      'prefs.image',
      [
        group(
          'prefs.imageInsert',
          select('imageAction', t('prefs.imageAction'), [
            ['none', t('prefs.imageNone')],
            ['copy', t('prefs.imageCopy')]
          ]),
          text('imageFolder', 'prefs.imageFolder'),
          note('prefs.imageNote'),
          checkbox('imageRelative', 'prefs.imageRelative')
        )
      ]
    ],
    [
      'markdown',
      'prefs.markdown',
      [
        group(
          'prefs.syntax',
          checkbox('inlineMath', 'prefs.inlineMath', '$E = mc^2$'),
          checkbox('subscript', 'prefs.subscript', 'H~2~O'),
          checkbox('superscript', 'prefs.superscript', 'x^2^'),
          checkbox('highlight', 'prefs.highlight', '==important=='),
          note('prefs.syntaxNote')
        )
      ]
    ],
    ['export', 'prefs.export', [group('prefs.pandoc', pandocNote)]]
  ]

  const nav = h('div', { class: 'prefs-nav' }, h('h2', null, t('prefs.title')))
  const body = h('div', { class: 'prefs-body' })
  const show = (id: string): void => {
    activeSection = id
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id))
    body.querySelectorAll('.prefs-section').forEach((s) => s.classList.toggle('active', (s as HTMLElement).dataset.id === id))
  }
  for (const [id, title, groups] of sections) {
    nav.appendChild(h('button', { type: 'button', 'data-id': id, onclick: () => show(id) }, t(title)))
    body.appendChild(h('div', { class: 'prefs-section', 'data-id': id }, h('h3', null, t(title)), groups))
  }

  const close = iconButton('close', t('find.close'), () => closePreferences())
  close.classList.add('prefs-close')
  panel = h('div', { class: 'prefs' }, nav, body, close)
  panel.tabIndex = -1
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(panel)
  show(sections.some(([id]) => id === section) ? section : 'general')
  panel.focus()
}
