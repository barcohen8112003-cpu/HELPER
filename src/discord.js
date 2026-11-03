// Discord, built in. HELPER logs in as its own Discord bot and answers its owner in private messages, with the
// same memory, tools and queue as WhatsApp. It asks Discord only for direct messages (no server channels), so
// nothing private is ever written where other people can read it.
//
// Turn on: DISCORD_TOKEN (the bot's token from discord.com/developers). The owner is DISCORD_OWNER_ID, or, when
// that is empty, whoever proves it by typing a code that HELPER sends to the owner's WhatsApp.
import WebSocket from 'ws'
import { randomInt } from 'node:crypto'
import { config } from './config.js'
import { state, save } from './store.js'

const API = 'https://discord.com/api/v10'
// DIRECT_MESSAGES only. Discord delivers the text of a DM without the privileged Message Content intent.
export const INTENTS = 1 << 12
// Close codes after which reconnecting cannot help: the setting itself is wrong.
export const FATAL = {
  4004: 'הטוקן של בוט הדיסקורד שגוי. צריך להעתיק אותו שוב מ-Developer Portal (Bot, Reset Token).',
  4010: 'Discord: shard שגוי',
  4011: 'Discord: הבוט צריך sharding',
  4012: 'Discord: גרסת API לא תקינה',
  4013: 'Discord: intents לא תקינים',
  4014: 'Discord: intents לא מאושרים לבוט',
}
const PAIR_TTL_MS = 10 * 60000
const PAIR_TRIES = 5

// Discord allows 2000 characters a message. Cut on a line break, then a space, never inside a word if avoidable.
export function splitMessage(text, max = 1900) {
  const out = []
  let rest = String(text || '').trim()
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One connection to Discord with one token. ask(text) => reply comes from HELPER's queue; tellOwner(text) writes
// to the owner on WhatsApp (used for the pairing code). fetchImpl and WebSocketImpl are swapped in by the self-test.
export function createDiscord({ token, ask, tellOwner = async () => {}, ownerId = () => config.discord.ownerId || state.discordOwnerId || '', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, log = (m) => console.log(`[discord] ${m}`), retryBase = 1000 }) {
  let ws = null
  let seq = null
  let sessionId = null
  let resumeUrl = null
  let gatewayUrl = null
  let heartbeat = null
  let acked = true
  let stopped = false
  let retries = 0
  let reconnectTimer = null
  let me = null
  let ready = false
  let error = ''
  let dmChannel = null
  let pairing = null // { userId, code, until, tries }
  const seen = new Set()

  async function rest(method, route, body) {
    for (let i = 0; i < 4; i++) {
      const r = await fetchImpl(API + route, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/barcohen8112003-cpu/HELPER, 1.0)' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}))
        await sleep(Math.min(10, Number(j.retry_after) || 1) * 1000)
        continue
      }
      if (r.status === 401) throw Object.assign(new Error(FATAL[4004]), { fatal: true })
      if (!r.ok) throw new Error(`Discord ${method} ${route.split('/')[1]}: ${r.status}`)
      return r.status === 204 ? null : r.json().catch(() => null)
    }
    throw new Error('Discord: יותר מדי בקשות, נסה שוב עוד רגע')
  }

  async function sendTo(channelId, text) {
    for (const part of splitMessage(text)) await rest('POST', `/channels/${channelId}/messages`, { content: part, allowed_mentions: { parse: [] } })
  }

  async function ownerChannel() {
    const owner = ownerId()
    if (!owner) return null
    if (dmChannel?.owner !== owner) dmChannel = { owner, id: (await rest('POST', '/users/@me/channels', { recipient_id: owner })).id }
    return dmChannel.id
  }

  // Messages HELPER queued for Discord (the send_discord tool, the WhatsApp-is-down alert).
  async function flushOutbox() {
    if (!ready || !state.discordOutbox?.length) return 0
    const channel = await ownerChannel()
    if (!channel) return 0
    const items = state.discordOutbox
    state.discordOutbox = []
    save()
    let sent = 0
    try {
      for (const item of items) {
        await sendTo(channel, item.text)
        sent++
      }
    } catch (e) {
      state.discordOutbox = [...items.slice(sent), ...state.discordOutbox].slice(-20)
      save()
      log(`outbox: ${e.message}`)
    }
    return sent
  }

  function send(payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload))
  }

  function beat() {
    if (!acked) {
      // No answer to the last heartbeat: the connection is dead even if the socket looks open.
      log('אין תשובה מ-Discord, מתחבר מחדש')
      if (ws?.terminate) ws.terminate()
      else ws?.close(4000)
      return
    }
    acked = false
    send({ op: 1, d: seq })
  }

  async function pair(user, text) {
    const now = Date.now()
    const typed = text.replace(/\s/g, '')
    if (pairing && pairing.userId === user.id && pairing.until > now && /^\d{6}$/.test(typed)) {
      if (typed === pairing.code) {
        state.discordOwnerId = user.id
        save()
        pairing = null
        dmChannel = null
        log(`מחובר לבעלים ${user.username} (${user.id})`)
        return 'מחובר ✅ מעכשיו אני עונה לך כאן, עם אותו זיכרון ואותם כלים כמו בוואטסאפ. אישורים (👍) עדיין מגיעים לוואטסאפ.'
      }
      if (++pairing.tries >= PAIR_TRIES) pairing = null
      return 'הקוד לא נכון.'
    }
    // One live code at a time, so a stranger cannot flood the owner's WhatsApp with codes.
    if (pairing && pairing.until > now) return pairing.userId === user.id ? 'כבר שלחתי קוד לוואטסאפ. תכתוב אותו כאן.' : null
    pairing = { userId: user.id, code: String(randomInt(0, 1_000_000)).padStart(6, '0'), until: now + PAIR_TTL_MS, tries: 0 }
    try {
      await tellOwner(`מישהו בדיסקורד (${user.username}) מבקש לדבר איתי שם בתור אתה.\nאם זה אתה, תכתוב לבוט בדיסקורד את הקוד: ${pairing.code}\nאם זה לא אתה, אל תעשה כלום. הקוד פג בעוד 10 דקות.`)
    } catch (e) {
      pairing = null
      log(`לא הצלחתי לשלוח קוד חיבור לוואטסאפ: ${e.message}`)
      return 'אני עוזר פרטי. כדי לחבר אותי לחשבון שלך צריך DISCORD_OWNER_ID באתר ההגדרות.'
    }
    return 'אני עוזר פרטי. כדי לוודא שזה אתה, שלחתי קוד לוואטסאפ שלך. תכתוב אותו כאן.'
  }

  async function onMessage(m) {
    if (!m?.author || m.author.bot || m.guild_id) return
    if (me && m.author.id === me.id) return
    if (seen.has(m.id)) return
    seen.add(m.id)
    if (seen.size > 500) seen.delete(seen.values().next().value)
    const text = String(m.content || '').trim()
    const owner = ownerId()
    if (!owner) {
      if (!text) return
      const answer = await pair(m.author, text)
      if (answer) await sendTo(m.channel_id, answer)
      return
    }
    if (m.author.id !== owner) return // a private assistant: other people get no answer at all
    if (!text) {
      if (m.attachments?.length) await sendTo(m.channel_id, 'בדיסקורד אני קורא כרגע רק טקסט. קבצים, תמונות והודעות קוליות עדיין דרך וואטסאפ.')
      return
    }
    // "typing..." while HELPER thinks. It lasts 10 seconds, so it is renewed.
    const typing = () => rest('POST', `/channels/${m.channel_id}/typing`).catch(() => {})
    typing()
    const timer = setInterval(typing, 8000)
    let reply
    try {
      reply = await ask(text)
    } catch (e) {
      reply = `משהו השתבש: ${e.message}`
    } finally {
      clearInterval(timer)
    }
    await sendTo(m.channel_id, reply || '...')
  }

  function onPacket(p) {
    if (p.s != null) seq = p.s
    if (p.op === 10) {
      clearInterval(heartbeat)
      acked = true
      const every = p.d.heartbeat_interval
      setTimeout(() => {
        if (stopped) return
        beat()
        heartbeat = setInterval(beat, every)
      }, Math.floor(every * Math.random()))
      if (sessionId && resumeUrl) send({ op: 6, d: { token, session_id: sessionId, seq } })
      else send({ op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: 'helper', device: 'helper' } } })
      return
    }
    if (p.op === 11) return void (acked = true)
    if (p.op === 1) return beat()
    if (p.op === 7) return void ws?.close(4000)
    if (p.op === 9) {
      // Invalid session: d=true means the session can still be resumed.
      if (!p.d) {
        sessionId = null
        seq = null
      }
      return void setTimeout(() => ws?.close(4000), 1000 + Math.random() * 4000)
    }
    if (p.op !== 0) return
    if (p.t === 'READY') {
      sessionId = p.d.session_id
      resumeUrl = p.d.resume_gateway_url
      me = p.d.user
      ready = true
      retries = 0
      error = ''
      state.bridgeSeenAt = Date.now()
      save()
      log(`מחובר כ-${me?.username}. ${ownerId() ? 'עונה לבעלים בהודעות פרטיות.' : 'אין עדיין בעלים: ההודעה הפרטית הראשונה תקבל קוד בוואטסאפ.'}`)
      flushOutbox().catch(() => {})
    } else if (p.t === 'RESUMED') {
      ready = true
      retries = 0
    } else if (p.t === 'MESSAGE_CREATE') {
      onMessage(p.d).catch((e) => log(`הודעה: ${e.message}`))
    }
  }

  function fail(message) {
    error = message
    ready = false
    stopped = true
    log(message)
  }

  function scheduleReconnect() {
    if (stopped) return
    retries++
    const wait = Math.min(60_000, retryBase * 2 ** Math.min(retries, 6))
    reconnectTimer = setTimeout(() => connect().catch(onConnectError), wait)
  }

  function onConnectError(e) {
    if (e.fatal) return fail(e.message)
    error = e.message
    log(`חיבור נכשל: ${e.message}`)
    scheduleReconnect()
  }

  async function connect() {
    if (stopped) return
    const base = sessionId && resumeUrl ? resumeUrl : (gatewayUrl ||= (await rest('GET', '/gateway/bot')).url)
    const socket = new WebSocketImpl(`${base}/?v=10&encoding=json`)
    ws = socket
    socket.on('message', (raw) => {
      if (ws !== socket) return
      try {
        onPacket(JSON.parse(String(raw)))
      } catch (e) {
        log(`חבילה לא תקינה: ${e.message}`)
      }
    })
    socket.on('error', (e) => log(`חיבור: ${e.message}`))
    socket.on('close', (code) => {
      if (ws !== socket) return
      clearInterval(heartbeat)
      ready = false
      if (stopped) return
      if (FATAL[code]) return fail(FATAL[code])
      // These two end the session for good: start a new one instead of resuming.
      if (code === 4007 || code === 4009) {
        sessionId = null
        seq = null
      }
      scheduleReconnect()
    })
  }

  const outboxTimer = setInterval(() => flushOutbox().catch((e) => log(`outbox: ${e.message}`)), 5000)
  outboxTimer.unref?.()
  // While connected the bot counts as linked, so the send_discord tool stays available.
  const seenTimer = setInterval(() => {
    if (ready) state.bridgeSeenAt = Date.now()
  }, 3600_000)
  seenTimer.unref?.()

  connect().catch(onConnectError)

  return {
    status: () => ({ connected: ready, user: me?.username || '', owner: ownerId(), error }),
    flushOutbox,
    stop() {
      stopped = true
      ready = false
      clearInterval(heartbeat)
      clearInterval(outboxTimer)
      clearInterval(seenTimer)
      clearTimeout(reconnectTimer)
      try {
        ws?.close(1000)
      } catch {}
    },
  }
}

// Started once from src/index.js. It follows DISCORD_TOKEN: saving the token in the settings site connects
// within a few seconds, clearing it disconnects, with no restart.
let running = null
let runningToken = ''
export function startDiscord({ ask, tellOwner }) {
  const sync = () => {
    const token = config.discord.token
    if (token === runningToken) return
    running?.stop()
    running = null
    runningToken = token
    if (token) running = createDiscord({ token, ask, tellOwner })
  }
  sync()
  setInterval(sync, 10_000).unref()
}

export const discordStatus = () => (running ? running.status() : null)
