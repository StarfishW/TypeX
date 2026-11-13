/**
 * The help pages are written with Windows and Linux shortcuts. On macOS they
 * are shown with the Mac equivalents, which differ for several commands.
 */
const MAC_KEYS: [string, string][] = [
  ['Ctrl+1 to Ctrl+6', '⌘1 to ⌘6'],
  ['Ctrl+Shift+K', '⌘⌥C'],
  ['Ctrl+Shift+L', '⌘⇧L'],
  ['Ctrl+T', '⌘⌥T'],
  ['Ctrl+P', '⌘⇧O'],
  ['**Ctrl**', '**⌘ Command**']
]

export function forPlatform(text: string, platform: string): string {
  if (platform !== 'darwin') return text
  let out = text
  for (const [win, mac] of MAC_KEYS) out = out.split(win).join(mac)
  // Everything else maps Ctrl to Command one for one.
  return out.replace(/Ctrl\+/g, '⌘')
}
