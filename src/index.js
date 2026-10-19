import fs from 'node:fs'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import { config, DATA_DIR } from './config.js'
import { state, save } from './store.js'
import { startWhatsApp } from './whatsapp.js'
import { runTurn, runTask, resetHistory, compact, setSettingsUrl } from './agent.js'
import { startScheduler } from './scheduler.js'
import { prepare, speak } from './media.js'
import { setLocation, isLiveUpdate } from './location.js'
import { createOutbox } from './outbox.js'
import { chatModel, Aborted } from './llm.js'
import { parseCommand } from './commands.js'
import { status } from './status.js'
import { startUi } from './ui.js'
import { wakeEnabled, wakePc } from './wake.js'
import { startPcBridgeServer, bridgeLabel } from './pc-bridge.js'
import { startVoice } from './voice.js'
import { createMonitoring } from './monitoring/index.js'
import { inQuietHours } from './outbox.js'
import { calendarOn, listEvents } from './calendar.js'
import { getDay } from './day.js'

let reconciled = false
import { exec } from 'node:child_process'

if (!config.llm.apiKey || !config.llm.model) {
  console.log('חסר LLM_API_KEY או LLM_MODEL. העתק את .env.example ל-.env ומלא אותם.')
  // 2 tells start.bat this is a setup problem, not a crash worth restarting for.
  process.exit(2)
}
// Open the bridge port before WhatsApp connects, so a platform health check is not waiting on the login.
startPcBridgeServer()

// One assistant per data folder: two would share the WhatsApp session and answer every message twice.
const LOCK = path.join(DATA_DIR, 'helper.lock')
const HEALTHY = path.join(DATA_DIR, 'healthy')
const running = (pid) => {
  try {
    return process.kill(pid, 0)
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const lockedBy = Number(fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8'))
if (lockedBy && lockedBy !== process.pid && running(lockedBy)) {
  console.log(`העוזר כבר רץ (תהליך ${lockedBy}). סגור את החלון השני לפני שמפעילים שוב.`)
  process.exit(2)
}
fs.writeFileSync(LOCK, String(process.pid))
fs.rmSync(HEALTHY, { force: true })
process.on('exit', () => fs.rmSync(LOCK, { force: true }))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => process.exit(0))
// start.bat reads this file as "the last run was fine", and stops retrying only after a string of quick crashes.
setTimeout(() => fs.writeFileSync(HEALTHY, ''), 5 * 60000).unref()

// One bad promise should not take the assistant down; start.bat restarts it if something worse does.
process.on('unhandledRejection', (e) => console.log(`[error] ${e?.message || e}`))

const CONFIRM_TIMEOUT = 5 * 60000
const LATE_NOTE = 120
const APPROVE = ['👍', '✅', '❤️', '👌']
const DENY = ['👎', '❌']
const EXAMPLES = `*דברים לנסות*
• "תזכיר לי מחר ב-8 להביא את הטופס"
• "תעקוב אחרי המחיר של [קישור] ותגיד לי כשהוא מתחת ל-300"
• "כל בוקר ב-7:30 תגיד לי מה יש לי היום"
• "מה יש להגיש השבוע?"
• לשלוח לי תמונה של דף עבודה, PDF או הודעה קולית`
const HELP = `*פקודות*
/status - מה מחובר ואחרי מה אני עוקב
/wake - מדליק את המחשב מרחוק
/watch status - מעקב שקט: מה נצפה, כמה סונן, מה מושתק או מוגבר (/watch לכל הפקודות)
עצור - מפסיק את מה שאני עושה עכשיו ומוותר על מה שחיכה בתור
שיחה חדשה (או /new) - מתחיל שיחה חדשה (זיכרון, תזכורות ומעקבים נשארים)
/voice on - עונה בהודעה קולית על כל הודעה, /voice off חוזר לטקסט
/compact - מסכם את השיחה כדי לחסוך
/model strong - עובר למודל החזק, /model default חוזר
/unpair - מנתק את הצ'אט הזה
/help - ההודעה הזאת

חוץ מזה פשוט כותבים לי: טקסט, הודעה קולית, תמונה או קובץ.`

let pairCode = null
let pendingConfirm = null
let queue = Promise.resolve()
// The turn that is running for a WhatsApp message ({ ac: AbortController, done: Promise }), so "עצור" can end it.
let activeTurn = null
// Bumped by "עצור" and "שיחה חדשה": messages that were already waiting in the queue are dropped, not answered late.
let stopEpoch = 0

function announcePairing() {
  pairCode = String(randomInt(100000, 1000000))
  console.log(`\nקוד צימוד: ${pairCode}\nשלח את הקוד הזה בוואטסאפ בצ'אט שבו תרצה לדבר עם העוזר (למשל "הודעה לעצמך").\n`)
}

const isOwner = (m) =>
  state.owner && m.fromMe === state.owner.self && (m.jids.some((j) => state.owner.jids.includes(j)) || (state.owner.selfChat && m.selfChat))

const wa = await startWhatsApp(async (m) => {
  if (!state.owner) {
    if (!pairCode || !m.text.includes(pairCode)) return
    state.owner = { jid: m.jids[0], jids: m.jids, self: m.fromMe, selfChat: m.selfChat }
    pairCode = null
    save()
    console.log(`צומד לצ'אט ${m.jids[0]}`)
    await wa.send(state.owner.jid, `היי, אני ${config.botName} 👋 מעכשיו אפשר לכתוב לי כאן.\n\n${HELP}`)
    return
  }
  if (!isOwner(m)) return
  const text = m.text.trim()

  // A reaction only ever answers a pending approval: thumbs-up approves, thumbs-down cancels, anything else is ignored.
  if (m.reaction) {
    const answer = APPROVE.includes(m.reaction) ? true : DENY.includes(m.reaction) ? false : null
    if (pendingConfirm && answer !== null) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(answer)
    }
    return
  }
  // A shared location is saved, no model involved. A bare 📍 gets a 📍 back; updates of a live location get nothing.
  // With a comment ("תזמין לכאן פיצה") the message goes on to the model, which now sees the new location.
  if (m.location) {
    const update = isLiveUpdate(m.location)
    await setLocation(m.location).catch((e) => console.log(`[location] ${e.message}`))
    if (!text) return update ? undefined : wa.react(state.owner.jid, m.key, '📍').catch(() => {})
  }
  // "עצור" ends what the assistant is doing and forgets what was waiting; "שיחה חדשה" does that and clears the chat.
  // Both answer at once: no model, no queue.
  const command = parseCommand(text)
  if (command) {
    // A question waiting for approval is answered "no" first, so the turn is not left hanging on it.
    if (pendingConfirm) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(false)
    }
    const running = activeTurn
    stopEpoch++
    running?.ac.abort()
    if (command === 'stop') return wa.send(state.owner.jid, running ? 'עצרתי.' : 'אין מה לעצור.')
    // The stopped turn rolls its own messages back; the history is cleared only after that, never under it.
    if (running) await Promise.race([running.done, new Promise((r) => setTimeout(r, 10000))])
    resetHistory()
    return wa.send(state.owner.jid, 'שיחה חדשה. הזיכרון, התזכורות והמעקבים נשארו.')
  }
  if (pendingConfirm) {
    const resolve = pendingConfirm
    pendingConfirm = null
    resolve(/^(כן|אשר|מאשר|yes|y|ok|אוקיי|אוקי|👍|✅)(?=$|[\s.,!])/i.test(text))
    return
  }
  if (text === '/help') return wa.send(state.owner.jid, HELP)
  // A shortcut: no model, no queue, no cost. It answers while a long turn is still running.
  if (text === '/wake') return wa.send(state.owner.jid, wakeEnabled() ? `🖥️ ${await wakePc().catch((e) => `לא הצלחתי: ${e.message}`)}` : 'ההדלקה מרחוק לא מוגדרת. חסר WAKE_MAC בהגדרות.')
  // Only a command typed by the owner here reaches the watch registry. Nothing read from mail or the web can.
  if (text === '/watch' || text.startsWith('/watch ')) return wa.send(state.owner.jid, await monitoring.command(text))
  if (text === '/status') return wa.send(state.owner.jid, status(wa.connectedSince()))
  if (text === '/compact') {
    const done = await compact(true).catch((e) => (console.log(`[compact] ${e.message}`), false))
    return wa.send(state.owner.jid, done ? 'סיכמתי את השיחה עד עכשיו ופיניתי מקום.' : 'אין מה לסכם כרגע.')
  }
  if (text === '/model' || text.startsWith('/model ')) {
    const want = text.slice(6).trim()
    if (want === 'default') state.modelOverride = ''
    else if (want === 'strong') {
      if (!config.llm.strongModel) return wa.send(state.owner.jid, 'לא הוגדר מודל חזק. צריך למלא LLM_STRONG_MODEL בקובץ .env')
      state.modelOverride = config.llm.strongModel
    } else if (want) state.modelOverride = want
    save()
    return wa.send(state.owner.jid, `מודל נוכחי: ${chatModel()}${state.modelOverride ? ' (נעול עד /model default או /new)' : ' (ברירת המחדל)'}`)
  }
  if (text === '/voice' || text.startsWith('/voice ')) {
    const want = text.slice(6).trim()
    if (want === 'on') state.voiceMode = 'always'
    if (want === 'off') state.voiceMode = 'match'
    save()
    return wa.send(state.owner.jid, state.voiceMode === 'always' ? 'מצב קול פעיל: אני עונה בהודעה קולית על כל הודעה. /voice off מכבה.' : 'מצב קול כבוי: אני עונה בקול רק על הודעה קולית. /voice on מפעיל.')
  }
  if (text === '/unpair') {
    await wa.send(state.owner.jid, 'נותקתי מהצ\'אט הזה. קוד צימוד חדש מופיע בחלון של התוכנה.')
    state.owner = null
    state.manualPair = true
    save()
    return announcePairing()
  }

  const epoch = stopEpoch
  queue = queue.then(async () => {
    if (epoch !== stopEpoch) return // stopped, or a new conversation began, while this was waiting its turn
    const ac = new AbortController()
    let finish
    activeTurn = { ac, done: new Promise((r) => (finish = r)) }
    wa.typing(state.owner.jid)
    // A long turn (search, several pages) outlasts one typing indicator.
    const typing = setInterval(() => wa.typing(state.owner.jid), 8000)
    // The message gets a thinking face the moment work starts, swapped for a check mark once the answer has landed.
    let reacted = false
    let answered = false
    const react = (emoji) => ((reacted = true), wa.react(state.owner.jid, m.key, emoji))
    await wa.react(state.owner.jid, m.key, '🤔').catch(() => {})
    try {
      const input = await prepare({ text, media: await m.getMedia() })
      // Written while the assistant was off: the model should know it is answering late, since "now" may have moved on.
      if (m.lateSeconds > LATE_NOTE) input.text = `[ההודעה הזאת נכתבה לפני ${Math.round(m.lateSeconds / 60)} דקות, כשהיית כבוי. אתה עונה עליה באיחור - אמור זאת בקצרה, ובדוק אם היא עדיין רלוונטית.]\n${input.text}`
      // Sending in the owner's name is offered only here, in his own WhatsApp chat, never to scheduled runs or the bridge.
      const reply = await runTurn(input.text, { confirm, sendMedia, say, react, sendAs: wa.sendAs, findContact: wa.findContact, signal: ac.signal }, input.image)
      // A spoken message gets a spoken answer, and in "always" voice mode so does a typed one.
      // The text follows only when it has links, or when speech failed.
      const wantsVoice = input.voice || state.voiceMode === 'always'
      const spoken = reply && wantsVoice ? await speak(reply).catch((e) => (console.log(`[voice] ${e.message}`), null)) : null
      if (spoken) await wa.sendVoice(state.owner.jid, spoken)
      if (reply && (!spoken || /https?:\/\//.test(reply))) await wa.send(state.owner.jid, reply)
      answered = true
    } catch (e) {
      // Stopping is the user's own doing: no warning, the "עצרתי" has already been sent.
      if (e instanceof Aborted || ac.signal.aborted) console.log('[agent] הופסק על ידי המשתמש')
      else {
        console.log(`[agent] ${e.message}`)
        await wa.send(state.owner.jid, `⚠️ ${e.message}`).catch(() => {})
      }
    } finally {
      clearInterval(typing)
      // An emoji the model chose as its answer stays. After an error the thinking face just comes off.
      if (!reacted) wa.react(state.owner.jid, m.key, answered ? '✅' : '').catch(() => {})
    }
    await compact().catch((e) => console.log(`[compact] ${e.message}`))
    if (activeTurn?.ac === ac) activeTurn = null
    finish()
  })
}, pairWithSelf)

// Default pairing: the moment the QR is scanned, the assistant lives in the account's "message yourself" chat.
// Skipped after /unpair, where the user picks a chat with the pairing code instead.
async function pairWithSelf(me) {
  // Already paired with the self-chat: keep its list of addresses current, since the lid can become known later.
  if (state.owner?.selfChat && state.owner.self) {
    state.owner.jids = [...new Set([...state.owner.jids, me.jid, me.lid].filter(Boolean))]
    save()
  }
  // Once per run, as soon as there is a connection: settle any message that was mid-send when the last run ended.
  if (state.owner && !reconciled) {
    reconciled = true
    monitoring.reconcile().catch((e) => console.log(`[watch] ${e.message}`))
  }
  if (state.owner || state.manualPair) return
  state.owner = { jid: me.jid, jids: [me.jid, me.lid].filter(Boolean), self: true, selfChat: true }
  save()
  console.log('מחובר לצ\'אט שלך עם עצמך. כתוב שם כדי לדבר עם העוזר.')
  await wa.send(state.owner.jid, `היי, אני ${config.botName} 👋 מעכשיו כותבים לי כאן, בצ'אט שלך עם עצמך.\n\n${EXAMPLES}\n\n${HELP}`)
}

const sendMedia = (media) => wa.sendMedia(state.owner.jid, media)
const say = (text) => wa.send(state.owner.jid, text)

// `media` ({ buffer, mime }): the question goes out as that image's caption, so a checkout screen and what it asks
// for arrive as one bubble.
function confirm(question, media) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingConfirm === done) pendingConfirm = null
      resolve(false)
    }, CONFIRM_TIMEOUT)
    const done = (ok) => {
      clearTimeout(timer)
      resolve(ok)
    }
    pendingConfirm = done
    const text = `🔐 ${question}\n*כן* או 👍 לאישור, כל דבר אחר מבטל.`
    const sent = media ? wa.sendMedia(state.owner.jid, { ...media, caption: text }).catch(() => wa.send(state.owner.jid, text)) : wa.send(state.owner.jid, text)
    sent.catch(() => done(false))
  })
}

const outbox = createOutbox((text) => wa.send(state.owner.jid, text))
// Scheduled tasks wait their turn in the same queue as chat messages, so two model runs never interleave.
const scheduledTask = (instruction) => {
  const run = queue.then(() => runTask(instruction, { confirm, sendMedia, say, patient: true }))
  queue = run.catch(() => {})
  return run
}
// Quiet monitoring owns mail, calendar and the morning brief. Its only way out is a message to the owner.
const monitoring = createMonitoring({ send: (text) => wa.send(state.owner.jid, text), getDay })

// Proactive notices from the rest of the assistant. During quiet hours a non-urgent one is not held to be sent
// on its own at 08:00: it joins the night's batch and arrives inside the one morning brief.
function notify(text, urgent = false, key) {
  if (urgent || !inQuietHours()) return outbox.notify(text, urgent, key)
  if (key) {
    if (state.sentKeys.includes(key)) return Promise.resolve()
    state.sentKeys = [...state.sentKeys, key].slice(-500)
    save()
  }
  monitoring.addNote(text)
  return Promise.resolve()
}
startScheduler(notify, scheduledTask, monitoring)
startVoice()
setInterval(outbox.flush, 30000)

if (!state.owner) {
  if (state.manualPair) announcePairing()
  else console.log('אחרי סריקת הקוד העוזר יתחבר לבד לצ\'אט שלך עם עצמך ("הודעה לעצמך").')
}
console.log(`${config.botName} רץ. מודל: ${config.llm.model} | שליטה במחשב: ${config.computerMode}${bridgeLabel()}`)

// Exit code 3 asks start.bat for an immediate restart, with no crash delay.
// A message that came in through the bridge (Discord) takes its turn in the same queue as WhatsApp, with the same
// memory and tools. Anything the assistant needs approved, or sends as a file, still goes to the WhatsApp chat.
const BRIDGE_NOTE = {
  voice: (source) => `[שיחה קולית דרך ${source}. התשובה שלך תוקרא בקול: משפט או שניים, בלי עיצוב, בלי אימוג'י, בלי קישורים ובלי רשימות.]`,
  text: (source) => `[הודעה דרך ${source}. עיצוב רגיל של צ'אט, לא של וואטסאפ.]`,
}
const bridgeAsk = (text, { voice, source }) => {
  const run = queue.then(() => runTurn(`${BRIDGE_NOTE[voice ? 'voice' : 'text'](source)}\n${text}`, { confirm, sendMedia, say }))
  queue = run.catch(() => {}).then(() => compact().catch(() => {}))
  return run
}

const settingsUrl = startUi({ connectedSince: () => wa.connectedSince(), restart: () => process.exit(3), agent: bridgeAsk })
setSettingsUrl(settingsUrl)
console.log(`\nאתר ההגדרות (חיבור חשבונות, העדפות, מה פעיל):\n${settingsUrl}\n`)
// On a fresh install the page opens by itself, since connecting accounts is the next thing to do.
if (!state.owner && process.platform === 'win32' && !process.env.HELPER_DATA_DIR) exec(`start "" "${settingsUrl}"`)
