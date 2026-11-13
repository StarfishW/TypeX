// Generates the application icons from a procedural drawing, so the
// repository needs no binary design source:
//
//   resources/icon.png       256 px, window icon on Windows and Linux
//   resources/icon.ico       Windows, 16 to 256 px
//   resources/icon.icns      macOS, 16 to 1024 px, with Apple's standard margin
//   resources/icons/*.png    Linux, 16 to 512 px
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const TOP = hex('#3b82f6')
const BOTTOM = hex('#1e40af')
const WHITE = [255, 255, 255]
const ACCENT = hex('#bfdbfe')

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Colour of the drawing at a point of a 256x256 canvas, or null where it is transparent. */
function sample(x, y) {
  if (!insideRoundRect(x, y, 8, 8, 248, 248, 54)) return null
  // The letter T: a top bar and a stem.
  if (insideRoundRect(x, y, 58, 62, 198, 94, 8) || insideRoundRect(x, y, 112, 62, 144, 198, 8)) return WHITE
  // A small x, bottom right.
  if (distToSegment(x, y, 166, 152, 198, 190) <= 7 || distToSegment(x, y, 198, 152, 166, 190) <= 7) return ACCENT
  const t = (y - 8) / 240
  return [0, 1, 2].map((i) => TOP[i] + (BOTTOM[i] - TOP[i]) * t)
}

/**
 * Renders the drawing at `size` pixels. `margin` is the transparent border as
 * a fraction of the size (macOS icons keep about a tenth of the canvas clear).
 */
function render(size, margin = 0) {
  const ss = Math.max(4, Math.ceil(64 / size))
  const pixels = Buffer.alloc(size * size * 4)
  const scale = 256 / (1 - 2 * margin)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((px + (sx + 0.5) / ss) / size - margin) * scale
          const v = ((py + (sy + 0.5) / ss) / size - margin) * scale
          const c = u >= 0 && v >= 0 && u < 256 && v < 256 ? sample(u, v) : null
          if (!c) continue
          r += c[0]
          g += c[1]
          b += c[2]
          a++
        }
      }
      const i = (py * size + px) * 4
      if (a) {
        pixels[i] = Math.round(r / a)
        pixels[i + 1] = Math.round(g / a)
        pixels[i + 2] = Math.round(b / a)
        pixels[i + 3] = Math.round((a / (ss * ss)) * 255)
      }
    }
  }
  return pixels
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const cache = new Map()
function pngAt(size, margin = 0) {
  const key = `${size}/${margin}`
  if (!cache.has(key)) cache.set(key, png(size, render(size, margin)))
  return cache.get(key)
}

/** An .ico file whose entries are PNG images (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map((s) => pngAt(s))
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i
    header[e] = s >= 256 ? 0 : s // width, 0 means 256
    header[e + 1] = s >= 256 ? 0 : s // height
    header.writeUInt16LE(1, e + 4) // colour planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(images[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

/** An .icns file with PNG-encoded entries, the layout `iconutil` produces. */
function icns(margin) {
  const entries = [
    ['icp4', 16],
    ['ic11', 32],
    ['icp5', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024]
  ].map(([type, size]) => {
    const data = pngAt(size, margin)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(join(out, 'icons'), { recursive: true })
writeFileSync(join(out, 'icon.png'), pngAt(256))
writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
// Apple's icon grid keeps 100 px of a 1024 px canvas clear on every side.
writeFileSync(join(out, 'icon.icns'), icns(100 / 1024))
for (const size of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(join(out, 'icons', `${size}x${size}.png`), pngAt(size))
console.log(`icons written to ${out}`)
