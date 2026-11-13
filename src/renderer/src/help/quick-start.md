# Quick Start

TypeX is a Markdown editor without a separate preview pane. What you type is rendered in place, and the Markdown syntax reappears whenever the caret moves into it.

## Writing

Just type. A few characters at the start of a line turn it into a block:

| Type                    | Result             |
| ----------------------- | ------------------ |
| `#` to `######` + Space | Heading 1 to 6     |
| `-`, `*` or `+` + Space | Bullet list        |
| `1.` + Space            | Numbered list      |
| `[ ]` + Space in a list | Task item          |
| `>` + Space             | Quote              |
| ` ``` ` + Enter         | Code fence         |
| `$$` + Enter            | Math block         |
| `---` + Enter           | Horizontal line    |
| `\| a \| b \|` + Enter  | Table              |
| `[toc]` + Enter         | Table of contents  |

Inline styles work the same way: type `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `==highlight==` or `[text](link)` and the markers fold away as soon as you move on. Put the caret back inside and they return, ready to edit.

- Type **/** at the start of a line (or after a space) to pick a block from a list: headings, lists, tables, code, math, diagrams and more. Keep typing to filter it, for example `/h2` or `/table`. You can turn this off in **Preferences > Editor**.
- Press **Enter** for a new paragraph and **Shift+Enter** for a line break.
- Press **Tab** and **Shift+Tab** to indent and outdent list items, or to move between table cells.
- Hold **Ctrl** and click a link to open it.

## Useful shortcuts

| Action               | Shortcut         |
| -------------------- | ---------------- |
| Bold, italic         | Ctrl+B, Ctrl+I   |
| Heading 1 to 6       | Ctrl+1 to Ctrl+6 |
| Insert table         | Ctrl+T           |
| Code fence           | Ctrl+Shift+K     |
| Find, replace        | Ctrl+F, Ctrl+H   |
| Toggle sidebar       | Ctrl+Shift+L     |
| Source code mode     | Ctrl+/           |
| Focus mode           | F8               |
| Typewriter mode      | F9               |
| Preferences          | Ctrl+,           |

Every command is also in the menu bar, with its shortcut next to it.

## Files

The sidebar shows the outline of the current document and the Markdown files of the folder it lives in. Use **File > Open Folder** to browse a different folder, and **Ctrl+P** to jump to a file by name.

## Images

Paste an image from the clipboard, drag one in, or use **Format > Image**. In **Preferences > Image** you can have TypeX copy every inserted image into a folder next to your document.

## Export

**File > Export** writes PDF and HTML directly. Word, EPUB, LaTeX and other formats are produced through [Pandoc](https://pandoc.org) when it is installed.

## Themes

Pick a theme from the **Themes** menu. To add your own, drop a `.css` file into the theme folder (**Help > Open Theme Folder**) and restart.
