// node src/pc-bridge-selftest.js
// The cloud routes computer actions to a home bridge: signature, replay, a real loopback socket,
// a disconnected PC, and COMPUTER_MODE=ask refusing a state change before anything is sent.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-pc-bridge-'))
process.env.HELPER_ENV_FILE = path.join(process.env.HELPER_DATA_DIR, 'no.env')
process.env.PC_BRIDGE_SECRET = 'test-secret-not-real'
process.env.COMPUTER_MODE = 'ask'
process.env.PC_BRIDGE_PORT = '0'
delete process.env.PC_BRIDGE_EXECUTOR
delete process.env.PC_BRIDGE_ON_PORT
delete process.env.PORT
delete process.env.WAKE_MAC
process.env.WEBTOP_URL = 'https://school.example/'

const bridge = await import('./pc-bridge.js')
const { tools, activeTools } = await import('./tools.js')
const { config } = await import('./config.js')
const pc = await import('./pc.js')
const session = await import('./session.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const tool = (name) => tools.find((t) => t.name === name)
const SECRET = config.pcBridge.secret

// ── signature, encryption, replay ───────────────────────────────────────────
{
  const body = { t: 'call', id: '1', name: 'media', args: ['mute'] }
  const frame = bridge.seal(SECRET, body)
  ok(!frame.includes('"name":"media"'), 'the call is not plaintext on the wire')
  const seen = new Map()
  const opened = bridge.openFrame(SECRET, frame, seen)
  ok(opened.ok && opened.payload.name === 'media' && opened.payload.args[0] === 'mute', 'a signed frame opens')
  ok(bridge.openFrame(SECRET, frame, seen).error === 'repeat', 'a replayed frame is rejected')
  ok(bridge.openFrame('other-secret-value', frame, new Map()).error === 'bad signature', 'a wrong secret is rejected')
  const stale = bridge.seal(SECRET, { t: 'call', id: '2', name: 'status', args: [] }, Date.now() - 120000)
  ok(bridge.openFrame(SECRET, stale, new Map()).error === 'too old', 'an old frame is rejected')

  ok(bridge.verifyHello(SECRET, bridge.signHello(SECRET)) === null, 'a fresh hello is accepted')
  ok(bridge.verifyHello(SECRET, bridge.signHello('nope-nope-nope')) === 'bad signature', 'a hello signed with the wrong secret is rejected')
  ok(bridge.verifyHello(SECRET, bridge.signHello(SECRET, Date.now() - 120000)) === 'too old', 'an old hello is rejected')
  const hello = bridge.signHello(SECRET)
  ok(bridge.verifyHello(SECRET, hello) === null && bridge.verifyHello(SECRET, hello) === 'repeat', 'a replayed hello is rejected')

  const tmp = path.join(os.tmpdir(), `helper-pack-${Date.now()}.png`)
  fs.writeFileSync(tmp, Buffer.from('PNGDATA'))
  const packed = bridge.pack({ width: 2, file: tmp }, true)
  ok(!fs.existsSync(tmp), 'a temp screenshot is removed on the sender after it is packed')
  const back = bridge.unpack(packed)
  ok(back.width === 2 && fs.readFileSync(back.file).toString() === 'PNGDATA', 'the screenshot is restored on the receiver')
  fs.rmSync(back.file, { force: true })
  const round = bridge.unpack(bridge.pack({ data: Buffer.from('hi') }))
  ok(Buffer.isBuffer(round.data) && round.data.toString() === 'hi', 'file bytes survive the bridge')

  let ran = 0
  const session = bridge.createHomeSession({
    secret: SECRET,
    handlers: { media: () => { ran++; return 'ok' } },
  })
  const call = bridge.seal(SECRET, { t: 'call', id: 'abc', name: 'media', args: ['mute'] })
  await session.handle(call)
  const second = await session.handle(call)
  ok(ran === 1 && second.error === 'repeat', 'a replayed call does not run twice')

  const sent = []
  const unknown = bridge.createHomeSession({ secret: SECRET, handlers: {} })
  unknown.attach({ readyState: WebSocket.OPEN, send: (frame) => sent.push(frame) })
  await unknown.handle(bridge.seal(SECRET, { t: 'call', id: 'z', name: 'nope', args: [] }))
  const reply = bridge.openFrame(SECRET, sent[0], new Map())
  ok(reply.ok && reply.payload.ok === false && reply.payload.error.includes('לא מוכרת'), 'an unknown action is refused')
}

// ── loopback: routing, refusal, disconnected PC ─────────────────────────────
const srv = bridge.startPcBridgeServer({ port: 0, host: '127.0.0.1' })
try {
  const addr = await srv.ready
  const url = `ws://127.0.0.1:${addr.port}/pc`
  const health = await fetch(`http://127.0.0.1:${addr.port}/pc/health`)
  ok(health.ok && (await health.json()).home === false, 'health answers before the PC connects')

  await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'x-helper-pc': bridge.signHello('wrong-secret-value') }, handshakeTimeout: 3000 })
    let done = false
    const finish = (cond, name) => {
      if (done) return
      done = true
      ok(cond, name)
      try { ws.terminate() } catch {}
      resolve()
    }
    ws.on('unexpected-response', (_req, res) => finish(res.statusCode === 401, 'the cloud refuses a bad hello'))
    ws.on('open', () => finish(false, 'the cloud refuses a bad hello'))
    ws.on('error', () => {})
    setTimeout(() => finish(false, 'the cloud refuses a bad hello'), 3000)
  })

  ok(activeTools().some((t) => t.name === 'pc_status'), 'computer tools are offered when the bridge is configured')
  config.computerMode = 'off'
  ok(!activeTools().some((t) => t.name === 'pc_status'), 'COMPUTER_MODE=off hides the computer tools')
  config.computerMode = 'ask'

  let offline = ''
  try {
    await tool('pc_status').run()
  } catch (e) {
    offline = e.message
  }
  ok(offline.includes('לא מחובר') && offline.includes('שום פעולה לא בוצעה'), 'a disconnected PC is reported, not a silent failure')
  let webtopOff = ''
  try {
    await session.readSessionPage('https://school.example/home')
  } catch (e) {
    webtopOff = e.message
  }
  ok(webtopOff.includes('לא מחובר') && webtopOff.includes('אי אפשר לשלוט'), 'Webtop is not read when the home bridge is down')

  const calls = []
  const link = await bridge.connectHome({
    url,
    secret: SECRET,
    handlers: {
      status: () => '{"cpu":1}',
      power: (action) => {
        calls.push(action)
        return `power:${action}`
      },
      typeText: (text) => {
        calls.push(`type:${text}`)
        return 'typed'
      },
      screenshot: () => {
        const file = path.join(os.tmpdir(), `helper-screen-${Date.now()}.png`)
        fs.writeFileSync(file, Buffer.from('SHOT'))
        return { file, width: 3, height: 4, scale: 1, left: 0, top: 0 }
      },
      readSessionPage: (url) => {
        calls.push(`webtop:${url}`)
        return 'מערכת שעות'
      },
      sessionKeepAlive: () => {
        const err = new Error('Webtop לא מחובר.')
        err.hint = 'צריך להיכנס שוב בחלון ה-Webtop.'
        throw err
      },
    },
  })
  ok(bridge.bridgeConnected(), 'the home bridge shows as connected')
  ok((await tool('pc_status').run()) === '{"cpu":1}', 'pc_status runs on the bridge and the answer comes back')

  ok((await session.readSessionPage('https://school.example/home')) === 'מערכת שעות', 'Webtop is read on the home PC through the bridge')
  ok(calls.includes('webtop:https://school.example/home'), 'the Webtop address is sent to the home window')
  let hinted = null
  try {
    await session.sessionKeepAlive()
  } catch (e) {
    hinted = e
  }
  ok(hinted?.message.includes('Webtop לא מחובר') && hinted?.hint.includes('חלון ה-Webtop'), 'a Webtop failure keeps its hint across the bridge')

  const shot = await pc.screenshot(100)
  ok(shot.width === 3 && shot.height === 4 && fs.readFileSync(shot.file).toString() === 'SHOT', 'a screenshot is taken on the home side and returned as a file')
  fs.rmSync(shot.file, { force: true })

  const denied = await tool('pc_power').run({ action: 'shutdown', minutes: 0 }, { confirm: async () => false })
  ok(denied.includes('לא אישר'), 'COMPUTER_MODE=ask tells the model the user refused')
  ok(!calls.includes('shutdown'), 'a refused shutdown is not sent to the PC')

  const allowed = await tool('pc_power').run({ action: 'shutdown', minutes: 0 }, { confirm: async () => true })
  ok(allowed === 'power:shutdown' && calls.includes('shutdown'), 'an approved shutdown is routed to the PC')

  {
    const { runTurn } = await import('./agent.js')
    config.llm.apiKey = 'test-key'
    config.llm.model = 'fake-model'
    config.llm.baseUrl = 'http://fake.invalid'
    config.llm.fallbackModels = []
    config.llm.cheapModel = ''
    config.llm.backup = { apiKey: '', model: '' }
    config.llm.light = false
    const realFetch = globalThis.fetch
    const seen = []
    let script = []
    globalThis.fetch = async (fetchUrl, init) => {
      if (!String(fetchUrl).startsWith('http://fake.invalid')) return realFetch(fetchUrl, init)
      const body = JSON.parse(init.body)
      seen.push(body.messages.filter((m) => m.role === 'tool').map((m) => m.content))
      return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() }] }) }
    }
    const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    script = [
      { role: 'assistant', content: '', tool_calls: [call('pc_type', { text: 'hello' }, '1')] },
      { role: 'assistant', content: 'לא הוקלד' },
    ]
    const before = calls.length
    await runTurn('תקליד hello', { confirm: async () => false })
    ok(calls.length === before, 'CONFIRM_ALWAYS refusal does not reach the PC')
    ok(seen.some((batch) => batch.some((x) => String(x).includes('לא אישר'))), 'the model is told the typing was refused')

    script = [
      { role: 'assistant', content: '', tool_calls: [call('pc_type', { text: 'hello' }, '2')] },
      { role: 'assistant', content: 'הוקלד' },
    ]
    await runTurn('תקליד hello', { confirm: async () => true })
    ok(calls.includes('type:hello'), 'approved typing is routed to the PC')
    globalThis.fetch = realFetch
  }

  link.close()
  await new Promise((r) => setTimeout(r, 50))
  config.wake.mac = '74563CE517D9'
  let woke = ''
  try {
    await tool('pc_status').run()
  } catch (e) {
    woke = e.message
  }
  ok(woke.includes('לא מחובר') && woke.includes('תדליק את המחשב') && woke.includes('Wake-on-LAN'), 'when the PC drops off, the answer names Wake-on-LAN')
  ok(!bridge.bridgeConnected(), 'the bridge is marked disconnected after the socket closes')
} finally {
  await bridge.stopPcBridgeServer()
}

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
