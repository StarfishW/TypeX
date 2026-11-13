// Launches the packaged application and checks that it starts, opens a file
// passed on the command line and renders it. On Windows it also checks that
// the language chosen in the installer becomes the interface language.
//
//   npm run pack && node scripts/check-package.mjs [path-to-executable]
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where electron-builder puts the unpacked app for the current platform and CPU. */
function defaultExecutable() {
  const dist = join(root, 'dist')
  const arm = process.arch === 'arm64'
  if (process.platform === 'win32') return join(dist, arm ? 'win-arm64-unpacked' : 'win-unpacked', 'TypeX.exe')
  if (process.platform === 'darwin') return join(dist, arm ? 'mac-arm64' : 'mac', 'TypeX.app', 'Contents', 'MacOS', 'TypeX')
  return join(dist, arm ? 'linux-arm64-unpacked' : 'linux-unpacked', 'typex')
}

const exe = process.argv[2] || defaultExecutable()
if (!existsSync(exe)) {
  console.error(`Not found: ${exe}\nRun "npm run pack" first.`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'typex-pkg-'))
const file = join(dir, 'packaged.md')
writeFileSync(file, '# Packaged build\n\nIt **works**: $a^2 + b^2 = c^2$\n\n```js\nconst ok = true\n```\n')

let failed = 0
let passed = 0
let shownTitle = ''
const problems = []

// A failure outside the checks (the app not starting, say) is reported on the CI run page too.
const crash = (err) => {
  console.log('ERROR', err)
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=packaged app (${process.platform} ${process.arch})::stopped after ${passed} checks: ${String(err?.message || err).split('\n')[0]}`)
  }
  process.exit(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  ' + detail}`)
  if (ok) passed++
  else failed++
}

async function launch() {
  const app = await electron.launch({
    executablePath: exe,
    args: [file],
    env: { ...process.env, TYPEX_TEST: '1', TYPEX_USER_DATA: mkdtempSync(join(tmpdir(), 'typex-profile-')) }
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForSelector('#write h1', { timeout: 60000 })
  return { app, page, errors }
}

async function quit(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {})
  await app.close().catch(() => {})
}

let resources = ''
{
  const { app, page, errors } = await launch()
  try {
    await page.waitForSelector('#write .md-math mjx-container', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    check('packaged app is flagged as packaged', await app.evaluate(({ app: a }) => a.isPackaged))
    check('app name is TypeX', (await app.evaluate(({ app: a }) => a.name)) === 'TypeX')
    check('file from the command line is open', (await page.locator('#write h1').innerText()) === 'Packaged build')
    check('inline math renders', (await page.locator('#write .md-math mjx-container').count()) === 1)
    check('code is highlighted', (await page.locator('#write .md-fences .tok-keyword').count()) >= 1)
    // macOS shows only the document name; the app name is in the menu bar.
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    shownTitle = title
    check('window title', title === (process.platform === 'darwin' ? 'packaged.md' : 'packaged.md - TypeX'), title)
    resources = await app.evaluate(() => process.resourcesPath)
    check(
      'license files are bundled',
      existsSync(join(resources, 'LICENSE.txt')) && existsSync(join(resources, 'THIRD_PARTY_LICENSES.txt')),
      resources
    )
    check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    // A screenshot is a visual aid, not a check; a failed capture must not fail the run.
    if (process.env.SMOKE_OUT) await page.screenshot({ path: join(process.env.SMOKE_OUT, 'packaged.png') }).catch(() => {})
  } catch (err) {
    console.log('ERROR', err)
    problems.push(String(err?.message || err).split('\n')[0])
    failed++
  } finally {
    await quit(app)
  }
}

// The Windows installer leaves the language chosen at its start next to the app.
if (process.platform === 'win32' && resources) {
  const marker = join(resources, 'installer-language.txt')
  writeFileSync(marker, 'de')
  const { app, page } = await launch()
  try {
    const menu = await app.evaluate(() => globalThis.__typexMenuTemplate('win32'))
    check('the installer language becomes the interface language', menu[0].label === '&Datei', menu[0].label)
    check('the window uses it too', (await page.evaluate(() => document.documentElement.lang)) === 'de')
  } catch (err) {
    console.log('ERROR', err)
    problems.push(String(err?.message || err).split('\n')[0])
    failed++
  } finally {
    await quit(app)
    rmSync(marker, { force: true })
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nPackaged app works')
if (process.env.GITHUB_ACTIONS === 'true') {
  // A one-line result on the workflow run page (also readable through the public API).
  const where = `packaged app (${process.platform} ${process.arch})`
  console.log(
    failed
      ? `::error title=${where}::${failed} of ${passed + failed} checks failed ${problems.join('; ')}`
      : `::notice title=${where}::${passed} checks passed; window title "${shownTitle}"`
  )
}
process.exit(failed ? 1 : 0)
