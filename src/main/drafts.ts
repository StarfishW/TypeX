/**
 * Crash recovery. While a document has unsaved changes its text is mirrored
 * to a draft file in the user-data folder. Closing the window normally
 * removes the draft; if the application dies instead, the next launch finds
 * the draft and reopens it.
 */
import { app } from 'electron'
import { promises as fs, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface Draft {
  /** Path of the document the draft belongs to, or '' if it was never saved. */
  path: string
  content: string
  time: number
}

const draftsDir = (): string => join(app.getPath('userData'), 'drafts')

export const draftFileFor = (windowId: number): string => join(draftsDir(), `${process.pid}-${windowId}.json`)

export async function saveDraft(file: string, draft: Draft): Promise<void> {
  await fs.mkdir(draftsDir(), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(draft), 'utf8')
  await fs.rename(tmp, file)
}

export function removeDraft(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* a draft that cannot be removed is offered again next time, which is harmless */
  }
}

/**
 * Returns and deletes the drafts left by a previous session. Only call this
 * at startup, before any window exists: everything in the folder is then a
 * leftover.
 */
export function takeLeftoverDrafts(): Draft[] {
  const out: Draft[] = []
  let names: string[]
  try {
    names = readdirSync(draftsDir())
  } catch {
    return out
  }
  for (const name of names) {
    const file = join(draftsDir(), name)
    if (name.endsWith('.json')) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<Draft>
        if (typeof d.content === 'string' && d.content.trim()) {
          out.push({ path: typeof d.path === 'string' ? d.path : '', content: d.content, time: Number(d.time) || 0 })
        }
      } catch {
        /* a draft that cannot be read is dropped */
      }
    }
    removeDraft(file)
  }
  return out
}
