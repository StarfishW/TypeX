/** Small DOM helpers and the icon set used by the application chrome. */

type Child = Node | string | number | null | undefined | false

type Attrs = Record<string, unknown>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
      } else if (key === 'class') {
        el.className = String(value)
      } else if (key === 'value' && 'value' in el) {
        ;(el as unknown as HTMLInputElement).value = String(value)
      } else if (key === 'checked' && 'checked' in el) {
        ;(el as unknown as HTMLInputElement).checked = Boolean(value)
      } else if (value === true) {
        el.setAttribute(key, '')
      } else {
        el.setAttribute(key, String(value))
      }
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
  return el
}

const ICONS: Record<string, string> = {
  sidebar: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  list: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  tree: '<path d="M3 3v9.5h4M3 7h4"/><rect x="8" y="5.5" width="5" height="3" rx=".6"/><rect x="8" y="11" width="5" height="3" rx=".6"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  alignLeft: '<path d="M3 4h10M3 8h6M3 12h8"/>',
  alignCenter: '<path d="M3 4h10M5 8h6M4 12h8"/>',
  alignRight: '<path d="M3 4h10M7 8h6M5 12h8"/>',
  rowAdd: '<rect x="2.5" y="3" width="11" height="5" rx="1"/><path d="M8 10v4M6 12h4"/>',
  colAdd: '<rect x="3" y="2.5" width="5" height="11" rx="1"/><path d="M10 8h4M12 6v4"/>',
  rowDelete: '<rect x="2.5" y="3" width="11" height="5" rx="1"/><path d="M6 12h4"/>',
  colDelete: '<rect x="3" y="2.5" width="5" height="11" rx="1"/><path d="M10 8h4"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5"/>',
  // Blocks, for the slash-command list.
  paragraph: '<path d="M9.5 8.5H7.25a2.75 2.75 0 0 1 0-5.5H13M9.5 3v10.5M12 3v10.5"/>',
  bulletList:
    '<path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/><circle cx="3.25" cy="4.5" r=".5"/><circle cx="3.25" cy="8" r=".5"/><circle cx="3.25" cy="11.5" r=".5"/>',
  orderedList: '<path d="M7 4.5h6.5M7 8h6.5M7 11.5h6.5M2.6 3.3l1-.8v3.6M2.5 10.4a1 1 0 1 1 1.8.6L2.5 13.4h2.1"/>',
  taskList: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.3 8.1 1.9 1.9 3.6-3.8"/>',
  quote: '<path d="M3.5 3v10M6.5 4.5h7M6.5 8h7M6.5 11.5h4.5"/>',
  math: '<path d="M12 3.5H4.5L8.5 8l-4 4.5H12"/>',
  table: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M2.5 6.6h11M2.5 9.8h11M8 6.6V13"/>',
  diagram: '<rect x="2.5" y="2.5" width="5" height="4" rx="1"/><rect x="8.5" y="9.5" width="5" height="4" rx="1"/><path d="M5 6.5v4.5h3.5"/>',
  rule: '<path d="M2.5 8h11"/><path d="M5 4.5h6M5 11.5h6" opacity=".4"/>',
  toc: '<path d="M2.5 4h1M5.5 4h8M4.5 8h1M7.5 8h6M4.5 12h1M7.5 12h6"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m3 12.5 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5"/>',
  link: '<path d="M6.8 9.2a2.4 2.4 0 0 0 3.4 0l2.3-2.3a2.4 2.4 0 0 0-3.4-3.4l-.6.6M9.2 6.8a2.4 2.4 0 0 0-3.4 0L3.5 9.1a2.4 2.4 0 0 0 3.4 3.4l.6-.6"/>',
  footnote: '<path d="M2.5 5.5h6.5M2.5 9h11M2.5 12.5h8M11.4 3.3l1.2-.8v4"/>',
  frontMatter: '<path d="M2.5 2.5h5.3l5.7 5.7-5.3 5.3-5.7-5.7z"/><circle cx="5.5" cy="5.5" r=".6"/>'
}

export function icon(name: keyof typeof ICONS | string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.innerHTML = ICONS[name] || ''
  return svg
}

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void): HTMLButtonElement {
  const btn = h('button', { class: 'icon-button', title, type: 'button', onclick })
  btn.appendChild(icon(name))
  // Keep keyboard focus (and the selection) where it was.
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  return btn
}

export const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) => {
  let timer = 0
  return (...args: A) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), ms)
  }
}
