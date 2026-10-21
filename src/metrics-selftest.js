// Offline checks for response-time stats and the daily budget of messages Helper sends on its own.
import assert from 'node:assert/strict'
process.env.MESSAGE_BUDGET = '3'
const { recordTurn, takeProactiveSlot, metricsSummary } = await import('./metrics.js')
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
console.log(`${passed} בדיקות עברו, 0 נכשלו`)
