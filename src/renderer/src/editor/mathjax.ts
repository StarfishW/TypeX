import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'

export function createEngine(): { render: (tex: string, display: boolean) => HTMLElement; css: string } {
  const adaptor = browserAdaptor()
  RegisterHTMLHandler(adaptor)
  const tex = new TeX({ packages: AllPackages })
  const svg = new SVG({ fontCache: 'none' })
  const doc = mathjax.document(document, { InputJax: tex, OutputJax: svg })
  const sheet = svg.styleSheet(doc) as unknown as HTMLElement
  return {
    render(source: string, display: boolean): HTMLElement {
      // Labels and equation numbers must not leak from one formula to the next.
      tex.reset()
      return doc.convert(source, { display }) as HTMLElement
    },
    css: sheet.textContent || ''
  }
}
