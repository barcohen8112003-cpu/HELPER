// The parts of the setup wizard that decide things, with no questions and no side effects, so they can be tested:
// reading and writing .env without losing its comments, the model providers, checking a key, finding the speech
// engine to download, and what is already set up on this PC.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
export const DESKTOP = path.join(ROOT, 'desktop')
export const IS_WIN = process.platform === 'win32'

// ---- .env ---------------------------------------------------------------------------------------

/** KEY=value pairs of a .env text (comments and blank lines skipped, quotes taken off). */
export function parseEnv(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[line.slice(0, eq).trim()] = v
  }
  return out
}

/**
 * The same text with these keys set: an existing KEY= line is changed where it is (its comments stay above it), a
 * new key goes at the end. undefined leaves a key as it is.
 */
export function setEnv(text, values) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const lines = String(text || '').split(/\r?\n/)
  const done = new Set()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Z0-9_]+)\s*=/)
    if (!m || !(m[1] in values) || values[m[1]] === undefined || done.has(m[1])) continue
    lines[i] = `${m[1]}=${quote(values[m[1]])}`
    done.add(m[1])
  }
  const add = Object.entries(values).filter(([k, v]) => v !== undefined && !done.has(k))
  if (add.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push('', '# ---- נוסף באשף ההתקנה ----', ...add.map(([k, v]) => `${k}=${quote(v)}`), '')
  } else if (lines[lines.length - 1] !== '') lines.push('')
  return lines.join(eol)
}
const quote = (v) => (/[\s#"']/.test(String(v)) && !/^".*"$/.test(String(v)) ? JSON.stringify(String(v)) : String(v))

/** The .env text to start from: the existing .env, else .env.example, else empty. */
export function envText(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  const example = path.join(ROOT, '.env.example')
  return fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : ''
}

/** "sk-or-v1-abcd…wxyz": enough to recognise a key, never the whole of it. */
export const mask = (k) => (!k ? '' : k.length <= 10 ? '•'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`)

// ---- model providers ----------------------------------------------------------------------------

export const PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter (מומלץ: כל המודלים במפתח אחד)', base: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-5.5', keyUrl: 'https://openrouter.ai/keys', keyHint: /^sk-or-/ },
  { id: 'gemini', name: 'Google Gemini (מפתח חינמי)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', keyHint: /^AIza/ },
  { id: 'groq', name: 'Groq (חינמי, מהיר, מכסה קטנה)', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', keyHint: /^gsk_/, light: true },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keyUrl: 'https://platform.openai.com/api-keys', keyHint: /^sk-/ },
  { id: 'custom', name: 'ספק אחר שתואם OpenAI', base: '', model: '', keyUrl: '' },
]

/** The provider a base URL belongs to (for "you are on OpenRouter"), or custom. */
export function providerOf(base) {
  const b = String(base || '').replace(/\/+$/, '')
  return PROVIDERS.find((p) => p.base && b === p.base) || PROVIDERS.find((p) => p.id === 'custom')
}

/**
 * Does this key work with this model? A one-word answer with one tool offered (HELPER needs tool calling).
 * {ok, reason}: reason is in Hebrew when not ok. 401/403 is a wrong key; 404 a model the provider does not have.
 */
export async function checkModel({ base, key, model }, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(String(base).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }],
        tools: [{ type: 'function', function: { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } } }],
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (r.ok) return { ok: true }
    const body = (await r.text().catch(() => '')).slice(0, 300)
    if (r.status === 401 || r.status === 403) return { ok: false, badKey: true, reason: 'הספק אומר שהמפתח לא נכון' }
    if (r.status === 404 || /model/i.test(body) && r.status === 400) return { ok: false, badModel: true, reason: `הספק לא מכיר את המודל ${model}` }
    if (r.status === 402) return { ok: false, reason: 'אין קרדיט בחשבון אצל הספק' }
    if (r.status === 429) return { ok: true, warn: 'המפתח עובד, אבל הספק עמוס כרגע (429)' }
    return { ok: false, reason: `הספק החזיר ${r.status}: ${body.replace(/\s+/g, ' ').slice(0, 120)}` }
  } catch (e) {
    return { ok: false, offline: true, reason: 'אין חיבור לספק (' + (e.name === 'TimeoutError' ? 'לא ענה בזמן' : e.message) + ')' }
  }
}

// ---- the speech engine (HELPER for Windows) -----------------------------------------------------

export const SPEECH_MODEL_URL = 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin'
export const speechPaths = () => ({
  server: path.join(DESKTOP, 'vendor', 'whisper', 'Release', 'whisper-server.exe'),
  model: path.join(DESKTOP, 'vendor', 'ggml-ivrit-turbo.bin'),
})

/**
 * The whisper.cpp build to download from a list of GitHub releases: the CUDA 12 one for an NVIDIA card, else the
 * plain one. Release file names change between versions ("whisper-cublas-12.4.0-bin-x64.zip",
 * "whisper-bin-win-cuda-12.4.0-x64.zip"), so they are matched by what they contain. {url, name, size, gpu} or null.
 */
export function pickWhisperAsset(releases, gpu) {
  const cuda = /(cublas|cuda)-12[\d.]*.*x64\.zip$/i
  const cpu = /^whisper-bin-x64\.zip$/i
  for (const want of gpu ? [cuda, cpu] : [cpu]) {
    for (const r of releases || []) {
      const a = (r.assets || []).find((x) => want.test(x.name))
      if (a) return { url: a.browser_download_url, name: a.name, size: a.size, gpu: want === cuda, tag: r.tag_name }
    }
  }
  return null
}

// ---- what this PC already has -------------------------------------------------------------------

export function which(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null
}
export function version(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: IS_WIN })
  return r.status === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null
}
export const nodeMajor = () => Number(process.versions.node.split('.')[0])

export const desktopDataDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'helper-desktop')
export function desktopSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(desktopDataDir(), 'settings.json'), 'utf8')) } catch { return {} }
}
/** Changes only these settings of HELPER for Windows, keeping the rest. */
export function saveDesktopSettings(values) {
  const dir = desktopDataDir()
  fs.mkdirSync(dir, { recursive: true })
  const s = Object.assign(desktopSettings(), values)
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s, null, 2), 'utf8')
}

export const startupDir = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
export const BOT_AUTOSTART = 'HELPER bot.lnk'

/** Which processes of HELPER run now: {bot, desktop}. */
export function running() {
  if (!IS_WIN) {
    const r = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
    return { bot: /node\s+\S*src[\\/]index\.js/.test(r.stdout || ''), desktop: false }
  }
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='electron.exe'\" | ForEach-Object { $_.CommandLine }"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  const lines = (r.stdout || '').split(/\r?\n/)
  // start.bat runs "node src/index.js" from the project folder, so its command line has the relative path.
  return {
    bot: lines.some((l) => /node(\.exe)?"?\s+("?[^"]*[\\/])?src[\\/]index\.js/i.test(l)),
    desktop: lines.some((l) => /electron\.exe/i.test(l) && !/--type=/.test(l) && l.toLowerCase().includes(DESKTOP.toLowerCase())),
  }
}

/** Everything the doctor reports, in one object. */
export function state(envFile = path.join(ROOT, '.env')) {
  const env = parseEnv(fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '')
  const sp = speechPaths()
  const ds = desktopSettings()
  return {
    node: process.versions.node, nodeOk: nodeMajor() >= 24,
    git: Boolean(which('git')), claude: Boolean(which('claude')),
    envFile: fs.existsSync(envFile), env,
    model: { base: env.LLM_BASE_URL || '', model: env.LLM_MODEL || '', key: Boolean(env.LLM_API_KEY) },
    botDeps: fs.existsSync(path.join(ROOT, 'node_modules', '@whiskeysockets', 'baileys')),
    desktopDeps: fs.existsSync(path.join(DESKTOP, 'node_modules', 'electron', 'dist', IS_WIN ? 'electron.exe' : 'electron')),
    speech: { server: fs.existsSync(sp.server), model: fs.existsSync(sp.model) },
    cloud: { url: ds.helperUrl || '', token: Boolean(ds.helperToken) },
    autostart: IS_WIN && fs.existsSync(path.join(startupDir(), BOT_AUTOSTART)),
    whatsapp: fs.existsSync(path.join(ROOT, 'data', 'auth', 'creds.json')),
  }
}
