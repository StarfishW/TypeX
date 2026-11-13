/** Find and replace bar. It drives whichever editor is active through a small target interface. */
import type { SearchQuery } from '../editor/search'
import { shortcut, t } from '../i18n'
import { debounce, h, iconButton } from './dom'

export interface FindTarget {
  setSearch: (query: SearchQuery | null, replacement: string) => void
  step: (dir: 1 | -1) => void
  replace: (replacement: string) => void
  replaceAll: (replacement: string) => void
  info: () => { count: number; current: number }
  focus: () => void
}

export class FindBar {
  private readonly input: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly count: HTMLElement
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regex', HTMLButtonElement>
  private readonly options = { caseSensitive: false, wholeWord: false, regex: false }

  constructor(
    private readonly el: HTMLElement,
    private readonly target: () => FindTarget
  ) {
    this.input = h('input', { type: 'text', placeholder: t('find.find'), spellcheck: 'false' })
    this.replaceInput = h('input', { type: 'text', placeholder: t('find.replace'), spellcheck: 'false' })
    this.count = h('span', { class: 'find-count' })

    const toggle = (key: keyof typeof this.options, label: string, title: string): HTMLButtonElement => {
      const btn = h('button', { class: 'find-toggle', type: 'button', title }, label)
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', () => {
        this.options[key] = !this.options[key]
        btn.classList.toggle('active', this.options[key])
        this.apply()
      })
      return btn
    }
    this.toggles = {
      caseSensitive: toggle('caseSensitive', 'Aa', t('find.matchCase')),
      wholeWord: toggle('wholeWord', 'W', t('find.wholeWord')),
      regex: toggle('regex', '.*', t('find.regex'))
    }

    const apply = debounce(() => this.apply(), 120)
    this.input.addEventListener('input', apply)
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.step(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        this.close()
      }
    })
    this.replaceInput.addEventListener('input', apply)
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.replace()
      } else if (e.key === 'Escape') {
        this.close()
      }
    })

    el.append(
      h(
        'div',
        { class: 'find-row' },
        h(
          'div',
          { class: 'find-field' },
          this.input,
          this.count,
          this.toggles.caseSensitive,
          this.toggles.wholeWord,
          this.toggles.regex
        ),
        iconButton('up', t('find.previous', { key: shortcut('edit.findPrevious') }), () => this.step(-1)),
        iconButton('down', t('find.next', { key: shortcut('edit.findNext') }), () => this.step(1)),
        iconButton('close', t('find.close'), () => this.close())
      ),
      h(
        'div',
        { class: 'find-row replace-row' },
        h('div', { class: 'find-field' }, this.replaceInput),
        h('button', { class: 'text-button', type: 'button', onclick: () => this.replace() }, t('find.replace')),
        h('button', { class: 'text-button', type: 'button', onclick: () => this.replaceAll() }, t('find.replaceAll'))
      )
    )
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open')
  }

  open(withReplace: boolean, initial = ''): void {
    this.el.classList.add('open')
    this.el.classList.toggle('replace', withReplace)
    if (initial && !initial.includes('\n')) this.input.value = initial
    this.input.focus()
    this.input.select()
    this.apply()
  }

  close(): void {
    if (!this.isOpen) return
    this.el.classList.remove('open')
    const target = this.target()
    target.setSearch(null, '')
    target.focus()
  }

  /** Sets the query from outside, e.g. after opening a folder search result. */
  search(text: string): void {
    this.input.value = text
    this.el.classList.add('open')
    this.apply()
    this.step(1)
  }

  private query(): SearchQuery | null {
    const text = this.input.value
    return text ? { text, ...this.options } : null
  }

  private apply(): void {
    if (!this.isOpen) return
    this.target().setSearch(this.query(), this.replaceInput.value)
    this.updateCount()
  }

  /** Re-applies the query to the current target, after the active editor changed. */
  reapply(): void {
    this.apply()
  }

  updateCount(): void {
    if (!this.isOpen) return
    const { count, current } = this.target().info()
    this.count.textContent = this.input.value ? `${current >= 0 ? current + 1 : 0}/${count}` : ''
  }

  step(dir: 1 | -1): void {
    if (!this.isOpen) {
      this.open(false)
      return
    }
    this.target().step(dir)
    this.updateCount()
  }

  private replace(): void {
    this.target().replace(this.replaceInput.value)
    this.updateCount()
  }

  private replaceAll(): void {
    this.target().replaceAll(this.replaceInput.value)
    this.updateCount()
  }
}
