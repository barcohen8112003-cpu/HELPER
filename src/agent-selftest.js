// node src/agent-selftest.js: the agent layer (src/planner.js and the loop in src/agent.js) with a scripted model,
// offline. A goal gets a plan, the plan is shown once, the turn is checked against "done" before it answers, the
// check never reaches the history, an open plan is kept for "תמשיך", and a plan buys more steps than a question.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-agent-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const { looksLikeGoal, normalizePlan, openSteps, planTool, needsVerify, savedPlan, PLAN_TTL } = await import('./planner.js')
const { runTurn, runBackground, resetHistory } = await import('./agent.js')
const { tools } = await import('./tools.js')
const { config } = await import('./config.js')
const { state } = await import('./store.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// ── reading a message as a goal ──────────────────────────────────────────────
for (const t of [
  'תמצא לי אוזניות אלחוטיות עד 300 שקל ותשווה מחירים בין 3 חנויות',
  'תבדוק מה יש לי מחר ביומן ואז תקבע לי תזכורת שעה לפני כל שיעור',
  'תתכנן לי טיול של יומיים בצפון עם מסלול, מקום לינה ומסעדה',
  'research the best budget laptop and compare three of them',
]) ok(looksLikeGoal(t), `goal: ${t}`)
for (const t of ['מה השעה?', 'מה מזג האוויר מחר בחיפה?', 'תודה', 'מי זה איינשטיין', 'לילה טוב']) ok(!looksLikeGoal(t), `not a goal: ${t}`)

// ── the plan itself ──────────────────────────────────────────────────────────
{
  const p = normalizePlan({ goal: 'x'.repeat(500), steps: ['a', { text: 'b', status: 'done' }, { text: '' }, { text: 'c', status: 'weird' }, ...Array(20).fill('d')] })
  ok(p.goal.length === 200, 'goal is clipped')
  ok(p.steps.length === 10, 'at most ten steps, empty ones dropped')
  ok(p.steps[0].status === 'pending' && p.steps[1].status === 'done' && p.steps[2].status === 'pending', 'plain strings and unknown statuses become pending')
  ok(openSteps(p).length === 9, 'open steps counted')
  const ctx = {}
  ok(/ריקה/.test(planTool.run({ goal: 'g', steps: [] }, ctx)) && !ctx.plan, 'an empty plan is refused')
}

// ── a scripted model ─────────────────────────────────────────────────────────
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
  const next = typeof script === 'function' ? script(body) : script.shift()
  return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: next || { role: 'assistant', content: 'סוף' } }] }) }
}
let nextId = 1
const call = (name, args) => ({ id: `c${nextId++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const calls = (...c) => ({ role: 'assistant', content: '', tool_calls: c })
const say = (content) => ({ role: 'assistant', content })
const ran = []
tools.push({ name: 'zz_lookup', description: 'x', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] }, run: ({ q }) => (ran.push(q), `found ${q}`) })
const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content?.find?.((p) => p.type === 'text')?.text || '')
const systemOf = (body) => body.messages[0].content
const lastOf = (body) => textOf(body.messages.at(-1))

const steps3 = (statuses) => ['לחפש בזאפ', 'לבדוק 3 חנויות', 'לסכם עם קישורים'].map((text, i) => ({ text, status: statuses[i] }))

// 1. A goal, worked to the end: plan shown once, checked against "done", and the check is not kept.
{
  resetHistory()
  const shown = []
  requests = []
  script = [
    calls(call('update_plan', { goal: 'אוזניות עד 300', done_when: 'רשימה של 3 חנויות עם מחיר וקישור', steps: steps3(['doing', 'pending', 'pending']) }), call('zz_lookup', { q: 'zap' })),
    calls(call('zz_lookup', { q: 'shops' }), call('update_plan', { goal: 'אוזניות עד 300', steps: steps3(['done', 'done', 'done']) })),
    say('טיוטה'),
    say('הכי זול: 279 ₪ ב-KSP https://ksp.co.il'),
  ]
  const reply = await runTurn('תמצא לי אוזניות עד 300 שקל ותשווה מחירים בין 3 חנויות', { source: 'whatsapp', confirm: async () => true, say: (t) => shown.push(t) })
  ok(/279/.test(reply), 'the answer after the check is the one returned')
  ok(shown.length === 1 && /אוזניות עד 300/.test(shown[0]) && /1\. לחפש בזאפ/.test(shown[0]), 'the plan is sent to him once, as a short card')
  ok(/ההודעה הזאת נראית כמו מטרה/.test(systemOf(requests[0])), 'a goal-like message gets the plan hint')
  ok(/התוכנית שלך למטרה הזאת/.test(systemOf(requests[1])) && /▶ 1\. לחפש בזאפ/.test(systemOf(requests[1])), 'the plan as it stands is in the prompt of the next step')
  ok(/מצב סוכן/.test(systemOf(requests[0])), 'the agent rules are in the prompt')
  ok(/בדיקה עצמית/.test(lastOf(requests[3])) && /רשימה של 3 חנויות/.test(lastOf(requests[3])), 'before answering, the model is asked to check against done_when')
  ok(requests.length === 4, 'one check, one extra call')
  ok(!state.history.some((m) => /בדיקה עצמית/.test(textOf(m)) || m.content === 'טיוטה'), 'neither the draft nor the check is left in the history')
  ok(state.history.at(-1).content === reply && state.history.at(-1).role === 'assistant', 'the history ends with the real answer')
  ok(state.history.filter((m) => m.role === 'tool').length === 4, 'every tool result stays, so the next message can build on them')
  ok(!state.plan, 'a finished plan is not kept')
  ok(ran.join(',') === 'zap,shops', 'the steps really ran')
}

// 2. Stopped with steps open: the check names them, the plan is kept, and the next message sees it.
{
  resetHistory()
  requests = []
  script = [
    calls(call('update_plan', { goal: 'טיול בצפון', done_when: 'מסלול, לינה ומסעדה', steps: steps3(['done', 'pending', 'pending']) })),
    say('טיוטה'),
    say('מצאתי מסלול. לינה ומסעדה עוד פתוחים: צריך תאריך.'),
  ]
  await runTurn('תתכנן לי טיול של יומיים בצפון עם מסלול, מקום לינה ומסעדה', { source: 'whatsapp', confirm: async () => true, say: () => {} })
  ok(/שלבים שעוד פתוחים/.test(lastOf(requests[2])) && /לבדוק 3 חנויות/.test(lastOf(requests[2])), 'the check lists the open steps')
  ok(state.plan && openSteps(state.plan).length === 2, 'an open plan is kept for the next message')
  requests = []
  script = [say('ממשיך')]
  await runTurn('תמשיך', { source: 'whatsapp', confirm: async () => true, say: () => {} })
  ok(/תוכנית פתוחה מקודם/.test(systemOf(requests[0])) && /טיול בצפון/.test(systemOf(requests[0])), '"תמשיך" sees the open plan')
  ok(requests.length === 1, 'a plan picked up but not touched does not trigger a check')
  ok(state.plan, 'and it is still kept')
  state.plan.updatedAt = Date.now() - PLAN_TTL - 1000
  ok(savedPlan() === null && !state.plan, 'after a day it is dropped')
  state.plan = normalizePlan({ goal: 'g', steps: ['a'] })
  resetHistory()
  ok(!state.plan, '"שיחה חדשה" drops the plan too')
}

// 3. A plain question: no plan, no check, no card, the short step limit.
{
  resetHistory()
  requests = []
  const shown = []
  script = [calls(call('zz_lookup', { q: 'weather' })), say('22 מעלות')]
  const reply = await runTurn('מה מזג האוויר מחר בחיפה?', { source: 'whatsapp', confirm: async () => true, say: (t) => shown.push(t) })
  ok(reply === '22 מעלות' && requests.length === 2 && !shown.length, 'a question is answered straight, no extra call')
  ok(!/ההודעה הזאת נראית כמו מטרה/.test(systemOf(requests[0])), 'no plan hint for a question')

  requests = []
  script = () => calls(call('zz_lookup', { q: 'again' }))
  await runTurn('מה מזג האוויר?', { source: 'whatsapp', confirm: async () => true })
  ok(requests.length === 13, `without a plan: 12 steps and a closing answer (${requests.length})`)

  requests = []
  let first = true
  script = () => (first ? ((first = false), calls(call('update_plan', { goal: 'g', steps: steps3(['doing', 'pending', 'pending']) }))) : calls(call('zz_lookup', { q: 'again' })))
  await runTurn('תמצא ותשווה', { source: 'whatsapp', confirm: async () => true })
  ok(requests.length === 25, `with a plan: 24 steps and a closing answer (${requests.length})`)
  ok(/your plan, as it stands/.test(lastOf(requests.at(-1))) && /Say which steps are still open/.test(lastOf(requests.at(-1))), 'out of steps, the closing answer is told what is still open')
  ok(state.plan, 'and the unfinished plan is kept')
  resetHistory()
}

// 4. A background task: progress goes to "מה רץ", nothing is sent mid-way, and it gets the plan hint.
{
  requests = []
  const steps = []
  const shown = []
  script = [
    calls(call('update_plan', { goal: 'סקר מחירים', steps: steps3(['doing', 'pending', 'pending']) })),
    calls(call('update_plan', { goal: 'סקר מחירים', steps: steps3(['done', 'doing', 'pending']) })),
    calls(call('update_plan', { goal: 'סקר מחירים', steps: steps3(['done', 'done', 'done']) })),
    say('נמצא ב-389 ₪'),
  ]
  const reply = await runBackground('סקר', 'סקר מחירים לאוזניות', { source: 'job', confirm: async () => true, say: (t) => shown.push(t), setStep: (s) => steps.push(s) })
  ok(steps.join(' | ') === '0/3 · לחפש בזאפ | 1/3 · לבדוק 3 חנויות | 3/3', `progress lines: ${steps.join(' | ')}`)
  ok(!shown.length, 'a background task does not send the plan card')
  ok(/ההודעה הזאת נראית כמו מטרה/.test(systemOf(requests[0])), 'a background task always gets the plan hint')
  ok(reply === 'נמצא ב-389 ₪' && requests.length === 4, 'all steps closed and no done_when: no extra check')
}

// 5. Light mode: English rules, and a closed plan is not re-checked there (small per-minute budget).
{
  config.llm.light = true
  ok(!needsVerify({ planTouched: true, plan: normalizePlan({ goal: 'g', done_when: 'd', steps: [{ text: 'a', status: 'done' }] }) }), 'light mode skips the check on a closed plan')
  ok(needsVerify({ planTouched: true, plan: normalizePlan({ goal: 'g', steps: ['a'] }) }), 'but still checks a plan with open steps')
  resetHistory()
  requests = []
  script = [say('hi')]
  await runTurn('שלום', { source: 'whatsapp', confirm: async () => true })
  ok(/Agent mode:/.test(systemOf(requests[0])), 'light prompt carries the agent rules in English')
  ok(requests[0].tools.some((t) => t.function.name === 'update_plan' && /goal of several stages/.test(t.function.description)), 'update_plan is offered, briefly described')
  config.llm.light = false
}

// 6. Config: the card can be turned off.
{
  config.agent.showPlan = false
  const shown = []
  const ctx = { source: 'whatsapp', say: (t) => shown.push(t) }
  planTool.run({ goal: 'g', steps: ['a', 'b', 'c'] }, ctx)
  ok(!shown.length, 'AGENT_SHOW_PLAN=off keeps the plan to itself')
  config.agent.showPlan = true
}

globalThis.fetch = realFetch
fs.rmSync(dir, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
process.exit(0)
