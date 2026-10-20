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
  login: { pkg: 'com.example.bank', nodes: [
    { i: 1, role: 'EditText', hint: 'סיסמה', editable: true, password: true, focused: true, x: 540, y: 900, b: [0, 850, 1080, 950] },
  ] },
  map: { pkg: 'com.waze', nodes: [] },
}
let phone
function connectPhone(screen = 'whatsapp', { stopOnObserve = 0 } = {}) {
  const log = { acts: [], observes: 0, captures: 0, status: [], finish: [] }
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
        if (stopOnObserve && log.observes === stopOnObserve) ws.send(JSON.stringify({ type: 'stop' }))
        return reply({ ...SCREENS[phone.screen], width: 1080, height: 2400, ...(m.args.image ? { image: 'aW1n' } : {}) })
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
  const think = script({ action: { type: 'intent', kind: 'alarm', hour: 7, minute: 0 } }, { action: { type: 'done', summary: 'שעון מעורר ל-07:00' } })
  const out = await runOnPhone('תדליק שעון מעורר ל-7', '', {}, { think })
  ok(phone.log.acts.length === 1 && phone.log.acts[0].kind === 'alarm', 'the alarm goes through one intent')
  ok(out.startsWith('DONE'), 'and the run ends DONE')
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

phone.ws.close()
await new Promise((r) => setTimeout(r, 50))
ok(!app.phoneAppConnected(), 'a closed app is no longer connected')
server.close()
console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
