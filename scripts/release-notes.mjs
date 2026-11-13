// Writes the notes for a GitHub release, built from the README so that every
// release carries the current project description and install instructions.
//
//   node scripts/release-notes.mjs [tag] > release-notes.md
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n?/g, '\n')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = process.argv[2] || `v${version}`
const v = tag.replace(/^v/, '')

const repo = process.env.GITHUB_REPOSITORY
const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
const repoUrl = repo ? `${server}/${repo}` : ''

/** The first paragraph after the title: the project description. */
function description() {
  const body = readme.replace(/^# .*\n+/, '')
  return body.split(/\n{2,}/)[0].trim()
}

/** A `## heading` section of the README, without its heading. */
function section(heading) {
  const lines = readme.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return ''
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

/** README links point into the repository; in release notes they must be absolute. */
function absolutize(markdown) {
  if (!repoUrl) return markdown
  return markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, target) => `](${repoUrl}/blob/${tag}/${target})`).replace(
    /\]\(#([^)\s]+)\)/g,
    (_m, anchor) => `](${repoUrl}/blob/${tag}/README.md#${anchor})`
  )
}

const downloads = [
  ['Windows', `\`TypeX-${v}-win-setup.exe\` (installer) or \`TypeX-${v}-win.zip\` (portable)`],
  ['macOS, Apple silicon', `\`TypeX-${v}-mac-arm64.dmg\` (or \`.zip\`)`],
  ['macOS, Intel', `\`TypeX-${v}-mac-x64.dmg\` (or \`.zip\`)`],
  ['Linux, x64', `\`TypeX-${v}-linux-x86_64.AppImage\` or \`TypeX-${v}-linux-x64.tar.gz\``],
  ['Linux, ARM64', `\`TypeX-${v}-linux-arm64.AppImage\` or \`TypeX-${v}-linux-arm64.tar.gz\``]
]

const parts = [
  description(),
  '## Downloads',
  ['| System | File |', '| --- | --- |', ...downloads.map(([system, file]) => `| ${system} | ${file} |`)].join('\n'),
  section('Install') ? `## Install\n\n${section('Install').replace(/<version>/g, v)}` : '',
  section('Languages') ? `## Languages\n\n${section('Languages')}` : '',
  repoUrl ? `See the [README](${repoUrl}/blob/${tag}/README.md) for the full feature list and documentation.` : ''
]

process.stdout.write(absolutize(parts.filter(Boolean).join('\n\n')) + '\n')
