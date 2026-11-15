import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import './secret-logs.js'
import pino from 'pino'
import QRCode from 'qrcode'
import baileys, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, jidNormalizedUser, downloadMediaMessage, downloadAndProcessHistorySyncNotification, proto } from '@whiskeysockets/baileys'
import { DATA_DIR } from './config.js'
import { state as store, save } from './store.js'
import { ingestGroupMetadata, syncParticipatingGroups, isSchoolworkGroup } from './groups.js'
import { readHomeworkMedia, quotedAndCaption } from './schoolwork-media.js'
import * as inflight from './inflight.js'

const CATCH_UP = 12 * 3600
const MAX_SEEN = 500
const MAX_QR = 15
const MAX_SENT = 300

const makeWASocket = baileys.default ?? baileys
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const QR_FILE = path.join(DATA_DIR, 'qr.png')
const CODE_FILE = path.join(DATA_DIR, 'pair-code.txt')
// Invisible prefix on everything the bot sends, so it never answers itself in a self-chat.
const notConnected = () => Object.assign(new Error('וואטסאפ לא מחובר כרגע'), { notSent: true })
const BOT_MARK = '​'
const MAX_MEDIA = 15 * 1024 * 1024
const logger = pino({ level: 'silent' })

// While WhatsApp is not linked, the settings site shows the current QR and a code to type in. On a server there is
// no window to scan from, so this is the only way to link there without reading the logs.
const pairing = { qr: '', code: '', number: '' }
let askCode = null
export const pairingInfo = () => ({ ...pairing })
// The settings page reads this. Nothing else should print it, and auth creds never go in here.
export function publishPairing(next = {}) {
  if ('qr' in next) pairing.qr = String(next.qr || '')
  if ('code' in next) pairing.code = String(next.code || '')
  if ('number' in next) pairing.number = String(next.number || '')
  return pairingInfo()
}
export async function requestPairing(raw) {
  if (!askCode) throw new Error('וואטסאפ עוד עולה, נסה שוב בעוד כמה שניות')
  return askCode(raw)
}

// "050-123-4567", "+972 50...", "00972..." or "972050..." -> "972501234567". WhatsApp wants the country code and
// no leading 0; a number typed the Israeli way is the most common reason a pairing code is refused.
export function pairingNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = '972' + d.slice(1)
  if (d.startsWith('9720')) d = '972' + d.slice(4)
  return d.length >= 10 && d.length <= 15 ? d : ''
}

// onMessage({ jids, fromMe, selfChat, key, lateSeconds, text, getMedia, reaction?, location? })
// onReady({ jid, lid }): the linked account's own ids, each time the connection opens.
// onGroup({ group, id, sender, senderName, at, text, fromMe }): a text message in a group, for src/groups.js. Read only.
// groupName(jid) / setGroupName(jid, name): the group's subject, looked up once and kept there.
// eligible(m): no side effects. True for a message meant for the assistant (the owner's chat, Instinct), which is then
// kept in flight (src/inflight.js, id and time only) until m.receipt() or the end of onMessage. Others are not listed.
export async function startWhatsApp(onMessage, onReady = () => {}, groupHooks = null, eligible = () => false) {
  const bootedAt = Math.floor(Date.now() / 1000)
  // Handled message ids survive a restart, so nothing is answered twice. Messages sent while the assistant was
  // off are still picked up, as long as they are newer than the last one handled and not older than CATCH_UP.
  const seen = new Set(store.wa.seen)
  const since = store.wa.lastAt ? Math.max(store.wa.lastAt, bootedAt - CATCH_UP) : bootedAt
  let sock
  let ready = false
  let attempts = 0
  let qrShown = 0
  let openedAt = 0
  // What was sent lately, by message id. When the phone cannot decrypt a message it asks for it again, and without
  // this the resend has nothing to send, so the message stays on "waiting for this message" forever.
  const sent = new Map()

  // The "message yourself" chat lives under the account's lid. Sent to the phone number instead, the message
  // reaches the phone but it cannot decrypt it.
  function target(jid) {
    const [pn, lid] = ownIds()
    return lid && jidNormalizedUser(jid) === pn ? lid : jid
  }

  async function deliver(jid, content, options) {
    const msg = await sock.sendMessage(target(jid), content, options)
    if (msg?.key?.id && msg.message) {
      sent.set(msg.key.id, msg.message)
      if (sent.size > MAX_SENT) sent.delete(sent.keys().next().value)
    }
    return msg
  }

  // The account's own addresses: its phone-number id first, then its "lid". The "message yourself" chat can arrive
  // under either one. They are read from the saved credentials, because right after the first QR scan sock.user
  // does not carry the lid yet, and a self-chat message addressed to it would look like someone else's chat.
  function ownIds() {
    const me = { ...sock.user, ...sock.authState?.creds?.me }
    return [me.id, me.lid].filter(Boolean).map(jidNormalizedUser)
  }

  function remember(id, at = Math.floor(Date.now() / 1000)) {
    seen.add(id)
    store.wa.seen = [...store.wa.seen, id].slice(-MAX_SEEN)
    store.wa.lastAt = Math.max(store.wa.lastAt, at)
    save()
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}))
    // Baileys 6.7.24, if shouldSyncHistoryMessage is omitted, ties it to syncFullHistory and then
    // ignores RECENT and ON_DEMAND history — including school-group homework photos.
    const HistType = proto.Message?.HistorySyncNotification?.HistorySyncType || {}
    sock = makeWASocket({
      auth: state,
      version,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: (msg) => {
        const t = msg?.syncType
        return t === HistType.RECENT || t === HistType.ON_DEMAND || t === HistType.PUSH_NAME || t === HistType.INITIAL_BOOTSTRAP || t == null
      },
      getMessage: async (key) => sent.get(key.id),
    })
    sock.ev.on('creds.update', saveCreds)
    let codeAsked = false
    askCode = async (raw) => {
      const number = pairingNumber(raw)
      if (!number) throw new Error('מספר לא תקין. כתוב אותו עם קידומת, למשל 0501234567 או 972501234567')
      if (ready) throw new Error('וואטסאפ כבר מחובר')
      codeAsked = true
      const code = await sock.requestPairingCode(number)
      Object.assign(pairing, { code, number })
      // Remembered so a restart offers a code for the same number right away.
      store.wa.pairNumber = number
      save()
      fs.writeFileSync(CODE_FILE, code)
      // The code is shown on the signed-in settings page. It is not written to the log: a cloud log is not the token.
      return { code, number }
    }

    // Names for numbers, from the address book WhatsApp syncs and from the names people give themselves.
    // A saved name wins over a self-given one.
    const learn = (list, saved = true) => {
      let changed = false
      for (const c of list || []) {
        const id = c.id && jidNormalizedUser(c.id)
        const name = (saved && (c.name || c.verifiedName)) || c.notify
        if (!id || !name || !id.endsWith('@s.whatsapp.net') || (!saved && store.contacts[id])) continue
        if (store.contacts[id] !== name) (store.contacts[id] = name), (changed = true)
      }
      if (changed) save()
    }
    sock.ev.on('contacts.upsert', (list) => learn(list))
    sock.ev.on('contacts.update', (list) => learn(list))
    const textOfContent = (content) =>
      content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.documentMessage?.caption || content?.videoMessage?.caption || content?.pollCreationMessage?.name || ''
    const groupTextOf = (msg) => quotedAndCaption(normalizeMessageContent(msg.message), textOfContent)
    const schoolMediaOf = (msg) => {
      const content = normalizeMessageContent(msg.message)
      if (!content || content.viewOnceMessage || content.viewOnceMessageV2) return null
      const part = content.imageMessage || content.documentMessage
      if (!part) return null
      const mime = part.mimetype || ''
      const name = part.fileName || ''
      if (content.documentMessage && !/pdf|image\//i.test(mime) && !/\.(pdf|jpe?g|png|webp|gif)$/i.test(name)) return null
      return { mime, name }
    }
    const sentAtOf = (msg) => {
      const raw = msg.messageTimestamp
      let n = Number(raw?.toNumber?.() ?? raw)
      if (n > 1e12) n = Math.floor(n / 1000)
      return n
    }
    // Regular upserts only take messages from this connection onward (`since`). A schoolwork lookback also
    // captures older group messages, for two weeks, into the local groups buffer — nothing is sent or marked read.
    const takeGroupMessage = (msg, { ignoreSince = false } = {}) => {
      const jid = msg.key?.remoteJid
      if (!jid?.endsWith('@g.us') || !msg.message || !groupHooks?.on()) return false
      const text = groupTextOf(msg)
      const sentAt = sentAtOf(msg)
      const school = Boolean(groupHooks?.isSchoolwork?.(jid) || isSchoolworkGroup(jid))
      const media = school ? schoolMediaOf(msg) : null
      if ((!text && !media) || (text && text.startsWith(BOT_MARK))) return false
      const sentAtSec = sentAt > 1e12 ? Math.floor(sentAt / 1000) : sentAt
      const twoWeeksAgo = Math.floor((Date.now() - 14 * 86400000) / 1000)
      // In a school group, homework photos from the last two weeks are taken even if WhatsApp
      // hands them over as a late upsert after we connected (not only on a history-sync event).
      const allowOld = ignoreSince || (school && sentAtSec >= twoWeeksAgo)
      if (!allowOld && sentAtSec < since) return false
      if (sentAtSec < twoWeeksAgo) return false
      if (!groupHooks.knows(jid)) sock.groupMetadata(jid).then((m) => groupHooks.setGroupName(jid, m.subject)).catch(() => {})
      const payload = { group: jid, id: msg.key.id, sender: msg.key.participant || msg.participant || '', senderName: msg.pushName || '', at: sentAt, fromMe: Boolean(msg.key.fromMe) }
      try {
        if (text) groupHooks.capture({ ...payload, text })
      } catch (e) {
        console.log(`[groups] ${e.message}`)
        return false
      }
      if (media) {
        const mid = msg.key.id
        if (!takeGroupMessage._mediaSeen) takeGroupMessage._mediaSeen = new Set()
        if (takeGroupMessage._mediaSeen.has(mid)) return true
        takeGroupMessage._mediaSeen.add(mid)
        enqueueSchoolMedia(async () => {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
            const read = await readHomeworkMedia({ buffer, mime: media.mime, name: media.name, caption: text })
            const combined = [text, read].filter(Boolean).join('\n')
            if (combined) groupHooks.capture({ ...payload, text: combined })
            console.log(`[schoolwork-media] photo ${read ? 'read' : 'empty'} ${(read || '').length} chars`)
          } catch (e) {
            console.log(`[schoolwork-media] download: ${e.message}`)
          }
        })
      }
      return true
    }
    const protocolOf = (msg) => {
      const content = normalizeMessageContent(msg?.message)
      return content?.protocolMessage || msg?.message?.protocolMessage || null
    }
    const peerSeen = new Set()
    const absorbPeer = async (msg) => {
      const p = protocolOf(msg)
      if (!p) return
      const id = msg.key?.id
      if (id) {
        if (peerSeen.has(id)) return
        peerSeen.add(id)
      }
      const kind = p.historySyncNotification
        ? 'historySync'
        : (p.peerDataOperationRequestResponseMessage ? 'pdoResponse' : `type:${p.type}`)
      console.log(`[whatsapp] peer ${kind}`)
      if (p.historySyncNotification) {
        try {
          const data = await downloadAndProcessHistorySyncNotification(p.historySyncNotification, {})
          const msgs = data.messages || []
          let taken = 0
          for (const m of msgs) {
            if (takeGroupMessage(m, { ignoreSince: true })) taken++
          }
          console.log(`[whatsapp] history blob messages=${msgs.length} taken=${taken}`)
        } catch (e) {
          console.log(`[whatsapp] history download: ${e.message}`)
        }
      }
      const results = p.peerDataOperationRequestResponseMessage?.peerDataOperationResult || []
      for (const result of results) {
        const present = Object.keys(result || {}).filter((k) => result[k] != null && k !== 'toJSON')
        if (present.length) console.log(`[whatsapp] pdo fields ${present.join(',')}`)
        const bytes = result.placeholderMessageResendResponse?.webMessageInfoBytes
        if (!bytes) continue
        try {
          const web = proto.WebMessageInfo.decode(bytes)
          takeGroupMessage(web, { ignoreSince: true })
        } catch (e) {
          console.log(`[whatsapp] pdo decode: ${e.message}`)
        }
      }
    }

    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      learn(contacts)
      for (const msg of messages || []) takeGroupMessage(msg, { ignoreSince: true })
    })

    // Names of every group he is in, not only groups that happen to speak after we connect.
    // Old messages are not fetched. A failure here must not take the socket down.
    const syncGroups = () => syncParticipatingGroups(sock).catch((e) => console.log(`[groups] ${e.message}`))
    groupHooks?.bindSync?.(syncGroups)
    const keepNames = (list) => {
      try {
        ingestGroupMetadata(list)
      } catch (e) {
        console.log(`[groups] ${e.message}`)
      }
    }
    sock.ev.on('groups.upsert', keepNames)
    sock.ev.on('groups.update', keepNames)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        pairing.qr = qr
        // Nobody is scanning: stop instead of printing codes forever. Exit code 2 tells start.bat not to restart.
        // Only in a window at home: on a server nobody would start it again, and the settings site needs it running.
        if (++qrShown > MAX_QR && process.stdout.isTTY) {
          console.log('\nהקוד לא נסרק. כשתהיה מוכן לסרוק, הפעל שוב את start.bat.')
          process.exit(2)
        }
        await QRCode.toFile(QR_FILE, qr, { width: 420 })
        // The home window can show the QR, same as before. A server has no window: the QR and the pairing code
        // stay on the signed-in settings page and are not written into the log. Auth creds are never printed.
        if (process.stdout.isTTY) {
          console.log('\nסרוק את הקוד: וואטסאפ בטלפון > מכשירים מקושרים > קישור מכשיר\n')
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
          console.log(`(אם הקוד לא קריא כאן, פתח את התמונה: ${QR_FILE})\n`)
        }
        // A phone cannot scan a code shown on its own screen. When the number is already known from an earlier
        // link, a code to type in is offered as well: Linked devices > Link a device > Link with phone number.
        // On a server there is no screen to scan at all, so the number can also be given up front:
        // WHATSAPP_PAIRING_NUMBER, digits only with the country code.
        const number = pairingNumber(process.env.WHATSAPP_PAIRING_NUMBER) || store.wa.pairNumber || (/^\d+@s\.whatsapp\.net$/.test(store.owner?.jid || '') && store.owner.jid.split('@')[0])
        if (number && !codeAsked) {
          try {
            const { code } = await askCode(number)
            if (process.stdout.isTTY) console.log(`או בלי סריקה: מכשירים מקושרים > קישור מכשיר > קישור עם מספר טלפון, והקלד: ${code}\n`)
          } catch (e) {
            console.log(`[whatsapp] ${e.message}`)
          }
        }
      }
      if (connection === 'open') {
        ready = true
        attempts = 0
        openedAt = Date.now()
        qrShown = 0
        Object.assign(pairing, { qr: '', code: '', number: '' })
        fs.rmSync(QR_FILE, { force: true })
        fs.rmSync(CODE_FILE, { force: true })
        console.log('מחובר לוואטסאפ ✔')
        // The address book arrives only with the first sync after linking. A link made before names were collected
        // asks for that part again, once: the saved version is dropped so the whole list comes back.
        if (!store.wa.contactsSynced) {
          store.wa.contactsSynced = true
          save()
          sock.authState.keys
            .set({ 'app-state-sync-version': { critical_unblock_low: null } })
            .then(() => sock.resyncAppState(['critical_unblock_low'], true))
            .then(() => console.log(`[whatsapp] אנשי קשר: ${Object.keys(store.contacts).length}`))
            .catch((e) => console.log(`[whatsapp] אנשי קשר: ${e.message}`))
        }
        // Deferred a tick so the caller already holds the returned handle when this runs.
        setTimeout(() => Promise.resolve(onReady({ jid: ownIds()[0], lid: ownIds()[1] || null })).catch((e) => console.log(`[whatsapp] ${e.message}`)))
        syncGroups()
      }
      if (connection === 'close') {
        ready = false
        // A code belongs to the socket that asked for it; the next socket offers a new one.
        Object.assign(pairing, { qr: '', code: '' })
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          console.log('החיבור נותק מהטלפון. מתחבר מחדש עם קוד QR חדש...')
        }
        // 3s, 6s, 12s ... up to a minute, so a long outage is not hammered with reconnects.
        const delay = Math.min(60000, 3000 * 2 ** attempts++)
        setTimeout(() => connect().catch((e) => console.log(`[whatsapp] ${e.message}`)), delay)
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        const protoMsg = protocolOf(msg)
        if (protoMsg?.historySyncNotification || protoMsg?.peerDataOperationRequestResponseMessage) {
          enqueueSchoolMedia(() => absorbPeer(msg))
        }
        const jid = msg.key?.remoteJid
        // A group message never reaches the assistant's chat. It is handed to the groups reader, text only, when that
        // is on; nothing is sent back, reacted to or marked as read.
        if (jid?.endsWith('@g.us') && msg.message && groupHooks?.on()) {
          takeGroupMessage(msg)
          continue
        }
        if (!jid || !msg.message || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
        if (!msg.key.fromMe && msg.pushName) learn([{ id: msg.key.senderPn || jid, notify: msg.pushName }], false)
        const sentAt = Number(msg.messageTimestamp)
        if (sentAt < since || seen.has(msg.key.id)) continue
        const id = msg.key.id
        const content = normalizeMessageContent(msg.message)
        const base = () => {
          const own = ownIds()
          const jids = [jid, msg.key.senderPn, msg.key.remoteJidAlt].filter(Boolean).map(jidNormalizedUser)
          // lateSeconds > 0: the message was written before this run started, while the assistant was off.
          return { jids, fromMe: Boolean(msg.key.fromMe), selfChat: jids.some((j) => own.includes(j)), key: msg.key, lateSeconds: Math.max(0, bootedAt - sentAt) }
        }
        // Read what the message is before it is marked seen, without acting on it yet.
        const reaction = content?.reactionMessage ? content.reactionMessage.text || '' : null
        // A shared 📍 or live location. Live location keeps sending updates; they arrive here the same way.
        const pin = content?.locationMessage || content?.liveLocationMessage
        const location = pin && Number.isFinite(pin.degreesLatitude) && Number.isFinite(pin.degreesLongitude)
          ? { lat: pin.degreesLatitude, lng: pin.degreesLongitude, name: pin.name || '', address: pin.address || '', live: Boolean(content.liveLocationMessage || pin.isLive) }
          : null
        const part = content?.imageMessage || content?.audioMessage || content?.documentMessage
        const text = content?.conversation || content?.extendedTextMessage?.text || part?.caption || pin?.comment || pin?.caption || ''
        const handled = reaction !== null ? Boolean(reaction) : Boolean(text || part || location) && !text.startsWith(BOT_MARK)
        // In flight from the same save that marks it seen, so a crash in between cannot lose it in silence.
        let tracked = false
        try {
          tracked = handled && Boolean(eligible(base()))
        } catch {}
        if (tracked) inflight.track(store.wa, id, sentAt * 1000, Date.now())
        remember(id, sentAt)
        // Released once onMessage gave it a durable receipt (m.receipt) or finished it. A throw keeps it listed, so the
        // inflight sweep in index.js tells the owner later instead of it staying unknown.
        const receipt = () => {
          if (tracked && inflight.release(store.wa, id)) save()
        }
        const run = (m) =>
          Promise.resolve(onMessage({ ...m, receipt }))
            .then(receipt)
            .catch((e) => console.log(`[whatsapp] ${e.message}`))
        // An emoji reaction arrives as its own message; an empty one means the reaction was removed.
        if (reaction !== null) {
          if (reaction) run({ ...base(), text: '', reaction, getMedia: async () => null })
          continue
        }
        if (!handled) continue
        // Downloaded lazily, so media from chats the bot ignores is never fetched.
        const getMedia = async () => {
          if (!part) return null
          if (Number(part.fileLength) > MAX_MEDIA) throw new Error('הקובץ גדול מדי (מעל 15MB)')
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
          return { kind: content.imageMessage ? 'image' : content.audioMessage ? 'audio' : 'file', buffer, mime: part.mimetype || '', name: part.fileName || '' }
        }
        run({ ...base(), text, getMedia, ...(location && { location }) })
      }
    })
  }

  let schoolMediaTail = Promise.resolve()
  const enqueueSchoolMedia = (fn) => {
    schoolMediaTail = schoolMediaTail.then(fn).catch((e) => console.log(`[schoolwork-media] ${e.message}`))
    return schoolMediaTail
  }
  const waitSchoolMedia = (ms = 120000) => Promise.race([schoolMediaTail, new Promise((r) => setTimeout(r, ms))])

  await connect()

  // Media cannot carry BOT_MARK, so its id is registered up front to keep the bot from answering itself.
  // Returns the message id. Not connected: throws before anything is sent (err.notSent), so a caller can tell
  // "surely did not leave" from a send that broke halfway and may have left.
  async function sendTracked(jid, content) {
    if (!ready) throw notConnected()
    const messageId = '3EB0' + randomBytes(9).toString('hex').toUpperCase()
    remember(messageId)
    await deliver(jid, content, { messageId })
    return messageId
  }

  return {
    async send(jid, text) {
      if (!ready) throw notConnected()
      let last
      for (let i = 0; i < text.length; i += 3500) last = await deliver(jid, { text: BOT_MARK + text.slice(i, i + 3500) })
      // The id WhatsApp knows the message by, for anyone who needs proof that it left.
      return last?.key?.id || null
    },
    sendVoice(jid, ogg) {
      return sendTracked(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true })
    },
    // media: { buffer, mime, caption? }. Images and videos show inline, audio plays, anything else arrives as a file.
    sendMedia(jid, { buffer, mime, caption, name }) {
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document'
      return sendTracked(jid, { [kind]: buffer, mimetype: mime, ...(kind !== 'audio' && caption && { caption }), ...(kind === 'document' && { fileName: name || 'file' }) })
    },
    // Puts an emoji on the message with this key; an empty string takes it off again.
    react(jid, key, emoji) {
      return sendTracked(jid, { react: { text: emoji, key } })
    },
    // A message to someone else, in the owner's name, exactly as written (no invisible bot mark).
    sendAs(jid, text) {
      return sendTracked(jid, { text })
    },
    // "דני" or "050-1234567" -> { jid, name, number }, { matches: [...] } when the name is ambiguous, or { error }.
    async findContact(query) {
      if (!ready) return { error: 'וואטסאפ לא מחובר כרגע' }
      const q = String(query || '').trim()
      let digits = q.replace(/\D/g, '')
      if (digits.length >= 9) {
        if (digits.startsWith('0')) digits = '972' + digits.slice(1)
        const [hit] = await sock.onWhatsApp(`${digits}@s.whatsapp.net`).catch(() => [])
        if (!hit?.exists) return { error: `למספר +${digits} אין וואטסאפ` }
        const jid = jidNormalizedUser(hit.jid)
        return { jid, number: `+${digits}`, name: store.contacts[jid] || `+${digits}` }
      }
      const lower = q.toLowerCase()
      const all = Object.entries(store.contacts).filter(([jid]) => !ownIds().includes(jid))
      const exact = all.filter(([, name]) => name.toLowerCase() === lower)
      const partial = exact.length ? exact : all.filter(([, name]) => name.toLowerCase().includes(lower))
      if (!partial.length) return { error: `לא מצאתי איש קשר בשם "${q}". צריך את המספר שלו.` }
      if (partial.length > 1) return { matches: partial.slice(0, 6).map(([jid, name]) => `${name} (+${jid.split('@')[0]})`) }
      const [jid, name] = partial[0]
      return { jid, name, number: `+${jid.split('@')[0]}` }
    },
    // When the current connection opened, or 0 while disconnected.
    connectedSince: () => (ready ? openedAt : 0),
    typing(jid) {
      if (ready) sock.sendPresenceUpdate('composing', target(jid)).catch(() => {})
    },
    // On-demand group history for the homework lookback. The phone must be online. Times out and returns
    // what arrived; never throws into the caller. Messages land through messaging-history.set.
    async fetchGroupHistory(jid, { count = 300, oldest, timeoutMs = 45000, resend = [] } = {}) {
      if (!ready || !sock) return { n: 0, timedOut: false, reason: 'not-ready', pulled: false }
      if (!oldest?.id) return { n: 0, timedOut: false, reason: 'no-cursor', pulled: false }
      let n = 0
      let lastHit = 0
      const take = (messages) => {
        for (const msg of messages || []) {
          if (msg.key?.remoteJid !== jid) continue
          n++
          lastHit = Date.now()
          takeGroupMessage(msg, { ignoreSince: true })
        }
      }
      const onSet = ({ messages }) => take(messages)
      const onUpsert = ({ messages }) => take(messages)
      sock.ev.on('messaging-history.set', onSet)
      sock.ev.on('messages.upsert', onUpsert)
      const delay = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        const key = { remoteJid: jid, id: oldest.id, fromMe: Boolean(oldest.fromMe) }
        const ts = Number(oldest.at) || 0
        const tsMs = ts > 1e12 ? ts : ts * 1000
        // A cursor just after the newest known message, so that message (the Tuesday photo) is included too.
        const askTs = tsMs + 1000
        // Match the hashed sender we already stored, so a group resend includes the participant. The raw id stays in memory only.
        const hashOf = (x) => createHash('sha256').update(String(x || '')).digest('hex').slice(0, 12)
        const byHash = new Map()
        try {
          const meta = await sock.groupMetadata(jid)
          for (const p of meta.participants || []) {
            for (const id of [p.id, p.lid, p.jid, p.phoneNumber]) {
              if (id) byHash.set(hashOf(id), id)
            }
          }
        } catch (e) {
          console.log(`[whatsapp] metadata: ${e.message}`)
        }
        const accountLid = sock.authState?.creds?.me?.lid || ''
        if (typeof sock.sendPeerDataOperationMessage === 'function' && proto?.Message?.PeerDataOperationRequestType?.HISTORY_SYNC_ON_DEMAND) {
          await sock.sendPeerDataOperationMessage({
            historySyncOnDemandRequest: {
              chatJid: jid,
              oldestMsgFromMe: Boolean(oldest.fromMe),
              oldestMsgId: oldest.id,
              oldestMsgTimestampMs: askTs,
              onDemandMsgCount: count,
              ...(accountLid ? { accountLid } : {}),
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
          })
          console.log(`[whatsapp] history asked lid=${accountLid ? 'yes' : 'no'} resend=${(resend || []).length}`)
        } else {
          await sock.fetchMessageHistory(count, key, askTs)
          console.log(`[whatsapp] history asked resend=${(resend || []).length}`)
        }
        for (const m of resend || []) {
          if (!m?.id) continue
          const rk = { remoteJid: jid, id: m.id, fromMe: Boolean(m.fromMe) }
          if (m.s && byHash.has(m.s)) rk.participant = byHash.get(m.s)
          try {
            await sock.requestPlaceholderResend(rk)
            console.log('[whatsapp] resend asked')
          } catch (e) {
            console.log(`[whatsapp] resend: ${e.message}`)
          }
        }
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          await delay(1000)
          if (n > 0 && lastHit && Date.now() - lastHit >= 8000) break
        }
        const timedOut = n === 0 && Date.now() - start >= timeoutMs - 50
        await waitSchoolMedia(120000)
        console.log(`[whatsapp] fetchGroupHistory n=${n} timedOut=${timedOut} waited=${Date.now() - start}ms`)
        return { n, timedOut, pulled: n > 0 }
      } catch (e) {
        console.log(`[whatsapp] fetchGroupHistory: ${e.message}`)
        return { n, timedOut: false, reason: e.message, pulled: false }
      } finally {
        try { sock.ev.off('messaging-history.set', onSet) } catch {}
        try { sock.ev.off('messages.upsert', onUpsert) } catch {}
      }
    },
  }
}
