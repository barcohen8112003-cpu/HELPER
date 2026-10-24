// The brain for what the instant commands don't cover: Claude Code on this PC (the user's own Claude plan, no API
// key), with HELPER's hands on the PC (bin/hands.mjs) and HELPER's memory on the cloud. When Claude Code can't run
// (not installed, not signed in), HELPER on the cloud answers instead.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const store = require('./store')
const directLlm = require('./direct-llm')

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
    '',
    'איך מדברים, כי התשובה גם נשמעת בקול:',
    '- כמו בן אדם שמדבר, לא כמו מערכת שמדווחת. "פתחתי את המחשבון ושמתי אותו משמאל", לא "בוצע: מחשבון - צד שמאל".',
    '- משפטים קצרים, גוף ראשון, זמן עבר על מה שעשית. כתוב את המספרים כמו שאומרים אותם ("חמש דקות", "עשרים ושלוש עשרים וחמש").',
    '- בלי סימנים שלא נקראים בקול: סוגריים, נקודותיים, חצים, קווים, אימוג׳י, קישורים, נתיבים, מזהים, קוד. שם של אפליקציה כמו שאומרים אותו.',
    '- תתאים את הטון אליו: אם הוא ממהר, מילה או שתיים. אם הוא שואל, תענה בשלמות. אם הוא כועס או לחוץ, בלי בדיחות.',
    '- כשמשהו נכשל, תגיד מה קרה בפשטות ומה אפשר לעשות, לא "אירעה שגיאה".',
    '- כשאתה לא בטוח מה הוא התכוון (התמלול לפעמים משובש, למשל "פלסטרום"), תנחש לפי מה שפתוח אצלו ותגיד מה הבנת, או תשאל שאלה אחת קצרה.',
  ].join('\n')
}

function handsDoc() {
  const h = `node ${HANDS}`
  return [
    'הידיים שלך במחשב: פקודות bash עם JSON בגרש בודד. כל פקודה מחזירה שורה בעברית או שגיאה.',
    'מהירות: כל קריאה לכלי היא עוד סבב של כמה שניות. כמה פעולות → קריאה אחת של batch. רשימת החלונות כבר למטה בהקשר, אל תבקש אותה שוב.',
    `${h} batch '{"steps":[{"cmd":"open","args":{"name":"מחשבון"}},{"cmd":"place","args":{"name":"מחשבון","where":"left"}}]}'  – כמה פעולות בקריאה אחת, לפי הסדר (עד 12). תמיד עדיף על קריאות נפרדות: כל קריאה היא עוד סבב של שניות`,
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
    `${h} play '{"query":"אופק אדנק נתתי לך בית"}'   – מנגן: מוצא את הסרטון או השיר הראשון ביוטיוב ומפעיל אותו. לכל "תפעיל / תנגן / תשים לי" של סרטון או שיר`,
    `${h} search '{"query":"...","site":"youtube"}' – רק חיפוש (כשהוא אומר "תחפש"), site: google|youtube|maps`,
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
    '- כשהוא שואל על משהו במסך ("מה זה", "מה כתוב", "איפה ללחוץ"): אם צורף צילום, Read אליו (זה המסך שהוא עובד עליו) ותענה לפי מה שרואים; בלי צילום, screenshot בלי מספר מסך. מסך אחר רק כשמה שהוא שאל עליו לא שם. "איפה" → גם point.',
    '- כשהוא מבקש לסדר חלונות או לפתוח דברים: תעשה, ואז משפט קצר שאומר מה עשית.',
    '- משימה מורכבת (כמה אפליקציות, מסכים, סדר): חשוב קודם על כל הצעדים, ובצע אותם כולם בקריאה אחת של batch. אל תעשה צעד, תחכה לתשובה, ואז עוד צעד.',
    '- אחרי משימה שמסדרת חלונות, אם יש ספק שזה הצליח (חלון שלא נפתח, מסך אחר), בדוק עם windows פעם אחת, ותקן.',
    '- בקשה שיש בה שתי משימות נפרדות ("תפתח את X, ותגיד לי מה השעה"): תעשה את שתיהן ותענה על שתיהן במשפט אחד.',
    '- התשובה של הידיים ("כרום בצד שמאל") היא האישור שזה קרה: אל תוסיף "לא וידאתי". רק כשצעד נכשל, או כשאין לך דרך לדעת, תגיד את זה.',
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
  if (extra.opened) lines.push('מה ש-HELPER פתח בחצי השעה האחרונה (אם הוא אומר "תסגור מה שפתחת", זה מה שהוא מתכוון): ' + extra.opened)
  if (extra.windows) lines.push('החלונות הפתוחים (id, אפליקציה, מסך, כותרת):\n' + extra.windows)
  return lines.join('\n')
}

/**
 * claude.exe itself, run with no shell: through claude.cmd and cmd.exe, Hebrew, quotes and new lines in the
 * arguments would be mangled. npm puts it under node_modules next to claude.cmd; the native installer in ~/.local/bin.
 */
let claudeExe
function claudeCommand() {
  // Tests put a stand-in here that speaks Claude Code's stream-json (test/fake-claude.js).
  if (process.env.HELPER_CLAUDE_EXE) return process.env.HELPER_CLAUDE_EXE
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
    // Lean: only the tools HELPER uses, and none of the user's MCP servers, plugins, skills or settings (each
    // adds to every request, and none of them is HELPER's business).
    '--tools', 'Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands',
  ]
  if (home) args.push('--add-dir', home)
  if (lastSession && Date.now() - lastAt < CONTINUE_MS) args.push('--resume', lastSession)

  return new Promise((done) => {
    let out = ''
    let final = null
    let session = null
    let child
    // Claude Code writes a summary for two seconds after the answer (post_turn_summary): the answer is shown as
    // soon as it is plainly the last message (text with no tool call, and nothing after it for a moment).
    let settled = false
    const resolve = (r) => { if (!settled) { settled = true; done(r) } }
    let lastText = null
    let early = null
    const exe = claudeCommand()
    if (!exe) {
      claudeState = 'missing'
      return resolve({ ok: false, missing: true, text: '' })
    }
    try {
      const env = Object.assign({}, process.env, { HELPER_DESKTOP: '1' })
      // A .js stand-in (tests) runs through Node: Electron's own binary is Node with ELECTRON_RUN_AS_NODE.
      child = /\.m?js$/i.test(exe)
        ? spawn(process.execPath, [exe, ...args], { cwd: store.workDir(), windowsHide: true, env: Object.assign(env, { ELECTRON_RUN_AS_NODE: '1' }) })
        : spawn(exe, args, { cwd: store.workDir(), windowsHide: true, env })
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
        let tool = false
        let text = ''
        for (const c of ev.message.content) {
          if (c.type === 'text' && c.text.trim()) { text += (text ? '\n' : '') + c.text.trim(); onEvent({ type: 'text', text: c.text.trim() }) }
          if (c.type === 'tool_use') { tool = true; onEvent({ type: 'tool', name: c.name, input: c.input }) }
        }
        clearTimeout(early)
        lastText = tool ? null : text || null
        if (lastText && !/not logged in|please run \/login|invalid api key/i.test(lastText)) {
          const answer = lastText
          early = setTimeout(() => {
            if (lastText !== answer) return
            claudeState = 'ok'
            if (session) { lastSession = session; lastAt = Date.now() }
            resolve({ ok: true, text: answer, session, early: true })
          }, 350)
        }
      } else if (ev.type === 'user') {
        clearTimeout(early)   // a tool result: the turn goes on
        lastText = null
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
      clearTimeout(early)
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
      resolve({ ok: Boolean(final && !final.is_error), text: resultText.trim(), session, code, subtype: final && final.subtype, err: err.slice(-300) })
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

/**
 * Unified smart ask: tries Claude Code if available and valid, but falls back seamlessly to direct LLM with full tools & vision.
 */
async function ask(text, extra, onEvent) {
  const exe = claudeCommand()
  if (exe && claudeState !== 'signed-out') {
    try {
      const res = await askClaude(text, extra, onEvent)
      if (res && res.ok && res.text && !/usage_limit_reached|session limit/i.test(res.text)) {
        return res
      }
    } catch {}
  }
  return await directLlm.ask(text, extra, onEvent)
}

module.exports = { ask, askClaude, askHelper, voiceOf, cancel, state: () => claudeState, HANDS }
