import { App } from './app'

const app = new App()
window.__typexApp = app

app.start().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
  const pre = document.createElement('pre')
  pre.style.cssText = 'padding:24px;white-space:pre-wrap;font:13px/1.5 Consolas,monospace;color:#b42318'
  pre.textContent = `TypeX failed to start.\n\n${message}`
  document.body.appendChild(pre)
  console.error(err)
})
