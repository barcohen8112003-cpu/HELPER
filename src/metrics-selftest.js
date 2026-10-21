// Offline checks for response-time stats and the daily budget of messages Helper sends on its own.
import assert from 'node:assert/strict'
process.env.MESSAGE_BUDGET = '3'
process.env.LLM_PRICES = 'paid-model=2/8, bad entry'
process.env.MONTHLY_COST_LIMIT = '1'
const { recordTurn, takeProactiveSlot, metricsSummary, prices, recordUsage, costSummary, costText, costTick } = await import('./metrics.js')
let passed = 0
for (const ms of [1000, 2000, 3000, 4000, 20000]) recordTurn({ ms, tools: 2, model: 'm' })
const s = metricsSummary()
assert.equal(s.turns24h, 5); passed++
assert.equal(s.p50, 3); passed++
assert.equal(s.p90, 20); passed++
assert.equal(s.avgTools, 2); passed++
assert.deepEqual([takeProactiveSlot(), takeProactiveSlot(), takeProactiveSlot(), takeProactiveSlot()], [true, true, true, false]); passed++
assert.equal(metricsSummary().proactiveToday, 3); passed++
const old = metricsSummary(Date.now() + 25 * 3600 * 1000)
assert.equal(old.turns24h, 0); passed++

// ── cost ──
assert.deepEqual(prices(), { 'paid-model': { input: 2, output: 8 } }); passed++
recordUsage('paid-model', { prompt_tokens: 100000, completion_tokens: 10000 })
recordUsage('free-model', { prompt_tokens: 50000, completion_tokens: 5000 })
recordUsage('paid-model', undefined)
let c = costSummary()
assert.equal(c.calls, 3); passed++
assert.equal(c.input, 150000); passed++
assert.equal(c.usd, 0.28); passed++ // 0.1M*2 + 0.01M*8, the free model adds nothing
assert.match(costText(c, 'החודש'), /^החודש: 3 קריאות למודל, 165 אלף טוקנים, בערך \$0\.28\.$/); passed++
assert.equal(costText(costSummary('1999-01'), 'x'), ''); passed++
const sent = []
const notify = async (text, urgent, key) => sent.push({ text, urgent, key })
await costTick(notify, new Date())
assert.equal(sent.filter((m) => m.key.startsWith('cost-alert')).length, 0); passed++ // $0.28 of $1
for (let i = 0; i < 2; i++) recordUsage('paid-model', { prompt_tokens: 100000, completion_tokens: 10000 }) // $0.84
await costTick(notify, new Date())
assert.deepEqual(sent.filter((m) => m.key.startsWith('cost-alert')).map((m) => m.urgent), [false]); passed++ // 80%
await costTick(notify, new Date())
assert.equal(sent.filter((m) => m.key.startsWith('cost-alert')).length, 1); passed++ // once
recordUsage('paid-model', { prompt_tokens: 100000, completion_tokens: 10000 }) // $1.12
await costTick(notify, new Date())
assert.deepEqual(sent.filter((m) => m.key.startsWith('cost-alert')).map((m) => m.urgent), [false, true]); passed++ // 100% is urgent
assert.ok(/\$1\.12 מתוך \$1/.test(sent.at(-1).text)); passed++
// The monthly line about last month: silent when last month had no use, and asked about only once.
assert.equal(sent.filter((m) => m.key.startsWith('cost-month')).length, 0); passed++
assert.ok(metricsSummary().cost.startsWith('החודש: 6 קריאות')); passed++
console.log(`${passed} בדיקות עברו, 0 נכשלו`)
