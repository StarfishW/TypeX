/**
 * Keyboard shortcuts: Typora's documented defaults for Windows and Linux, and
 * for macOS. The menus register them; tooltips show them.
 */

/** [Windows and Linux, macOS] accelerators. `null` means none on that platform. */
export const KEYS: Record<string, [string | null, string | null]> = {
  'file.new': ['Ctrl+N', 'Command+N'],
  'file.newWindow': ['Ctrl+Shift+N', 'Command+Shift+N'],
  'file.newTab': [null, 'Command+T'],
  'file.open': ['Ctrl+O', 'Command+O'],
  'file.quickOpen': ['Ctrl+P', 'Command+Shift+O'],
  'file.reopenClosed': ['Ctrl+Shift+T', 'Command+Shift+T'],
  'file.save': ['Ctrl+S', 'Command+S'],
  'file.saveAs': ['Ctrl+Shift+S', 'Command+Shift+S'],
  'file.print': ['Alt+Shift+P', 'Command+P'],
  'file.close': ['Ctrl+W', 'Command+W'],
  'app.preferences': ['Ctrl+,', 'Command+,'],

  'edit.undo': ['Ctrl+Z', 'Command+Z'],
  'edit.redo': ['Ctrl+Y', 'Shift+Command+Z'],
  'edit.copyMarkdown': ['Ctrl+Shift+C', 'Command+Shift+C'],
  'edit.pastePlain': ['Ctrl+Shift+V', 'Command+Shift+V'],
  'edit.selectAll': ['Ctrl+A', 'Command+A'],
  'edit.selectLine': ['Ctrl+L', 'Command+L'],
  'edit.selectScope': ['Ctrl+E', 'Command+E'],
  'edit.selectWord': ['Ctrl+D', 'Command+D'],
  'edit.deleteWord': ['Ctrl+Shift+D', 'Command+Shift+D'],
  'edit.jumpTop': ['Ctrl+Home', 'Command+Up'],
  'edit.jumpSelection': ['Ctrl+J', 'Command+J'],
  'edit.jumpBottom': ['Ctrl+End', 'Command+Down'],
  'edit.find': ['Ctrl+F', 'Command+F'],
  'edit.findNext': ['F3', 'Command+G'],
  'edit.findPrevious': ['Shift+F3', 'Command+Shift+G'],
  'edit.replace': ['Ctrl+H', 'Command+H'],

  'paragraph.heading1': ['Ctrl+1', 'Command+1'],
  'paragraph.heading2': ['Ctrl+2', 'Command+2'],
  'paragraph.heading3': ['Ctrl+3', 'Command+3'],
  'paragraph.heading4': ['Ctrl+4', 'Command+4'],
  'paragraph.heading5': ['Ctrl+5', 'Command+5'],
  'paragraph.heading6': ['Ctrl+6', 'Command+6'],
  'paragraph.paragraph': ['Ctrl+0', 'Command+0'],
  'paragraph.headingUp': ['Ctrl+=', 'Command+='],
  'paragraph.headingDown': ['Ctrl+-', 'Command+-'],
  'table.insert': ['Ctrl+T', 'Command+Option+T'],
  'table.rowAfter': ['Ctrl+Enter', 'Command+Enter'],
  'table.deleteRow': ['Ctrl+Shift+Backspace', 'Command+Shift+Backspace'],
  'paragraph.code': ['Ctrl+Shift+K', 'Command+Option+C'],
  'paragraph.math': ['Ctrl+Shift+M', 'Command+Option+B'],
  'paragraph.quote': ['Ctrl+Shift+Q', 'Command+Option+Q'],
  'paragraph.orderedList': ['Ctrl+Shift+[', 'Command+Option+O'],
  'paragraph.bulletList': ['Ctrl+Shift+]', 'Command+Option+U'],
  'paragraph.taskList': ['Ctrl+Shift+X', 'Command+Option+X'],
  'paragraph.indent': ['Ctrl+[', 'Command+['],
  'paragraph.outdent': ['Ctrl+]', 'Command+]'],

  'format.strong': ['Ctrl+B', 'Command+B'],
  'format.em': ['Ctrl+I', 'Command+I'],
  'format.underline': ['Ctrl+U', 'Command+U'],
  'format.code': ['Ctrl+Shift+`', 'Command+Shift+`'],
  'format.del': ['Alt+Shift+5', 'Control+Shift+`'],
  'format.link': ['Ctrl+K', 'Command+K'],
  'format.image': ['Ctrl+Shift+I', 'Command+Control+I'],
  'format.clear': ['Ctrl+\\', 'Command+\\'],

  'view.sidebar': ['Ctrl+Shift+L', 'Command+Shift+L'],
  'view.outline': ['Ctrl+Shift+1', 'Command+Control+1'],
  'view.articles': ['Ctrl+Shift+2', 'Command+Control+2'],
  'view.files': ['Ctrl+Shift+3', 'Command+Control+3'],
  'view.search': ['Ctrl+Shift+F', 'Command+Shift+F'],
  'view.source': ['Ctrl+/', 'Command+/'],
  'view.focus': ['F8', 'F8'],
  'view.typewriter': ['F9', 'F9'],
  'view.fullscreen': ['F11', 'Command+Option+F'],
  'view.zoomReset': ['Ctrl+Shift+0', null],
  'view.zoomIn': ['Ctrl+Shift+=', null],
  'view.zoomOut': ['Ctrl+Shift+-', null],
  'view.switchWindow': ['Ctrl+Tab', 'Command+`'],
  'view.devtools': ['Shift+F12', 'Command+Option+I']
}

export const acceleratorFor = (id: string, platform: string): string | undefined =>
  KEYS[id]?.[platform === 'darwin' ? 1 : 0] ?? undefined

const MAC_MODIFIERS: [string, string][] = [
  ['Control', '⌃'],
  ['Option', '⌥'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Command', '⌘']
]
const MAC_KEY_NAMES: Record<string, string> = { Up: '↑', Down: '↓', Enter: '↩', Backspace: '⌫', Tab: '⇥' }

/** A shortcut as people read it: `Ctrl+Shift+L` on Windows and Linux, `⇧⌘L` on macOS. */
export function displayKey(id: string, platform: string): string {
  const accelerator = acceleratorFor(id, platform)
  if (!accelerator) return ''
  if (platform !== 'darwin') return accelerator
  const parts = accelerator.split('+')
  const key = parts.pop()!
  // macOS lists modifiers in a fixed order: Control, Option, Shift, Command.
  const mods = MAC_MODIFIERS.filter(([name]) => parts.includes(name)).map(([, symbol]) => symbol)
  return [...new Set(mods)].join('') + (MAC_KEY_NAMES[key] ?? key)
}
