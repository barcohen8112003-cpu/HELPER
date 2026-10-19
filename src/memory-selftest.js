// node src/memory-selftest.js
// Offline: no model, no network, temp data folder. Covers memory.js, memory-learn.js, memory-tools.js and the
// agent loop's parallel-run and approval rules.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-memory-'))

const { state } = await import('./store.js')
const { config } = await import('./config.js')
config.llm.light = false // the real .env may switch light mode on, which turns learning off
const mem = await import('./memory.js')
const { learnFrom, parseFacts, worthLearningFrom, _resetLearnClock } = await import('./memory-learn.js')
const { memoryTools } = await import('./memory-tools.js')
const { tools, allTools } = await import('./tools.js')
const { _test } = await import('./agent.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
const tool = (name) => tools.find((t) => t.name === name)

// ── similarity and tokens ───────────────────────────────────────────────────
ok(mem.stem('בבית') === 'בית', 'stem strips a Hebrew prefix')
ok(mem.stem('והבית') === 'בית', 'stem strips two prefixes')
ok(mem.stem('שמש') === 'שמש', 'stem keeps short words')
ok(mem.similarity('אוהב קפה שחור', 'אוהב קפה שחור') > 0.99, 'identical facts are the same')
ok(mem.similarity('אוהב קפה שחור', 'לומד מדעי המחשב') === 0, 'unrelated facts share nothing')
ok(mem.similarity('אוהב קפה', 'אוהב קפה שחור עם סוכר') > 0.5, 'a fact inside a longer one is recognised')

// ── adding facts: duplicates, updates, refusals ─────────────────────────────
const t0 = 1_700_000_000_000
const a = mem.addFact('גר בראשון לציון', { category: 'person', now: t0 })
ok(a.status === 'added', 'new fact is added')
ok(mem.addFact('גר בראשון לציון', { category: 'person', now: t0 }).status === 'duplicate', 'same fact is a duplicate')
ok(state.memory.length === 1, 'duplicate did not grow the memory')
const upd = mem.addFact('גר בתל אביב', { category: 'person', now: t0 })
ok(upd.status === 'updated' && upd.id === a.id, 'a changed fact of the same kind replaces the old one')
ok(state.memory[0].fact === 'גר בתל אביב' && upd.previous === 'גר בראשון לציון', 'the update keeps the id and reports the old text')
ok(throws(() => mem.addFact('הסיסמה שלי היא abc123')), 'password-like facts are refused')
ok(throws(() => mem.addFact('מספר הזהות שלי 123456789')), 'ID numbers are refused')
ok(throws(() => mem.addFact('כרטיס אשראי 4580 1234 5678 9012')), 'card numbers are refused')
ok(throws(() => mem.addFact('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), 'long key-like strings are refused')
ok(throws(() => mem.addFact('x')), 'too short is refused')
ok(throws(() => mem.addFact('א'.repeat(300))), 'too long is refused')
ok(mem.looksSecret('my api key is here') && !mem.looksSecret('אוהב לשחק כדורגל'), 'looksSecret tells them apart')
ok(mem.removeFact(a.id) && !mem.removeFact(a.id), 'removeFact removes once')

// ── old records still work ───────────────────────────────────────────────────
state.memory = [{ id: 900, fact: 'אלרגי לבוטנים' }]
ok(mem.retrieve('מה לאכול').length === 1, 'a legacy { id, fact } record is retrievable')
ok(mem.memoryBlock('מה לאכול').includes('#900 אלרגי לבוטנים'), 'a legacy record appears in the prompt block')
state.memory = []

// ── retrieval over a large memory ────────────────────────────────────────────
const topics = ['כדורגל', 'מוזיקה', 'מתמטיקה', 'פיזיקה', 'אנגלית', 'היסטוריה', 'ביולוגיה', 'ספרות', 'כימיה', 'תנ"ך', 'אזרחות', 'גיאוגרפיה', 'ציור', 'צילום', 'בישול', 'ריצה', 'שחייה', 'קולנוע', 'משחקי מחשב', 'תכנות']
topics.forEach((t, i) => {
  state.memory.push({ id: 1000 + i, fact: `מתעניין ב${t} ומקדיש לזה זמן בשבוע ${i}`, importance: 3, category: 'preference' })
})
state.memory.push({ id: 2000, fact: 'קוראים לו נאור', importance: 5, category: 'person' })
state.memory.push({ id: 2001, fact: 'אלרגי לאגוזים', importance: 5, category: 'health' })
const got = mem.retrieve('מה כדאי לי לעשות עם כדורגל בסוף השבוע', 8)
ok(got.length === 8, 'retrieval returns the limit')
ok(got.some((m) => m.fact.includes('כדורגל')), 'the relevant fact is retrieved')
ok(got.some((m) => m.id === 2000) && got.some((m) => m.id === 2001), 'importance-5 facts are always included')
const block = mem.memoryBlock('מה כדאי לי לעשות עם כדורגל', { now: t0 })
ok(block.includes('כדורגל') && /עוד \d+ עובדות/.test(block), 'the block says how many facts are not shown')
ok(mem.search('פיזיקה').some((m) => m.fact.includes('פיזיקה')), 'search finds a fact that retrieval left out')
ok(mem.search('').length === 0, 'an empty search finds nothing')
state.memory = []

// ── eviction keeps automatic, low-value facts first ──────────────────────────
state.memory = Array.from({ length: 300 }, (_, i) => ({ id: 5000 + i, fact: `עובדה מספר ${i} על נושא ייחודי${i}`, importance: i === 0 ? 5 : 3, source: i === 1 ? 'auto' : 'explicit', created: t0, lastUsed: t0, uses: 0, category: 'other' }))
mem.addFact('עובדה חדשה לגמרי על משהו אחר לחלוטין', { now: t0 + 1000 })
ok(state.memory.length === 300, 'the memory stays at its cap')
ok(!state.memory.some((m) => m.id === 5001), 'the automatic fact was evicted first')
ok(state.memory.some((m) => m.id === 5000), 'the important fact survived')
state.memory = []

// ── candidates ───────────────────────────────────────────────────────────────
const c1 = mem.addCandidate('אוהב קפה שחור', { category: 'preference' })
ok(c1.status === 'proposed' && mem.pending().length === 1, 'a candidate is queued, not saved')
ok(state.memory.length === 0, 'a candidate is not memory yet')
ok(mem.addCandidate('אוהב קפה שחור').status === 'queued', 'the same candidate is not queued twice')
mem.addFact('אוהב קפה שחור')
ok(mem.addCandidate('אוהב קפה שחור').status === 'known', 'a known fact is not proposed again')
mem.rejectCandidates()
ok(mem.pending().length === 0, 'reject clears the queue')
const distinct = [
  'מפחד מכלבים גדולים', 'מנגן בגיטרה בערבים', 'שותה תה עם נענע', 'אחיו הקטן נקרא דור', 'משחק כדורסל בשישי',
  'מעדיף פיצה ללא זיתים', 'מתכנן טיול לאילת', 'מקשיב לפודקאסטים בנסיעות', 'הולך לישון מאוחר', 'אוהב סרטי מדע בדיוני',
  'קורא ספרי פנטזיה', 'מרכיב משקפיים לקריאה', 'חובב צילום נוף', 'מתאמן בחדר כושר', 'משתמש במקלדת מכנית',
  'מעדיף עבודה בשקט', 'מכין שקשוקה בשבתות', 'נוסע באופניים לבית ספר', 'אוסף מטבעות ישנים', 'צופה בפורמולה אחת',
  'שונא קיץ חם מדי', 'מטייל בגליל עם חברים', 'אוהב שוקולד מריר', 'רוצה ללמוד יפנית', 'מצייר בזמנו הפנוי',
]
distinct.forEach((fact) => mem.addCandidate(fact))
ok(mem.pending().length <= 20, 'the queue is capped')
const ids = mem.pending().slice(0, 2).map((c) => c.id)
const confirmed = mem.confirmCandidates(ids)
ok(confirmed.length === 2 && confirmed.every((d) => d.status === 'added'), 'confirm saves only the chosen ones')
ok(state.memory.filter((m) => m.source === 'auto').length === 2, 'confirmed facts are marked as learned automatically')
mem.rejectCandidates()
state.memory = []

// ── the prompt asks about pending facts, but not too often ───────────────────
mem.addCandidate('לומד מדעי המחשב', { category: 'school' })
state.memoryAskedAt = 0
ok(mem.memoryBlock('היי', { now: t0 }).includes('ממתינות לאישור'), 'pending facts are mentioned in the prompt')
state.memoryAskedAt = t0
ok(!mem.memoryBlock('היי', { now: t0 + 3600e3 }).includes('ממתינות לאישור'), 'but not again within four hours of the last ask')
ok(mem.memoryBlock('היי', { now: t0 + 5 * 3600e3 }).includes('ממתינות לאישור'), 'and again after four hours')
mem.rejectCandidates()

// ── learning from messages ───────────────────────────────────────────────────
ok(!worthLearningFrom('מה השעה'), 'a short question is not worth learning from')
ok(!worthLearningFrom('/new'), 'a command is not')
ok(!worthLearningFrom('תזכיר לי מחר בשמונה לקחת את הכביסה מהמייבש'), 'a reminder with no personal statement is not')
ok(worthLearningFrom('אני לומד מדעי המחשב ואוהב קפה שחור בבוקר'), 'a personal statement is')
ok(parseFacts('הנה: [{"fact":"אוהב קפה","category":"preference","importance":3}] תודה').length === 1, 'JSON inside text is found')
ok(parseFacts('לא JSON').length === 0 && parseFacts('[{"x":1}]').length === 0, 'junk gives nothing')
ok(parseFacts(JSON.stringify([1, 2, 3, 4].map((i) => ({ fact: `עובדה ${i}` })))).length === 3, 'at most three per message')

let asked = 0
const fake = async (system, user) => {
  asked++
  return JSON.stringify([
    { fact: 'לומד מדעי המחשב', category: 'school', importance: 4 },
    { fact: 'הסיסמה שלו היא hunter2', category: 'tech', importance: 5 },
    { fact: 'אוהב קפה שחור', category: 'bogus-category', importance: 99 },
  ])
}
_resetLearnClock()
const proposed = await learnFrom('אני לומד מדעי המחשב ואוהב קפה שחור, הסיסמה שלי hunter2', { askFn: fake, force: true })
ok(proposed.length === 2, 'two candidates proposed, the secret one dropped')
ok(!mem.pending().some((c) => /hunter2/.test(c.fact)), 'a secret never becomes a candidate')
ok(mem.pending().find((c) => c.fact.includes('קפה'))?.category === 'other', 'an unknown category falls back to other')
ok(mem.pending().find((c) => c.fact.includes('קפה'))?.importance === 5, 'importance is clamped to 1-5')
ok(state.memory.length === 0, 'learning saved nothing by itself')
_resetLearnClock()
await learnFrom('מה השעה עכשיו בבקשה תגיד לי', { askFn: fake })
ok(asked === 1, 'a message with no personal signal costs no model call')
const t1 = Date.now()
_resetLearnClock()
await learnFrom('אני גר בחיפה ואני עובד בבנק', { askFn: fake, now: t1 })
await learnFrom('אני אוהב לרוץ ואני לומד באוניברסיטה', { askFn: fake, now: t1 + 1000 })
ok(asked === 2, 'extraction is rate-limited')
mem.rejectCandidates()

// ── the tools the model sees ─────────────────────────────────────────────────
ok(memoryTools.every((t) => tools.includes(t)), 'memory tools are core tools')
ok(tool('memory_confirm').risk === 'write', 'memory_confirm needs the user’s approval')
ok(tool('memory_reject').risk === undefined && tool('memory_search').risk === undefined, 'reject and search do not')
mem.addCandidate('מעדיף ללמוד בלילה', { category: 'routine' })
const desc = tool('memory_confirm').describe({})
ok(desc.includes('מעדיף ללמוד בלילה') && desc.startsWith('לשמור בזיכרון'), 'the approval text shows the actual fact')
ok(_test.approvalText('memory_confirm', {}, tool('memory_confirm')) === desc, 'the agent uses the tool’s own approval text')
state.memoryAskedAt = 0
tool('memory_confirm').onAsk()
ok(state.memoryAskedAt > 0, 'asking records the time')
ok((await tool('memory_confirm').run({})).startsWith('נשמר'), 'confirm saves')
ok((await tool('memory_confirm').run({})) === 'אין עובדות ממתינות', 'confirm with nothing pending says so')
ok((await tool('remember').run({ fact: 'מעדיף ללמוד בלילה', category: 'routine' })).startsWith('כבר ידוע'), 'remember reports a duplicate')
ok((await tool('remember').run({ fact: 'גר בקרית אונו' })).startsWith('נשמר'), 'remember saves a new fact')
ok((await tool('remember').run({ fact: 'גר בקרית אונו ליד הים' })).startsWith('עודכן'), 'remember updates a changed fact')
ok(throws(() => tool('remember').run({ fact: 'api key is abc' })), 'remember refuses secrets')
ok((await tool('memory_search').run({ query: 'ללמוד' })).includes('בלילה'), 'memory_search finds it')
ok((await tool('forget').run({ id: 999999 })) === 'לא נמצא', 'forget reports a missing id')

// ── parallel runs and approvals in the agent loop ────────────────────────────
const find = (n) => allTools().find((t) => t.name === n)
ok(_test.runsInParallel(find('web_search'), {}), 'web_search can run in parallel')
ok(_test.runsInParallel(find('get_weather'), {}), 'weather can run in parallel')
ok(!_test.runsInParallel(find('remember'), {}), 'a writing tool never runs in parallel')
ok(!_test.runsInParallel(find('send_whatsapp'), {}), 'sending never runs in parallel')
ok(!_test.runsInParallel(find('memory_confirm'), {}), 'a tool that needs approval never runs in parallel')
ok(!_test.runsInParallel(find('pc_lock'), {}) && !_test.runsInParallel(find('pc_type'), {}), 'computer control never runs in parallel')
ok(!_test.runsInParallel(undefined, {}), 'an unknown tool does not either')
const net = allTools().find((t) => t.network === true)
ok(!net || _test.runsInParallel(net, {}), 'a toolkit tool marked network can run in parallel')
ok(allTools().filter((t) => t.risk === 'write').every((t) => !_test.runsInParallel(t, {})), 'no write-risk tool is ever parallel')
const msgs = [{ role: 'user', content: 'ראשון' }, { role: 'assistant', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'שני' }, { type: 'image_url', image_url: { url: 'data:' } }] }]
ok(_test.lastUserText(msgs) === 'שני', 'the last user text is found, also with an image')
ok(_test.lastUserText([]) === '', 'and empty history gives an empty query')

// Promise.all keeps the order of results, which the model relies on to match answers to calls.
const order = await Promise.all([30, 5, 15].map((ms, i) => new Promise((r) => setTimeout(() => r(i), ms))))
ok(order.join() === '0,1,2', 'parallel results keep the order of the calls')

// ── the whole loop with a fake model: order, parallelism and the approval gate ──
{
  const { runTurn } = await import('./agent.js')
  config.llm.apiKey = 'test-key'
  config.llm.model = 'fake-model'
  config.llm.fallbackModels = []
  config.llm.cheapModel = ''
  config.llm.baseUrl = 'http://fake.invalid'
  config.llm.backup = { apiKey: '', model: '' }

  const log = []
  const slow = (name) => ({
    name,
    description: 'בדיקה',
    parameters: { type: 'object', properties: {}, required: [] },
    network: true,
    async run() {
      log.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, 300))
      log.push(`${name}:end`)
      return `result-${name}`
    },
  })
  const writer = {
    name: 'zz_write',
    description: 'בדיקה',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'write',
    run() {
      log.push('zz_write:RAN')
      return 'wrote'
    },
  }
  tools.push(slow('zz_a'), slow('zz_b'), slow('zz_c'), writer)

  const realFetch = globalThis.fetch
  let script = []
  const seen = []
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
    const body = JSON.parse(init.body)
    seen.push(body.messages.filter((m) => m.role === 'tool').map((m) => m.content))
    const message = script.shift()
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message }] }) }
  }
  const call = (name, id) => ({ id, type: 'function', function: { name, arguments: '{}' } })
  const confirms = []
  const ctx = { confirm: async (text) => (confirms.push(text), false) }

  // Three independent lookups: they overlap, and the answers come back in the order they were asked.
  script = [{ role: 'assistant', content: '', tool_calls: [call('zz_a', '1'), call('zz_b', '2'), call('zz_c', '3')] }, { role: 'assistant', content: 'סיימתי' }]
  const t = Date.now()
  const reply = await runTurn('תבדוק שלושה דברים', ctx)
  const took = Date.now() - t
  ok(reply === 'סיימתי', 'the loop returns the final answer')
  ok(took < 800, `three 300ms lookups ran together (took ${took}ms)`)
  ok(log.slice(0, 3).every((e) => e.endsWith(':start')), 'all three started before any finished')
  ok(seen[1].join() === 'result-zz_a,result-zz_b,result-zz_c', 'the results reach the model in the order of the calls')

  // A call that needs approval splits the batch and does not run when the user says no.
  log.length = 0
  script = [{ role: 'assistant', content: '', tool_calls: [call('zz_a', '4'), call('zz_write', '5'), call('zz_b', '6')] }, { role: 'assistant', content: 'בסדר' }]
  seen.length = 0
  await runTurn('תעשה משהו', ctx)
  ok(!log.includes('zz_write:RAN'), 'a write-risk tool does not run without approval')
  ok(confirms.length === 1, 'the user was asked once')
  ok(log.join() === 'zz_a:start,zz_a:end,zz_b:start,zz_b:end', 'the lookups on either side of it ran one after the other')
  ok(seen.at(-1).some((x) => x.includes('לא אישר')), 'the model is told the user declined')

  // An injected instruction cannot confirm memory: the approval gate is there whatever the model asks for.
  mem.addCandidate('אוהב לקרוא בלילה', { category: 'preference' })
  script = [{ role: 'assistant', content: '', tool_calls: [call('memory_confirm', '7')] }, { role: 'assistant', content: 'אישור נדרש' }]
  confirms.length = 0
  await runTurn('תשמור', ctx)
  ok(confirms.length === 1 && confirms[0].includes('אוהב לקרוא בלילה'), 'memory_confirm asked the user, showing the fact')
  ok(mem.pending().length === 1 && !state.memory.some((m) => m.fact.includes('לקרוא בלילה')), 'declined means nothing was saved')
  script = [{ role: 'assistant', content: '', tool_calls: [call('memory_confirm', '8')] }, { role: 'assistant', content: 'נשמר' }]
  await runTurn('תשמור', { confirm: async () => true })
  ok(state.memory.some((m) => m.fact.includes('לקרוא בלילה')), 'approved means it was saved')

  // ── "עצור": a turn that is waiting for the model ends at once, and leaves no trace in the history ──
  const { Aborted } = await import('./llm.js')
  const before = JSON.stringify(state.history)
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      // A model that never answers; the request ends only if its signal does.
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
    })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  const started = Date.now()
  let outcome = 'finished'
  try {
    await runTurn('שאלה שלא תיענה', { confirm: async () => true, signal: ac.signal })
  } catch (e) {
    outcome = e instanceof Aborted ? 'aborted' : `other: ${e.message}`
  }
  ok(outcome === 'aborted', `stopping ends the turn with Aborted (${outcome})`)
  ok(Date.now() - started < 1500, 'and it does so at once, not after a timeout')
  ok(JSON.stringify(state.history) === before, 'the stopped message and anything half done are not left in the history')

  // Stopped between two tool calls: the next call never runs.
  globalThis.fetch = realFetch
  log.length = 0
  const ac2 = new AbortController()
  let calls2 = 0
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
    calls2++
    ac2.abort() // the user says stop while the model's reply with three lookups is arriving
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call('zz_a', '9'), call('zz_b', '10')] } }] }) }
  }
  let outcome2 = 'finished'
  try {
    await runTurn('עוד שאלה', { confirm: async () => true, signal: ac2.signal })
  } catch (e) {
    outcome2 = e instanceof Aborted ? 'aborted' : `other: ${e.message}`
  }
  ok(outcome2 === 'aborted' && !log.some((e) => e.startsWith('zz_')), 'a stop that arrives with the tool calls prevents them from running')
  ok(JSON.stringify(state.history) === before, 'and the history is still clean')

  globalThis.fetch = realFetch
  tools.splice(tools.findIndex((x) => x.name === 'zz_a'), 4)
}

// ── plain-language commands ──────────────────────────────────────────────────
{
  const { parseCommand } = await import('./commands.js')
  for (const t of ['עצור', 'עצור!', ' עצור ', 'תעצור.', 'stop', 'Stop', '/stop', 'עצור 🛑']) ok(parseCommand(t) === 'stop', `"${t}" stops`)
  for (const t of ['שיחה חדשה', 'שיחה חדשה!', 'שיחה חדשה.', 'תתחיל שיחה חדשה', '/new', '/reset', 'New chat']) ok(parseCommand(t) === 'new', `"${t}" starts a new conversation`)
  for (const t of ['תעצור את השיר', 'עצור את המוזיקה', 'אני רוצה שיחה חדשה עם דני', 'מה זה שיחה חדשה', 'עצורי', 'stop the music', '', 'שלום', 'מתי עוצרים']) {
    ok(parseCommand(t) === null, `"${t}" is left to the model`)
  }
}

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
