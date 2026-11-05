// node src/phone-app-selftest.js
// Offline: no model, no phone. A fake phone connects over a real WebSocket the way the HELPER app does, and a scripted
// "model" drives the phone body. The test checks what reached the phone: committing taps never do without approval,
// secret fields are never typed into, "stop" on the phone ends the run, and a direct shortcut finishes in one step.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-phone-app-'))

const { WebSocket } = await import('ws')
const { state } = await import('./store.js')
const { config } = await import('./config.js')
const phoneMod = await import('./phone.js')
const { activeTools } = await import('./tools.js')
const app = await import('./phone-app.js')
const { runOnPhone } = await import('./computer-use.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

const TOKEN = 'test-token'
const server = http.createServer()
server.on('upgrade', (req, socket, head) => app.handlePhoneUpgrade(req, socket, head, (r) => r.headers.authorization === `Bearer ${TOKEN}`))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `ws://127.0.0.1:${server.address().port}/bridge/phone`

// The phone: answers observe/capture/act like the app, and records everything it was asked to do.
const SCREENS = {
  whatsapp: { pkg: 'com.whatsapp', nodes: [
    { i: 1, role: 'TextView', text: 'אבא', x: 300, y: 120, b: [0, 80, 600, 160] },
    { i: 2, role: 'EditText', hint: 'הודעה', editable: true, focused: true, x: 500, y: 2200, b: [0, 2150, 900, 2250] },
    { i: 3, role: 'ImageButton', desc: 'שלח', clickable: true, x: 1000, y: 2200, b: [950, 2150, 1060, 2250] },
  ] },
  gett: { pkg: 'com.gettaxi.android', nodes: [
    { i: 1, role: 'TextView', text: 'בית', x: 500, y: 600, b: [0, 560, 1080, 640] },
    { i: 2, role: 'Button', text: 'הזמן נסיעה', clickable: true, x: 540, y: 2100, b: [100, 2050, 980, 2150] },
    { i: 3, role: 'TextView', text: 'נסיעות קודמות', clickable: true, x: 540, y: 300, b: [0, 260, 1080, 340] },
  ] },
  login: { pkg: 'com.example.login', nodes: [
    { i: 1, role: 'EditText', hint: 'סיסמה', editable: true, password: true, focused: true, x: 540, y: 900, b: [0, 850, 1080, 950] },
  ] },
  bank: { pkg: 'com.paypal.android.p2pmobile', nodes: [
    { i: 1, role: 'TextView', text: 'יתרה', x: 400, y: 400, b: [0, 360, 800, 440] },
    { i: 2, role: 'EditText', hint: 'סיסמה', editable: true, password: true, focused: true, x: 540, y: 900, b: [0, 850, 1080, 950] },
  ] },
  settings: { pkg: 'com.android.settings', nodes: [
    { i: 1, role: 'Button', text: 'אפשר', clickable: true, x: 800, y: 400, b: [700, 360, 980, 480] },
    { i: 2, role: 'TextView', text: 'Wi-Fi', clickable: true, x: 200, y: 400, b: [0, 360, 400, 480] },
  ] },
  map: { pkg: 'com.waze', nodes: [] },
}
let phone
function connectPhone(screen = 'whatsapp', { stopOnObserve = 0 } = {}) {
  const log = { acts: [], observes: 0, captures: 0, status: [], finish: [], imageAsks: [], widths: [] }
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', device: 'Test S25', perms: { accessibility: true } }))
      phone = { ws, log, screen }
      setTimeout(() => resolve(phone), 50)
    })
    ws.on('message', (data) => {
      const m = JSON.parse(data)
      if (m.op === 'status') return log.status.push(m.text)
      if (m.op === 'finish') return log.finish.push(m.text)
      const reply = (result) => ws.send(JSON.stringify({ id: m.id, ok: true, result }))
      if (m.op === 'observe') {
        log.observes++
        log.imageAsks.push(m.args?.image === true)
        log.widths.push(m.args?.maxWidth ?? null)
        if (stopOnObserve && log.observes === stopOnObserve) ws.send(JSON.stringify({ type: 'stop' }))
        return reply({ ...SCREENS[phone.screen], width: 1080, height: 2400, ...(m.args?.image ? { image: 'aW1n' } : {}) })
      }
      if (m.op === 'capture') return (log.captures++, reply({ image: 'aW1n' }))
      if (m.op === 'act') {
        log.acts.push(m.args)
        return reply({ ok: true, info: m.args.type === 'notifications' ? 'WhatsApp: אבא — איפה אתה?' : m.args.type === 'intent' ? 'השעון המעורר נקבע ל-07:00' : null })
      }
    })
  })
}
const script = (...steps) => {
  let i = 0
  const seen = []
  const think = async (messages) => {
    // Everything the model got since its last reply: block notices, action results and the new screen.
    const since = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1)
    seen.push(since.map((m) => (typeof m.content === 'string' ? m.content : m.content[0].text)).join('\n'))
    const s = steps[i++] ?? { action: { type: 'done', summary: 'בוצע' } }
    return { content: JSON.stringify({ thought: 't', ...s }) }
  }
  think.seen = seen
  return think
}
const settle = () => new Promise((r) => setTimeout(r, 80))
const sendTap = { type: 'tap', index: 3 }
const sendGate = { type: 'gate', kind: 'send', site: 'WhatsApp', items: 'לאבא: "אני בדרך"', then: sendTap }

// 0. A wrong token never gets a socket.
{
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer nope' } })
    ws.on('open', () => resolve(false))
    ws.on('error', () => resolve(true))
  })
  ok(refused, 'a wrong token is refused')
}

await connectPhone()
ok(app.phoneAppConnected() && app.phoneAppInfo().device === 'Test S25', 'the app connects and says hello')
config.phone.mode = 'ask'
config.phone.host = '100.110.143.89'
{
  const names = activeTools().map((t) => t.name)
  const run = activeTools().find((t) => t.name === 'run_on_phone')
  ok(names.includes('run_on_phone') && !names.some((n) => n.startsWith('phone_')), 'a connected app hides every ADB phone_* tool')
  ok(run && run.risk !== 'write', 'run_on_phone does not ask WhatsApp before it starts')
  ok(phoneMod.phoneRoutePrompt(false).includes('run_on_phone') && !phoneMod.phoneRoutePrompt(false).includes('phone_open_app') && !phoneMod.phoneRoutePrompt(false).includes('ניפוי אלחוטי'), 'the prompt with the app connected does not offer ADB')
  const status = await phoneMod.phoneStatus()
  ok(status.connected === false && status.app?.connected && status.app.device === 'Test S25' && status.app.permissions.accessibility === true, 'phone status reports the app link without pretending ADB is up')
  ok(status.line.includes('אפליקציית HELPER מחוברת') && status.line.includes('Test S25'), 'the status line names the connected phone')
}

// 1. "תשלח לאבא שאני בדרך": tapping send straight away is blocked; the gate asks with a screenshot; a no sends nothing.
{
  phone.log.acts.length = 0
  const asked = []
  const think = script(
    { step: 'כותב לאבא', action: { type: 'type', text: 'אני בדרך', index: 2 } },
    { action: sendTap },
    { action: sendGate },
  )
  const out = await runOnPhone('תשלח לאבא בוואטסאפ שאני בדרך', '', { confirm: async (t, media) => (asked.push({ t, media }), false) }, { think })
  ok(phone.log.acts.some((a) => a.type === 'type' && a.text === 'אני בדרך'), 'the message is typed')
  ok(!phone.log.acts.some((a) => a.type === 'tap' && a.index === 3), 'send is never tapped without approval')
  ok(think.seen[2]?.includes('Blocked by the safety check'), 'the model is told the tap was blocked')
  ok(out.startsWith('DENIED') && asked.length === 1 && asked[0].media?.buffer?.length, 'denied, asked once, with a screenshot')
  await settle()
  ok(phone.log.status.includes('כותב לאבא'), 'the bubble shows the step in Hebrew')
}

// 2. Approved: send is tapped exactly once.
{
  phone.log.acts.length = 0
  const think = script({ action: sendGate }, { action: { type: 'done', summary: 'נשלח לאבא' } })
  const out = await runOnPhone('תשלח לאבא שאני בדרך', '', { confirm: async () => true }, { think })
  ok(phone.log.acts.filter((a) => a.type === 'tap' && a.index === 3).length === 1 && out.startsWith('DONE'), 'an approved send runs once')
  await settle()
  ok(phone.log.finish.at(-1) === 'נשלח לאבא', 'the bubble shows the result at the end')
}

// 3. Gett: "הזמן נסיעה" is a commit on a phone; a list row about past rides is not.
{
  phone.screen = 'gett'
  phone.log.acts.length = 0
  const think = script({ action: { type: 'tap', index: 3 } }, { action: { type: 'key', keys: 'back' } }, { action: { type: 'tap', index: 2 } })
  await runOnPhone('תזמין לי מונית הביתה', '', {}, { think })
  ok(phone.log.acts.some((a) => a.index === 3), 'an ordinary row is tapped')
  ok(!phone.log.acts.some((a) => a.index === 2), 'the order button is not tapped without approval')
  ok(think.seen[3]?.includes('הזמן נסיעה'), 'the model is told which control was blocked')
}

// 4. A password field: nothing typed, the user is asked.
{
  phone.screen = 'login'
  phone.log.acts.length = 0
  const out = await runOnPhone('תיכנס לבנק', '', {}, { think: script({ action: { type: 'type', text: 'hunter2' } }) })
  ok(out.startsWith('NEED_USER') && !phone.log.acts.length, 'no typing into a password field')
}

// 5. "Stop" on the phone ends the run.
{
  phone.ws.close()
  await new Promise((r) => setTimeout(r, 50))
  await connectPhone('whatsapp', { stopOnObserve: 2 })
  const think = async () => ({ content: JSON.stringify({ action: { type: 'scroll', direction: 'down' } }) })
  const out = await runOnPhone('משהו ארוך', '', {}, { think })
  ok(out.startsWith('STOPPED'), 'stop in the bubble ends the run')
  await settle()
  ok(phone.log.finish.includes('נעצר'), 'and the bubble says so')
}

// 6. "תדליק שעון מעורר ל-7": one shortcut, its result reaches the model, then done.
{
  phone.log.acts.length = 0
  let approvals = 0
  const think = script({ action: { type: 'intent', kind: 'alarm', hour: 7, minute: 0 } }, { action: { type: 'done', summary: 'שעון מעורר ל-07:00' } })
  const out = await runOnPhone('תדליק שעון מעורר ל-7', '', { confirm: async () => { approvals++; return false } }, { think })
  ok(phone.log.acts.length === 1 && phone.log.acts[0].kind === 'alarm' && phone.log.acts[0].hour === 7 && phone.log.acts[0].minute === 0, 'the alarm goes through one intent with the hour')
  ok(approvals === 0 && out.startsWith('DONE'), 'setting an alarm does not ask for WhatsApp approval')
}

// 6b. Opening an app and reading the screen are the same: no approval.
{
  phone.log.acts.length = 0
  let approvals = 0
  const think = script({ action: { type: 'open_app', name: 'שעון' } }, { action: { type: 'notifications' } }, { action: { type: 'done', summary: 'נפתח' } })
  const out = await runOnPhone('תפתח את השעון ותקרא את המסך', '', { confirm: async () => { approvals++; return false } }, { think })
  ok(approvals === 0 && phone.log.acts.some((a) => a.type === 'open_app') && phone.log.acts.some((a) => a.type === 'notifications') && out.startsWith('DONE'), 'opening an app and reading notifications does not ask')
}

// 7. Notifications come back as text for the model.
{
  const think = script({ action: { type: 'notifications' } })
  await runOnPhone('מה ההתראות שלי', '', {}, { think })
  ok(think.seen[1]?.includes('WhatsApp: אבא — איפה אתה?') || false, 'notification text reaches the model')
}

// 8. A screen with no readable elements comes with a screenshot; the same screen 3 steps running is called out.
{
  phone.screen = 'map'
  phone.log.captures = 0
  const steps = Array(5).fill({ action: { type: 'swipe', direction: 'up' } })
  const think = script(...steps)
  await runOnPhone('תזיז את המפה', '', {}, { think })
  ok(phone.log.captures >= 1, 'an empty screen list brings a screenshot')
  ok(think.seen.some((s) => s.includes('has not changed for 3 steps')), 'a stuck screen is called out')
}

// 9. What the model learns about an app is kept, and shown the next time that app is on screen.
{
  phone.screen = 'gett'
  await runOnPhone('תזמין מונית', '', {}, { think: script({ learned: 'Gett: היעד נבחר מהרשימה "בית" באמצע המסך', action: { type: 'wait', amount: 1 } }) })
  ok(state.phoneAppNotes['com.gettaxi.android']?.length === 1, 'a learned note is saved for the app')
  const think = script()
  await runOnPhone('תזמין מונית', '', {}, { think })
  ok(think.seen[0].includes('What you learned about this app before') && think.seen[0].includes('בית'), 'and shown on the next run')
}

// 10. The list the model reads.
{
  const text = app.formatNodes(SCREENS.whatsapp.nodes)
  ok(text.includes('[3] ImageButton desc:"שלח" {tap} @1000,2200'), 'a node line has its number, label, flags and centre')
  ok(app.nodeFor(SCREENS.gett.nodes, { x: 540, y: 2100 })?.i === 2, 'a point maps to the element under it')
}

// 11. The vision agent is off unless the flag says so, and payment apps are recognised without a model.
{
  ok(!app.phoneVisionOn() && config.phone.vision === 'off', 'PHONE_VISION_AGENT defaults to off')
  ok(app.phoneVisionModel() === 'google/gemini-2.5-flash', 'the default vision model is the cheap one')
  ok(app.phoneAgentMaxSteps() === 40 && app.phoneAgentTimeoutMs() === 480000, 'the tree loop keeps 40 steps and an 8 minute limit')
  ok(!app.isPaymentApp('com.waze') && !app.isPaymentApp('com.whatsapp') && !app.isPaymentApp('com.android.bluetooth') && !app.isPaymentApp('com.google.android.calendar') && !app.isPaymentApp('בית'), 'ordinary apps are not payment apps')
  ok(app.isPaymentApp('com.paypal.android.p2pmobile') && app.isPaymentApp('ביט') && app.isPaymentApp('com.example.bank') && app.isPaymentApp('com.google.android.apps.walletnfcrel') && app.isPaymentApp('com.discount'), 'banks and wallets are payment apps')
  ok(app.isSettingsChange({ type: 'device', setting: 'volume', value: '10' }) && app.isSettingsChange({ type: 'intent', kind: 'settings' }) && !app.isSettingsChange({ type: 'intent', kind: 'alarm' }), 'volume and the settings panel are setting changes; an alarm is not')
  ok(phone.log.imageAsks.length > 0 && phone.log.imageAsks.every((v) => v === false), 'with the flag off, a readable screen is not photographed every step')
}

// 12. A bank that is already on screen is not read or touched without an explicit yes.
{
  phone.screen = 'bank'
  phone.log.acts.length = 0
  const asked = []
  let thoughts = 0
  const out = await runOnPhone('מה היתרה', '', { confirm: async (t, media) => (asked.push({ t, media }), false) }, { think: async () => (thoughts++, { content: JSON.stringify({ action: { type: 'tap', index: 1 } }) }) })
  ok(out.startsWith('DENIED') && thoughts === 0 && phone.log.acts.length === 0, 'a payment app is refused before the model acts')
  ok(asked.length === 1 && /בנק או תשלום/.test(asked[0].t) && asked[0].media?.buffer?.length, 'the question names the app and carries a screenshot')
  await settle()
  ok(phone.log.finish.at(-1)?.includes('לא אושר'), 'the bubble says it stopped')
}

// 13. After that yes, a harmless tap runs, and a password still is not typed.
{
  phone.screen = 'bank'
  phone.log.acts.length = 0
  const think = script({ action: { type: 'tap', index: 1 } }, { action: { type: 'type', text: 'hunter2', index: 2 } })
  const out = await runOnPhone('תיכנס לפייפאל', '', { confirm: async () => true }, { think })
  ok(phone.log.acts.some((a) => a.type === 'tap' && a.index === 1), 'an approved payment app can be tapped')
  ok(!phone.log.acts.some((a) => a.type === 'type') && out.startsWith('NEED_USER'), 'a password in that app is still not typed')
}

// 14. Opening ביט from another app asks, and a no opens nothing.
{
  phone.screen = 'whatsapp'
  phone.log.acts.length = 0
  const asked = []
  const out = await runOnPhone('תפתח ביט', '', { confirm: async (t) => (asked.push(t), false) }, { think: script({ action: { type: 'open_app', name: 'ביט' } }) })
  ok(out.startsWith('DENIED') && !phone.log.acts.length && asked.some((t) => t.includes('ביט')), 'opening a payment app needs its own yes')
}

// 15. A setting is not changed until a gate of kind account is approved. Navigating the list is fine.
{
  phone.screen = 'settings'
  phone.log.acts.length = 0
  let asks = 0
  const think = script(
    { action: { type: 'device', setting: 'volume', value: '10' } },
    { action: { type: 'tap', index: 1 } },
    { action: { type: 'tap', index: 2 } },
    { action: { type: 'gate', kind: 'account', site: 'טלפון', items: 'עוצמת שמע ל-10', then: { type: 'device', setting: 'volume', value: '10' } } },
  )
  const out = await runOnPhone('תנמיך את הווליום', '', { confirm: async () => (++asks, asks === 1) }, { think })
  ok(phone.log.acts.filter((a) => a.type === 'device').length === 1, 'volume changes only after the gate')
  ok(!phone.log.acts.some((a) => a.type === 'tap' && a.index === 1), 'Allow is not tapped without a gate')
  ok(phone.log.acts.some((a) => a.type === 'tap' && a.index === 2), 'a settings row that does not change anything is tapped')
  ok(out.startsWith('DONE') && asks === 1, 'one approval covers that one settings change')
}

// 16. Vision mode: every step is a small screenshot, progress goes out, and the run ends with a picture.
{
  config.phone.vision = 'on'
  config.phone.visionWidth = 480
  phone.screen = 'whatsapp'
  phone.log.imageAsks.length = 0
  phone.log.widths.length = 0
  phone.log.acts.length = 0
  const said = []
  const media = []
  let sawImage = false
  let turns = 0
  const think = async (messages) => {
    const last = messages.at(-1)
    const parts = Array.isArray(last.content) ? last.content : []
    if (parts.some((p) => p.type === 'image_url')) sawImage = true
    turns++
    if (turns === 1) return { content: JSON.stringify({ thought: 't', step: 'פותח ווייז', action: { type: 'open_app', name: 'ווייז' } }) }
    return { content: JSON.stringify({ thought: 't', action: { type: 'done', summary: 'ווייז נפתח' } }) }
  }
  const out = await runOnPhone('תפתח ווייז ותנווט הביתה', '', { say: (t) => said.push(t), sendMedia: (m) => media.push(m), confirm: async () => false }, { think })
  ok(app.phoneAgentMaxSteps() === 16, 'vision mode caps a run at 16 steps unless configured')
  ok(phone.log.imageAsks.length >= 2 && phone.log.imageAsks.every(Boolean), 'every vision step asks for a screenshot')
  ok(phone.log.widths.every((w) => w === 480), 'those screenshots are requested downscaled')
  ok(sawImage, 'the planner receives the picture')
  ok(said.includes('פותח ווייז'), 'a short progress line is sent')
  ok(phone.log.acts.some((a) => a.type === 'open_app' && a.name === 'ווייז'), 'Waze is opened without an extra approval')
  ok(media.some((m) => m.buffer?.length && m.caption === 'ווייז נפתח') && out.startsWith('DONE'), 'the final screenshot goes out with the summary')
  config.phone.vision = 'off'
}

// 17. The step cap and the timeout both stop a run that does not finish.
{
  config.phone.agentMaxSteps = 2
  phone.screen = 'whatsapp'
  phone.log.acts.length = 0
  const capped = await runOnPhone('משהו ארוך', '', {}, { think: script({ action: { type: 'swipe', direction: 'up' } }, { action: { type: 'swipe', direction: 'up' } }, { action: { type: 'done', summary: 'לא' } }) })
  ok(capped.startsWith('FAIL') && capped.includes('2') && phone.log.acts.length === 2, 'the step cap stops the run')
  config.phone.agentMaxSteps = ''
  config.phone.agentTimeoutSec = 0.05
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 120))
    return { content: JSON.stringify({ thought: 't', action: { type: 'swipe', direction: 'up' } }) }
  }
  const timed = await runOnPhone('עוד משהו', '', {}, { think: slow })
  ok(timed.startsWith('FAIL') && timed.includes('זמן'), 'the timeout stops the run')
  await settle()
  ok(phone.log.finish.includes('נגמר הזמן'), 'and the bubble says the time ran out')
  config.phone.agentTimeoutSec = '180'
}

// 18. "עצור" from the chat aborts the run the same way the bubble does.
{
  const ac = new AbortController()
  let threw = false
  const think = async () => (ac.abort(), { content: JSON.stringify({ action: { type: 'swipe', direction: 'up' } }) })
  try {
    await runOnPhone('תעצור', '', { signal: ac.signal }, { think })
  } catch (e) {
    threw = e.name === 'Aborted'
  }
  ok(threw, 'עצור aborts the phone run')
}

phone.ws.close()
await new Promise((r) => setTimeout(r, 50))
ok(!app.phoneAppConnected(), 'a closed app is no longer connected')
ok(activeTools().some((t) => t.name === 'phone_open_app') && !activeTools().some((t) => t.name === 'run_on_phone'), 'ADB tools return once the app disconnects')
ok(phoneMod.phoneRoutePrompt(false).includes('phone_open_app') && phoneMod.phoneRoutePrompt(false).includes('5555'), 'and the prompt goes back to ADB')
config.phone.mode = 'off'
config.phone.host = ''
ok(phoneMod.phoneRoutePrompt(false).includes('HELPER: שליטה בטלפון') && phoneMod.phoneRoutePrompt(false).includes('אל תציע ניפוי אלחוטי') && !phoneMod.phoneRoutePrompt(false).includes('5555'), 'with neither link, ask him to open the app and its accessibility service')
server.close()
console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
