/**
 * Math rendering. The TeX engine is large, so it is loaded on first use and
 * formulas that are requested earlier are filled in once it is ready.
 */

interface Engine {
  render: (tex: string, display: boolean) => HTMLElement
  css: string
}

let engine: Engine | null = null
let loading: Promise<void> | null = null

export function loadMath(): Promise<void> {
  if (!loading) {
    loading = import('./mathjax').then((m) => {
      engine = m.createEngine()
      const style = document.createElement('style')
      style.id = 'mathjax-styles'
      style.textContent = engine.css
      document.head.appendChild(style)
    })
  }
  return loading
}

function fill(el: HTMLElement, tex: string, display: boolean): void {
  el.textContent = ''
  el.classList.remove('md-math-error')
  try {
    el.appendChild(engine!.render(tex, display))
  } catch (err) {
    el.classList.add('md-math-error')
    el.textContent = err instanceof Error ? err.message : String(err)
  }
}

/** Renders `tex` into `el`, immediately when possible and otherwise once the engine has loaded. */
export function renderMathInto(el: HTMLElement, tex: string, display: boolean): void {
  if (engine) {
    fill(el, tex, display)
    return
  }
  el.textContent = tex
  void loadMath().then(() => {
    if (el.isConnected || !el.parentNode) fill(el, tex, display)
  })
}

/** Self-contained SVG markup for a formula, used by export. */
export async function mathToHtml(tex: string, display: boolean): Promise<string> {
  await loadMath()
  try {
    return engine!.render(tex, display).outerHTML
  } catch {
    return ''
  }
}

export const mathCss = (): string => engine?.css ?? ''
