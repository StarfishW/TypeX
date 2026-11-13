// End-to-end tests for document lifecycle: the unsaved-changes prompt, saving
// an untitled document, user themes, restoring the last file, IME input and a
// large-document performance check.
//
//   npm run build && node scripts/e2e-lifecycle.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const out = process.env.SMOKE_OUT || join(tmpdir(), 'typex-lifecycle')
mkdirSync(out, { recursive: true })

const failures = []
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`)
  if (ok) passed++
  else failures.push(name)
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`)

async function launch(profile, args = [], env = {}) {
  const app = await electron.launch({
    args: ['.', ...args],
    env: { ...process.env, TYPEX_TEST: '1', TYPEX_USER_DATA: profile, ...env }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.waitForSelector('#write p, #write h1', { timeout: 20000 })
  await page.waitForTimeout(500)
  return { app, page }
}
const text = (page) => page.evaluate(() => window.__typexApp.getText())
const setEnv = (app, name, value) => app.evaluate((_e, [n, v]) => void (process.env[n] = v), [name, value])
const closeWindow = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const exited = (app, ms = 8000) =>
  Promise.race([app.waitForEvent('close').then(() => true), new Promise((r) => setTimeout(() => r(false), ms))])
const newProfile = () => mkdtempSync(join(tmpdir(), 'typex-profile-'))
const newDir = () => mkdtempSync(join(tmpdir(), 'typex-life-'))

/* ------------------------- unsaved changes: don't save ---------------------- */
{
  const dir = newDir()
  const file = join(dir, 'a.md')
  writeFileSync(file, 'original\n')
  const { app, page } = await launch(newProfile(), [file])
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' edited')
  await page.waitForTimeout(200)
  check('window title marks unsaved changes', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).includes('\u2022'))
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '1')
  const done = exited(app)
  await closeWindow(app)
  check("closing with Don't Save quits", await done)
  eq("Don't Save leaves the file alone", readFileSync(file, 'utf8'), 'original\n')
}

/* ---------------------------- unsaved changes: save ------------------------- */
{
  const dir = newDir()
  const file = join(dir, 'b.md')
  writeFileSync(file, 'original\r\n\r\nsecond\r\n')
  const { app, page } = await launch(newProfile(), [file])
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' edited')
  await page.waitForTimeout(200)
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '0')
  const done = exited(app)
  await closeWindow(app)
  check('closing with Save quits', await done)
  eq('Save writes the file and keeps CRLF line endings', readFileSync(file, 'utf8'), 'original\r\n\r\nsecond edited\r\n')
}

/* --------------------------- unsaved changes: cancel ------------------------ */
{
  const dir = newDir()
  const file = join(dir, 'c.md')
  writeFileSync(file, 'original\n')
  const { app, page } = await launch(newProfile(), [file])
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' edited')
  await page.waitForTimeout(200)
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '2')
  await closeWindow(app)
  await page.waitForTimeout(800)
  check('Cancel keeps the window open', (await windowCount(app)) === 1)
  eq('Cancel keeps the edits', await text(page), 'original edited\n')
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '1')
  const done = exited(app)
  await closeWindow(app)
  await done
}

/* ----------------------------- saving an untitled doc ----------------------- */
{
  const dir = newDir()
  const target = join(dir, 'New note.md')
  const { app, page } = await launch(newProfile())
  check('a fresh window is untitled', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).startsWith('Untitled'))
  await page.keyboard.type('# New note')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Body text.')
  await page.waitForTimeout(200)
  await setEnv(app, 'TYPEX_SAVE_PATH', target)
  await page.evaluate(() => window.__typexApp.save())
  await page.waitForTimeout(500)
  check('Save As wrote the file', existsSync(target) && readFileSync(target, 'utf8') === '# New note\n\nBody text.\n')
  check('title follows the new name', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).startsWith('New note.md -'))
  const done = exited(app)
  await closeWindow(app)
  check('a saved document closes without a prompt', await done)
}

/* ------------------------- user theme and restore-on-launch ------------------ */
{
  const profile = newProfile()
  mkdirSync(join(profile, 'themes'), { recursive: true })
  writeFileSync(join(profile, 'themes', 'ocean-dark.css'), ':root { --bg-color: rgb(1, 2, 3); --text-color: rgb(200, 210, 220); }\n')
  const dir = newDir()
  const file = join(dir, 'restore-me.md')
  writeFileSync(file, '# Restore me\n')
  {
    const { app, page } = await launch(profile, [file])
    const themes = await page.evaluate(() => window.typex.invoke('themes:list'))
    const mine = themes.find((t) => t.id === 'user:ocean-dark.css')
    check('user theme is listed', !!mine && mine.dark === true && mine.name === 'Ocean Dark', JSON.stringify(themes.map((t) => t.id)))
    await page.evaluate(() => window.typex.invoke('prefs:set', { theme: 'user:ocean-dark.css', startup: 'restore' }))
    await page.waitForTimeout(600)
    eq('user theme is applied', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(1, 2, 3)')
    const done = exited(app)
    await closeWindow(app)
    await done
  }
  {
    const { app, page } = await launch(profile)
    eq('last file is restored on launch', await text(page), '# Restore me\n')
    eq('theme choice persists', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(1, 2, 3)')
    const done = exited(app)
    await closeWindow(app)
    await done
  }
}

/* -------------------------------- crash recovery ---------------------------- */
{
  const profile = newProfile()
  const dir = newDir()
  const file = join(dir, 'crash.md')
  writeFileSync(file, 'saved text\n')
  {
    const { app, page } = await launch(profile, [file])
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' plus unsaved work')
    // Drafts are written a couple of seconds after the last edit.
    await page.waitForTimeout(3200)
    // End the whole process tree at once, the way a crash or power loss would.
    const done = exited(app)
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      app.process().kill('SIGKILL')
    }
    await done
    await new Promise((r) => setTimeout(r, 1500))
  }
  eq('a killed session leaves the file as it was saved', readFileSync(file, 'utf8'), 'saved text\n')
  {
    const { app, page } = await launch(profile)
    eq('unsaved work is recovered on the next launch', await text(page), 'saved text plus unsaved work\n')
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    check('the recovered document belongs to its file and is marked unsaved', title.startsWith('crash.md') && title.includes('•'), title)
    check('a notice explains the recovery', await page.locator('#notice.open').isVisible())
    check('only the recovered window opens', (await windowCount(app)) === 1)
    await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '0')
    const done = exited(app)
    await closeWindow(app)
    await done
  }
  eq('saving the recovered document writes it to the file', readFileSync(file, 'utf8'), 'saved text plus unsaved work\n')
  {
    const { app, page } = await launch(profile)
    check('nothing is recovered after a clean exit', (await text(page)) === '' && !(await page.locator('#notice.open').isVisible()))
    const done = exited(app)
    await closeWindow(app)
    await done
  }
}

/* ------------------------------------ IME ----------------------------------- */
{
  const { app, page } = await launch(newProfile())
  const client = await page.context().newCDPSession(page)
  const compose = async (steps, commit) => {
    for (const s of steps) {
      await client.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
      await page.waitForTimeout(40)
    }
    await client.send('Input.insertText', { text: commit })
    await page.waitForTimeout(150)
  }
  await page.evaluate(() => {
    const a = window.__typexApp
    a.editor.setMarkdown('\u524d **\u7c97\u4f53** \u540e')
    a.editor.focus()
  })
  await page.keyboard.press('Control+End')
  await compose(['n', 'ni', 'ni h', 'ni ha', 'ni hao'], '\u4f60\u597d')
  eq('IME composition at the end of a paragraph', await text(page), '\u524d **\u7c97\u4f53** \u540e\u4f60\u597d\n')
  // Into the middle of the bold span. Moving left skips the hidden closing
  // marker, so five presses from the end land between the two bold characters.
  await page.keyboard.press('Control+End')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(100)
  await compose(['z', 'zh', 'zho', 'zhon', 'zhong'], '\u4e2d')
  eq('IME composition inside a styled span', await text(page), '\u524d **\u7c97\u4e2d\u4f53** \u540e\u4f60\u597d\n')
  check('styling is re-applied after composition', (await page.locator('#write strong').count()) >= 1)
  await page.keyboard.press('Enter')
  await compose(['#'], '# ')
  await compose(['b', 'bi', 'bia', 'biao'], '\u6807\u9898')
  await page.waitForTimeout(200)
  check('composed text after a typed heading prefix', (await text(page)).includes('\u6807\u9898'), await text(page))
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '1')
  const done = exited(app)
  await closeWindow(app)
  await done
}

/* -------------------------------- large document ---------------------------- */
{
  const parts = []
  for (let i = 1; i <= 300; i++) {
    parts.push(`## Section ${i}`)
    parts.push(`Paragraph with **bold ${i}**, *italic*, \`code\`, a [link](https://example.com/${i}) and some more plain text to make it longer.`)
    parts.push(`Another paragraph with ~~strike~~ and ==highlight== number ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`)
    parts.push(`- item one\n- item two\n  - nested item\n- [ ] task ${i}`)
    if (i % 10 === 0) parts.push('```js\nfunction f(x) {\n  return x * 2\n}\n```')
    if (i % 15 === 0) parts.push('| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   | 3   |\n| 4   | 5   | 6   |')
    if (i % 25 === 0) parts.push('$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$')
  }
  const big = parts.join('\n\n') + '\n'
  const dir = newDir()
  const file = join(dir, 'big.md')
  writeFileSync(file, big)
  const { app, page } = await launch(newProfile(), [file])
  const stats = await page.evaluate((src) => {
    const a = window.__typexApp
    const t0 = performance.now()
    a.editor.setMarkdown(src)
    const load = performance.now() - t0
    const view = a.editor.view
    const t1 = performance.now()
    const md = a.getText()
    const serialize = performance.now() - t1
    // Time 40 single-character insertions at the end of the first paragraph.
    let pos = 0
    view.state.doc.forEach((node, offset, index) => {
      if (index === 1) pos = offset + node.nodeSize - 1
    })
    const times = []
    for (let i = 0; i < 40; i++) {
      const s = performance.now()
      view.dispatch(view.state.tr.insertText('x', pos + i))
      times.push(performance.now() - s)
    }
    times.sort((x, y) => x - y)
    return { load, serialize, median: times[20], worst: times[39], blocks: view.state.doc.childCount, same: md === src }
  }, big)
  console.log(
    `INFO  large document: ${big.length} chars, ${stats.blocks} top-level blocks; load ${stats.load.toFixed(0)} ms, ` +
      `serialize ${stats.serialize.toFixed(1)} ms, edit median ${stats.median.toFixed(2)} ms, worst ${stats.worst.toFixed(2)} ms`
  )
  check('large document round-trips unchanged', stats.same)
  check('large document loads in under 3 s', stats.load < 3000, `${stats.load.toFixed(0)} ms`)
  check('editing a large document stays responsive', stats.median < 16, `median ${stats.median.toFixed(2)} ms`)
  await setEnv(app, 'TYPEX_DIALOG_RESPONSE', '1')
  const done = exited(app)
  await closeWindow(app)
  await done
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
if (process.env.GITHUB_ACTIONS === 'true') {
  // A one-line result on the workflow run page (also readable through the public API).
  console.log(
    failures.length
      ? `::error title=lifecycle (${process.platform})::${failures.length} of ${passed + failures.length} checks failed: ${failures.join('; ')}`
      : `::notice title=lifecycle (${process.platform})::${passed} checks passed`
  )
}
process.exit(failures.length ? 1 : 0)
