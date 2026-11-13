// Collects the license texts of the open-source packages bundled into the
// renderer and writes them to resources/THIRD_PARTY_LICENSES.txt, which the
// installer ships next to the application.
//
// Starts from the packages the source imports and follows their runtime
// dependencies, so it may list a few packages that tree-shaking later drops.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = [
  'prosemirror-commands', 'prosemirror-dropcursor', 'prosemirror-gapcursor', 'prosemirror-history',
  'prosemirror-inputrules', 'prosemirror-keymap', 'prosemirror-model', 'prosemirror-schema-list',
  'prosemirror-state', 'prosemirror-tables', 'prosemirror-transform', 'prosemirror-view',
  'codemirror', '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/lang-markdown',
  '@codemirror/language', '@codemirror/language-data', '@codemirror/legacy-modes', '@codemirror/search',
  '@codemirror/state', '@codemirror/view', '@lezer/highlight',
  'markdown-it', 'mathjax-full', 'mermaid', 'dompurify', 'turndown', 'turndown-plugin-gfm', 'gemoji'
]

/** Finds a package the way Node resolves it from `fromDir`. */
function locate(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The declared license, or one recognised from the license text when the field is missing. */
function licenseOf(pkg, text) {
  const declared = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type
  if (declared) return declared.replace(/^\((.*)\)$/, '$1')
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(text)) return 'MIT'
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC'
  if (/Apache License,? Version 2\.0/i.test(text)) return 'Apache-2.0'
  return 'see license text'
}

/** Where the package's source code can be obtained. */
function sourceOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!repo) return pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`
  if (/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.startsWith('github:')) return `https://github.com/${repo.replace(/^github:/, '')}`
  return repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '')
}

const seen = new Map()
const queue = ROOTS.map((name) => [name, root])
while (queue.length) {
  const [name, from] = queue.shift()
  const dir = locate(name, from)
  if (!dir || seen.has(dir)) continue
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f))
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : ''
  seen.set(dir, { name: pkg.name, version: pkg.version, license: licenseOf(pkg, text), source: sourceOf(pkg), text })
  for (const dep of Object.keys(pkg.dependencies || {})) queue.push([dep, dir])
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const parts = [
  'TypeX includes the following open-source software, unmodified. Each entry below',
  'names the license and where the complete source code can be obtained.',
  '',
  ...entries.map((e) => `- ${e.name} ${e.version} (${e.license})`),
  ''
]
for (const e of entries) {
  parts.push('='.repeat(78), `${e.name} ${e.version}`, `License: ${e.license}`, `Source: ${e.source}`, '-'.repeat(78))
  parts.push(e.text || `No license file is included in the package; it is published under ${e.license}.`, '')
}
writeFileSync(join(root, 'resources', 'THIRD_PARTY_LICENSES.txt'), parts.join('\n'), 'utf8')
console.log(`${entries.length} packages written to resources/THIRD_PARTY_LICENSES.txt`)
