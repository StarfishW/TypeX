# TypeX

A free, open-source Markdown editor with seamless live preview. There is no separate preview pane: what you type is rendered in place, and the Markdown syntax reappears only around the caret, ready to edit.

## Install

Download the file for your system from the [latest release](https://github.com/StarfishW/TypeX/releases/latest). The packages are not signed with a paid certificate yet, so each system asks for confirmation the first time.

**Windows.** Run `TypeX-<version>-win-setup.exe`. The installer starts by asking for a language, and TypeX opens in that language. Or unzip `TypeX-<version>-win.zip` and start `TypeX.exe`. SmartScreen shows "Windows protected your PC"; choose **More info**, then **Run anyway**.

**macOS.** Open the DMG that matches your Mac (`arm64` for Apple silicon, `x64` for Intel) and drag TypeX to Applications. The app is not notarized by Apple, so the first launch is blocked:
- macOS 15 and later: open **System Settings > Privacy & Security** and choose **Open Anyway** next to the TypeX message.
- Earlier versions: Control-click TypeX in Applications, choose **Open**, then **Open** again.

**Linux.**
- **AppImage** (any distribution): make it executable and run it, for example `chmod +x TypeX-<version>-linux-x86_64.AppImage`, then `./TypeX-<version>-linux-x86_64.AppImage`. Where the system restricts the Chromium sandbox, as Ubuntu 24.04 does, the AppImage turns it off for itself and starts anyway.
- **tar.gz**: extract it and run `./typex`. On Ubuntu 24.04 and later, enable the sandbox helper once with `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in the extracted folder.

The Windows installer, the macOS app and the Linux desktop entry register TypeX for `.md`, `.markdown`, `.mdown` and `.mkd` files.

## Languages

TypeX is available in English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português (Brasil) and Русский.

- **Default.** TypeX follows the system language, or English if the system language is not one of these.
- **Changing it.** Choose a language in **Preferences > General > Language**. The window switches immediately and keeps open documents and unsaved changes.
- **Windows installer.** The installer starts with a language selection, and TypeX uses that language from its first start.
- **Help pages.** Quick Start and Markdown Reference are in English.

To add or improve a translation, edit `src/shared/i18n/<language>.ts`. `npm test` checks that every message is translated, keeps its placeholders and has the plural forms the language needs.

## Features

- **Live preview editing.** Headings, emphasis, links, images, code, math and HTML render as you type. Moving the caret into an element shows its Markdown again.
- **Markdown coverage.** CommonMark and GFM blocks, plus:
  - task lists, tables, footnotes, link references and a `[toc]` table of contents
  - YAML front matter
  - `$$` math blocks and `$inline$` math, rendered with MathJax
  - Mermaid diagrams
  - `==highlight==`, `H~2~O` subscript, `x^2^` superscript and `:emoji:` shortcodes
  - inline HTML such as `<u>`, `<kbd>` and styled `<span>`
- **Slash commands.** Type `/` at the start of a line or after a space to insert a block from a list: headings, lists, quotes, code, math, tables, diagrams, dividers, a table of contents, images, links, footnotes or front matter.
  - Typing on filters the list, by name in the interface language or by English keywords (`/h2`, `/table`, `/todo`).
  - ↑ and ↓ choose, Enter or Tab inserts, and Esc closes the list and keeps what you typed. One undo brings the typed text back.
  - A slash inside a word, as in `and/or` or a path, opens nothing.
  - Turn it off in **Preferences > Editor**.
- **Code fences.** Syntax highlighting for over 100 languages, with a language field that suggests names.
- **Tables.** A toolbar for alignment and for adding and deleting rows and columns. Tab and Enter move between cells.
- **Source code mode** (`Ctrl+/`) shows the whole file as plain Markdown. The caret position carries over between modes.
- **Sidebar.**
  - Outline of the document.
  - File tree or article list of a folder, with new, rename and delete.
  - Search across every file in the folder.
- **Focus mode** (`F8`) and **typewriter mode** (`F9`).
- **Find and replace** with case, whole-word and regular-expression options.
- **Quick open** (`Ctrl+P`) and **reopen closed file** (`Ctrl+Shift+T`).
- **Images.** Paste, drag in or insert from disk. Optionally copy every inserted image into a folder next to the document (`./assets` or `./${filename}.assets`).
- **Export.**
  - PDF, HTML and print are built in.
  - Word, OpenOffice, RTF, EPUB, LaTeX, MediaWiki, reStructuredText, Textile and OPML use [Pandoc](https://pandoc.org) when it is installed.
- **Themes.** Daylight, Newsroom, Midnight (dark), Latte and Chalk are included. Add your own by dropping a `.css` file into the theme folder (**Help > Open Theme Folder**).
- **Safety.**
  - Files are saved through a temporary file, so a crash mid-write cannot truncate them.
  - Unsaved changes are mirrored to a draft and recovered after a crash or power loss.
  - Changes made by other programs are detected; a clean document reloads silently.
- **Keyboard shortcuts** follow Typora's documented defaults on each system, so muscle memory carries over. Windows and Linux share one set; macOS has its own (for example ⌘⌥C for code fences and ⌘⇧O for Open Quickly). Every command is in the menu bar with its shortcut next to it.
- **macOS integration.** A standard application menu, native window tabs (⌘T), files opened from Finder or dropped on the Dock icon, and the Dock menu.

**Help > Quick Start** and **Help > Markdown Reference** open guides inside the app.

## Files and fidelity

- **Inline text is never rewritten.** The text of paragraphs, headings, list items and table cells is stored exactly as typed, so what you open is what you save.
- **Block structure is written in a normalized form:**
  - setext headings become `#` headings
  - `~~~` fences become backtick fences
  - table columns are padded and aligned
  - list numbers are renumbered
- **Line endings and encoding.** Each file keeps its own line endings (LF or CRLF) and byte-order mark. Files in GB18030 or UTF-16 are read correctly and saved as UTF-8; a notice says when that happens.
- **Escaping.** Text that would otherwise turn into a different block when the file is reopened gets a backslash. Examples: a paragraph that starts with `# ` or `1. `, or a line made only of `---`.

Preferences, user themes and recovery drafts live in `%APPDATA%\TypeX` on Windows, `~/Library/Application Support/TypeX` on macOS and `~/.config/TypeX` on Linux.

## Development

Requires Node.js 22.12 or later (24 LTS recommended).

```sh
npm install
npm run dev        # run with hot reload
npm run build      # production build into out/
npm start          # run the production build
npm test           # unit tests: tokenizer, parser, serializer
npm run e2e        # end-to-end tests that drive the real app (run npm run build first)
npm run pack       # unpacked app for this system in dist/
npm run dist       # installers for this system in dist/
```

`node scripts/check-package.mjs` launches the packaged build and checks that it starts and renders a document.

The end-to-end suites press Windows and Linux shortcuts, so run them on those systems (on Linux under `xvfb-run` when there is no display). They also check the macOS menu and its shortcuts.

### Building packages

Each system's packages are built on that system: `npm run dist` produces the Windows installer and zip on Windows, the DMG and ZIP for Apple silicon and Intel on a Mac, and the AppImage and tar.gz for x64 and arm64 on Linux. (electron-builder cannot build macOS apps on Windows, and the AppImage tools only run on Linux and macOS.)

[`.github/workflows/build.yml`](.github/workflows/build.yml) does all three on GitHub's runners:
- On every push and pull request it type-checks, runs the unit tests, runs the end-to-end suites on Windows and Linux, packages, launches each packaged app, and uploads the packages as workflow artifacts.
- Pushing a version tag publishes a release. The tag must match `version` in `package.json`, for example `v0.1.0`. Once all three systems pass, the workflow creates a GitHub release with every package attached.

The release notes are generated from this README by `scripts/release-notes.mjs`: the project description, a download table and the Install and Languages sections. Updating the README updates the next release's notes.

**Signing.**
- The macOS app is ad-hoc signed (`mac.identity` is `"-"`), which Apple silicon requires before an app can run at all. Distributing it without the Gatekeeper prompt needs an Apple Developer ID certificate and notarization: set `mac.identity` to the certificate name, set `hardenedRuntime` to `true` and configure `mac.notarize`.
- On Windows, a code-signing certificate passed through `CSC_LINK` and `CSC_KEY_PASSWORD` removes the SmartScreen prompt.

**Debian and RPM packages** need a public project URL. Add a `homepage` field and `build.linux.maintainer` to `package.json`, then add `deb` and `rpm` to `build.linux.target`.

## Architecture

TypeX is an Electron application. The renderer runs sandboxed with context isolation. It reaches the operating system only through an allow-listed IPC bridge.

| Path | Role |
| --- | --- |
| `src/main` | Main process: windows, menus, file I/O, file watching, export, preferences, crash-recovery drafts |
| `src/preload` | The IPC bridge |
| `src/renderer/src/app.ts` | Window controller and the command table that menus, shortcuts and buttons all go through |
| `src/renderer/src/ui` | Sidebar, find bar, dialogs, preferences |
| `src/renderer/src/editor` | The editor core (below) |

The central design decision is how inline content is stored. The block structure is a [ProseMirror](https://prosemirror.net) document. Inline content is not modelled as marks: every text block holds its raw Markdown source. Live rendering is a layer of decorations over that text.

This is what makes round-trips lossless. It also lets the syntax markers appear and disappear around the caret without changing the document.

| Module | Role |
| --- | --- |
| `schema.ts` | Block nodes. Text blocks contain plain text only. |
| `inline.ts` | Inline tokenizer: the CommonMark delimiter algorithm with GFM and extensions. Every token carries exact source ranges, including its markers. |
| `decorations.ts` | Turns tokens into styling, hidden markers and widgets (images, math, emoji). Re-renders only the blocks a change touches. |
| `markdown.ts` | Parsing uses markdown-it's block parser only, so inline source passes through untouched. The serializer writes blocks back and escapes text that would be read back differently. |
| `nodeviews.ts` | Code fences, math, HTML and front matter are edited in embedded CodeMirror editors, with live MathJax and Mermaid previews. |
| `keymap.ts`, `commands.ts` | Typing shortcuts, Enter/Backspace/Tab behaviour and all editing commands |
| `clipboard.ts` | Copy writes Markdown and HTML; pasted HTML is converted to Markdown. |
| `html.ts` | Renders a document to HTML for export, printing and the clipboard |
| `search.ts`, `autocomplete.ts`, `slash.ts`, `plugins.ts` | Find and replace, emoji suggestions, the slash-command list, focus tracking, task checkboxes and document invariants |

## Not yet implemented

- Debian and RPM packages (see [Building packages](#building-packages)), and signed or notarized builds.
- Image upload services.
- Auto-pairing of Markdown markers (`*`, `_`, `` ` ``). Brackets and quotes are paired.
- Smart punctuation.
- Dragging to resize table columns.
- Diagram languages other than Mermaid.
- Export options such as headers, footers and per-format settings.
- Typora's whitespace and line-break preferences.

## License

MIT. See [LICENSE](LICENSE). Every package also carries the licenses of the bundled open-source components in `THIRD_PARTY_LICENSES.txt`, next to the application's other resources.
