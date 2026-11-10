// node src/continuity-selftest.js: what a short follow-up still has in reach after the history is folded, offline.
// Folding keeps his last messages word for word however many tool messages they brought, never leaves a tool
// result without its call, the summarizer is told what a follow-up leans on, and a short follow-up looks memory up
// by what the conversation is about. This checks context and contract only, never how a real model answers.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-continuity-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const { runTurn, runBackground, noteBackground, compact, resetHistory, runIsolated, _test } = await import('./agent.js')
const { planTool, isFinished, savedPlan, keepPlan, clearPlan, planBlock, PLAN_TTL } = await import('./planner.js')
const { startJob, stopJobs } = await import('./jobs.js')
const { tools } = await import('./tools.js')
const { config } = await import('./config.js')
const { state } = await import('./store.js')
const { foldPlan, clipMiddle, KEEP_TURNS, KEEP_RECENT } = _test

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

const user = (content) => ({ role: 'user', content })
const answer = (content) => ({ role: 'assistant', content })
let id = 0
// One turn that used `n` tools: his message, the call, the results, the answer.
const toolTurn = (say, n, reply) => {
  const calls = Array.from({ length: n }, () => ({ id: `c${++id}`, type: 'function', function: { name: 'web_search', arguments: '{}' } }))
  return [user(say), { role: 'assistant', content: '', tool_calls: calls }, ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: `result ${c.id}` })), answer(reply)]
}
const chat = (pairs) => Array.from({ length: pairs }, (_, i) => [user(`הודעה ${i}`), answer(`תשובה ${i}`)]).flat()
const apply = (history, plan) => history.filter((m, i) => i >= plan.cut && !plan.thin.includes(i))
// Every tool result follows the call that asked for it, and every call has all its results.
function valid(history) {
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role === 'tool') {
      const owner = history.slice(0, i).findLast((x) => x.role === 'assistant' && x.tool_calls?.length)
      if (!owner?.tool_calls.some((c) => c.id === m.tool_call_id)) return false
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set(history.filter((x) => x.role === 'tool').map((x) => x.tool_call_id))
      if (!m.tool_calls.every((c) => ids.has(c.id))) return false
    }
  }
  return history[0]?.role === 'user'
}

// ── where to fold ────────────────────────────────────────────────────────────
{
  const plain = chat(30)
  const plan = foldPlan(plain)
  ok(plan.cut === plain.length - KEEP_RECENT && !plan.thin.length, 'a plain chat folds exactly where it did before')

  // A correction one message back, then a turn heavy with tools: the old rule kept only the last turn.
  const history = [...chat(10), user('המצגת בעברית, לא לשנות את הגרפים'), answer('סגור, רק טקסט'), ...toolTurn('בעצם הכותרת יותר פשוטה', KEEP_RECENT + 2, 'מפשט')]
  const p = foldPlan(history)
  const kept = apply(history, p)
  const texts = kept.map((m) => m.content)
  ok(texts.includes('המצגת בעברית, לא לשנות את הגרפים') && texts.includes('סגור, רק טקסט'), 'the message before a tool-heavy turn stays word for word')
  ok(kept.filter((m) => m.role === 'user').length === Math.min(KEEP_TURNS, history.filter((m) => m.role === 'user').length), `his last ${KEEP_TURNS} messages stay`)
  ok(kept.filter((m) => m.role === 'tool').length === KEEP_RECENT + 2, 'the newest turn keeps all its tool results')
  ok(valid(kept), 'the kept history is valid for the API')

  // Two tool-heavy turns in a row: the older one keeps his message and the answer, not half of its tool traffic.
  const two = [...chat(10), ...toolTurn('תמצא שתי מסעדות, בלי להזמין', 4, 'טרטוריה כרמל או בית הסלט'), ...toolTurn('הראשונה נשמעת טוב', 4, 'טרטוריה כרמל')]
  const p2 = foldPlan(two)
  const kept2 = apply(two, p2)
  ok(kept2.some((m) => m.content === 'תמצא שתי מסעדות, בלי להזמין') && kept2.some((m) => m.content === 'טרטוריה כרמל או בית הסלט'), 'an older tool-heavy turn keeps his message and its answer')
  ok(valid(kept2), 'no tool result is left without its call')
  ok(kept2.length <= Math.max(KEEP_RECENT, two.length - foldPlanOld(two)) + 2 * KEEP_TURNS, 'the kept part stays about as big as before')

  // A single giant turn with no message of his in the last KEEP_RECENT: the old rule folded nothing at all.
  const giant = [...chat(10), ...toolTurn('תחקור לעומק', KEEP_RECENT * 2, 'הנה')]
  const pg = foldPlan(giant)
  ok(pg.cut > 0 && valid(apply(giant, pg)), 'a long tool turn still lets the chat before it fold')
}

// The old rule, for the size check above: how many messages it kept.
function foldPlanOld(history) {
  let cut = history.length - KEEP_RECENT
  while (cut < history.length && history[cut].role !== 'user') cut++
  return cut
}

// What Helper wrote on its own does not count as a message of his.
{
  const own = (n) => [user(`[משימה מתוזמנת רצה: בדיקה ${n}]`), answer(`תוצאה ${n}`)]
  const history = [...chat(12), user('הכותרת צריכה להיות פשוטה יותר'), answer('סגור'), ...Array.from({ length: KEEP_TURNS + 2 }, (_, n) => own(n)).flat(), user('תמשיך')]
  const kept = apply(history, foldPlan(history))
  ok(kept.some((m) => m.content === 'הכותרת צריכה להיות פשוטה יותר'), 'scheduled results between his messages do not push his messages out')
  ok(valid(kept), 'and the kept history is still valid')
}

// ── the summary ──────────────────────────────────────────────────────────────
{
  const long = `${'א'.repeat(700)} ותזכור: בלי להזמין`
  const clipped = clipMiddle(long, 600)
  ok(clipped.length <= 603 && clipped.endsWith('בלי להזמין'), 'a long message keeps its end when clipped for the summary')
  ok(clipMiddle('קצר', 600) === 'קצר', 'a short message is untouched')
}

// ── a scripted model ─────────────────────────────────────────────────────────
config.llm.apiKey = 'test-key'
config.llm.model = 'fake-model'
config.llm.fallbackModels = []
config.llm.cheapModel = ''
config.llm.baseUrl = 'http://fake.invalid'
config.llm.backup = { apiKey: '', model: '' }
config.memoryLearn = false
const requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
  const body = JSON.parse(init.body)
  requests.push(body)
  const summarizing = !body.tools && /^סיכום קודם:/.test(body.messages[1]?.content || '')
  return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content: summarizing ? 'סיכום' : 'בסדר' } }] }) }
}
const systemOf = (body) => body.messages[0].content

{
  resetHistory()
  state.history = [...chat(30), user('תזכור, בלי להזמין שום דבר'), answer('סגור')]
  requests.length = 0
  ok(await compact(), 'a long history is folded')
  const asked = requests.find((b) => !b.tools)
  ok(/תיקונים/.test(asked.messages[0].content) && /מגבלות/.test(asked.messages[0].content) && /רק התחיל/.test(asked.messages[0].content), 'the summarizer is told to keep corrections, limits and what is only started')
  ok(state.history.some((m) => m.content === 'תזכור, בלי להזמין שום דבר'), 'his last messages are not handed to the summary')
  ok(state.summary === 'סיכום', 'the summary is stored')
}

// ── memory for a short follow-up ─────────────────────────────────────────────
{
  resetHistory()
  const now = Date.now()
  const filler = ['מתאמן בחדר כושר', 'אוהב היפ הופ', 'יש לו חתולה', 'משחק FIFA', 'קורא מנגה', 'אוהב קפה קר', 'לומד גיטרה', 'הצבע האהוב כחול', 'מנוי ספוטיפיי', 'קם בשבע', 'רוכב על אופניים', 'צופה במדע בדיוני', 'חוסך לאוזניות', 'סבתא בקריית ים', 'לא שותה אנרגיה', 'אוהב פיצה עם זיתים', 'לומד לנהוג']
  state.memory = [
    ...filler.map((fact, i) => ({ id: i + 1, fact, category: 'other', importance: 3, created: now - (i + 1) * 864e5, lastUsed: now - (i + 1) * 864e5, uses: 2, source: 'user' })),
    { id: 99, fact: 'לא אוכל חריף ואוהב מסעדות איטלקיות', category: 'preference', importance: 3, created: now - 60 * 864e5, lastUsed: now - 60 * 864e5, uses: 1, source: 'user' },
  ]
  state.history = [user('תמצא שתי מסעדות איטלקיות לערב, בלי להזמין'), answer('טרטוריה כרמל או בית הסלט')]
  requests.length = 0
  await runTurn('טוב תעשה את זה', { source: 'whatsapp', confirm: async () => false, say: () => {} })
  ok(/#99 /.test(systemOf(requests[0])), 'a short follow-up gets the memory its conversation is about')

  resetHistory()
  // The turn above marked #99 as just used; put it back to how old it was.
  Object.assign(state.memory.find((m) => m.id === 99), { lastUsed: now - 60 * 864e5, uses: 1 })
  requests.length = 0
  await runTurn('מה דעתך על הסרט החדש של נולאן שיצא השבוע בקולנוע', { source: 'whatsapp', confirm: async () => false, say: () => {} })
  ok(!/#99 /.test(systemOf(requests[0])), 'a full message is looked up by itself')

  // The remote panel reads none of his private context, follow-up or not.
  requests.length = 0
  await runIsolated([user('תמשיך')], { isolated: true, gate: () => '', systemPrompt: 'panel', tools: [] })
  ok(systemOf(requests[0]) === 'panel' && !requests[0].messages.some((m) => /מסעדות/.test(m.content)), 'an isolated turn gets no memory and no chat history')
}

// ── waiting is not finished ──────────────────────────────────────────────────
const step = (text, status, note) => ({ text, status, ...(note ? { note } : {}) })
{
  resetHistory()
  const ctx = {}
  const said = planTool.run({ goal: 'טיול בצפון', done_when: 'מסלול ולינה', steps: [step('מסלול', 'done'), step('לינה', 'blocked', 'צריך תאריך')] }, ctx)
  ok(!isFinished(ctx.plan), 'a plan with a blocked step is not finished')
  ok(/לא הושלמה/.test(said) && /צריך תאריך/.test(said) && !/כל השלבים סגורים/.test(said), 'the tool tells the model it is waiting, with what for, not that all is closed')
  keepPlan(ctx.plan)
  const back = savedPlan()
  ok(back?.resumed && back.steps[1].status === 'blocked', 'it is kept and offered back to the next message')
  ok(/✗ 2\. לינה \(צריך תאריך\)/.test(planBlock({ plan: back }, false, false)) && /מחכה למה שכתוב בהערה/.test(planBlock({ plan: back }, false, false)), 'the prompt shows the blocked step and how to pick it up')
  state.plan.updatedAt = Date.now() - PLAN_TTL - 1000
  ok(savedPlan() === null, 'and still dropped after a day')
  const done = {}
  planTool.run({ goal: 'g', steps: [step('a', 'done'), step('b', 'skipped')] }, done)
  ok(isFinished(done.plan), 'done and skipped steps finish a plan, as before')
  ok(/כל השלבים סגורים/.test(planTool.run({ goal: 'g', steps: [step('a', 'done')] }, {})), 'a plan with every step done still says so')
}

// ── two goals: the first is set aside, not overwritten ───────────────────────
{
  resetHistory()
  const gift = { goal: 'מתנה לאמא', steps: [step('לאסוף רעיונות', 'done'), step('לבדוק מחירים', 'pending')] }
  const quiz = { goal: 'סיכום לבוחן', steps: [step('לאסוף חומר', 'done'), step('לכתוב סיכום', 'pending')] }
  const first = {}
  planTool.run(gift, first)
  keepPlan(first.plan)
  const second = { plan: savedPlan() }
  planTool.run(quiz, second)
  keepPlan(second.plan)
  ok(state.plan.goal === 'סיכום לבוחן' && state.planAside?.goal === 'מתנה לאמא', 'a plan for another goal sets the open one aside')
  const block = planBlock({ plan: savedPlan() }, false, false)
  ok(/הונחה בצד/.test(block) && /○ 2\. לבדוק מחירים/.test(block) && /○ 2\. לכתוב סיכום/.test(block), 'both are in the prompt, each with its open step')
  const third = { plan: savedPlan() }
  planTool.run(gift, third)
  keepPlan(third.plan)
  ok(state.plan.goal === 'מתנה לאמא' && state.planAside?.goal === 'סיכום לבוחן', 'going back to the first swaps them')
  // The same goal reworded, keeping a step, is an update, not a new goal.
  const fourth = { plan: savedPlan() }
  planTool.run({ goal: 'מתנה ליום הולדת של אמא', steps: [step('לאסוף רעיונות', 'done'), step('לבדוק מחירים', 'done'), step('להזמין', 'pending')] }, fourth)
  ok(state.planAside?.goal === 'סיכום לבוחן' && fourth.plan.goal === 'מתנה ליום הולדת של אמא', 'a reworded goal that keeps a step updates the same plan')
  // The current one finishes: the one set aside comes back as the open plan.
  planTool.run({ goal: 'מתנה ליום הולדת של אמא', steps: [step('לאסוף רעיונות', 'done'), step('לבדוק מחירים', 'done'), step('להזמין', 'skipped')] }, fourth)
  keepPlan(fourth.plan)
  const promoted = savedPlan()
  ok(promoted?.goal === 'סיכום לבוחן' && !state.planAside, 'when the current plan finishes, the one set aside is offered back')
  clearPlan()
  ok(!state.plan && !state.planAside, '"שיחה חדשה" drops both')
}

// ── a plan hint is an offer, not an order ────────────────────────────────────
{
  const hint = planBlock({}, false, true)
  ok(/אם הוא מבקש שתבצע/.test(hint) && /רק מספר/.test(hint), 'the goal hint leaves "is he asking or telling" to the model')
}

// ── a background result does not cut into a turn ─────────────────────────────
{
  resetHistory()
  let script = []
  const scripted = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return scripted(url, init)
    const body = JSON.parse(init.body)
    requests.push(body)
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() || { role: 'assistant', content: 'בסדר' } }] }) }
  }
  // While this tool runs, a background task ends.
  tools.push({ name: 'zz_slow', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, run: async () => (await runBackground('השוואת מחירים', 'x', { source: 'job' }), 'slide 3') })
  script = [{ role: 'assistant', content: '', tool_calls: [{ id: 'z1', type: 'function', function: { name: 'zz_slow', arguments: '{}' } }] }, { role: 'assistant', content: 'הכי זול 899' }, { role: 'assistant', content: 'בשקופית 3: רוח' }]
  requests.length = 0
  const reply = await runTurn('תבדוק מה כתוב בשקופית 3', { source: 'whatsapp', confirm: async () => false, say: () => {} })
  ok(reply === 'בשקופית 3: רוח', 'the turn answers its own question')
  ok(requests.every((b) => valid(b.messages.slice(1))), 'no request has a tool result away from its call')
  ok(valid(state.history) && state.history.at(-2).content === '[משימת רקע הסתיימה: השוואת מחירים]' && state.history.at(-1).content === 'הכי זול 899', 'the result joins the history after the turn')

  // A turn that fails rolls back to where it began; a result that arrived meanwhile is kept.
  const before = state.history.length
  tools.push({ name: 'zz_boom', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, run: async () => (noteBackground('דף נחיתה', 'מוכן: index.html'), 'ok') })
  script = [{ role: 'assistant', content: '', tool_calls: [{ id: 'z2', type: 'function', function: { name: 'zz_boom', arguments: '{}' } }] }]
  const stop = new AbortController()
  const failing = runTurn('משהו', { source: 'whatsapp', confirm: async () => false, say: () => {}, signal: stop.signal })
  // The second model call of this turn never comes: the turn is stopped once the tool has run.
  const inner = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, init) => (++calls === 2 ? (stop.abort(), Promise.reject(new Error('aborted'))) : inner(url, init))
  await failing.catch(() => {})
  globalThis.fetch = inner
  ok(state.history.length === before + 2 && state.history.at(-1).content === 'מוכן: index.html', 'a result that landed during a turn that failed is not rolled back with it')

  // A failure is told to the conversation too.
  noteBackground('הכנת קובץ', 'המשימה "הכנת קובץ" לא הסתיימה: שירות חיצוני לא ענה', true)
  ok(state.history.at(-2).content === '[משימת רקע לא הסתיימה: הכנת קובץ]', 'a failed task leaves its failure in the conversation')
  globalThis.fetch = scripted
}

// ── what is running right now ────────────────────────────────────────────────
{
  resetHistory()
  ok(_test.jobsLine(false) === '', 'no line when nothing runs')
  startJob('הכנת קובץ', (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))), () => {})
  requests.length = 0
  await runTurn('סיימת?', { source: 'whatsapp', confirm: async () => false, say: () => {} })
  ok(/משימות רקע שעדיין רצות עכשיו: "הכנת קובץ"/.test(systemOf(requests[0])) && /לא הסתיימו/.test(systemOf(requests[0])), 'a running task is named in the prompt as not finished')
  requests.length = 0
  await runIsolated([user('סיימת?')], { isolated: true, gate: () => '', systemPrompt: 'panel', tools: [] })
  ok(systemOf(requests[0]) === 'panel', 'the remote panel is not told about his background tasks')
  stopJobs()
  await new Promise((r) => setTimeout(r, 20))
  ok(_test.jobsLine(false) === '', 'a stopped task leaves the line')
}

// ── a spoken follow-up ───────────────────────────────────────────────────────
{
  resetHistory()
  const now = Date.now()
  Object.assign(state.memory.find((m) => m.id === 99), { lastUsed: now - 60 * 864e5, uses: 1 })
  state.history = [user('תמצא שתי מסעדות איטלקיות לערב, בלי להזמין'), answer('טרטוריה כרמל או בית הסלט')]
  requests.length = 0
  await runTurn("[שיחה קולית דרך android_app. התשובה שלך תוקרא בקול: משפט או שניים, בלי עיצוב, בלי אימוג'י, בלי קישורים ובלי רשימות.]\nטוב תעשה את זה", { source: 'android_app', confirm: async () => false, say: () => {} })
  ok(/#99 /.test(systemOf(requests[0])), 'the note in front of a spoken message does not hide that it is a short follow-up')
}

// ── the offline conversation evaluation, two cases ───────────────────────────
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-converse-report-'))
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'converse-eval.mjs'), '--only', 'compaction-continuity,chosen-option', '--modes', 'light', '--conditions', 'compacted'], {
    cwd: root,
    env: { ...process.env, CONVERSE_REPORT_DIR: out, HELPER_ENV_FILE: path.join(dir, '.env') },
    encoding: 'utf8',
    timeout: 120000,
  })
  const file = fs.readdirSync(out).find((f) => f.endsWith('.json'))
  const report = file ? JSON.parse(fs.readFileSync(path.join(out, file), 'utf8')) : { runs: [] }
  ok(run.status === 0 && report.runs.length === 4 && !report.runs.some((r) => r.error), 'the evaluation runs offline')
  ok(report.runs.every((r) => r.needs.every((n) => n.verdict === 'ok')), 'after folding, every fact these follow-ups need is in reach')
  ok(report.runs.every((r) => !r.blocked.length && !r.effects.length), 'nothing left the machine and no effect tool ran')
  fs.rmSync(out, { recursive: true, force: true })
}

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
