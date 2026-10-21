// Hands a coding job (a website, a script, a small app) to Claude Code, signed in with Naor's Claude subscription:
// no API key and no per-use bill. The token comes from `claude setup-token`, run once on any computer, and is saved
// as CLAUDE_CODE_OAUTH_TOKEN on the settings page.
//
// Claude Code runs in its own folder per project, with a short list of tools: read, write and edit files there,
// search and read the web. No shell, and Helper's own data and code are off limits, so a web page it reads cannot
// talk it into touching Helper's keys. The finished files come back as a zip, plus index.html on its own when there
// is one, so a site opens straight from WhatsApp.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { deflateRawSync, crc32 } from 'node:zlib'
import { DATA_DIR } from './config.js'

const bin = () => process.env.CLAUDE_CODE_BIN || 'claude'
export const workRoot = () => process.env.CLAUDE_CODE_WORKDIR || path.join(os.tmpdir(), 'helper-claude')

function onPath(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name)
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)))
}

export const claudeCodeEnabled = () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) && onPath(bin())

// "אתר לחנות פרחים" -> "אתר-לחנות-פרחים". Hebrew stays readable; nothing can climb out of the work folder.
export function projectSlug(name) {
  const slug = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'project'
}

export const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite']
// Absolute paths start with // in Claude Code permission rules.
export const deniedPaths = () =>
  [DATA_DIR, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')].flatMap((p) => ['Read', 'Edit', 'Write'].map((tool) => `${tool}(/${p}/**)`))

const PREFIX = `You are building something for Naor, who asked for it in Hebrew over WhatsApp and will get the files back there.
Work only inside the current folder. You have no shell: write plain files.
For a website, unless he asked otherwise: a static site that opens by double-clicking index.html (HTML, CSS, vanilla JS, no build step, no server), responsive for a phone, Hebrew and right-to-left when the content is Hebrew.
When done, reply in 2-4 short Hebrew lines: what you built, the main files, and anything he must fill in himself (like real contact details).
The task: `

// Builds the command line. Exported for the self-test.
export function claudeArgs(task) {
  return ['-p', PREFIX + task, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(','), '--disallowedTools', ['Bash', ...deniedPaths()].join(',')]
}

// What a stream-json line means for the user: a step to show, or the final result.
export function readEvent(line) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (ev.type === 'result') return { result: String(ev.result || ''), error: Boolean(ev.is_error), cost: ev.total_cost_usd }
  if (ev.type === 'assistant') {
    const use = (ev.message?.content || []).find((c) => c.type === 'tool_use')
    if (!use) return null
    const file = use.input?.file_path ? path.basename(use.input.file_path) : ''
    const label = { Write: 'כותב', Edit: 'עורך', MultiEdit: 'עורך', Read: 'קורא', WebSearch: 'מחפש ברשת', WebFetch: 'קורא אתר' }[use.name] || use.name
    return { step: `${label}${file ? ` ${file}` : ''}` }
  }
  return null
}

// Runs one job. Resolves { summary, dir, files } or throws. `signal` stops it (עצור, or the 20 minute limit).
export function runClaudeCode(task, { project, signal, setStep = () => {} } = {}) {
  const dir = path.join(workRoot(), projectSlug(project))
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true })
  // Only what Claude Code needs. Helper's keys stay out of its environment.
  const env = { PATH: process.env.PATH, HOME: path.join(dir, '.home'), LANG: 'C.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, DISABLE_AUTOUPDATER: '1' }
  return new Promise((resolve, reject) => {
    const child = spawn(bin(), claudeArgs(task), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    let final = null
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = readEvent(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (ev?.step) setStep(ev.step)
        if (ev && 'result' in ev) final = ev
      }
    })
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-2000)))
    child.on('error', (e) => reject(new Error(`Claude Code לא הופעל: ${e.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) return reject(signal.reason || new Error('stopped'))
      if (final && !final.error) return resolve({ summary: final.result.trim(), dir, files: listFiles(dir) })
      const why = final?.result || err.trim() || `יצא עם קוד ${code}`
      if (/auth|login|token|401|403/i.test(why)) return reject(new Error('Claude Code לא מחובר. צריך להריץ claude setup-token ולשמור את הטוקן באתר ההגדרות.'))
      if (/limit|quota|usage/i.test(why)) return reject(new Error('נגמרה המכסה של מנוי Claude לעכשיו. אפשר לנסות שוב מאוחר יותר.'))
      reject(new Error(String(why).slice(0, 300)))
    })
  })
}

const SKIP = new Set(['.home', '.git', 'node_modules', '.claude'])

export function listFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out.sort()
}

// A plain zip (deflate), enough for WhatsApp and every phone and computer to open.
export function zipFiles(dir, files) {
  const locals = []
  const central = []
  let offset = 0
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel))
    const packed = deflateRawSync(data)
    const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // names are UTF-8
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(name.length, 26)
    locals.push(head, name, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += 30 + name.length + packed.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}
