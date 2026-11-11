// Speaks one Hebrew line with the real edge-tts CLI and checks that the file is audio.
// Not part of check:all: it needs the network and the edge-tts package.
//   node scripts/edge-tts-smoke.mjs
//   node scripts/edge-tts-smoke.mjs "שלום, מה נשמע?"
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const voice = process.env.EDGE_TTS_VOICE || 'he-IL-HilaNeural'
const rate = process.env.EDGE_TTS_RATE || '+0%'
const text = process.argv[2] || 'שלום, אני הלפר.'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-edge-smoke-'))
const mp3 = path.join(dir, 'he.mp3')

const run = spawnSync('edge-tts', ['--voice', voice, '--rate', rate, '--text', text, '--write-media', mp3], { encoding: 'utf8' })
if (run.error?.code === 'ENOENT') {
  console.error('edge-tts is not on PATH. Install it (pip install edge-tts) or use the helper image, which has it.')
  process.exit(1)
}
if (run.status !== 0) {
  console.error((run.stderr || run.stdout || 'edge-tts failed').slice(0, 500))
  process.exit(1)
}
const buf = fs.readFileSync(mp3)
const header = buf.subarray(0, 3).toString()
if (buf.length < 1000 || (header !== 'ID3' && buf[0] !== 0xff)) {
  console.error(`edge-tts did not write mp3 audio (${buf.length} bytes, starts ${header})`)
  process.exit(1)
}
console.log(`ok hebrew edge-tts voice=${voice} rate=${rate} bytes=${buf.length} file=${mp3}`)

const ffmpeg = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 })
const opus = ffmpeg(['-i', mp3, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-b:a', '32k', '-f', 'ogg', 'pipe:1'])
if (opus.error?.code === 'ENOENT') {
  console.log('ffmpeg is not installed; skipped the WhatsApp opus and LiveKit pcm checks')
} else if (opus.status !== 0 || opus.stdout.subarray(0, 4).toString() !== 'OggS') {
  console.error(opus.stderr?.toString().slice(0, 400) || 'ffmpeg did not write Ogg Opus')
  process.exit(1)
} else {
  console.log(`ok ogg opus 48kHz ${opus.stdout.length} bytes`)
  const pcm = ffmpeg(['-i', mp3, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'])
  if (pcm.status !== 0 || pcm.stdout.length < 1600) {
    console.error('ffmpeg did not write 16 kHz pcm')
    process.exit(1)
  }
  console.log(`ok pcm 16kHz mono ${pcm.stdout.length} bytes`)
}

// The live worker streams the same engine. Use the interpreter that installed the CLI,
// because the image keeps edge-tts in a venv and the system python does not see it.
function edgePython() {
  const which = spawnSync('which', ['edge-tts'], { encoding: 'utf8' })
  const bin = (which.stdout || '').trim()
  if (!bin) return 'python3'
  try {
    const shebang = fs.readFileSync(bin, 'utf8').split('\n')[0]
    if (shebang.startsWith('#!')) return shebang.slice(2).trim().split(/\s+/)[0]
  } catch { /* fall through */ }
  return 'python3'
}
const py = edgePython()
const probe = spawnSync(py, ['-c', 'import edge_tts'], { cwd: root })
if (probe.status !== 0) {
  console.log('edge-tts module is not importable; the CLI audio above is the smoke')
  process.exit(0)
}
const stream = spawnSync(py, ['-c', `
import asyncio, sys
sys.path.insert(0, "voice")
from edge_pcm import iter_pcm
async def main():
    total = 0
    frames = 0
    async for chunk in iter_pcm(sys.argv[1], sys.argv[2], sys.argv[3], attempts=2):
        frames += 1
        total += len(chunk)
    print(f"stream frames={frames} bytes={total}")
    if total < 1000:
        raise SystemExit("stream produced no audio")
asyncio.run(main())
`, text, voice, rate], { cwd: root, encoding: 'utf8' })
if (stream.status !== 0) {
  console.error((stream.stderr || stream.stdout || 'edge stream failed').slice(0, 600))
  process.exit(1)
}
console.log(`ok ${stream.stdout.trim()}`)
