// The brain for what the instant commands don't cover: Claude Code on this PC (the user's own Claude plan, no API
// key), with HELPER's hands on the PC (bin/hands.mjs) and HELPER's memory on the cloud. When Claude Code can't run
// (not installed, not signed in), HELPER on the cloud answers instead.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const store = require('./store')

const HANDS = path.join(__dirname, '..', 'bin', 'hands.mjs').replace(/\\/g, '/')
const CONTINUE_MS = 3 * 60 * 1000   // a new ask this soon after the last one continues the same conversation

let lastSession = null
let lastAt = 0
let running = null
let claudeState = 'unknown'         // unknown | ok | missing | signed-out

function persona() {
  return [
    'אתה HELPER, העוזר האישי של נאור, כאן על המחשב שלו (Windows 11, שני מסכים). אותו HELPER כמו בוואטסאפ ובטלוויזיה.',
    'קול: חבר חד ומצחיק, עברית מדוברת וטבעית. תענה קודם, קצר. בלי "בטח!", "כמובן", "אשמח לעזור", בלי לחזור על הבקשה ובלי "עוד משהו?".',
    'התשובה שלך מופיעה בבועה קטנה בראש המסך: שורה או שתיים בדרך כלל. ארוך רק כשהוא מבקש הסבר או טקסט.',
  ].join('\n')
}

function handsDoc() {
  const h = `node ${HANDS}`
  return [
    'הידיים שלך במחשב: פקודת bash אחת לכל פעולה, עם JSON בגרש בודד. כל פקודה מחזירה שורה בעברית או שגיאה.',
    `${h} windows                                   – החלונות הפתוחים: id, אפליקציה, מסך, כותרת`,
    `${h} apps '{"query":"spot"}'                  – אפליקציות מותקנות לפי שם`,
    `${h} open '{"name":"Spotify"}'                – פותח אפליקציה (או עובר אליה אם פתוחה), או אתר כמו ynet.co.il`,
    `${h} focus '{"name":"Chrome"}'                – מביא חלון קדימה (שם אפליקציה או id)`,
    `${h} place '{"name":"Chrome","where":"left","screen":"next"}' – where: left|right|top|bottom|center|max|min|restore; screen: next|ימני|שמאלי|גדול|1|2`,
    `${h} close '{"name":"Discord"}'               – סוגר חלון`,
    `${h} type '{"text":"שלום"}'                   – מקליד בשדה שבפוקוס (כל שפה)`,
    `${h} key '{"keys":"ctrl+l"}'                  – קיצור מקלדת: ctrl, alt, shift, win, enter, tab, esc, f1..f12, חצים, אותיות`,
    `${h} click '{"x":1200,"y":540}'               – לחיצה בפיקסלים של המסך (button: right, count: 2 לדאבל-קליק)`,
    `${h} scroll '{"amount":-5}'                   – גלילה (שלילי = למטה)`,
    `${h} screenshot '{"screen":1}'                – צילום מסך; מחזיר נתיב קובץ שקוראים עם Read, ואיך לתרגם מיקום בתמונה למסך`,
    `${h} point '{"x":1200,"y":540,"label":"כאן"}' – מסמן עיגול ותווית על המסך, כשהוא שואל איפה ללחוץ או איפה משהו`,
    `${h} volume '{"op":"set","value":30}'         – op: up|down|mute|set`,
    `${h} media '{"op":"next"}'                    – play|pause|next|prev`,
    `${h} search '{"query":"...","site":"youtube"}' – site: google|youtube|maps`,
    `${h} web '{"url":"https://..."}'              – פותח כתובת בדפדפן`,
    `${h} remember '{"fact":"..."}'                – לזכור משהו עליו (כשהוא אומר "תזכור")`,
    `${h} helper '{"question":"..."}'              – לשאול את HELPER בענן: הוואטסאפ, המייל, היומן, תזכורות, ומה שהוא סיפר לך שם`,
    `${h} confirm '{"question":"לשלוח את המייל לדני?"}' – שואל אותו כן/לא ומחכה; מחזיר "כן" או "לא"`,
    `${h} say '{"text":"..."}'                     – שורת ביניים בבועה במשימה ארוכה`,
  ].join('\n')
}

function rules() {
  return [
    'כללים:',
    '- לפני כל שליחה (הודעה, מייל, פוסט), מחיקה, קנייה, תשלום או שינוי הגדרה: confirm, ורק על "כן" ממשיכים. בלי יוצא מן הכלל.',
    '- אל תריץ פקודות מערכת אחרות; רק את הידיים, וכלי הקריאה והחיפוש.',
    '- כשהוא שואל על משהו במסך ("מה זה", "מה כתוב", "איפה ללחוץ"): screenshot, Read לתמונה, ותענה לפי מה שרואים. "איפה" → גם point.',
    '- כשהוא מבקש לסדר חלונות או לפתוח דברים: תעשה, ואז משפט קצר שאומר מה עשית.',
    '- מה שאתה לא מצליח לוודא שקרה, תגיד שלא וידאת.',
    '- שאלות אישיות (מה כתבו לו, מה ביומן, מה הוא סיפר לך פעם): helper.',
    '- התשובה הסופית שלך היא מה שמופיע לו בבועה. בלי markdown, בלי כותרות, בלי רשימות ארוכות.',
  ].join('\n')
}

function context(extra) {
  const lines = []
  const mem = store.memory()
  if (mem.length) lines.push('מה שהוא ביקש שתזכור:\n' + mem.slice(-40).map((m) => '- ' + m.text).join('\n'))
  const now = new Date()
  lines.push(`עכשיו: ${now.toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`)
  if (extra.foreground) lines.push(`החלון שבחזית: ${extra.foreground}`)
  if (extra.screens) lines.push(`מסכים: ${extra.screens}`)
  return lines.join('\n')
}

/**
 * claude.exe itself, run with no shell: through claude.cmd and cmd.exe, Hebrew, quotes and new lines in the
 * arguments would be mangled. npm puts it under node_modules next to claude.cmd; the native installer in ~/.local/bin.
 */
let claudeExe
function claudeCommand() {
  if (claudeExe) return claudeExe
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.local', 'bin'))
  const candidates = []
  for (const d of dirs) {
    candidates.push(path.join(d, 'claude.exe'))
    candidates.push(path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  }
  claudeExe = candidates.find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) || null
  return claudeExe
}

/**
 * Asks Claude Code. onEvent({type:'text'|'tool'|'done'|'error', ...}) streams what happens.
 * extra: {screenshot, mark, foreground, screens, model}. Resolves {text, ok, session}.
 */
function askClaude(text, extra, onEvent) {
  if (running) running.kill()
  const settings = store.settings()
  const model = extra.model || settings.model || 'haiku'
  let prompt = text
  if (extra.screenshot) prompt += `\n\n[צילום של המסך שלו מהרגע הזה: ${extra.screenshot.path.replace(/\\/g, '/')} — ${extra.screenshot.note}]`
  if (extra.mark) prompt += `\n\n[הוא סימן על המסך את האזור הזה (פיקסלים של המסך): x=${extra.mark.x}, y=${extra.mark.y}, רוחב ${extra.mark.width}, גובה ${extra.mark.height}. תמונה של האזור: ${extra.mark.crop.replace(/\\/g, '/')}. השאלה שלו היא על מה שסימן.]`

  const system = [persona(), handsDoc(), rules(), context(extra)].join('\n\n')
  const systemFile = path.join(store.workDir(), 'system.txt')
  fs.writeFileSync(systemFile, system, 'utf8')
  const home = process.env.USERPROFILE ? process.env.USERPROFILE.replace(/\\/g, '/') : null
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--append-system-prompt-file', systemFile,
    '--allowedTools', `Bash(node ${HANDS}:*)`, 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
    '--max-turns', '24',
  ]
  if (home) args.push('--add-dir', home)
  if (lastSession && Date.now() - lastAt < CONTINUE_MS) args.push('--resume', lastSession)

  return new Promise((resolve) => {
    let out = ''
    let final = null
    let session = null
    let child
    const exe = claudeCommand()
    if (!exe) {
      claudeState = 'missing'
      return resolve({ ok: false, missing: true, text: '' })
    }
    try {
      child = spawn(exe, args, { cwd: store.workDir(), windowsHide: true, env: Object.assign({}, process.env, { HELPER_DESKTOP: '1' }) })
    } catch (e) {
      claudeState = 'missing'
      return resolve({ ok: false, missing: true, text: '' })
    }
    running = child
    // The ask goes in on stdin: any length, any language, no quoting.
    child.stdin.end(prompt, 'utf8')
    const onLine = (line) => {
      let ev
      try { ev = JSON.parse(line) } catch { return }
      if (ev.session_id) session = ev.session_id
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'text' && c.text.trim()) onEvent({ type: 'text', text: c.text.trim() })
          if (c.type === 'tool_use') onEvent({ type: 'tool', name: c.name, input: c.input })
        }
      }
      if (ev.type === 'result') final = ev
    }
    child.stdout.on('data', (d) => {
      out += d.toString('utf8')
      let i
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim()
        out = out.slice(i + 1)
        if (line) onLine(line)
      }
    })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', () => { claudeState = 'missing'; resolve({ ok: false, missing: true, text: '' }) })
    child.on('close', (code) => {
      if (running === child) running = null
      if (out.trim()) onLine(out.trim())
      const resultText = final ? String(final.result || '') : ''
      if (/not logged in|please run \/login|invalid api key|authentication/i.test(resultText + err)) {
        claudeState = 'signed-out'
        return resolve({ ok: false, signedOut: true, text: '' })
      }
      if (/is not recognized|not found|ENOENT/i.test(err) && !final) {
        claudeState = 'missing'
        return resolve({ ok: false, missing: true, text: '' })
      }
      claudeState = 'ok'
      if (session) { lastSession = session; lastAt = Date.now() }
      resolve({ ok: Boolean(final && !final.is_error), text: resultText.trim(), session, code })
    })
  })
}

function cancel() {
  if (running) { running.kill(); running = null }
}

/** HELPER on the cloud: its memory, WhatsApp, mail and calendar. Resolves {reply, audio} or throws in Hebrew. */
async function askHelper(text, { voice = false } = {}) {
  const s = store.settings()
  if (!s.helperUrl || !s.helperToken) throw new Error('HELPER בענן עוד לא מחובר למחשב (חסר קוד חיבור). מריצים פעם אחת את desktop\\connect.ps1.')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90000)
  try {
    const r = await fetch(s.helperUrl.replace(/\/$/, '') + '/bridge/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + s.helperToken },
      body: JSON.stringify({ text, source: 'pc', voice, audio: voice }),
      signal: ctrl.signal,
    })
    if (r.status === 403) throw new Error('הקוד של HELPER בענן לא נכון. מריצים שוב את desktop\\connect.ps1.')
    if (!r.ok) throw new Error('HELPER בענן לא ענה (' + r.status + ')')
    const j = await r.json()
    return { reply: String(j.reply || '').trim(), audio: j.audio || null }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('HELPER בענן לא ענה בזמן')
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(e.message)) throw new Error('אין חיבור ל-HELPER בענן')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** HELPER's own voice for a line, as MP3 bytes (ElevenLabs, on the cloud). */
async function voiceOf(text) {
  const s = store.settings()
  if (!s.helperUrl || !s.helperToken) return null
  const r = await fetch(s.helperUrl.replace(/\/$/, '') + '/bridge/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + s.helperToken },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) return null
  return Buffer.from(await r.arrayBuffer())
}

module.exports = { askClaude, askHelper, voiceOf, cancel, state: () => claudeState, HANDS }
