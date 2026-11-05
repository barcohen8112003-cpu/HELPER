// Original HELPER portrait: flat illustrated character, not a photograph and not a real person.
// Writes src/face-avatar.png and face/avatar/box.json. Wav2Lip pastes the mouth back into `box`
// (y1, y2, x1, x2), the same order LiveTalking stores in coords.pkl.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const W = 256
const H = 256

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

export function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, row + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function renderFace() {
  const px = new Uint8Array(W * H * 3)
  const set = (x, y, r, g, b) => {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 3
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
  }
  for (let i = 0; i < px.length; i += 3) {
    px[i] = 18
    px[i + 1] = 32
    px[i + 2] = 40
  }
  const ellipse = (cx, cy, rx, ry, r, g, b) => {
    const x0 = Math.floor(cx - rx)
    const x1 = Math.ceil(cx + rx)
    const y0 = Math.floor(cy - ry)
    const y1 = Math.ceil(cy + ry)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) set(x, y, r, g, b)
      }
    }
  }
  const diamond = (cx, cy, s, r, g, b) => {
    for (let y = cy - s; y <= cy + s; y++) {
      for (let x = cx - s; x <= cx + s; x++) {
        if (Math.abs(x - cx) + Math.abs(y - cy) <= s) set(x, y, r, g, b)
      }
    }
  }
  ellipse(128, 214, 30, 40, 214, 164, 132)
  ellipse(128, 250, 96, 42, 32, 52, 62)
  ellipse(128, 112, 92, 104, 48, 36, 40)
  ellipse(128, 122, 70, 82, 232, 186, 150)
  ellipse(54, 128, 14, 20, 214, 158, 126)
  ellipse(202, 128, 14, 20, 214, 158, 126)
  ellipse(128, 58, 74, 32, 48, 36, 40)
  ellipse(100, 114, 16, 11, 255, 248, 242)
  ellipse(156, 114, 16, 11, 255, 248, 242)
  ellipse(102, 116, 6, 6, 24, 104, 114)
  ellipse(158, 116, 6, 6, 24, 104, 114)
  ellipse(104, 114, 2, 2, 255, 255, 255)
  ellipse(160, 114, 2, 2, 255, 255, 255)
  ellipse(128, 138, 5, 8, 210, 154, 120)
  for (let x = 108; x <= 148; x++) {
    const t = (x - 128) / 20
    const y = 170 - Math.round(t * t * 3)
    set(x, y, 146, 78, 74)
    set(x, y + 1, 176, 110, 102)
  }
  diamond(128, 214, 7, 31, 150, 148)
  diamond(128, 214, 3, 232, 244, 242)
  // The box is the skin region Wav2Lip replaces: eyes through the closed mouth, inside the frame.
  const box = { y1: 56, y2: 200, x1: 64, x2: 192 }
  return { png: encodePng(W, H, px), box, width: W, height: H, mouthY: 170 }
}

function isMain() {
  const self = fileURLToPath(import.meta.url)
  return process.argv[1] && path.resolve(process.argv[1]) === self
}

if (isMain()) {
  const { png, box } = renderFace()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const pngPath = path.join(root, 'src', 'face-avatar.png')
  const boxPath = path.join(root, 'face', 'avatar', 'box.json')
  fs.writeFileSync(pngPath, png)
  fs.writeFileSync(boxPath, JSON.stringify(box, null, 2) + '\n')
  console.log(`wrote ${pngPath} (${png.length} bytes) and ${boxPath}`)
}
