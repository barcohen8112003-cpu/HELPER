// Spoken WhatsApp messages on this PC: what WhatsApp Desktop's own Windows notification says (who and what), said
// aloud by HELPER's on-device voice. Everything here is decisions only, no Electron, no files, no network, so the
// tests run it in Node with synthetic notifications.
//
// The rules (desktop/README.md, "הקראת הודעות וואטסאפ"):
// - Off until the owner turns it on. Only chats he added, unless he chose "everyone".
// - Plain text only: a photo, video, voice message, sticker, file, location, poll, call, reaction or deleted
//   message is never said. View-once exists only for media, so a view-once message is never said either.
// - A notification that marks a disappearing message, or "view once", is never said, and a chat that ever shows a
//   disappearing-message marker leaves the list.
// - Only now: a notification that is older than 15 seconds, came before HELPER started or before the PC was
//   unlocked, or arrives while the PC is locked, WhatsApp is not running, WhatsApp is in front, it is quiet hours
//   or the owner paused it, is dropped on the spot. Nothing is queued for later (no backlog).
// - Nothing is kept: the text lives only until it is handed to the voice. Only notification ids (numbers) are
//   remembered, to not say one twice.
'use strict'

const FRESH_MS = 15000          // older than this: not "now" any more
const BUSY_WAIT_MS = 10000      // HELPER is listening or speaking: wait this long at most, then drop
const BUSY_STEP_MS = 500
const RATE_WINDOW_MS = 60000
const SEEN_MAX = 2000
const DEFAULT_PER_MINUTE = 4
const DEFAULT_MAX_CHARS = 160

const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g

/** A chat name as compared: no direction marks, no "(3 messages)", one space, lower case. */
function normName(s) {
  return String(s || '')
    .replace(BIDI, '')
    .replace(/\s*[(\[]\s*\d+\s*(messages?|הודעות|הודעה)\s*[)\]]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Media and other non-text messages, as WhatsApp labels them in a notification (English and Hebrew UI).
const MEDIA_EMOJI = /^[\s‎‏]*(📷|📸|🎥|📹|🎬|🎞|🖼|🎤|🎙|🎵|🎶|🔊|📎|📄|📑|📃|🗂|📁|📍|🗺|📊|👤|📇|💳|🎁|🔂|①|⏱|⏲|🕒)/u
const MEDIA_WORD = /^[\s‎‏]*(photo|image|video|gif|sticker|voice message|voice note|audio|document|file|location|live location|contact|poll|album|\d+\s+(photos|videos|images)|תמונה|תמונות|\d+\s+תמונות|סרטון|סרטונים|וידאו|וידיאו|גיף|מדבקה|סטיקר|הודעה קולית|הקלטה|הקלטה קולית|קובץ|מסמך|מיקום|מיקום בזמן אמת|איש קשר|כרטיס איש קשר|סקר|אלבום)(\s*$|\s*[:•·,-]|\s)/i
const VIEW_ONCE = /(view[\s-]*once|viewed once|צפייה חד[\s-]*פעמית|לצפייה חד[\s-]*פעמית|חד[\s-]*פעמי|🔂|①)/i
const DISAPPEARING = /(disappearing|disappear|הודעות נעלמות|הודעה נעלמת|נעלמות|ייעלמו|תיעלם|⏱|⏲|timer)/i
// Only a sure marker takes a chat off the list (a message that merely says "timer" is dropped, the chat stays).
const DISAPPEARING_SURE = /(disappearing messages?|הודעות נעלמות|הודעה נעלמת|⏱|⏲)/i
const GENERIC = /^(\d+\s+)?(new messages?|new message from|you have new messages?|message|הודעה חדשה|הודעות חדשות|\d+\s+הודעות חדשות|יש לך הודעות חדשות|יש לך הודעה חדשה)\.?$|^\d+\s+(messages?|הודעות)(\s+(from|מ-?)\s*\d+\s+(chats?|צ'אטים|שיחות))?\.?$/i
const CALL = /(incoming (voice |video )?call|missed (voice |video )?call|calling…|calling\.\.\.|voice call|video call|שיחה נכנסת|שיחה קולית|שיחת וידאו|שיחה שלא נענתה|מתקשר|מתקשרת)/i
const REACTION = /(reacted|reaction|הגיב|הגיבה|הגיבו|התגובה|סימן\/ה)/i
const DELETED = /(this message was deleted|message deleted|ההודעה נמחקה|הודעה זו נמחקה)/i
const STATUS = /(status update|posted a status|עדכון סטטוס|עדכן\/ה סטטוס)/i
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu

/**
 * A notification's text lines → what it is.
 * Direct: title = the contact, body = the text. Group: title = the group, body = "Sender: text", or a title of
 * "Sender @ Group". Which chats are groups also comes from the owner's list (kind: 'group').
 * Returns {chat, sender, group, body} or {skip: reason}.
 */
function parseToast(lines, { groups = new Set(), directs = new Set() } = {}) {
  if (!Array.isArray(lines)) return { skip: 'no-text' }
  const clean = lines.map((l) => String(l == null ? '' : l).replace(BIDI, '').trim()).filter(Boolean)
  if (clean.length < 2) return { skip: clean.length ? 'generic' : 'no-text' }
  let title = clean[0]
  let body = clean.slice(1).join(' ')
  if (/^whatsapp$/i.test(title) || /^וואטסאפ$/.test(title)) return { skip: 'generic' }

  let group = false, sender = '', chat = title
  const at = title.match(/^(.{1,60}?)\s+@\s+(.{1,100})$/)
  if (at) { group = true; sender = at[1].trim(); chat = at[2].trim() }
  const known = groups.has(normName(chat))
  const prefixed = body.match(/^~?\s?([^:\n]{1,40}?):\s+([\s\S]+)$/)
  if (!group && prefixed && (known || (looksLikeName(prefixed[1]) && !directs.has(normName(chat))))) {
    group = true
    sender = prefixed[1].replace(/^~\s?/, '').trim()
    body = prefixed[2]
  } else if (group && prefixed && normName(prefixed[1]) === normName(sender)) {
    body = prefixed[2]
  }
  if (known) group = true
  return { chat: chat.replace(/\s*[(\[]\s*\d+\s*(messages?|הודעות|הודעה)\s*[)\]]\s*$/i, '').trim(), sender, group, body: body.trim() }
}

/** "דנה", "Dana Cohen", "~ Dana": short, a name and no sentence. "הערה" / "Note" / "שימו לב" still pass: groups off drops them. */
function looksLikeName(s) {
  const t = String(s).replace(/^~\s?/, '').trim()
  if (!t || t.length > 40) return false
  if (/[.!?,;"“”״]/.test(t)) return false
  if (/^\d+$/.test(t)) return false
  return t.split(/\s+/).length <= 4
}

/** Why a parsed message is not said, or '' when it may be said. The marker checks look at the whole text. */
function contentSkip(p, rawLines) {
  const all = (Array.isArray(rawLines) ? rawLines : []).map(String).join(' \n ')
  if (VIEW_ONCE.test(all)) return 'view-once'
  if (DISAPPEARING.test(all)) return 'disappearing'
  if (CALL.test(all)) return 'call'
  if (GENERIC.test(p.body)) return 'generic'
  if (MEDIA_EMOJI.test(p.body) || MEDIA_WORD.test(p.body)) return 'media'
  if (DELETED.test(p.body)) return 'deleted'
  if (REACTION.test(p.body)) return 'reaction'
  if (STATUS.test(all)) return 'status'
  return ''
}

/** What is said aloud: no emoji, links as "קישור", no markup, cut at maxChars. '' when nothing is left. */
function sayable(text, maxChars = DEFAULT_MAX_CHARS) {
  let t = String(text || '')
    .replace(BIDI, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, 'קישור')
    .replace(EMOJI, ' ')
    .replace(/[`*_~>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(t)) return ''
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const sp = cut.lastIndexOf(' ')
    t = (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trim() + '… ועוד'
  }
  return t
}

const speakName = (s) => sayable(s, 60)

/** The spoken line. */
function phraseFor(p, text) {
  const chat = speakName(p.chat) || 'וואטסאפ'
  if (p.group) {
    const who = speakName(p.sender)
    return who ? `בקבוצה ${chat}, ${who}: ${text}` : `הודעה בקבוצה ${chat}: ${text}`
  }
  return `הודעה מ${chat}: ${text}`
}

function moreFor(p) {
  const chat = speakName(p.chat) || 'וואטסאפ'
  return p.group ? `יש עוד הודעות בקבוצה ${chat}` : `יש עוד הודעות מ${chat}`
}

/** "22:00" → minutes since midnight, or null. */
function minutesOf(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** Quiet hours, across midnight too ("22:00" to "07:00"). */
function inQuiet(quiet, date) {
  if (!quiet || !quiet.on) return false
  const from = minutesOf(quiet.from), to = minutesOf(quiet.to)
  if (from == null || to == null || from === to) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** Is this chat on? allowlist: only listed chats. all: every chat but the blocked ones, groups only with waGroups. */
function chatAllowed(s, p) {
  const name = normName(p.chat)
  if (!name) return false
  const listed = (Array.isArray(s.waChats) ? s.waChats : []).find((c) => c && normName(c.name) === name)
  if ((s.waMode || 'allowlist') !== 'all') return Boolean(listed)
  const blocked = (Array.isArray(s.waBlock) ? s.waBlock : []).some((b) => normName(b && b.name !== undefined ? b.name : b) === name)
  if (blocked) return false
  if (p.group && !s.waGroups && !listed) return false
  return true
}

/**
 * The announcer. deps:
 *   settings(): the current settings (waAnnounce, waMode, waChats, waBlock, waGroups, waQuiet, waMaxChars, waPerMinute)
 *   env: { running(toast), locked(), foreground(), busy(), paused() }: booleans about the PC right now
 *   speak(line) → Promise<boolean>: says it (the private voice); the line is not kept anywhere
 *   onDisappearing(chatName): a chat showed a disappearing marker (main takes it off the list)
 *   now(), date(), timers: for tests
 *   onDecision(reason): for tests and the tray's status; gets a reason code only, never text
 */
function createAnnouncer(deps) {
  const now = deps.now || (() => Date.now())
  const date = deps.date || (() => new Date(now()))
  const timers = deps.timers || { setTimeout, clearTimeout }
  const env = deps.env || {}
  const decide = (r) => { try { deps.onDecision && deps.onDecision(r) } catch { } return r }

  const seen = new Set()
  let since = now()              // nothing from before this moment is ever said
  let window = { start: 0, spoken: 0, more: new Set() }
  let speaking = false
  const waiting = new Set()      // timers of messages waiting for HELPER to be free

  function remember(id) {
    seen.add(id)
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
  }

  /** Nothing from before now: at start, at unlock, when turned on. */
  function reset() {
    since = now()
    for (const t of waiting) timers.clearTimeout(t)
    waiting.clear()
  }

  function gate(s, toast) {
    if (!s.waAnnounce) return 'off'
    if (env.paused && env.paused()) return 'paused'
    if (env.locked && env.locked()) return 'locked'
    if (env.running && !env.running(toast)) return 'not-running'
    if (env.foreground && env.foreground()) return 'foreground'
    if (inQuiet(s.waQuiet, date())) return 'quiet'
    return ''
  }

  function rate(s, p) {
    const t = now()
    if (t - window.start >= RATE_WINDOW_MS) window = { start: t, spoken: 0, more: new Set() }
    const limit = Number.isFinite(s.waPerMinute) && s.waPerMinute > 0 ? s.waPerMinute : DEFAULT_PER_MINUTE
    if (window.spoken < limit) { window.spoken++; return 'ok' }
    const key = normName(p.chat)
    if (window.more.has(key)) return 'drop'
    window.more.add(key)
    return 'more'
  }

  async function say(line) {
    speaking = true
    try { return Boolean(await deps.speak(line)) } catch { return false } finally { speaking = false }
  }

  /** One notification from the listener: {id, at, lines, running}. Returns a reason code (a promise). */
  function toast(t) {
    if (!t || t.id === undefined || t.id === null) return Promise.resolve(decide('bad'))
    const id = String(t.id)
    if (seen.has(id)) return Promise.resolve(decide('seen'))
    remember(id)
    const at = Number(t.at)
    if (!Number.isFinite(at) || at < since || now() - at > FRESH_MS) return Promise.resolve(decide('old'))
    const s = deps.settings()
    const closed = gate(s, t)
    if (closed) return Promise.resolve(decide(closed))

    const groups = new Set((Array.isArray(s.waChats) ? s.waChats : []).filter((c) => c && c.kind === 'group').map((c) => normName(c.name)))
    const directs = new Set((Array.isArray(s.waChats) ? s.waChats : []).filter((c) => c && c.kind !== 'group').map((c) => normName(c.name)))
    const p = parseToast(t.lines, { groups, directs })
    if (p.skip) return Promise.resolve(decide(p.skip))
    const why = contentSkip(p, t.lines)
    if (why) {
      if (why === 'disappearing' && deps.onDisappearing && DISAPPEARING_SURE.test((t.lines || []).join(' '))) { try { deps.onDisappearing(p.chat) } catch { } }
      return Promise.resolve(decide(why))
    }
    if (!chatAllowed(s, p)) return Promise.resolve(decide('not-listed'))
    const text = sayable(p.body, Number.isFinite(s.waMaxChars) && s.waMaxChars > 20 ? s.waMaxChars : DEFAULT_MAX_CHARS)
    if (!text) return Promise.resolve(decide('empty'))

    const arrived = now()
    return new Promise((resolve) => {
      const attempt = () => {
        // Still allowed now? (locked, quiet, paused or turned off while it waited: dropped.)
        const s2 = deps.settings()
        const closed2 = gate(s2, t)
        if (closed2) return resolve(decide(closed2))
        if (speaking || (env.busy && env.busy())) {
          if (now() - arrived >= BUSY_WAIT_MS) return resolve(decide('busy'))
          const timer = timers.setTimeout(() => { waiting.delete(timer); attempt() }, BUSY_STEP_MS)
          waiting.add(timer)
          return
        }
        const r = rate(s2, p)
        if (r === 'drop') return resolve(decide('rate'))
        const line = r === 'more' ? moreFor(p) : phraseFor(p, text)
        say(line).then((ok) => resolve(decide(ok ? (r === 'more' ? 'more' : 'spoken') : 'voice-failed')))
      }
      attempt()
    })
  }

  /** Ids of notifications already there when listening starts: never said. */
  function seed(ids) { for (const id of ids || []) remember(String(id)) }

  return { toast, seed, reset, speaking: () => speaking }
}

// ---- voice commands -------------------------------------------------------------------------------------

/**
 * "תקריא לי הודעות מדנה" / "תקריא לי הודעות מהקבוצה כיתה ח" / "תפסיק להקריא הודעות מדנה" / "תפסיק להקריא הודעות" /
 * "תתחיל להקריא הודעות" / "תשתוק". → {op: 'add'|'remove'|'off'|'on'|'hush', name?, kind?} or null.
 */
function waCommand(text) {
  const s = String(text || '').replace(BIDI, '').trim().replace(/^(הלפר|helper)[\s,]+/i, '').replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (/^(תשתוק|תשתקי|שקט|stop talking|shut up)$/i.test(s)) return { op: 'hush' }
  let m
  const VERB_ADD = '(?:תקריא|תקריאי|תקרא|תקראי|תגיד|תגידי)'
  const VERB_STOP = '(?:תפסיק|תפסיקי|אל|לא)\\s+(?:להקריא|להקריא לי|תקריא|תקריאי|לקרוא|להגיד)'
  const MSGS = '(?:את\\s+)?(?:ה)?הודעות(?:\\s+(?:ה)?וואטסאפ|\\s+בוואטסאפ)?'
  const target = (rest) => {
    let r = rest.trim()
    let kind = 'direct'
    const g = r.match(/^(?:מ-?\s?ה?קבוצה|מ-?\s?קבוצת|בקבוצה|בקבוצת)\s+(.+)$/)
    if (g) { kind = 'group'; r = g[1] } else r = r.replace(/^מ-?\s?/, '').replace(/^של\s+/, '')
    r = r.replace(/^["'״׳]|["'״׳]$/g, '').trim()
    return r ? { name: r, kind } : null
  }
  if ((m = s.match(new RegExp(`^${VERB_STOP}(?:\\s+${MSGS})?\\s+(.+)$`)))) {
    const t = target(m[1])
    if (t && !/^הודעות(\s+וואטסאפ)?$/.test(t.name)) return Object.assign({ op: 'remove' }, t)
  }
  if (new RegExp(`^${VERB_STOP}(?:\\s+${MSGS})?$`).test(s)) return { op: 'off' }
  if (/^(?:תתחיל|תתחילי)\s+(?:להקריא|לקרוא)(?:\s+(?:לי\s+)?(?:את\s+)?(?:ה)?הודעות(?:\s+(?:ה)?וואטסאפ|\s+בוואטסאפ)?)?$/.test(s)) return { op: 'on' }
  if ((m = s.match(new RegExp(`^${VERB_ADD}\\s+(?:לי\\s+)?${MSGS}\\s+(.+)$`)))) {
    const t = target(m[1])
    if (t) return Object.assign({ op: 'add' }, t)
  }
  return null
}

/** The chat list after a command: add (no duplicates) or remove. */
function editChats(list, cmd) {
  const chats = (Array.isArray(list) ? list : []).filter((c) => c && c.name)
  const key = normName(cmd.name)
  const rest = chats.filter((c) => normName(c.name) !== key)
  if (cmd.op === 'add') return rest.concat([{ name: String(cmd.name).trim(), kind: cmd.kind === 'group' ? 'group' : 'direct' }]).slice(-100)
  if (cmd.op === 'remove') return rest
  return chats
}

module.exports = {
  createAnnouncer, parseToast, contentSkip, sayable, phraseFor, inQuiet, chatAllowed, normName, waCommand, editChats,
  FRESH_MS, BUSY_WAIT_MS, RATE_WINDOW_MS, DEFAULT_PER_MINUTE, DEFAULT_MAX_CHARS,
}
