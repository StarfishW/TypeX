// End-to-end smoke test: launches the built app, opens a sample document,
// exercises the editor through real key presses and writes screenshots.
//
//   npm run build && npm run smoke
//
// Set SMOKE_OUT to choose where the screenshots and artifacts go.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const out = process.env.SMOKE_OUT || join(tmpdir(), 'typex-smoke')
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'typex-profile-'))

const SAMPLE = `---
title: Sample
---

# TypeX sample document

A paragraph with **bold**, *italic*, \`inline code\`, ~~strike~~, ==highlight==, H~2~O, x^2^,
a [link](https://example.com) and inline math $e^{i\\pi} + 1 = 0$. An emoji :rocket: too.

## Lists

- First item
  - Nested item
- [x] Done task
- [ ] Open task

1. One
2. Two

> A quote with *emphasis*.

## Code

\`\`\`js
function greet(name) {
  return \`Hello, \${name}\`
}
\`\`\`

## Math

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Table

| Name  | Qty | Price |
| :---- | :-: | ----: |
| Apple |  3  |  1.20 |
| Pear  |  5  |  0.80 |

---

Footnote reference[^1] and <u>underline</u>.

[^1]: The footnote text.
`

const samplePath = join(out, 'sample.md')
writeFileSync(samplePath, SAMPLE, 'utf8')

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const app = await electron.launch({
  args: ['.', samplePath],
  env: { ...process.env, TYPEX_TEST: '1', TYPEX_USER_DATA: profile }
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text())
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message)
  errors.push(e.message)
})

const shot = (name) => page.screenshot({ path: join(out, name) })
const text = () => page.evaluate(() => window.__typexApp.getText())
const mod = 'Control'

try {
  await page.waitForSelector('#write h1', { timeout: 20000 })
  await page.waitForTimeout(1500)
  await shot('01-open.png')

  check('heading rendered', (await page.locator('#write h1').innerText()).includes('TypeX sample document'))
  check('strong rendered', (await page.locator('#write strong').count()) > 0)
  check('table rendered', (await page.locator('#write table tr').count()) === 3)
  check('code block has editor', (await page.locator('#write .md-fences .cm-content').count()) === 1)
  check('math block rendered', (await page.locator('#write .md-math-block mjx-container').count()) === 1)
  check('task checkboxes', (await page.locator('#write .md-task-checkbox').count()) === 2)
  check('round trip is stable', (await text()) === SAMPLE, 'serialized text equals the file')

  // Typing at the end of the document: block shortcuts and inline styles.
  await page.locator('#write > p').last().click()
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.press('Enter')
  await page.keyboard.type('## Typed heading')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Some **strong** text and a `code` span.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- item one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('item two')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the list.')
  await page.waitForTimeout(300)
  const typed = await text()
  check('typed heading', typed.includes('\n## Typed heading\n'))
  check('typed inline source kept', typed.includes('Some **strong** text and a `code` span.'))
  check('typed list', typed.includes('- item one\n- item two\n'))
  check('left the list with Enter', typed.trimEnd().endsWith('After the list.'))

  // Ctrl+B must toggle exactly once.
  await page.keyboard.press('Enter')
  await page.keyboard.type('word')
  await page.keyboard.press(`${mod}+b`)
  await page.waitForTimeout(200)
  check('Ctrl+B toggles once', (await text()).trimEnd().endsWith('**word**'), JSON.stringify((await text()).slice(-30)))
  await shot('02-typed.png')

  // Source mode and back.
  await page.evaluate(() => window.__typexApp.run('view.source'))
  await page.waitForTimeout(400)
  check('source mode shows the editor', await page.locator('#source .cm-content').isVisible())
  await shot('03-source.png')
  const before = await text()
  await page.evaluate(() => window.__typexApp.run('view.source'))
  await page.waitForTimeout(400)
  check('source mode round trip', (await text()) === before)

  // Sidebar outline.
  await page.evaluate(() => window.__typexApp.run('view.outline'))
  await page.waitForTimeout(300)
  check('outline lists headings', (await page.locator('.outline-item').count()) >= 5)
  await shot('04-outline.png')

  // Find.
  await page.evaluate(() => window.__typexApp.run('edit.find'))
  await page.keyboard.type('item')
  await page.waitForTimeout(400)
  const hits = await page.locator('#write .md-search-hit').count()
  check('find highlights matches', hits >= 4, `${hits} hits`)
  await shot('05-find.png')
  await page.keyboard.press('Escape')

  // Dark theme.
  await page.evaluate(() => window.typex.invoke('prefs:set', { theme: 'midnight' }))
  await page.waitForTimeout(500)
  await page.evaluate(() => document.querySelector('#editor-scroll').scrollTo(0, 0))
  await shot('06-midnight.png')

  // Save and read back from disk.
  await page.evaluate(() => window.__typexApp.save())
  await page.waitForTimeout(300)
  check('saved to disk', readFileSync(samplePath, 'utf8') === (await text()))

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  console.log('ERROR', err)
  failures.push('exception')
  await shot('error.png').catch(() => {})
} finally {
  // The document was saved above, so the window closes without a prompt.
  await app.close().catch(() => {})
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed')
console.log(`Artifacts: ${out}`)
process.exit(failures.length ? 1 : 0)
