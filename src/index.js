import './secret-logs.js' // first, so every later log line is masked
import fs from 'node:fs'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import { config, DATA_DIR } from './config.js'
import { lockHeldByOther } from './instance-lock.js'
import { state, save } from './store.js'
import { startWhatsApp } from './whatsapp.js'
import { runTurn, runTask, runBackground, resetHistory, compact, setSettingsUrl } from './agent.js'
import { startJob, stopJobs, jobsText, listJobs, interruptedJobs } from './jobs.js'
import { startScheduler, newsDigest, newsInBrief } from './scheduler.js'
import * as inbox from './inbox.js'
import { prepare, speak } from './media.js'
import { setLocation, isLiveUpdate } from './location.js'
import { createOutbox } from './outbox.js'
import { chatModel, Aborted } from './llm.js'
import { parseCommand } from './commands.js'
import { fastCommand } from './fast-commands.js'
import { loadUserTools } from './tool-builder.js'
import { status } from './status.js'
import { maskSettingsUrl, startUi } from './ui.js'
import { wakeEnabled, wakePc } from './wake.js'
import { startPcBridgeServer, bridgeLabel } from './pc-bridge.js'
import { closeCloudBrowsers, cloudGoogleHomeOn, cloudWebtopOn, ensureCloudBrowser, ensureCloudWebtop, errandCloudOn } from './webtop-browser.js'
import { startCloudDesktop } from './cloud-desktop.js'
import { startVoice } from './voice.js'
import { createMonitoring } from './monitoring/index.js'
import { inQuietHours } from './outbox.js'
import { calendarOn, listEvents } from './calendar.js'
import { getDay } from './day.js'
import { backupTick } from './backup.js'
import { humanError } from './style.js'
import { takeProactiveSlot } from './metrics.js'
import { kindOf, noticeLevel, noticeSent, noticeEngaged, parseNoticeCommand, runNoticeCommand } from './notice-learning.js'
import { parsePhoneMessage, handlePhoneCommand } from './phone.js'
import { announceRelease } from './release-notes.js'
import * as groups from './groups.js'
import { groupAdders } from './group-tools.js'

let reconciled = false
import { scraplingEnabled, scraplingStatus } from './scrapling.js'
import { exec } from 'node:child_process'

if (!config.llm.apiKey || !config.llm.model) {
  console.log('חסר LLM_API_KEY או LLM_MODEL. העתק את .env.example ל-.env ומלא אותם.')
  // 2 tells start.bat this is a setup problem, not a crash worth restarting for.
  process.exit(2)
}
// Open the bridge port before WhatsApp connects, so a platform health check is not waiting on the login.
startPcBridgeServer()
// fetch_page through Scrapling: say once at start whether it can run, so a missing venv shows in the log.
if (scraplingEnabled()) {
  scraplingStatus().then((s) => console.log(s.ok ? `[scrapling] זמין: Scrapling ${s.scrapling}, Python ${s.python}` : `[scrapling] לא זמין (${s.kind}): ${s.error}. fetch_page משתמש בקורא הרגיל רק כשהוא לא מותקן`))
}
function startCloudBrowsers() {
  if (cloudWebtopOn()) ensureCloudWebtop().catch((e) => console.log(`[webtop] ${e.message}`))
  if (cloudGoogleHomeOn()) ensureCloudBrowser('google-home').catch((e) => console.log(`[google-home] ${e.message}`))
  if (errandCloudOn()) ensureCloudBrowser('errand').catch((e) => console.log(`[errand] ${e.message}`))
  if (config.gemini.cloud) ensureCloudBrowser('gemini').catch((e) => console.log(`[gemini] ${e.message}`))
}
if (config.desktop.enabled) {
  startCloudDesktop().then(startCloudBrowsers).catch((e) => console.log(`[desktop] ${e.message}`))
} else {
  startCloudBrowsers()
}

// One assistant per data folder: two would share the WhatsApp session and answer every message twice.
// The lock lives on the persistent disk, so a reboot can leave a PID that now belongs to tini or a browser.
// Only a live node process running src/index.js, other than us, counts. Anything else is deleted.
const LOCK = path.join(DATA_DIR, 'helper.lock')
const HEALTHY = path.join(DATA_DIR, 'healthy')
if (fs.existsSync(LOCK)) {
  const lockedBy = Number(fs.readFileSync(LOCK, 'utf8'))
  if (lockHeldByOther(lockedBy)) {
    console.log(`העוזר כבר רץ (תהליך ${lockedBy}). סגור את החלון השני לפני שמפעילים שוב.`)
    process.exit(2)
  }
  fs.rmSync(LOCK, { force: true })
}
fs.writeFileSync(LOCK, String(process.pid))
fs.rmSync(HEALTHY, { force: true })
process.on('exit', () => fs.rmSync(LOCK, { force: true }))
// The cloud browsers are closed first, so their sign-ins are on disk when the container stops.
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'])
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    closeCloudBrowsers().finally(() => process.exit(0))
  })
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
• "מה יש לי בטלפון?" או "תשלוט לי בטלפון"
• לשלוח לי תמונה של דף עבודה, PDF או הודעה קולית`
const HELP = `*פקודות*
/status - מה מחובר ואחרי מה אני עוקב
/wake - מדליק את המחשב מרחוק
/watch status - מעקב שקט: מה נצפה, כמה סונן, מה מושתק או מוגבר (/watch לכל הפקודות)
עצור - מפסיק את מה שאני עושה עכשיו, כולל משימות ברקע, ומוותר על מה שחיכה בתור
מה רץ - המשימות שרצות ברקע עכשיו. עצור את <שם> עוצר רק אחת
שיחה חדשה (או /new) - מתחיל שיחה חדשה (זיכרון, תזכורות ומעקבים נשארים)
/voice on - עונה בהודעה קולית על כל הודעה, /voice off חוזר לטקסט
/compact - מסכם את השיחה כדי לחסוך
/model strong - עובר למודל החזק, /model default חוזר
/unpair - מנתק את הצ'אט הזה
/help - ההודעה הזאת
מה אתה שולח לי - אילו הודעות יזומות נשלחות. "תפסיק לשלוח לי חדשות" משתיק, "תחזור לשלוח לי חדשות" מחזיר
צמד טלפון <פורט> <קוד> - צימוד חד-פעמי לניפוי אלחוטי
חבר טלפון <פורט> - חיבור לפורט של ניפוי אלחוטי. אחר כך העוזר עובר לפורט 5555 עד אתחול, גם בנתונים סלולריים

חוץ מזה פשוט כותבים לי: טקסט, הודעה קולית, תמונה או קובץ. "תשלוט לי בטלפון" ו"מה יש לי בטלפון" מפעילים את שליטת הטלפון.`

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
    tellRelease()
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
  // A message of his counts toward notices he was sent. This does not touch follow-up pacing (src/proactive.js).
  noticeEngaged()
  // "תפסיק לשלוח לי חדשות" / "תחזור לשלוח..." / "מה אתה שולח לי": one reply, no model.
  const noticeCmd = parseNoticeCommand(text)
  if (noticeCmd) return wa.send(state.owner.jid, runNoticeCommand(noticeCmd))
  // A shared location is saved, no model involved. A bare 📍 gets a 📍 back; updates of a live location get nothing.
  // With a comment ("תזמין לכאן פיצה") the message goes on to the model, which now sees the new location.
  if (m.location) {
    const update = isLiveUpdate(m.location)
    await setLocation(m.location).catch((e) => console.log(`[location] ${e.message}`))
    if (!text) return update ? undefined : wa.react(state.owner.jid, m.key, '📍').catch(() => {})
  }
  // "עצור" ends what the assistant is doing and forgets what was waiting; "שיחה חדשה" does that and clears the chat.
  // Both answer at once: no model, no queue.
  const phoneCmd = parsePhoneMessage(text)
  if (phoneCmd) {
    if (pendingConfirm) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(false)
    }
    return wa.send(state.owner.jid, await handlePhoneCommand(phoneCmd))
  }
  // "עצור את <שם משימה>" stops that background task only. Anything else starting with it ("תעצור את השיר") is a
  // request for the model.
  const stopOne = text.match(/^ת?עצור את (.+?)[.!]?$/)
  if (stopOne && listJobs().some((j) => j.title.includes(stopOne[1].trim()))) {
    const stopped = stopJobs(stopOne[1])
    return wa.send(state.owner.jid, `עצרתי את ${stopped.map((t) => `"${t}"`).join(', ')}.`)
  }
  const command = parseCommand(text)
  if (command === 'jobs') return wa.send(state.owner.jid, jobsText())
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
    const stoppedJobs = stopJobs()
    if (command === 'stop') return wa.send(state.owner.jid, running || stoppedJobs.length ? `עצרתי${stoppedJobs.length ? `, כולל ${stoppedJobs.map((t) => `"${t}"`).join(', ')} שרץ ברקע` : ''}.` : 'אין מה לעצור.')
    // The stopped turn rolls its own messages back; the history is cleared only after that, never under it.
    if (running) await Promise.race([running.done, new Promise((r) => setTimeout(r, 10000))])
    resetHistory()
    return wa.send(state.owner.jid, 'שיחה חדשה. הזיכרון, התזכורות והמעקבים נשארו.')
  }
  if (pendingConfirm) {
    const resolve = pendingConfirm
    pendingConfirm = null
    const yes = /^(כן|אשר|מאשר|yes|y|ok|אוקיי|אוקי|👍|✅)(?=$|[\s.,!])/i.test(text)
    resolve(yes)
    // "לא" just cancels. Anything else cancels too, and is then answered as the new message it is, since with
    // tasks in the background he may be talking about something else.
    if (yes || /^(לא|בטל|ביטול|no|n|👎|❌)(?=$|[\s.,!])/i.test(text)) return
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

  // "תדליק את האורות": no model and no queue, the light comes on while the turn before it may still be thinking.
  const quick = await fastCommand(text)
  if (quick) return wa.send(state.owner.jid, quick.reply)
  const epoch = stopEpoch
  // From here the message waits for the model. It is logged, and a watchdog speaks up if no answer leaves.
  const msgId = m.key?.id
  state.inbox = inbox.received(state.inbox || [], msgId, text || (m.location ? '📍' : '[קובץ]'))
  const settle = (how) => {
    state.inbox = inbox.answered(state.inbox || [], msgId, how)
    save()
  }
  queue = queue.then(async () => {
    if (epoch !== stopEpoch) return settle('stopped') // stopped, or a new conversation began, while this was waiting its turn
    const ac = new AbortController()
    let finish
    activeTurn = { ac, done: new Promise((r) => (finish = r)), msgId }
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
      let reply = await runTurn(input.text, { source: 'whatsapp', confirm, sendMedia, say, react, sendAs: wa.sendAs, findContact: wa.findContact, signal: ac.signal, background }, input.image)
      // Every message gets an answer. Nothing came back and no emoji was chosen as the answer: one short question.
      if ((!reply?.trim() || /^SKIP\b/.test(reply.trim())) && !reacted) {
        console.log('[agent] the model returned no answer; asking him instead of staying silent')
        reply = inbox.NO_ANSWER
      }
      // A spoken message gets a spoken answer, and in "always" voice mode so does a typed one.
      // The text follows only when it has links, or when speech failed.
      const wantsVoice = input.voice || state.voiceMode === 'always'
      const spoken = reply && wantsVoice ? await speak(reply).catch((e) => (console.log(`[voice] ${e.message}`), null)) : null
      if (spoken) await wa.sendVoice(state.owner.jid, spoken)
      if (reply && (!spoken || /https?:\/\//.test(reply))) await wa.send(state.owner.jid, reply)
      answered = true
      settle(reacted && !reply ? 'reaction' : 'reply')
    } catch (e) {
      // Stopping is the user's own doing: no warning, the "עצרתי" has already been sent.
      if (e instanceof Aborted || ac.signal.aborted) {
        console.log('[agent] הופסק על ידי המשתמש')
        settle('stopped')
      } else {
        console.log(`[agent] ${e.message}`)
        const told = await wa.send(state.owner.jid, humanError(e)).then(() => true, () => false)
        if (told) settle('error')
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
}, pairWithSelf, { on: groups.groupsOn, knows: groups.knowsGroup, setGroupName: groups.setGroupName, capture: (m) => groups.capture(m), bindSync: groups.bindGroupSync })

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
  if (!state.owner && !state.manualPair) {
    state.owner = { jid: me.jid, jids: [me.jid, me.lid].filter(Boolean), self: true, selfChat: true }
    save()
    console.log('מחובר לצ\'אט שלך עם עצמך. כתוב שם כדי לדבר עם העוזר.')
    await wa.send(state.owner.jid, `היי, אני ${config.botName} 👋 מעכשיו כותבים לי כאן, בצ'אט שלך עם עצמך.\n\n${EXAMPLES}\n\n${HELP}`)
  }
  if (state.owner) tellRelease()
}

function tellRelease() {
  announceRelease({ send: (text) => wa.send(state.owner.jid, text) }).catch((e) => console.log(`[release] ${e.message}`))
}

const sendMedia = (media) => wa.sendMedia(state.owner.jid, media)
const say = (text) => wa.send(state.owner.jid, text)

// `media` ({ buffer, mime }): the question goes out as that image's caption, so a checkout screen and what it asks
// for arrive as one bubble.
// One approval is open at a time: with background tasks two could ask at once, and one "כן" must answer one question.
let confirmChain = Promise.resolve()
function confirm(question, media) {
  const asked = confirmChain.then(() => askOnce(question, media))
  confirmChain = asked.catch(() => {})
  return asked
}

// Starts a background task (start_background_task). Its result, or why it failed, arrives as its own message.
// `run(signal, setStep)` replaces the agent for work done by something else (Claude Code).
function background(title, instruction, run) {
  return startJob(
    title,
    run || ((signal, setStep) => runBackground(title, instruction, { source: 'job', confirm: (q, media) => confirm(`(${title}) ${q}`, media), sendMedia, say, signal, patient: true, setStep })),
    async (name, result, error) => {
      if (result) return wa.send(state.owner.jid, `*${name}*\n${result}`)
      if (error) return wa.send(state.owner.jid, `המשימה "${name}" לא הסתיימה: ${humanError(error)}`)
    }
  )
}

function askOnce(question, media) {
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
// Once an hour: a daily encrypted backup to Drive, when a passphrase is set (src/backup.js).
setInterval(() => backupTick((text) => notify(text)).catch((e) => console.log(`[backup] ${e.message}`)), 3600 * 1000).unref()
setTimeout(() => backupTick((text) => notify(text)).catch(() => {}), 5 * 60000).unref()

const cutShort = interruptedJobs()
if (cutShort.length) outbox.notify(`${cutShort.length > 1 ? 'המשימות' : 'המשימה'} ${cutShort.map((j) => `"${j.title}"`).join(', ')} ${cutShort.length > 1 ? 'נקטעו' : 'נקטעה'} כי הופעלתי מחדש. אם עדיין צריך, תבקש שוב.`, true).catch(() => {})

// WhatsApp cannot report its own outage, so after WHATSAPP_DOWN_ALERT_MIN minutes without it the alert goes out
// through Discord, and WhatsApp itself says how long it was gone once it is back.
const WHATSAPP_DOWN_ALERT_MIN = 10
let whatsappDownSince = 0
let whatsappDownAlerted = false
setInterval(() => {
  if (!state.owner) return
  if (wa.connectedSince()) {
    if (whatsappDownAlerted) {
      const minutes = Math.round((Date.now() - whatsappDownSince) / 60000)
      outbox.notify(`וואטסאפ היה מנותק כ-${minutes} דקות וחזר. הודעות שנשלחו לי בזמן הזה אולי לא הגיעו, אז שווה לשלוח שוב את מה שחשוב.`, true).catch(() => {})
    }
    whatsappDownSince = 0
    whatsappDownAlerted = false
    return
  }
  whatsappDownSince ||= Date.now()
  if (whatsappDownAlerted || Date.now() - whatsappDownSince < WHATSAPP_DOWN_ALERT_MIN * 60000) return
  whatsappDownAlerted = true
  console.log(`[whatsapp] מנותק כבר ${WHATSAPP_DOWN_ALERT_MIN} דקות`)
  state.discordOutbox = [...state.discordOutbox, { text: `⚠️ וואטסאפ של ${config.botName} מנותק כבר ${WHATSAPP_DOWN_ALERT_MIN} דקות. אם זה לא חוזר לבד, ייתכן שצריך לקשר מחדש (מכשירים מקושרים). המצב באתר ההגדרות.`, speak: false, at: Date.now() }].slice(-20)
  save()
}, 60000).unref()

// scripts/auto-update.sh leaves a note here when it had to roll back a broken update. It is sent once, as soon as
// WhatsApp is up again, so a failed deploy is never silent.
const DEPLOY_NOTICE = path.join(DATA_DIR, 'deploy-notice.txt')
if (fs.existsSync(DEPLOY_NOTICE)) {
  const text = fs.readFileSync(DEPLOY_NOTICE, 'utf8').trim()
  fs.rmSync(DEPLOY_NOTICE, { force: true })
  if (text) outbox.notify(text, true).catch(() => {})
}
// Scheduled tasks wait their turn in the same queue as chat messages, so two model runs never interleave.
const scheduledTask = (instruction, { noAsk = false } = {}) => {
  const run = queue.then(() => runTask(instruction, { source: 'task', confirm: noAsk ? async () => false : confirm, sendMedia, say, patient: true }))
  queue = run.catch(() => {})
  return run
}
// Quiet monitoring owns mail, calendar and the morning brief. Its only way out is a message to the owner.
// The tools HELPER wrote for itself and Naor approved come back with it, each checked again before it loads.
if (config.learning) loadUserTools().then((n) => n && console.log(`[tools] נטענו ${n} כלים שהעוזר כתב לעצמו`)).catch((e) => console.log(`[tools] ${e.message}`))

const monitoring = createMonitoring({ send: (text) => wa.send(state.owner.jid, text), getDay, news: () => (newsInBrief() ? newsDigest() : '') })

// Proactive notices from the rest of the assistant. During quiet hours a non-urgent one is not held to be sent
// on its own at 08:00: it joins the night's batch and arrives inside the one morning brief.
// Outside quiet hours, non-urgent notices are also capped per day (MESSAGE_BUDGET, default 6): past the cap they
// join the next brief instead of buzzing his phone again.
function notify(text, urgent = false, key, kindName) {
  const kind = kindOf(key, kindName)
  const level = noticeLevel(kind, urgent)
  // Explicit mute, or (only with NOTICE_LEARNING=true) a kind he keeps ignoring: do not buzz him.
  if (level === 'drop') {
    if (key && !state.sentKeys.includes(key)) {
      state.sentKeys = [...state.sentKeys, key].slice(-500)
      save()
    }
    return Promise.resolve()
  }
  // Learned "quieter": same path as quiet hours, it waits for the next brief.
  if (level === 'batch') {
    if (key) {
      if (state.sentKeys.includes(key)) return Promise.resolve()
      state.sentKeys = [...state.sentKeys, key].slice(-500)
      save()
    }
    monitoring.addNote(text)
    return Promise.resolve()
  }
  // 'interrupt' is the previous rule: urgent always, otherwise quiet hours and the daily budget.
  const already = Boolean(key && state.sentKeys.includes(key))
  if (urgent || (!inQuietHours() && (already || takeProactiveSlot()))) {
    if (!urgent && !already) noticeSent(kind)
    return outbox.notify(text, urgent, key)
  }
  if (key) {
    if (state.sentKeys.includes(key)) return Promise.resolve()
    state.sentKeys = [...state.sentKeys, key].slice(-500)
    save()
  }
  monitoring.addNote(text)
  return Promise.resolve()
}
startScheduler(notify, scheduledTask, monitoring)
// WhatsApp groups (src/groups.js): once a minute it checks whether a round of reading is due (every
// GROUPS_EVERY_MINUTES). Only a test, cancellation or change for today or tomorrow is sent now, through notify, so
// quiet hours and the daily budget apply; the rest waits for the morning brief and "מה פספסתי?".
setInterval(() => groups.tick({ notify, adders: groupAdders() }).catch((e) => console.log(`[groups] ${e.message}`)), 60000).unref()
startVoice()
setInterval(outbox.flush, 30000)
// A message that waited UNANSWERED_ALERT_MIN minutes (default 5, 0 = off) with no answer gets one short note, never
// silence: still in the queue behind a long task, or lost. The log has every message and how it was answered.
const UNANSWERED_ALERT_MIN = process.env.UNANSWERED_ALERT_MIN === undefined || process.env.UNANSWERED_ALERT_MIN === '' ? 5 : Number(process.env.UNANSWERED_ALERT_MIN) || 0
setInterval(() => {
  if (!state.owner || !state.inbox?.length || !wa.connectedSince()) return
  // Waiting on his 👍 is waiting on him, not a stuck message.
  if (pendingConfirm) return
  const late = inbox.overdue(state.inbox, { minutes: UNANSWERED_ALERT_MIN, busy: Boolean(activeTurn), active: activeTurn?.msgId })
  if (!late.length) return
  save()
  for (const l of late) wa.send(state.owner.jid, l.text).catch((e) => console.log(`[inbox] ${e.message}`))
}, 60000).unref()

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
  const run = queue.then(() => runTurn(`${BRIDGE_NOTE[voice ? 'voice' : 'text'](source)}\n${text}`, { source: String(source || 'bridge').slice(0, 30), confirm, sendMedia, say }))
  queue = run.catch(() => {}).then(() => compact().catch(() => {}))
  return run
}

const settingsUrl = startUi({ connectedSince: () => wa.connectedSince(), restart: () => process.exit(3), agent: bridgeAsk })
setSettingsUrl(settingsUrl)
console.log(`\nאתר ההגדרות (חיבור חשבונות, העדפות, מה פעיל):\n${maskSettingsUrl(settingsUrl)}\n`)
// On a fresh install the page opens by itself, since connecting accounts is the next thing to do.
if (!state.owner && process.platform === 'win32' && !process.env.HELPER_DATA_DIR) exec(`start "" "${settingsUrl}"`)
