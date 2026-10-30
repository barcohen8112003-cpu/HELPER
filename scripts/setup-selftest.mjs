// Checks of the one-command setup, with no internet and nothing of the owner's touched: the .env handling, the
// provider check against a stand-in provider on this PC, the speech-engine pick, and the whole wizard run
// unattended (--yes) into a throwaway .env and settings folder. Run: npm run check:setup
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import * as L from './setup/lib.mjs'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message.split('\n').slice(0, 12).join('\n   ')) }
}

// ---- .env ----
await check('env: parse skips comments and takes quotes off', () => {
  assert.deepStrictEqual(L.parseEnv('# x\nA=1\n\nB="two words"\nC=\n  D = 4 \n'), { A: '1', B: 'two words', C: '', D: '4' })
})
await check('env: a key is changed where it is, its comment stays above it', () => {
  const out = L.setEnv('# the model\nLLM_MODEL=\n# key\nLLM_API_KEY=old\n', { LLM_API_KEY: 'sk-new', LLM_MODEL: 'm1' })
  assert.strictEqual(out, '# the model\nLLM_MODEL=m1\n# key\nLLM_API_KEY=sk-new\n')
})
await check('env: a new key goes at the end, under a note', () => {
  const out = L.setEnv('A=1\n', { NEW_ONE: 'x' })
  assert.ok(/A=1\n\n# ---- נוסף באשף ההתקנה ----\nNEW_ONE=x\n$/.test(out), out)
})
await check('env: undefined leaves a key alone; spaces are quoted', () => {
  const out = L.setEnv('A=1\nB=2\n', { A: undefined, B: 'two words' })
  assert.strictEqual(out, 'A=1\nB="two words"\n')
})
await check('env: Windows line ends stay Windows line ends', () => {
  assert.strictEqual(L.setEnv('A=1\r\nB=2\r\n', { B: '3' }), 'A=1\r\nB=3\r\n')
})
await check('env: what the bot reads back is what was written', () => {
  const vals = { LLM_API_KEY: 'sk-or-v1-abc#def', BOT_NAME: "נאור's helper" }
  assert.deepStrictEqual(L.parseEnv(L.setEnv('', vals)), vals)
})
await check('mask shows a key only in part', () => {
  assert.strictEqual(L.mask('sk-or-v1-1234567890abcdef'), 'sk-or-…cdef')
  assert.strictEqual(L.mask('short'), '•••••')
})
await check('providers: a base URL names its provider', () => {
  assert.strictEqual(L.providerOf('https://openrouter.ai/api/v1/').id, 'openrouter')
  assert.strictEqual(L.providerOf('https://example.com/v1').id, 'custom')
})

// ---- Hebrew in a Windows console (which draws it back to front) ----
const B = await import('./setup/bidi.mjs')
await check('rtl: a Hebrew line is turned to read right to left; the status mark stays on the left', () => {
  assert.strictEqual(B.visual('  ✓ החבילות של הבוט'), '  ✓ טובה לש תוליבחה')
})
await check('rtl: English words, numbers, paths and addresses inside it stay left to right', () => {
  assert.strictEqual(B.visual('המוח של HELPER למחשב'), 'בשחמל HELPER לש חומה')
  assert.strictEqual(B.visual('הורדה של כ-2.3GB'), '2.3GB-כ לש הדרוה')
  assert.strictEqual(B.visual('מחובר לענן: http://37.60.240.231:3210'), 'http://37.60.240.231:3210 :ןנעל רבוחמ')
  assert.strictEqual(B.visual('נשמר ב-.env'), '.env-ב רמשנ')
  assert.strictEqual(B.visual('מפתח sk-or-…7037'), 'sk-or-…7037 חתפמ')
  assert.strictEqual(B.visual('דולג (--no-autostart)'), '(--no-autostart) גלוד')
  assert.strictEqual(B.visual('נכתב ל-HELPER'), 'HELPER-ל בתכנ')
})
await check('rtl: brackets are mirrored so they still open toward the words', () => {
  assert.strictEqual(B.visual('מספר [1]:'), ':[1] רפסמ')
  assert.strictEqual(B.visual('(ברירת מחדל)'), '(לדחמ תרירב)')
})
await check('rtl: lines without Hebrew, and colour codes around a line, are kept', () => {
  assert.strictEqual(B.visual('  ✓ Node.js 24.18.0'), '  ✓ Node.js 24.18.0')
  assert.strictEqual(B.visualColored('\x1b[2mשלום\x1b[0m'), '\x1b[2mםולש\x1b[0m')
})
await check('rtl: only for a Windows console; a pipe or a file gets the text as it is; HELPER_RTL overrides', () => {
  const was = process.env.HELPER_RTL
  delete process.env.HELPER_RTL
  assert.strictEqual(B.rtlConsole({ isTTY: false }), false)
  assert.strictEqual(B.rtlConsole({ isTTY: true }), process.platform === 'win32')
  process.env.HELPER_RTL = 'off'; assert.strictEqual(B.rtlConsole({ isTTY: true }), false)
  process.env.HELPER_RTL = 'on'; assert.strictEqual(B.rtlConsole({ isTTY: false }), true)
  if (was === undefined) delete process.env.HELPER_RTL; else process.env.HELPER_RTL = was
})

// ---- the one-line installer ----
await check('install.ps1 has no byte-order mark (through irm | iex it would hide the param block)', () => {
  const b = fs.readFileSync(path.join(L.ROOT, 'install.ps1'))
  assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf))
})
if (process.platform === 'win32' || fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell')) await check('install.ps1 parses the way irm | iex hands it over', async () => {
  const { spawnSync } = await import('node:child_process')
  const ps = "$t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes('" + path.join(L.ROOT, 'install.ps1') + "'));$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput($t,[ref]$null,[ref]$e);$e.Count"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  assert.strictEqual((r.stdout || '').trim(), '0', r.stdout + r.stderr)
})

// ---- the speech engine pick ----
const RELEASES = [
  { tag_name: 'v1.9.5', assets: [] },
  { tag_name: 'b5454', assets: [{ name: 'whisper-bin-x64.zip', size: 9e6, browser_download_url: 'u/cpu' }, { name: 'whisper-bin-win-cuda-12.4.0-x64.zip', size: 685e6, browser_download_url: 'u/cuda12' }, { name: 'whisper-bin-win-cuda-11.8.0-x64.zip', size: 285e6, browser_download_url: 'u/cuda11' }] },
  { tag_name: 'b5130', assets: [{ name: 'whisper-cublas-12.4.0-bin-x64.zip', size: 675e6, browser_download_url: 'u/old' }] },
]
await check('speech: the newest CUDA 12 build for an NVIDIA card, past an empty release', () => {
  const a = L.pickWhisperAsset(RELEASES, true)
  assert.strictEqual(a.url, 'u/cuda12'); assert.strictEqual(a.gpu, true)
})
await check('speech: the plain build without one', () => assert.strictEqual(L.pickWhisperAsset(RELEASES, false).url, 'u/cpu'))
await check('speech: the older name pattern is found too', () => assert.strictEqual(L.pickWhisperAsset([RELEASES[2]], true).url, 'u/old'))
await check('speech: nothing to pick is null', () => assert.strictEqual(L.pickWhisperAsset([], true), null))

// ---- a stand-in provider on this PC ----
const seen = []
const provider = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    seen.push({ auth: req.headers.authorization, model: j.model, tools: (j.tools || []).length })
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.headers.authorization !== 'Bearer sk-good') return send(401, { error: { message: 'invalid api key' } })
    if (j.model !== 'good-model') return send(404, { error: { message: 'model not found' } })
    send(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  })
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${provider.address().port}/v1`

await check('provider check: a working key and model', async () => {
  const r = await L.checkModel({ base: BASE, key: 'sk-good', model: 'good-model' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(seen[seen.length - 1].tools, 1, 'a tool is offered, since HELPER needs tool calling')
})
await check('provider check: a wrong key says so', async () => {
  const r = await L.checkModel({ base: BASE, key: 'sk-bad', model: 'good-model' })
  assert.strictEqual(r.ok, false); assert.strictEqual(r.badKey, true); assert.ok(/המפתח לא נכון/.test(r.reason))
})
await check('provider check: a model the provider does not have says so', async () => {
  const r = await L.checkModel({ base: BASE, key: 'sk-good', model: 'nope' })
  assert.strictEqual(r.badModel, true); assert.ok(/nope/.test(r.reason))
})
await check('provider check: no provider at all is "offline", not "wrong key"', async () => {
  const r = await L.checkModel({ base: 'http://127.0.0.1:9/v1', key: 'k', model: 'm' })
  assert.strictEqual(r.offline, true)
})

// ---- the whole wizard, unattended, into throwaway places ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-setup-test-'))
const envFile = path.join(tmp, '.env')
const appdata = path.join(tmp, 'appdata')
fs.mkdirSync(appdata)
function wizard(args, answers = null) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(L.ROOT, 'scripts', 'setup.mjs'), ...(answers == null ? ['--yes'] : []), `--env-path=${envFile}`, '--no-install', '--no-checks', '--no-start', '--no-autostart', ...args], {
      cwd: L.ROOT, env: { ...process.env, APPDATA: appdata, LLM_API_KEY: '', NO_COLOR: '1', HELPER_SETUP_INTERACTIVE: answers == null ? '' : '1' },
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ code, out }))
    p.stdin.end(answers == null ? '' : answers.join('\n') + '\n')
  })
}

await check('wizard: a first run writes the model into a new .env made from .env.example', async () => {
  const r = await wizard(['--parts=bot', '--provider=custom', `--base-url=${BASE}`, '--api-key=sk-good', '--model=good-model'])
  assert.strictEqual(r.code, 0, r.out)
  const text = fs.readFileSync(envFile, 'utf8')
  const env = L.parseEnv(text)
  assert.deepStrictEqual([env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL], [BASE, 'sk-good', 'good-model'])
  assert.ok(text.includes('# ---- המודל (חובה) ----'), "the example's explanations are kept")
  assert.ok(/המפתח עובד/.test(r.out), r.out)
  assert.ok(!r.out.includes('sk-good'), 'the key is never printed whole')
})
await check('wizard: a second run keeps what is set and changes nothing', async () => {
  const before = fs.readFileSync(envFile, 'utf8')
  const r = await wizard(['--parts=bot'])
  assert.strictEqual(r.code, 0, r.out)
  assert.ok(/כבר מוגדר/.test(r.out), r.out)
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), before)
})
await check('wizard: a key the provider turns down stops an unattended run and is not saved', async () => {
  const before = fs.readFileSync(envFile, 'utf8')
  const r = await wizard(['--parts=bot', '--provider=custom', `--base-url=${BASE}`, '--api-key=sk-bad', '--model=good-model'])
  assert.strictEqual(r.code, 1, r.out)
  assert.ok(/המפתח לא נכון/.test(r.out), r.out)
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), before)
})
// HELPER for Windows exists only on Windows; the full suite (check-all) runs every test as the Linux server.
const WIN = process.platform === 'win32'
if (!WIN) await check('wizard: on a server there is no HELPER for Windows to set up', async () => {
  const r = await wizard(['--parts=bot'])
  assert.strictEqual(r.code, 0, r.out)
  assert.ok(!/HELPER למחשב: לוחצים PD/.test(r.out), r.out)
})
if (WIN) await check('wizard: linking to the cloud writes only into the settings folder it was given', async () => {
  const cloud = http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer ' + 'a'.repeat(32) ? 400 : 403); res.end() })
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r))
  const r = await wizard(['--parts=desktop', `--cloud-url=http://127.0.0.1:${cloud.address().port}`, `--cloud-token=${'a'.repeat(32)}`])
  cloud.close()
  assert.strictEqual(r.code, 0, r.out)
  const s = JSON.parse(fs.readFileSync(path.join(appdata, 'helper-desktop', 'settings.json'), 'utf8'))
  assert.strictEqual(s.helperToken, 'a'.repeat(32))
  assert.ok(/מחובר/.test(r.out), r.out)
})

await check('wizard: answered by a person: a part turned off, a wrong key, then the right one', async () => {
  fs.rmSync(envFile, { force: true })
  // parts: turn HELPER for Windows off, done · provider 5 (other) · its URL · a wrong key · the model · try again:
  // yes · the right key · the model · three extras skipped · the name
  const r = await wizard([], ['2', '', '5', BASE, 'sk-bad', 'good-model', '', 'sk-good', 'good-model', '', '', '', ''])
  assert.strictEqual(r.code, 0, r.out)
  if (WIN) assert.ok(/\[ \] 2\./.test(r.out), 'the part was turned off')
  assert.ok(/המפתח לא נכון/.test(r.out) && /המפתח עובד/.test(r.out), r.out)
  assert.ok(!r.out.includes('sk-good') && !r.out.includes('sk-bad'), 'typed keys are not shown')
  const env = L.parseEnv(fs.readFileSync(envFile, 'utf8'))
  assert.deepStrictEqual([env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL], [BASE, 'sk-good', 'good-model'])
})

provider.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
