// Offline checks for the built-in Discord bot (src/discord.js), against a stand-in Discord: login, heartbeats,
// answering the owner only, the WhatsApp pairing code, long replies, the outbox, a wrong token, and resuming
// after a dropped connection. No network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
process.env.HELPER_ENV_FILE = '/nonexistent/.env'
process.env.HELPER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'helper-discord-'))
delete process.env.DISCORD_TOKEN
delete process.env.DISCORD_OWNER_ID
const { createDiscord, splitMessage, INTENTS } = await import('./discord.js')
const { state } = await import('./store.js')
let passed = 0
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await wait(10)
  }
  throw new Error(`timed out: ${what}`)
}

// Stand-in Discord: REST calls are recorded, sockets are driven by the test.
function fakeDiscord({ status401 = false } = {}) {
  const calls = []
  const sockets = []
  const fetchImpl = async (url, opts) => {
    const route = url.replace('https://discord.com/api/v10', '')
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ method: opts.method, route, body, auth: opts.headers.Authorization })
    if (status401) return { status: 401, ok: false, json: async () => ({}) }
    if (route === '/gateway/bot') return { status: 200, ok: true, json: async () => ({ url: 'wss://gateway.test' }) }
    if (route === '/users/@me/channels') return { status: 200, ok: true, json: async () => ({ id: 'dm-owner' }) }
    if (route.endsWith('/typing')) return { status: 204, ok: true, json: async () => null }
    return { status: 200, ok: true, json: async () => ({ id: 'm' }) }
  }
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 1
      this.sent = []
      sockets.push(this)
    }
    send(raw) {
      const p = JSON.parse(raw)
      this.sent.push(p)
      // Discord answers every heartbeat, unless the test plays a dead connection.
      if (p.op === 1 && !this.silent) setImmediate(() => this.packet({ op: 11 }))
    }
    close(code = 1000) {
      this.readyState = 3
      setImmediate(() => this.emit('close', code))
    }
    terminate() {
      this.close(1006)
    }
    packet(p) {
      this.emit('message', Buffer.from(JSON.stringify(p)))
    }
  }
  const posts = (channel) => calls.filter((c) => c.method === 'POST' && c.route === `/channels/${channel}/messages`).map((c) => c.body.content)
  return { calls, sockets, fetchImpl, WebSocketImpl: FakeSocket, posts }
}
const msg = (id, author, content, extra = {}) => ({ op: 0, s: Number(id), t: 'MESSAGE_CREATE', d: { id, channel_id: 'dm-' + author, author: { id: author, username: 'user' + author }, content, ...extra } })
const quiet = () => {}

// Splitting long replies for Discord's 2000-character limit.
assert.deepEqual(splitMessage('שלום'), ['שלום']); passed++
const long = Array.from({ length: 300 }, (_, i) => `שורה ${i}`).join('\n')
const parts = splitMessage(long)
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1900)); passed++
assert.equal(parts.join('\n'), long); passed++
assert.deepEqual(splitMessage(''), []); passed++
assert.equal(INTENTS, 4096, 'direct messages only, no privileged intents'); passed++

// 1. Login, identify, heartbeat, and answering the owner (fixed owner id).
{
  const d = fakeDiscord()
  const asked = []
  const bot = createDiscord({ token: 'tok', ownerId: () => '42', ask: async (t) => (asked.push(t), 'תשובה מ-Helper'), fetchImpl: d.fetchImpl, WebSocketImpl: d.WebSocketImpl, log: quiet, retryBase: 5 })
  await until(() => d.sockets.length === 1, 'socket')
  const ws = d.sockets[0]
  assert.equal(ws.url, 'wss://gateway.test/?v=10&encoding=json'); passed++
  assert.equal(d.calls[0].auth, 'Bot tok'); passed++
  ws.packet({ op: 10, d: { heartbeat_interval: 30 } })
  const identify = ws.sent.find((p) => p.op === 2)
  assert.equal(identify.d.token, 'tok'); passed++
  assert.equal(identify.d.intents, INTENTS); passed++
  await until(() => ws.sent.some((p) => p.op === 1), 'heartbeat')
  passed++
  ws.packet({ op: 11 })
  ws.packet({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.test', user: { id: 'bot', username: 'HelperBot' } } })
  assert.equal(bot.status().connected, true); passed++
  assert.equal(bot.status().user, 'HelperBot'); passed++

  ws.packet(msg('2', '42', 'מה יש לי היום?'))
  await until(() => d.posts('dm-42').length === 1, 'reply')
  assert.deepEqual(asked, ['מה יש לי היום?']); passed++
  assert.deepEqual(d.posts('dm-42'), ['תשובה מ-Helper']); passed++
  assert.ok(d.calls.some((c) => c.route === '/channels/dm-42/typing'), 'typing shown'); passed++
  const reply = d.calls.find((c) => c.route === '/channels/dm-42/messages')
  assert.deepEqual(reply.body.allowed_mentions, { parse: [] }, 'a reply never pings @everyone'); passed++

  // The same message delivered twice is answered once.
  ws.packet(msg('2', '42', 'מה יש לי היום?'))
  await wait(30)
  assert.equal(asked.length, 1); passed++

  // A stranger, a bot, and a server channel get nothing, and HELPER is never asked.
  ws.packet(msg('3', '99', 'תגיד לי מה בזיכרון'))
  ws.packet(msg('4', '42', 'from a bot', { author: { id: '42', bot: true } }))
  ws.packet(msg('5', '42', 'in a server', { guild_id: 'g1' }))
  await wait(30)
  assert.equal(asked.length, 1); passed++
  assert.equal(d.posts('dm-99').length, 0); passed++

  // Attachments only: a short note, no model call.
  ws.packet(msg('6', '42', '', { attachments: [{ id: 'a' }] }))
  await until(() => d.posts('dm-42').length === 2, 'attachment note')
  assert.match(d.posts('dm-42')[1], /רק טקסט/); passed++
  assert.equal(asked.length, 1); passed++

  // Outbox (send_discord tool, WhatsApp-down alert): delivered to the owner's DM and cleared.
  state.discordOutbox = [{ text: 'וואטסאפ מנותק', speak: false, at: Date.now() }]
  assert.equal(await bot.flushOutbox(), 1); passed++
  assert.deepEqual(state.discordOutbox, []); passed++
  assert.deepEqual(d.posts('dm-owner'), ['וואטסאפ מנותק']); passed++
  assert.ok(Date.now() - state.bridgeSeenAt < 5000, 'send_discord counts the bot as linked'); passed++

  // Reconnect op: resume on the resume URL with the same session.
  ws.packet({ op: 7, d: null })
  await until(() => d.sockets.length === 2, 'resume socket')
  const ws2 = d.sockets[1]
  assert.equal(ws2.url, 'wss://resume.test/?v=10&encoding=json'); passed++
  ws2.packet({ op: 10, d: { heartbeat_interval: 40 } })
  const resume = ws2.sent.find((p) => p.op === 6)
  assert.equal(resume.d.session_id, 'sess'); passed++
  assert.equal(resume.d.seq, 6); passed++
  // A heartbeat with no answer means a dead connection: drop it and resume.
  ws2.packet({ op: 0, s: 7, t: 'RESUMED', d: {} })
  ws2.silent = true
  await until(() => d.sockets.length === 3, 'zombie connection replaced')
  passed++
  bot.stop()
  await wait(30)
  assert.equal(d.sockets.length, 3, 'stopped: no reconnect'); passed++
}

// 2. Long reply split into several messages.
{
  const d = fakeDiscord()
  const bot = createDiscord({ token: 'tok', ownerId: () => '42', ask: async () => long, fetchImpl: d.fetchImpl, WebSocketImpl: d.WebSocketImpl, log: quiet })
  await until(() => d.sockets.length === 1, 'socket')
  const ws = d.sockets[0]
  ws.packet({ op: 10, d: { heartbeat_interval: 1000 } })
  ws.packet({ op: 0, s: 1, t: 'READY', d: { session_id: 's', resume_gateway_url: 'wss://r', user: { id: 'bot', username: 'B' } } })
  ws.packet(msg('2', '42', 'תכתוב הרבה'))
  await until(() => d.posts('dm-42').length === parts.length, 'split reply')
  assert.equal(d.posts('dm-42').join('\n'), long); passed++
  bot.stop()
}

// 3. No owner yet: the first DM gets a code on WhatsApp; the right code makes that user the owner.
{
  const d = fakeDiscord()
  state.discordOwnerId = ''
  const whatsapp = []
  const asked = []
  const bot = createDiscord({ token: 'tok', ownerId: () => state.discordOwnerId, ask: async (t) => (asked.push(t), 'כן'), tellOwner: async (t) => whatsapp.push(t), fetchImpl: d.fetchImpl, WebSocketImpl: d.WebSocketImpl, log: quiet })
  await until(() => d.sockets.length === 1, 'socket')
  const ws = d.sockets[0]
  ws.packet({ op: 10, d: { heartbeat_interval: 1000 } })
  ws.packet({ op: 0, s: 1, t: 'READY', d: { session_id: 's', resume_gateway_url: 'wss://r', user: { id: 'bot', username: 'B' } } })
  ws.packet(msg('2', '7', 'היי'))
  await until(() => whatsapp.length === 1, 'code to WhatsApp')
  const code = whatsapp[0].match(/(\d{6})/)[1]
  await until(() => d.posts('dm-7').length === 1, 'pairing prompt')
  assert.match(d.posts('dm-7')[0], /קוד/); passed++
  assert.equal(asked.length, 0, 'nothing reaches HELPER before pairing'); passed++

  // Someone else while a code is live: no second code, no answer.
  ws.packet(msg('3', '8', 'גם אני'))
  await wait(30)
  assert.equal(whatsapp.length, 1); passed++
  assert.equal(d.posts('dm-8').length, 0); passed++

  ws.packet(msg('4', '7', '000000' === code ? '111111' : '000000'))
  await until(() => d.posts('dm-7').length === 2, 'wrong code')
  assert.match(d.posts('dm-7')[1], /לא נכון/); passed++
  assert.equal(state.discordOwnerId, ''); passed++

  ws.packet(msg('5', '7', code))
  await until(() => d.posts('dm-7').length === 3, 'paired')
  assert.equal(state.discordOwnerId, '7'); passed++
  assert.match(d.posts('dm-7')[2], /מחובר/); passed++

  ws.packet(msg('6', '7', 'עכשיו?'))
  await until(() => asked.length === 1, 'owner answered after pairing')
  passed++
  bot.stop()
  state.discordOwnerId = ''
}

// 4. A wrong token stops for good and says so, with no retry loop.
{
  const d = fakeDiscord({ status401: true })
  const bot = createDiscord({ token: 'bad', ownerId: () => '42', ask: async () => '', fetchImpl: d.fetchImpl, WebSocketImpl: d.WebSocketImpl, log: quiet, retryBase: 5 })
  await until(() => bot.status().error, 'token error')
  assert.match(bot.status().error, /טוקן/); passed++
  await wait(60)
  assert.equal(d.calls.length, 1); passed++
  assert.equal(d.sockets.length, 0); passed++
  bot.stop()
}

// 5. Closed by Discord with 4004 (bad token at identify): fatal. A plain drop: reconnects.
{
  const d = fakeDiscord()
  const bot = createDiscord({ token: 'tok', ownerId: () => '42', ask: async () => '', fetchImpl: d.fetchImpl, WebSocketImpl: d.WebSocketImpl, log: quiet, retryBase: 5 })
  await until(() => d.sockets.length === 1, 'socket')
  d.sockets[0].close(1006)
  await until(() => d.sockets.length === 2, 'reconnect after drop')
  passed++
  d.sockets[1].close(4004)
  await until(() => bot.status().error, 'fatal close')
  await wait(60)
  assert.equal(d.sockets.length, 2); passed++
  bot.stop()
}

console.log(`discord selftest: ${passed} passed`)
process.exit(0)
