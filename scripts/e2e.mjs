// End-to-end editing tests: drives the built app with real key presses and
// checks the Markdown it produces.
//
//   npm run build && npm run e2e
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.SMOKE_OUT || join(tmpdir(), 'typex-e2e')
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'typex-profile-'))
const docPath = join(out, 'e2e.md')
writeFileSync(docPath, 'start\n', 'utf8')
copyFileSync(join(root, 'resources', 'icon.png'), join(out, 'icon.png'))

const failures = []
let passed = 0

// A failure outside the checks (the app not starting, say) is reported on the CI run page too.
const crash = (err) => {
  console.log('ERROR', err)
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=editing (${process.platform})::stopped after ${passed} checks: ${String(err?.message || err).split('\n')[0]}`)
  }
  process.exit(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`)
  if (ok) passed++
  else failures.push(name)
}
const eq = (name, actual, expected) => check(name, actual === expected, `got ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`)

const app = await electron.launch({
  args: ['.', docPath],
  env: { ...process.env, TYPEX_TEST: '1', TYPEX_USER_DATA: profile, TYPEX_EXPORT_DIR: out }
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') {
    console.log('[console.error]', m.text())
    errors.push(m.text())
  }
})
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message)
  errors.push(e.message)
})

const key = (k) => page.keyboard.press(k)
const type = (t) => page.keyboard.type(t)
const text = () => page.evaluate(() => window.__typexApp.getText())
// Screenshots are for people looking at a run, not checks; capturing a virtual
// display (Xvfb on CI) occasionally fails, which must not fail the suite.
const shot = (name) =>
  page.screenshot({ path: join(out, name) }).catch((err) => console.log(`(screenshot ${name} skipped: ${String(err.message).split('\n')[0]})`))
const settle = (ms = 150) => page.waitForTimeout(ms)
/** Replaces the document and puts the caret at its end. */
const load = async (md) => {
  await page.evaluate((m) => {
    const a = window.__typexApp
    a.editor.setMarkdown(m)
    a.editor.focus()
  }, md)
  await key('Control+End')
  await settle(80)
}
const count = (sel) => page.locator(sel).count()

try {
  await page.waitForSelector('#write p', { timeout: 60000 })
  await settle(800)

  /* ---------------------------- typing shortcuts --------------------------- */
  await load('')
  await type('# Title')
  check('heading appears as soon as "# " is typed', (await count('#write h1')) === 1)
  await key('Enter')
  await type('> quoted')
  await key('Enter')
  await key('Enter')
  await type('1. first')
  await key('Enter')
  await type('second')
  await key('Enter')
  await key('Enter')
  await type('- [ ] todo')
  await key('Enter')
  await type('next')
  await settle()
  eq('block shortcuts', await text(), '# Title\n\n> quoted\n\n1. first\n2. second\n\n- [ ] todo\n- [ ] next\n')

  /* ------------------------------ marker reveal ---------------------------- */
  await load('Hello **bold** world')
  check('markers hidden away from the caret', (await count('#write .md-meta.md-show')) === 0)
  for (let i = 0; i < 8; i++) await key('ArrowLeft')
  await settle()
  check('markers revealed around the caret', (await count('#write .md-meta.md-show')) === 2)
  await shot('e2e-01-markers.png')
  await key('Control+Home')
  await settle()
  check('markers hidden again', (await count('#write .md-meta.md-show')) === 0)

  /* -------------------------------- code fence ----------------------------- */
  await load('')
  await type('```js')
  await key('Enter')
  await settle(300)
  check('fence created', (await count('#write .md-fences')) === 1)
  await type('let a = 1')
  await key('Enter')
  await type('let b = 2')
  await settle(300)
  await shot('e2e-02-fence.png')
  await key('Control+Enter')
  await type('after')
  await settle()
  eq('code fence', await text(), '```js\nlet a = 1\nlet b = 2\n```\n\nafter\n')
  check('code is highlighted', (await count('#write .md-fences .tok-keyword')) >= 2)

  /* -------------------------------- math block ----------------------------- */
  await load('')
  await type('$$')
  await key('Enter')
  await settle(300)
  await type('x^2 + y^2')
  await settle(500)
  await shot('e2e-03-math.png')
  await key('ArrowDown')
  await type('below')
  await settle(400)
  eq('math block', await text(), '$$\nx^2 + y^2\n$$\n\nbelow\n')
  check('math rendered', (await count('#write .md-math-block mjx-container')) === 1)
  check('math editor hidden when unfocused', !(await page.locator('#write .md-math-block .md-cm-host').isVisible()))

  /* ---------------------------------- table -------------------------------- */
  await load('')
  await type('| Name | Qty |')
  await key('Enter')
  await settle(200)
  check('table created', (await count('#write table')) === 1)
  await type('Apple')
  await key('Tab')
  await type('3')
  await key('Tab')
  await type('Pear')
  await key('Tab')
  await type('5')
  await settle(300)
  await shot('e2e-04-table.png')
  eq('table', await text(), '| Name  | Qty |\n| ----- | --- |\n| Apple | 3   |\n| Pear  | 5   |\n')
  check('table toolbar shown', await page.locator('#table-toolbar').isVisible())
  await page.evaluate(() => window.__typexApp.run('table.alignRight'))
  await settle()
  eq('column alignment', await text(), '| Name  | Qty |\n| ----- | --: |\n| Apple |   3 |\n| Pear  |   5 |\n')
  await key('Enter')
  await type('out')
  await settle()
  check('Enter on the last row leaves the table', (await text()).endsWith('|\n\nout\n'))

  /* ------------------------------ structure keys --------------------------- */
  await load('# Title')
  await key('Home')
  await key('Backspace')
  await settle()
  eq('Backspace at heading start', await text(), 'Title\n')

  await load('- a\n- b')
  await page.locator('#write li').nth(1).click()
  await key('Tab')
  await settle()
  eq('Tab nests a list item', await text(), '- a\n  - b\n')
  await key('Shift+Tab')
  await settle()
  eq('Shift+Tab lifts it back', await text(), '- a\n- b\n')
  await key('End')
  await key('Enter')
  await key('Enter')
  await type('out')
  await settle()
  eq('Enter on an empty item leaves the list', await text(), '- a\n- b\n\nout\n')

  // Clicking out of an embedded editor and typing at once must land at the click.
  await load('---\ntitle: x\n---\n\nfirst\n\n```\ncode\n```\n\nlast')
  await page.locator('#write .md-fences .cm-content').click()
  await settle(200)
  await page.locator('#write > p').last().click()
  await type('!')
  await settle()
  check('typing right after clicking out of a code block', (await text()).includes('last!') || (await text()).includes('!last') || /la!st|l!ast/.test(await text()), await text())
  check('the code block was not modified', (await text()).includes('```\ncode\n```'))

  await load('one')
  await type(' two')
  await settle(600)
  await type(' three')
  await key('Control+z')
  await settle()
  check('undo', (await text()) !== 'one two three\n' && (await text()).startsWith('one'))
  await key('Control+y')
  await settle()
  eq('redo', await text(), 'one two three\n')

  await load('line')
  await key('Shift+Enter')
  await type('break')
  await settle()
  eq('Shift+Enter inserts a line break', await text(), 'line\nbreak\n')

  /* --------------------------------- commands ------------------------------ */
  await load('some words here')
  await page.evaluate(() => window.__typexApp.run('paragraph.heading2'))
  await settle()
  eq('heading command', await text(), '## some words here\n')
  await page.evaluate(() => window.__typexApp.run('paragraph.quote'))
  await settle()
  eq('quote command', await text(), '> ## some words here\n')
  await page.evaluate(() => window.__typexApp.run('paragraph.quote'))
  await page.evaluate(() => window.__typexApp.run('paragraph.paragraph'))
  await page.evaluate(() => window.__typexApp.run('paragraph.taskList'))
  await settle()
  eq('task list command', await text(), '- [ ] some words here\n')
  await page.evaluate(() => window.__typexApp.run('paragraph.taskList'))
  await settle()
  eq('task list command toggles off', await text(), 'some words here\n')

  /* ---------------------------- menu accelerators -------------------------- */
  // Browser-level input events go through the same path as real key presses,
  // including the application menu's accelerators.
  const accel = async (keyCode, modifiers = []) => {
    await app.evaluate(
      ({ BrowserWindow }, [k, m]) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents
        wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m })
        wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m })
      },
      [keyCode, modifiers]
    )
    await settle(300)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await load('alpha beta')
  await accel('2', ['control'])
  eq('Ctrl+2 makes a heading', await text(), '## alpha beta\n')
  await accel('0', ['control'])
  eq('Ctrl+0 makes a paragraph', await text(), 'alpha beta\n')
  await accel('B', ['control'])
  eq('Ctrl+B applies strong exactly once', await text(), 'alpha **beta**\n')
  await accel('B', ['control'])
  eq('Ctrl+B again removes it', await text(), 'alpha beta\n')
  await accel('I', ['control'])
  eq('Ctrl+I applies emphasis', await text(), 'alpha *beta*\n')
  await accel('Z', ['control'])
  eq('Ctrl+Z undoes it', await text(), 'alpha beta\n')
  await accel('/', ['control'])
  check('Ctrl+/ enters source mode', await page.evaluate(() => document.body.classList.contains('source-mode')))
  await accel('/', ['control'])
  check('Ctrl+/ leaves source mode', !(await page.evaluate(() => document.body.classList.contains('source-mode'))))
  await accel('F', ['control'])
  check('Ctrl+F opens the find bar', await page.evaluate(() => document.querySelector('#findbar').classList.contains('open')))
  await key('Escape')
  await accel('Q', ['control', 'shift'])
  eq('Ctrl+Shift+Q quotes', await text(), '> alpha beta\n')
  await accel('Q', ['control', 'shift'])
  await accel('K', ['control', 'shift'])
  eq('Ctrl+Shift+K makes a code fence', await text(), '```\nalpha beta\n```\n')
  await accel('F8')
  check('F8 toggles focus mode', (await count('#write.md-focus-mode')) === 1)
  await accel('F8')
  await load('- a\n- b')
  await page.locator('#write li').nth(1).click()
  await accel('[', ['control'])
  eq('Ctrl+[ indents a list item', await text(), '- a\n  - b\n')
  await accel(']', ['control'])
  eq('Ctrl+] outdents it', await text(), '- a\n- b\n')

  /* ------------------------- macOS and Linux menus -------------------------- */
  // The menus of the other platforms are built from the same template; check
  // them here, since this run cannot show them.
  const menuOf = (platform, idle = false) =>
    app.evaluate((_e, [p, i]) => globalThis.__typexMenuTemplate(p, i), [platform, idle])
  const find = (menu, ...path) => {
    let items = menu
    let item
    for (const part of path) {
      item = (items || []).find((i) => i.label === part || i.role === part)
      if (!item) return undefined
      items = item.submenu
    }
    return item
  }
  const accelOf = (menu, ...path) => find(menu, ...path)?.accelerator
  const duplicates = (menu) => {
    const seen = new Map()
    const dupes = []
    const walk = (items) => {
      for (const i of items) {
        if (i.accelerator) {
          if (seen.has(i.accelerator)) dupes.push(`${i.accelerator}: ${seen.get(i.accelerator)} / ${i.label}`)
          else seen.set(i.accelerator, i.label)
        }
        if (i.submenu) walk(i.submenu)
      }
    }
    walk(menu)
    return dupes
  }
  const mac = await menuOf('darwin')
  check('macOS: the application menu comes first', mac[0].label === 'TypeX' && ['about', 'services', 'hideOthers', 'quit'].every((r) => find(mac, 'TypeX', r)))
  eq('macOS: Preferences in the application menu', accelOf(mac, 'TypeX', 'Preferences…'), 'Command+,')
  check('macOS: no Preferences or About in File and Help', !find(mac, 'File', 'Preferences...') && !find(mac, 'Help', 'About TypeX'))
  check('macOS: has a Window menu', !!find(mac, 'window'))
  eq('macOS: New Tab', accelOf(mac, 'File', 'New Tab'), 'Command+T')
  eq('macOS: Open Quickly', accelOf(mac, 'File', 'Open Quickly...'), 'Command+Shift+O')
  eq('macOS: Code Fences', accelOf(mac, 'Paragraph', 'Code Fences'), 'Command+Option+C')
  eq('macOS: Math Block', accelOf(mac, 'Paragraph', 'Math Block'), 'Command+Option+B')
  eq('macOS: Insert Table', accelOf(mac, 'Paragraph', 'Table', 'Insert Table...'), 'Command+Option+T')
  eq('macOS: Strike', accelOf(mac, 'Format', 'Strike'), 'Control+Shift+`')
  eq('macOS: Image', accelOf(mac, 'Format', 'Image', 'Insert Image...'), 'Command+Control+I')
  eq('macOS: Outline', accelOf(mac, 'View', 'Outline'), 'Command+Control+1')
  eq('macOS: Find Next', accelOf(mac, 'Edit', 'Find and Replace', 'Find Next'), 'Command+G')
  eq('macOS: Jump to Top', accelOf(mac, 'Edit', 'Jump to Top'), 'Command+Up')
  eq('macOS: Redo', accelOf(mac, 'Edit', 'Redo'), 'Shift+Command+Z')
  check('macOS: Reveal in Finder', !!find(mac, 'File', 'Reveal in Finder...'))
  eq('macOS: no shortcut is used twice', duplicates(mac).join('; '), '')
  const idle = await menuOf('darwin', true)
  check(
    'macOS: with no window open, the menu can still create and open documents',
    accelOf(idle, 'File', 'New') === 'Command+N' && accelOf(idle, 'File', 'Open…') === 'Command+O' && !find(idle, 'Paragraph')
  )
  const linux = await menuOf('linux')
  eq('Linux: menu bar', linux.map((i) => i.label).join(' '), '&File &Edit &Paragraph F&ormat &View &Themes &Help')
  eq('Linux: Code Fences', accelOf(linux, '&Paragraph', 'Code Fences'), 'Ctrl+Shift+K')
  check('Linux: Open Containing Folder', !!find(linux, '&File', 'Open Containing Folder...'))
  eq('Linux: no shortcut is used twice', duplicates(linux).join('; '), '')
  eq('Windows: no shortcut is used twice', duplicates(await menuOf('win32')).join('; '), '')

  /* ------------------------------ task checkbox ---------------------------- */
  await load('- [ ] todo\n- [x] done')
  await page.locator('#write .md-task-checkbox').first().click()
  await settle()
  eq('clicking a checkbox ticks the task', await text(), '- [x] todo\n- [x] done\n')
  await page.locator('#write .md-task-checkbox').nth(1).click()
  await settle()
  eq('clicking again unticks it', await text(), '- [x] todo\n- [ ] done\n')

  await load('alpha beta')
  await page.evaluate(() => window.__typexApp.run('format.em'))
  await settle()
  eq('emphasis wraps the word at the caret', await text(), 'alpha *beta*\n')
  await page.evaluate(() => window.__typexApp.run('format.em'))
  await settle()
  eq('emphasis toggles off', await text(), 'alpha beta\n')
  await page.evaluate(() => window.__typexApp.run('format.link'))
  await settle()
  check('link command', (await text()).includes('[]()') || (await text()).includes('[beta]()'), await text())

  /* ---------------------------- emoji autocomplete -------------------------- */
  const emojiList = page.locator('.md-autocomplete:not(.md-slash-menu)')
  await load('Hello')
  await type(' :smi')
  await settle(200)
  check('emoji suggestions appear after a colon and a few letters', await emojiList.isVisible())
  check('suggestions show the emoji', (await emojiList.locator('.md-autocomplete-item').first().innerText()).includes('\u{1F604}'))
  await key('ArrowDown')
  await key('ArrowUp')
  await key('Enter')
  await settle()
  eq('Enter inserts the highlighted shortcode', await text(), 'Hello :smile:\n')
  check('the suggestion list closes', !(await emojiList.isVisible()))
  await type(' at 10:30')
  await settle(200)
  check('no suggestions after a digit (times of day)', !(await emojiList.isVisible()))
  await type(' :rock')
  await settle(200)
  await key('Escape')
  await settle()
  check('Escape dismisses the suggestions', !(await emojiList.isVisible()))
  eq('dismissing leaves the typed text', await text(), 'Hello :smile: at 10:30 :rock\n')
  await key('Enter')
  await settle()
  eq('Enter after dismissing inserts nothing', await text(), 'Hello :smile: at 10:30 :rock\n')
  check('Enter after dismissing starts a new paragraph', (await count('#write > p')) === 2)

  /* ------------------------------ slash commands ---------------------------- */
  const slashMenu = page.locator('.md-slash-menu')
  const slashActive = () => page.locator('.md-slash-item.active').getAttribute('data-id')
  await load('')
  await type('/')
  await settle(200)
  check('typing "/" on an empty line opens the block list', await slashMenu.isVisible())
  eq('the list starts with Heading 1', await slashActive(), 'h1')
  const secondRow = await page.locator('.md-slash-item').nth(1).innerText()
  check('each entry shows its name and its Markdown', secondRow.includes('Heading 2') && secondRow.includes('##'), secondRow)
  await type('h2')
  await settle(150)
  eq('typing filters the list', await slashActive(), 'h2')
  await key('Enter')
  await settle()
  check('Enter turns the line into the chosen block', (await count('#write h2')) === 1)
  check('the block list closes', !(await slashMenu.isVisible()))
  await type('Section')
  await key('Enter')
  await type('Intro /tab')
  await settle(150)
  await key('Enter')
  await settle(300)
  check('a table goes below a line that has text', (await count('#write table')) === 1)
  check('the line keeps its text, without "/tab"', (await text()).startsWith('## Section\n\nIntro\n\n|'), await text())
  await key('Control+z')
  await settle()
  eq('one undo removes the table and brings back the typed text', await text(), '## Section\n\nIntro /tab\n')
  check('undo does not reopen the block list', !(await slashMenu.isVisible()))

  await load('')
  await type('/h')
  await settle(150)
  await key('ArrowDown')
  await key('ArrowDown')
  await key('ArrowUp')
  eq('arrow keys move through the list', await slashActive(), 'h2')
  await key('Tab')
  await settle()
  check('Tab inserts the highlighted block', (await count('#write h2')) === 1)

  await load('')
  await type('/quo')
  await settle(150)
  await page.locator('.md-slash-item[data-id="quote"]').click()
  await settle()
  check('clicking an entry inserts it', (await count('#write blockquote')) === 1)
  check('the caret stays in the editor after a click', await page.evaluate(() => !!document.activeElement?.closest('#write')))

  await load('')
  await type('/co')
  await settle(150)
  await key('Escape')
  await settle()
  check('Escape dismisses the block list', !(await slashMenu.isVisible()))
  await type('de')
  await settle(150)
  check('the list stays closed while typing on', !(await slashMenu.isVisible()))
  await key('Enter')
  await settle()
  eq('Escape leaves the typed text as text', await text(), '/code\n')
  check('and Enter starts a new paragraph', (await count('#write > p')) === 2)
  await load('')
  await type('and/or 1/2 ./x')
  await settle(150)
  check('a slash inside a word opens nothing', !(await slashMenu.isVisible()))

  // Preferences > Editor turns the feature off and on.
  const slashSwitch = async (on) => {
    await page.evaluate(() => window.__typexApp.run('app.preferences'))
    await settle(300)
    await page.locator('.prefs-nav button[data-id="editor"]').click()
    const input = page.locator('.prefs-section[data-id="editor"] label', { hasText: 'Slash commands' }).locator('input')
    const was = await input.isChecked()
    if (on) await input.check()
    else await input.uncheck()
    await settle(300)
    await key('Escape')
    await settle(200)
    return was
  }
  check('Preferences > Editor has the slash-command switch, on by default', (await slashSwitch(false)) === true)
  await load('')
  await type('/')
  await settle(200)
  check('with the switch off, "/" opens nothing', !(await slashMenu.isVisible()))
  eq('and stays a plain slash', await text(), '/\n')
  check('the switch remembers that it is off', (await slashSwitch(true)) === false)
  await load('')
  await type('/')
  await settle(200)
  check('switched back on, "/" opens the list again', await slashMenu.isVisible())
  await key('Escape')

  /* ------------------------------- context menus --------------------------- */
  const contextMenu = async (locator) => {
    await app.evaluate(() => void (globalThis.__typexLastContextMenu = null))
    await locator.click({ button: 'right' })
    for (let i = 0; i < 20; i++) {
      const menu = await app.evaluate(() => globalThis.__typexLastContextMenu)
      if (menu) return JSON.stringify(menu)
      await settle(100)
    }
    return ''
  }
  await load('plain **bold** text\n\n| a | b |\n| - | - |\n| 1 | 2 |')
  let menu = await contextMenu(page.locator('#write > p').first())
  check('editor context menu', ['"Cut"', '"Copy"', '"Paste"', '"Format"', '"Paragraph"', '"Insert"'].every((s) => menu.includes(s)), menu)
  menu = await contextMenu(page.locator('#write td').first())
  check('table context menu', menu.includes('"Table"') && menu.includes('Add Row Below') && !menu.includes('"Insert"'), menu)
  await page.evaluate(() => window.__typexApp.run('view.files'))
  await settle(500)
  menu = await contextMenu(page.locator('.tree-row', { hasText: 'e2e.md' }))
  check('file tree context menu', ['"Open"', '"Rename"', '"Delete"', '"New File"'].every((s) => menu.includes(s)), menu)
  await page.evaluate(() => window.__typexApp.run('view.sidebar'))

  /* -------------------------------- source mode ---------------------------- */
  await load('First line\n\nsecond needle line\n\nthird needle')
  await page.evaluate(() => window.__typexApp.run('view.source'))
  await settle(300)
  await page.evaluate(() => window.__typexApp.run('edit.find'))
  await type('needle')
  await settle(400)
  check('source mode: find highlights matches', (await count('#source .cm-searchMatch')) === 2, String(await count('#source .cm-searchMatch')))
  await key('Escape')
  await page.evaluate(() => {
    const a = window.__typexApp
    a.source.gotoLine(0)
    a.source.focus()
  })
  await page.evaluate(() => window.__typexApp.run('paragraph.heading2'))
  await settle()
  check('source mode: heading command prefixes the line', (await text()).startsWith('## First line\n'))
  await key('End')
  await type(' ')
  await page.evaluate(() => window.__typexApp.run('format.strong'))
  await type('bold')
  await settle()
  check('source mode: strong command wraps', (await text()).startsWith('## First line **bold**\n'), await text())
  await page.evaluate(() => window.__typexApp.run('view.source'))
  await settle(300)
  check('source mode: edits carry back to the live view', (await count('#write h2')) === 1 && (await count('#write h2 strong')) === 1)

  /* ---------------------------------- images ------------------------------- */
  await load('![icon](icon.png)')
  await page.waitForFunction(() => {
    const img = document.querySelector('#write .md-image img')
    return img && img.complete
  })
  const loaded = await page.evaluate(() => document.querySelector('#write .md-image img').naturalWidth)
  check('relative local image loads', loaded === 256, `naturalWidth ${loaded}`)
  await shot('e2e-05-image.png')

  /* -------------------------------- clipboard ------------------------------ */
  await load('Copy **this** text')
  await key('Control+a')
  await key('Control+c')
  await settle(300)
  eq('copy puts Markdown on the clipboard', await page.evaluate(() => window.typex.invoke('clipboard:readText')), 'Copy **this** text')
  await load('')
  await page.evaluate(() =>
    window.typex.invoke('clipboard:write', {
      text: 'Title\nbold and link',
      html: '<h2>Title</h2><p><b>bold</b> and <a href="https://example.com">link</a></p><ul><li>one</li><li>two</li></ul>'
    })
  )
  await key('Control+v')
  await settle(400)
  eq('pasted HTML becomes Markdown', await text(), '## Title\n\n**bold** and [link](https://example.com)\n\n- one\n- two\n')

  /* ---------------------------------- export ------------------------------- */
  await load(
    '# Export\n\nText with $a^2$ and a note[^n].\n\n```js\nconst x = 1\n```\n\n- [x] done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[toc]\n\n[^n]: The note.'
  )
  const html = await page.evaluate(() => window.__typexApp.exportHtml(true, false))
  check('export: heading id', html.includes('<h1 id="export">'))
  check('export: highlighted code', html.includes('class="tok-keyword"'))
  check('export: math as SVG', html.includes('<mjx-container') && html.includes('<svg'))
  check('export: task list', html.includes('type="checkbox" disabled checked'))
  check('export: table', html.includes('<th>a</th>') && html.includes('<td>2</td>'))
  check('export: footnotes', html.includes('class="footnotes"') && html.includes('The note.'))
  check('export: table of contents', html.includes('class="toc"') && html.includes('href="#export"'))
  check('export: theme styles inlined', html.includes('--bg-color'))
  writeFileSync(join(out, 'export.html'), html, 'utf8')

  await page.evaluate(() => window.__typexApp.run('file.export', 'pdf'))
  const pdfPath = join(out, 'e2e.pdf')
  for (let i = 0; i < 60 && !existsSync(pdfPath); i++) await settle(250)
  check('export: PDF written', existsSync(pdfPath) && readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-')

  /* ------------------------------------ language ----------------------------- */
  // Switching language reloads the window; the open document and its unsaved
  // changes must survive that.
  const switchLanguage = async (language) => {
    const loaded = page.waitForEvent('load', { timeout: 20000 })
    // The page reloads while this call is still answering, which ends the call.
    await page.evaluate((l) => window.typex.invoke('prefs:set', { language: l }), language).catch(() => {})
    await loaded
    await page.waitForFunction((l) => document.documentElement.lang === l && window.__typexApp, language, { timeout: 20000 })
    await page.waitForSelector('#write h1')
    await settle(600)
  }
  await load('# Language test\n\nSome **text** here.')
  await key('Control+End')
  await type(' unsaved')
  await settle()
  const beforeSwitch = await text()
  const windowTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  await switchLanguage('zh-CN')
  eq('language switch keeps the document', await text(), beforeSwitch)
  check('language switch keeps it marked unsaved', (await windowTitle()).includes('•'), await windowTitle())
  eq('menus switch language', (await menuOf('win32')).map((i) => i.label).join(' '), '文件(&F) 编辑(&E) 段落(&P) 格式(&O) 视图(&V) 主题(&T) 帮助(&H)')
  eq('macOS menu labels drop the access keys', (await menuOf('darwin'))[1].label, '文件')
  check('status bar switches language', (await page.locator('#statusbar .status-item').innerText()).includes('词'))
  eq('sidebar switches language', await page.locator('.sidebar-tab').first().innerText(), '文件')
  await page.evaluate(() => window.__typexApp.run('app.preferences'))
  await settle(300)
  eq('preferences show the language setting', await page.locator('#prefs-language').inputValue(), 'zh-CN')
  await page.locator('#prefs-language').selectOption('ru').catch(() => {})
  await page.waitForFunction(() => document.documentElement.lang === 'ru' && window.__typexApp, null, { timeout: 20000 })
  await page.waitForSelector('#write h1')
  await settle(600)
  check('changing the setting in Preferences switches language', (await menuOf('win32'))[0].label === '&Файл')
  check('Preferences reopen after the switch', await page.locator('.prefs').isVisible())
  eq('the document is still there', await text(), beforeSwitch)
  await shot('e2e-06-russian.png')
  await key('Escape')
  await switchLanguage('en')
  eq('back in English', (await menuOf('win32'))[0].label, '&File')
  eq('the document survives every switch', await text(), beforeSwitch)

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  console.log('ERROR', err)
  failures.push(`exception: ${String(err?.message || err).split('\n')[0]}`)
  await shot('e2e-error.png').catch(() => {})
} finally {
  await page.evaluate(() => window.typex.invoke('win:close')).catch(() => {})
  await app.close().catch(() => {})
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
console.log(`Artifacts: ${out}`)
if (process.env.GITHUB_ACTIONS === 'true') {
  // A one-line result on the workflow run page (also readable through the public API).
  console.log(
    failures.length
      ? `::error title=editing (${process.platform})::${failures.length} of ${passed + failures.length} checks failed: ${failures.join('; ')}`
      : `::notice title=editing (${process.platform})::${passed} checks passed`
  )
}
process.exit(failures.length ? 1 : 0)
