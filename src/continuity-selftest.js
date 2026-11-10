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

const { runTurn, compact, resetHistory, runIsolated, _test } = await import('./agent.js')
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
