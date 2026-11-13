/**
 * Preload bridge. The renderer runs sandboxed with context isolation; this is
 * the only surface through which it can reach the main process.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const INVOKE = /^(app|dialog|fs|win|prefs|themes|shell|clipboard|image|export|draft):[a-zA-Z]+$/
const EVENTS = new Set(['command', 'open-file', 'open-folder', 'file-changed', 'folder-changed', 'prefs-changed', 'request-close'])

const api = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE.test(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    if (!EVENTS.has(channel)) throw new Error(`Blocked IPC event: ${channel}`)
    const wrapped = (_event: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  /** Absolute path of a file the user dropped or picked. */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('typex', api)

export type TypexBridge = typeof api
