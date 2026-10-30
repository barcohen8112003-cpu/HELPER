#!/usr/bin/env node
// HELPER's setup, start to finish, in one command: helper onboard (or npm run setup, or setup.bat).
// It checks the PC, asks which parts to set up, gets a model key and checks that it works, installs what is
// needed, downloads the Hebrew speech engine, links the PC app to HELPER on the cloud, sets HELPER to start with
// Windows, runs the self-checks and starts everything. Run it again any time: what is set up already is kept.
//
//   node scripts/setup.mjs                    questions, with defaults
//   node scripts/setup.mjs --yes              no questions: defaults, and keys from the flags or the environment
//   flags: --parts=bot,desktop,speech  --provider=openrouter|gemini|groq|openai|custom  --base-url=  --api-key=
//          --model=  --cloud-url=  --cloud-token=  --env-path=  --no-install  --no-checks  --no-start  --no-autostart
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as L from './setup/lib.mjs'
import * as U from './setup/ui.mjs'

const { ROOT, DESKTOP, IS_WIN } = L

// ---- flags ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined }
const F = {
  yes: flag('yes') || flag('y'),
  parts: opt('parts'),
  provider: opt('provider'), base: opt('base-url'), key: opt('api-key') || undefined, model: opt('model'),
  cloudUrl: opt('cloud-url'), cloudToken: opt('cloud-token'),
  envFile: opt('env-path') ? path.resolve(opt('env-path')) : path.join(ROOT, '.env'),
  install: !flag('no-install'), checks: !flag('no-checks'), start: !flag('no-start'), autostart: !flag('no-autostart'),
}
U.setAuto(F.yes)

const TOTAL = 9
const todo = []   // what is left for the user, said at the end

if (flag('help') || flag('h')) {
  console.log(`
  node scripts/setup.mjs [flags]      (or: helper onboard, npm run setup, setup.bat)

    --yes                 no questions: every default, keys from the flags or the environment
    --parts=bot,desktop,speech        what to set up (default: bot and HELPER for Windows)
    --provider=openrouter|gemini|groq|openai|custom   --base-url=URL   --api-key=KEY   --model=NAME
    --cloud-url=URL --cloud-token=CODE  link HELPER for Windows to HELPER on the cloud
    --env-path=PATH       another .env (default: the project's)
    --cpu                 the speech engine on the processor even with an NVIDIA card
    --no-install  --no-checks  --no-start  --no-autostart  --reinstall
`)
  process.exit(0)
}

// ---- running things ---------------------------------------------------------------------------------

/** Runs a command where its output shows; resolves to its exit code. npm is a script on Windows, so a shell runs it. */
function run(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  U.info('$ ' + [cmd, ...args].join(' ') + (cwd !== ROOT ? `   (${path.relative(ROOT, cwd) || '.'})` : ''))
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: quiet ? 'ignore' : 'inherit', shell: IS_WIN, windowsHide: true })
    p.on('close', (code) => resolve(code ?? 1))
    p.on('error', () => resolve(1))
  })
}

async function download(url, file, label) {
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok || !r.body) throw new Error(`ההורדה נכשלה (${r.status})`)
  const total = Number(r.headers.get('content-length')) || 0
  let got = 0, last = 0
  const body = Readable.fromWeb(r.body)
  body.on('data', (d) => {
    got += d.length
    if (process.stdout.isTTY && Date.now() - last > 300) {
      last = Date.now()
      process.stdout.write(`\r    ${U.V(label + ':')} ${(got / 1e6).toFixed(0)}${total ? ' / ' + (total / 1e6).toFixed(0) : ''} MB   `)
    }
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await pipeline(body, fs.createWriteStream(file + '.part'))
  fs.renameSync(file + '.part', file)
  if (process.stdout.isTTY) process.stdout.write('\n')
}

function powershell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true })
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
function shortcut(file, target, { args = '', cwd = '', icon = '', minimized = false, description = '' } = {}) {
  const r = powershell(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(file)});$s.TargetPath=${psq(target)};$s.Arguments=${psq(args)};$s.WorkingDirectory=${psq(cwd)};${icon ? `$s.IconLocation=${psq(icon)};` : ''}$s.Description=${psq(description)};${minimized ? '$s.WindowStyle=7;' : ''}$s.Save()`)
  return r.status === 0
}

// ---- 1. the PC -----------------------------------------------------------------------------------

async function checkPc() {
  U.step(1, TOTAL, 'בודק את המחשב')
  if (L.nodeMajor() >= 24) U.ok(`Node.js ${process.versions.node}`)
  else {
    U.bad(`Node.js ${process.versions.node}: צריך 24 ומעלה`)
    U.info(IS_WIN ? 'מתקינים עם: winget install OpenJS.NodeJS.LTS (או מריצים את install.ps1, שעושה את זה לבד)' : 'מתקינים מ-https://nodejs.org')
    throw new Error('Node.js ישן מדי')
  }
  const s = L.state(F.envFile)
  s.git ? U.ok('Git') : U.warn('Git לא מותקן: אפשר בלי, אבל helper update לא יעבוד')
  if (s.claude) U.ok('Claude Code: המוח של HELPER למחשב ירוץ על המנוי שלך')
  else U.info('Claude Code לא מותקן: HELPER למחשב ישתמש במפתח המודל (אפשר להוסיף אחר כך: npm i -g @anthropic-ai/claude-code)')
  const gpu = IS_WIN && !flag('cpu') && Boolean(L.which('nvidia-smi'))
  if (IS_WIN) gpu ? U.ok('כרטיס מסך NVIDIA: זיהוי הדיבור ירוץ עליו') : U.info('אין כרטיס NVIDIA: זיהוי הדיבור ירוץ על המעבד (איטי יותר)')
  return { s, gpu }
}

// ---- 2. which parts ------------------------------------------------------------------------------

async function chooseParts(s) {
  U.step(2, TOTAL, 'מה להתקין')
  const want = F.parts ? F.parts.split(',').map((x) => x.trim()) : null
  const items = [
    { id: 'bot', label: 'הבוט בוואטסאפ (המוח, הזיכרון, התזכורות, המייל)', on: want ? want.includes('bot') : true },
  ]
  if (IS_WIN) {
    items.push({ id: 'desktop', label: 'HELPER למחשב: לוחצים PD ומדברים, והוא שולט במחשב', on: want ? want.includes('desktop') : true })
    items.push({ id: 'speech', label: 'מנוע הדיבור בעברית ל-HELPER למחשב (הורדה של כ-2.3GB, פעם אחת)', on: want ? want.includes('speech') : !(s.speech.server && s.speech.model) && !F.yes })
  }
  const on = await U.pick('סמן מה להתקין:', items)
  const parts = Object.fromEntries(items.map((x, i) => [x.id, on[i]]))
  if (parts.speech && !parts.desktop) parts.desktop = true
  U.ok('נבחר: ' + (items.filter((x, i) => on[i]).map((x) => x.label.split(':')[0].split(' (')[0]).join(', ') || 'כלום'))
  return parts
}

// ---- 3. the model ----------------------------------------------------------------------------------

async function configureModel(s) {
  U.step(3, TOTAL, 'המודל (המוח)')
  const cur = s.model
  const env = L.parseEnv(L.envText(F.envFile))
  if (cur.key && cur.model && !F.key && !F.provider) {
    U.ok(`כבר מוגדר: ${L.providerOf(cur.base).id === 'custom' ? cur.base : L.providerOf(cur.base).name.split(' (')[0]}, מודל ${cur.model}, מפתח ${L.mask(env.LLM_API_KEY)}`)
    if (!(await U.confirm('לשנות?', false))) {
      if (await U.confirm('לבדוק שהמפתח עובד?', !F.yes)) await verifyModel({ base: cur.base, key: env.LLM_API_KEY, model: cur.model })
      return null
    }
  }
  let p = F.provider ? L.PROVIDERS.find((x) => x.id === F.provider) : null
  if (!p) p = L.PROVIDERS[await U.choose('איזה ספק?', L.PROVIDERS.map((x) => x.name), 0)]
  if (!p) throw new Error('ספק לא מוכר: ' + F.provider)
  let base = F.base || p.base
  if (!base) base = await U.ask('כתובת ה-API של הספק (מסתיימת ב-/v1 בדרך כלל)')
  if (p.keyUrl) U.info('מפתח לוקחים מכאן: ' + p.keyUrl)
  for (let tries = 0; ; tries++) {
    let key = F.key || process.env.LLM_API_KEY || ''
    if (!key || tries > 0) key = await U.secret('הדבק את המפתח (מוסתר)')
    if (!key) { U.warn('בלי מפתח הבוט לא יעלה. אפשר להריץ שוב אחר כך: helper onboard'); todo.push('להוסיף מפתח מודל: helper onboard'); return null }
    if (p.keyHint && !p.keyHint.test(key)) U.warn('זה לא נראה כמו מפתח של ' + p.name.split(' (')[0] + ', ממשיך בכל זאת')
    const model = F.model || await U.ask('איזה מודל', p.model || env.LLM_MODEL || '')
    const res = await verifyModel({ base, key, model })
    // Saved when it works, or when there is no way to know right now (no internet). A key the provider turned down
    // is never saved: unattended, the setup stops; with someone there, it asks again.
    if (res.ok || res.offline) {
      const values = { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model }
      if (p.light) values.LLM_LIGHT = 'true'
      return values
    }
    if (U.isAuto()) throw new Error(res.reason)
    if (tries >= 2 || !(await U.confirm('לנסות שוב?', true))) { todo.push('מפתח מודל שעובד: helper onboard'); return null }
  }
}

async function verifyModel(m) {
  U.info('בודק את המפתח מול הספק…')
  const r = await L.checkModel(m)
  if (r.ok) U.ok(r.warn || `המפתח עובד, והמודל ${m.model} עונה ותומך בכלים`)
  else (r.offline ? U.warn : U.bad)(r.reason)
  return r
}

// ---- 4. extras --------------------------------------------------------------------------------------

async function configureExtras() {
  U.step(4, TOTAL, 'תוספות (Enter מדלג על כל אחת)')
  const env = L.parseEnv(L.envText(F.envFile))
  const values = {}
  const extras = [
    ['ELEVENLABS_API_KEY', 'ElevenLabs: קול אנושי בעברית', 'https://elevenlabs.io/app/settings/api-keys'],
    ['TAVILY_API_KEY', 'Tavily: חיפוש באינטרנט טוב יותר (בלי זה DuckDuckGo)', 'https://app.tavily.com'],
    ['GEMINI_API_KEY', 'Gemini: "תשאל את ג׳מיני", מפתח חינמי', 'https://aistudio.google.com/apikey'],
  ]
  for (const [k, label, url] of extras) {
    if (env[k]) { U.ok(`${label.split(':')[0]}: כבר מוגדר (${L.mask(env[k])})`); continue }
    if (U.isAuto()) { U.info(`${label.split(':')[0]}: דולג`); continue }
    U.info(`${label} — ${url}`)
    const v = await U.secret(`מפתח ${label.split(':')[0]}`)
    if (v) { values[k] = v; U.ok(label.split(':')[0] + ': נשמר') }
  }
  if (!env.BOT_NAME) values.BOT_NAME = await U.ask('איך לקרוא לעוזר', 'Helper')
  return values
}

function writeEnv(values) {
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null))
  if (!Object.keys(set).length && fs.existsSync(F.envFile)) return
  const before = L.envText(F.envFile)
  const after = L.setEnv(before, set)
  if (fs.existsSync(F.envFile)) fs.copyFileSync(F.envFile, F.envFile + '.before-setup')
  fs.writeFileSync(F.envFile, after, 'utf8')
  const shown = F.envFile.startsWith(ROOT + path.sep) ? path.relative(ROOT, F.envFile) : F.envFile
  U.ok(`נשמר ב-${shown}${fs.existsSync(F.envFile + '.before-setup') ? ' (הגרסה הקודמת: .env.before-setup)' : ''}`)
}

// ---- 5. installing ----------------------------------------------------------------------------------

async function install(parts, s) {
  U.step(5, TOTAL, 'מתקין את החלקים')
  if (!F.install) { U.info('דולג (--no-install)'); return }
  if (parts.bot) {
    if (s.botDeps && !flag('reinstall')) U.ok('הבוט: כבר מותקן')
    else if ((await run('npm', ['install', '--no-audit', '--no-fund'])) === 0) U.ok('הבוט: הותקן')
    else { U.bad('npm install נכשל בשורש הפרויקט'); todo.push('להריץ npm install בתיקיית הפרויקט ולראות את השגיאה') }
  }
  if (parts.desktop) {
    if (s.desktopDeps && !flag('reinstall')) U.ok('HELPER למחשב: כבר מותקן')
    else {
      const code = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: DESKTOP })
      // npm 11 runs no install scripts until they are approved; Electron, koffi and the key hook need theirs.
      await run('npm', ['approve-scripts', 'electron', 'koffi', 'uiohook-napi'], { cwd: DESKTOP, quiet: true })
      await run('npm', ['rebuild', 'electron', 'koffi', 'uiohook-napi'], { cwd: DESKTOP })
      if (code === 0 && L.state(F.envFile).desktopDeps) U.ok('HELPER למחשב: הותקן')
      else { U.bad('ההתקנה של HELPER למחשב לא הושלמה'); todo.push('להריץ npm install בתיקייה desktop ולראות את השגיאה') }
    }
  }
}

// ---- 6. the speech engine ---------------------------------------------------------------------------

async function speech(parts, gpu) {
  U.step(6, TOTAL, 'מנוע הדיבור בעברית')
  const sp = L.speechPaths()
  if (!parts.desktop) { U.info('לא נבחר HELPER למחשב'); return }
  const has = { server: fs.existsSync(sp.server), model: fs.existsSync(sp.model) }
  if (has.server && has.model) { U.ok('כבר מותקן'); return }
  if (!parts.speech) { U.warn('לא מותקן: הקלדה עובדת, דיבור לא. להתקנה: helper onboard --parts=desktop,speech'); todo.push('מנוע דיבור: helper onboard --parts=desktop,speech'); return }
  try {
    if (!has.server) {
      U.info('מחפש את whisper.cpp העדכני…')
      const r = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=12', { headers: { 'User-Agent': 'helper-setup' } })
      const asset = L.pickWhisperAsset(r.ok ? await r.json() : [], gpu)
      if (!asset) throw new Error('לא נמצאה גרסה של whisper.cpp להורדה')
      U.info(`${asset.name} (${asset.tag}, ${(asset.size / 1e6).toFixed(0)}MB)`)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-whisper-'))
      const zip = path.join(tmp, asset.name)
      await download(asset.url, zip, 'whisper.cpp')
      const out = path.join(tmp, 'x')
      fs.mkdirSync(out)
      // tar in Windows 10 and later opens zip files.
      if (spawnSync('tar', ['-xf', zip, '-C', out], { windowsHide: true }).status !== 0) throw new Error('לא הצלחתי לפתוח את הקובץ')
      const found = findFile(out, 'whisper-server.exe')
      if (!found) throw new Error('אין whisper-server.exe בהורדה')
      const dest = path.dirname(sp.server)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(path.dirname(found), dest, { recursive: true })
      fs.rmSync(tmp, { recursive: true, force: true })
      U.ok('whisper.cpp ' + (asset.gpu ? '(על כרטיס המסך)' : '(על המעבד)'))
    }
    if (!has.model) {
      U.info('המודל העברי של ivrit.ai (כ-1.6GB)…')
      await download(L.SPEECH_MODEL_URL, sp.model, 'מודל עברית')
      U.ok('המודל העברי')
    }
  } catch (e) {
    U.bad('מנוע הדיבור: ' + e.message)
    todo.push('מנוע דיבור: להריץ שוב helper onboard --parts=desktop,speech')
  }
}
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase() === name) return p
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f }
  }
  return null
}

// ---- 7. linking the PC app to HELPER on the cloud ---------------------------------------------------

async function linkCloud(parts) {
  U.step(7, TOTAL, 'חיבור HELPER למחשב ל-HELPER בענן')
  if (!parts.desktop) { U.info('לא נבחר HELPER למחשב'); return }
  const cur = L.desktopSettings()
  if (cur.helperUrl && cur.helperToken && !F.cloudToken) {
    U.ok(`כבר מחובר ל-${cur.helperUrl}`)
    if (!(await U.confirm('לחבר מחדש?', false))) return
  }
  U.info('נותן ל-HELPER במחשב את הזיכרון, הוואטסאפ, המייל והקול של HELPER בענן. אפשר לדלג.')
  if (!F.cloudToken && !(await U.confirm('לחבר עכשיו?', !U.isAuto()))) { U.info('דולג. אפשר אחר כך: desktop\\connect.ps1'); return }
  const url = F.cloudUrl || await U.ask('כתובת HELPER בענן', cur.helperUrl || 'http://37.60.240.231:3210')
  U.info('קוד הגישה נמצא באתר ההגדרות של HELPER, ליד קוד ה-QR של האפליקציה ("הצג").')
  const token = F.cloudToken || await U.secret('קוד גישה (מוסתר)')
  if (!token) { U.info('דולג'); return }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) { U.bad('זה לא נראה כמו קוד הגישה (רק אותיות ומספרים). לא שמרתי.'); return }
  L.saveDesktopSettings({ helperUrl: url, helperToken: token })
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/bridge/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{"text":""}', signal: AbortSignal.timeout(15000) })
    if (r.status === 400 || r.ok) U.ok('מחובר')
    else if (r.status === 403) { U.bad('השרת אומר שהקוד לא נכון. נשמר בכל זאת; אפשר להריץ שוב'); todo.push('קוד גישה לענן: helper onboard') }
    else U.warn(`נשמר. השרת ענה ${r.status}`)
  } catch (e) { U.warn('נשמר. השרת לא ענה כרגע (' + e.message + ')') }
}

// ---- 8. shortcuts and starting with Windows ---------------------------------------------------------

async function autostart(parts) {
  U.step(8, TOTAL, 'קיצורי דרך והפעלה עם Windows')
  if (!IS_WIN) { U.info('לא Windows: בשרת מריצים עם docker compose או pm2 (ראו README)'); return }
  // --no-autostart: nothing here is touched, neither made nor taken away.
  if (!F.autostart) { U.info('דולג (--no-autostart): ההגדרות הקיימות נשארו כמו שהן'); return }
  if (parts.bot) {
    const link = path.join(L.startupDir(), L.BOT_AUTOSTART)
    const want = await U.confirm('שהבוט יעלה לבד כשהמחשב נדלק?', true)
    if (want) {
      if (shortcut(link, path.join(ROOT, 'start.bat'), { cwd: ROOT, minimized: true, description: 'HELPER: הבוט בוואטסאפ' })) U.ok('הבוט יעלה עם Windows (ממוזער)')
      else U.warn('לא הצלחתי ליצור את קיצור ההפעלה')
    } else if (fs.existsSync(link)) { fs.rmSync(link); U.info('הבוט לא יעלה לבד עם Windows') }
  }
  if (parts.desktop) {
    const electron = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe')
    const icon = path.join(DESKTOP, 'ui', 'icon.ico')
    let made = 0
    for (const dir of [path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(os.homedir(), 'Desktop')]) {
      if (fs.existsSync(dir) && shortcut(path.join(dir, 'HELPER.lnk'), electron, { args: `"${DESKTOP}"`, cwd: DESKTOP, icon, description: 'HELPER: לוחצים PD ומדברים' })) made++
    }
    if (made) U.ok('קיצור דרך "HELPER" בתפריט התחל ובשולחן העבודה')
    const atLogin = await U.confirm('ש-HELPER למחשב יעלה לבד עם Windows?', L.desktopSettings().startAtLogin !== false)
    L.saveDesktopSettings({ startAtLogin: atLogin })
    U.ok(atLogin ? 'HELPER למחשב יעלה עם Windows' : 'HELPER למחשב לא יעלה לבד')
  }
}

// ---- 9. checks and starting -------------------------------------------------------------------------

async function checksAndStart(parts) {
  U.step(9, TOTAL, 'בדיקות והפעלה')
  if (F.checks) {
    if (parts.bot && L.state(F.envFile).botDeps) {
      // Like CI: an empty data folder and .env, so the check cannot touch the real ones.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-setup-check-'))
      const r = spawnSync(process.execPath, ['src/selftest.js'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, HELPER_DATA_DIR: tmp, HELPER_ENV_FILE: path.join(tmp, '.env'), HELPER_OFFLINE: '1' } })
      fs.rmSync(tmp, { recursive: true, force: true })
      r.status === 0 ? U.ok('הבוט: הבדיקות עברו') : (U.bad('הבוט: בדיקה נכשלה'), U.info(((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-5).join('\n    ')))
    }
    if (parts.desktop && L.state(F.envFile).desktopDeps) {
      const r = spawnSync(process.execPath, ['test/selftest.js'], { cwd: DESKTOP, encoding: 'utf8', windowsHide: true, timeout: 120000 })
      const last = ((r.stdout || '').trim().split('\n').pop() || '')
      r.status === 0 ? U.ok('HELPER למחשב: ' + last) : (U.bad('HELPER למחשב: ' + last), todo.push('לבדוק: cd desktop && npm run check'))
    }
  } else U.info('בדיקות: דולג (--no-checks)')

  if (!F.start) { U.info('הפעלה: דולג (--no-start)'); return }
  const now = L.running()
  const st = L.state(F.envFile)
  if (parts.desktop && st.desktopDeps) {
    if (now.desktop) U.ok('HELPER למחשב כבר רץ (אייקון ליד השעון)')
    else if (await U.confirm('להפעיל את HELPER למחשב עכשיו?', true)) {
      const electron = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe')
      spawn(electron, [DESKTOP], { cwd: DESKTOP, detached: true, stdio: 'ignore' }).unref()
      U.ok('HELPER למחשב עלה: לוחצים PD (PageDown) ומדברים')
    }
  }
  if (parts.bot && st.botDeps && st.model.key) {
    if (now.bot) U.ok('הבוט כבר רץ')
    else if (await U.confirm(st.whatsapp ? 'להפעיל את הבוט עכשיו?' : 'להפעיל את הבוט עכשיו? (ייפתח חלון עם קוד QR לוואטסאפ)', true)) {
      if (IS_WIN) spawn('cmd.exe', ['/c', 'start', '"HELPER"', path.join(ROOT, 'start.bat')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false }).unref()
      else spawn(process.execPath, ['src/index.js'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref()
      U.ok('הבוט עלה בחלון משלו')
      if (!st.whatsapp) todo.push('לסרוק את קוד ה-QR: וואטסאפ בטלפון ← מכשירים מקושרים ← קישור מכשיר (או לפתוח data\\qr.png)')
    }
  }
}

// ---- the whole run ----------------------------------------------------------------------------------

async function main() {
  U.banner(['HELPER — התקנה בפקודה אחת', 'עונים על כמה שאלות, והכל מוכן. Enter = ברירת המחדל.'])
  if (U.isAuto()) U.info('מצב בלי שאלות (--yes): ברירות מחדל בכל מקום')
  const { s, gpu } = await checkPc()
  const parts = await chooseParts(s)
  const model = parts.bot || parts.desktop ? await configureModel(s) : null
  const extras = await configureExtras()
  writeEnv(Object.assign({}, model || {}, extras))
  await install(parts, L.state(F.envFile))
  await speech(parts, gpu)
  await linkCloud(parts)
  await autostart(parts)
  await checksAndStart(parts)

  U.say('')
  U.banner(todo.length ? ['כמעט מוכן. נשאר:'] : ['HELPER מוכן ✓'])
  for (const t of todo) U.say('  • ' + t)
  U.say('')
  U.say(U.c.dim('  מצב בכל רגע: helper doctor   ·   להתקין שוב / לשנות: helper onboard   ·   לעדכן: helper update'))
  U.close()
}

main().catch((e) => {
  U.say('')
  U.bad('ההתקנה נעצרה: ' + e.message)
  U.close()
  process.exit(1)
})
