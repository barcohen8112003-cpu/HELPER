// node src/proactive-selftest.js: Helper's initiative (src/proactive.js) offline, with a scripted model.
// The notebook of open loops, coming back to one when its time comes, the rules in the prompt, a concrete offer
// surviving the style pass, and the limits that keep it from spamming: quiet hours, mid-conversation, a gap
// between its own messages, a daily cap, and backing off when he does not answer.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-proactive-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const P = await import('./proactive.js')
const { runTurn, resetHistory } = await import('./agent.js')
const { tools } = await import('./tools.js')
const { config } = await import('./config.js')
const { state } = await import('./store.js')
const { polish } = await import('./style.js')
const { _test: sched } = await import('./scheduler.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const H = 3600000
const reset = () => {
  state.loops = []
  state.proactive = undefined
}

// ── the notebook ─────────────────────────────────────────────────────────────
{
  reset()
  const now = Date.now()
  const a = P.addLoop('לשלוח למורה לכימיה את העבודה', { when: new Date(now + 2 * H).toISOString(), now })
  ok(a.fresh && a.loop.id && a.loop.followUp, 'a loop is added with a time to come back')
  const b = P.addLoop('  לשלוח למורה לכימיה את  העבודה ', { now })
  ok(!b.fresh && state.loops.length === 1, 'the same thing twice is one loop')
  ok(P.dueLoops(now).length === 0 && P.dueLoops(now + 3 * H).length === 1, 'due only once its time has come')
  let threw = false
  try {
    P.addLoop('x', { when: 'not a date' })
  } catch {
    threw = true
  }
  ok(threw, 'a bad time is refused')
  ok(P.closeLoop('כימיה').length === 1 && !state.loops.length, 'closed by a word from it')
  P.addLoop('ישן', { now: now - P.LOOP_TTL - 1000 })
  ok(P.openLoops(now).length === 0, 'a loop nobody touched for two weeks is let go')
  for (let i = 0; i < P.MAX_LOOPS; i++) P.addLoop(`דבר ${i}`, { now })
  threw = false
  try {
    P.addLoop('עוד אחד', { now })
  } catch (e) {
    threw = /פתוחים/.test(e.message)
  }
  ok(threw, `at most ${P.MAX_LOOPS} open loops`)
  reset()
}

// ── the tool ─────────────────────────────────────────────────────────────────
{
  reset()
  ok(/נרשם/.test(P.loopTool.run({ action: 'add', text: 'לחכות לתשובה מדנה על הפרויקט', follow_up_when: '2099-01-01T18:00' })), 'open_loop add')
  ok(/דנה/.test(P.loopTool.run({ action: 'list' })), 'open_loop list')
  ok(/נסגר/.test(P.loopTool.run({ action: 'close', text: String(state.loops[0].id) })) && !state.loops.length, 'open_loop close by id')
  ok(/אין/.test(P.loopTool.run({ action: 'list' })), 'empty list says so')
  ok(!P.loopTool.risk, 'the notebook is Helper\'s own state: no approval needed')
  ok(tools.some((t) => t.name === 'open_loop'), 'open_loop is a core tool')
}

// ── pacing ───────────────────────────────────────────────────────────────────
{
  reset()
  const t = Date.now()
  P.noteUserMessage(t)
  ok(!P.mayReachOut(t + 5 * 60000), 'not while he is mid-conversation')
  ok(P.mayReachOut(t + P.ACTIVE_GAP + 1000), 'fine once he has been quiet a while')
  P.markReachedOut(t + P.ACTIVE_GAP + 1000)
  ok(!P.mayReachOut(t + P.ACTIVE_GAP + 30 * 60000), 'not twice within the hour')
  P.markReachedOut(t + 3 * H)
  ok(!P.mayReachOut(t + 10 * H), `after ${P.MAX_UNANSWERED} unanswered messages it waits for him`)
  P.noteUserMessage(t + 10 * H)
  ok(P.mayReachOut(t + 11 * H), 'his answer resets the back-off')
}

// ── taking a due loop ────────────────────────────────────────────────────────
{
  reset()
  const t = Date.now()
  config.proactive.followUpsPerDay = 3
  const { loop } = P.addLoop('לבדוק אם הגיע הציון במתמטיקה', { when: new Date(t - 1000).toISOString(), now: t - 2000 })
  const first = P.takeDueLoop(t)
  ok(first?.id === loop.id && loop.nudges === 1 && Date.parse(loop.followUp) > t + 20 * H, 'taken once, and the next try is a day later')
  ok(P.takeDueLoop(t) === null, 'not taken again right away')
  state.proactive.lastOutAt = 0
  const second = P.takeDueLoop(t + 25 * H)
  ok(second?.id === loop.id && loop.nudges === 2 && loop.followUp === null, `the last of ${P.MAX_NUDGES} tries`)
  ok(P.takeDueLoop(t + 60 * H) === null, 'never more than that')
  ok(/הפעם האחרונה/.test(P.followUpPrompt(loop)) && /SKIP/.test(P.followUpPrompt(loop)), 'the last try says so, and settled loops are skipped')

  reset()
  config.proactive.followUpsPerDay = 1
  P.addLoop('א', { when: new Date(t - 1000).toISOString(), now: t - 2000 })
  P.addLoop('ב', { when: new Date(t - 1000).toISOString(), now: t - 2000 })
  ok(P.takeDueLoop(t) && P.takeDueLoop(t + 2 * H) === null, 'FOLLOW_UPS_PER_DAY caps the day')
  config.proactive.followUpsPerDay = 0
  reset()
  P.addLoop('ג', { when: new Date(t - 1000).toISOString(), now: t - 2000 })
  ok(P.takeDueLoop(t) === null, 'FOLLOW_UPS_PER_DAY=0 turns it off')
  config.proactive.followUpsPerDay = 3
}

// ── the scheduler jobs ───────────────────────────────────────────────────────
{
  const quiet = config.quiet
  config.quiet = null
  reset()
  const sent = []
  const notify = async (text, urgent, key) => sent.push({ text, key })
  P.addLoop('להחזיר את הספר לספרייה', { when: new Date(Date.now() - 1000).toISOString(), now: Date.now() - 2000 })
  let asked = ''
  await sched.followUps(notify, async (instruction) => ((asked = instruction), 'הספר לספרייה עוד אצלך 📚 רוצה שאזכיר לך מחר בבוקר?'))
  ok(/להחזיר את הספר/.test(asked) && sent.length === 1 && /^loop:/.test(sent[0].key), 'a due loop is brought back, once, with a key')
  ok(state.proactive.unanswered === 1, 'and it counts as a message he has not answered yet')

  reset()
  sent.length = 0
  P.addLoop('משהו שכבר נסגר', { when: new Date(Date.now() - 1000).toISOString(), now: Date.now() - 2000 })
  await sched.followUps(notify, async () => '')
  ok(!sent.length && !state.proactive.unanswered, 'a settled loop (SKIP) sends nothing')

  reset()
  sent.length = 0
  P.addLoop('בשעות השקט', { when: new Date(Date.now() - 1000).toISOString(), now: Date.now() - 2000 })
  const h = new Date().getHours()
  config.quiet = { from: h * 60, to: ((h + 2) % 24) * 60 }
  let ran = false
  await sched.followUps(notify, async () => ((ran = true), 'x'))
  ok(!ran && !sent.length, 'nothing in quiet hours')
  config.quiet = null

  reset()
  sent.length = 0
  P.noteUserMessage()
  ran = false
  P.addLoop('באמצע שיחה', { when: new Date(Date.now() - 1000).toISOString(), now: Date.now() - 2000 })
  await sched.followUps(notify, async () => ((ran = true), 'x'))
  ok(!ran, 'nothing while he is mid-conversation')

  // A check-in starts from what is open.
  reset()
  sent.length = 0
  config.proactive.maxPerDay = 2
  config.proactive.everyMinutes = 0
  state.checkIn = { date: new Date().toDateString(), count: 0, lastAt: 1 }
  P.addLoop('לקבוע תור לרופא שיניים', { now: Date.now() })
  state.plan = { goal: 'טיול בצפון', steps: [{ text: 'לינה', status: 'pending' }], updatedAt: Date.now() }
  asked = ''
  await sched.checkIn(notify, async (instruction) => ((asked = instruction), 'מה עם התור לרופא שיניים? רוצה שאחפש תור פנוי השבוע?'))
  ok(/רופא שיניים/.test(asked) && /טיול בצפון/.test(asked), 'the check-in is told what is open')
  ok(sent.length === 1 && state.proactive.unanswered === 1, 'and sends one message')
  state.checkIn.lastAt = 1
  ran = false
  await sched.checkIn(notify, async () => ((ran = true), 'x'))
  ok(!ran, 'a second one within the hour is held back')
  delete state.plan
  config.quiet = quiet
}

// ── in the conversation ─────────────────────────────────────────────────────
config.llm.apiKey = 'test-key'
config.llm.model = 'fake-model'
config.llm.fallbackModels = []
config.llm.cheapModel = ''
config.llm.baseUrl = 'http://fake.invalid'
config.llm.backup = { apiKey: '', model: '' }
config.llm.light = false
config.memoryLearn = false
let script = []
let requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
  const body = JSON.parse(init.body)
  requests.push(body)
  const next = script.shift()
  return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: next || { role: 'assistant', content: 'סוף' } }] }) }
}
let id = 1
const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${id++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const say = (content) => ({ role: 'assistant', content })
const systemOf = (body) => body.messages[0].content

{
  reset()
  resetHistory()
  state.proactive = { lastUserAt: 0, unanswered: 2, lastOutAt: 0 }
  requests = []
  script = [call('open_loop', { action: 'add', text: 'לשלוח לדנה את המצגת', follow_up_when: '2099-01-01T19:00' }), say('רשמתי, אחזור לזה בערב 👍')]
  const reply = await runTurn('אני אשלח לדנה את המצגת אחר כך, עכשיו אין לי כוח', { source: 'whatsapp', confirm: async () => true })
  ok(/יוזמה:/.test(systemOf(requests[0])) && /רוצה ש/.test(systemOf(requests[0])), 'the initiative rules are in the prompt')
  ok(state.loops.length === 1 && /דנה/.test(state.loops[0].text), 'what he left for later is noted')
  ok(/רשמתי/.test(reply), 'and he is told in a few words')
  ok(state.proactive.unanswered === 0 && Date.now() - state.proactive.lastUserAt < 5000, 'his message resets the back-off')

  requests = []
  script = [call('open_loop', { action: 'close', text: 'דנה' }), say('סגרתי 🔥')]
  await runTurn('שלחתי לדנה את המצגת', { source: 'whatsapp', confirm: async () => true })
  ok(/דברים פתוחים שלו/.test(systemOf(requests[0])) && /לשלוח לדנה את המצגת/.test(systemOf(requests[0])), 'open loops are in the prompt, so a message that settles one can close it')
  ok(!state.loops.length, 'and it is closed')

  config.llm.light = true
  requests = []
  script = [say('hi')]
  await runTurn('היי', { source: 'whatsapp', confirm: async () => true })
  ok(/Proactive:/.test(systemOf(requests[0])), 'light prompt carries the rules in English')
  ok(requests[0].tools.some((t) => t.function.name === 'open_loop' && /Notebook/.test(t.function.description)), 'open_loop is offered, briefly described')
  config.llm.light = false
  resetHistory()
}

// ── the offer survives the style pass; a generic closer does not ────────────
ok(polish("ההגשה בכימיה ביום ה' ב-23:59 📚\nרוצה שאזכיר לך ברביעי בערב?").includes('רוצה שאזכיר לך'), 'a concrete offer is kept')
ok(!polish("ההגשה בכימיה ביום ה' ב-23:59 📚\nעוד משהו?").includes('עוד משהו'), 'a generic closer is still stripped')

globalThis.fetch = realFetch
fs.rmSync(dir, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
process.exit(0)
