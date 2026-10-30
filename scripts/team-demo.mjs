// npm run demo:team: the team's demo request, end to end, on a scripted model and a stand-in flight search.
// Prints every event (who got what, which adapter ran, what was rejected and why) and the one answer he gets.
// SYNTHETIC: no key, no paid model, no account, no message to anyone. The flights are test data.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-team-demo-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })
delete process.env.FLIGHTS_HOME

const { config } = await import('../src/config.js')
const { runTurn } = await import('../src/agent.js')
const team = await import('../src/team/conductor.js')
const { mockOptions, scriptedModel, DETAILS_REPLY } = await import('../src/team/fixtures.js')

Object.assign(config.llm, { apiKey: 'demo', model: 'not-called', baseUrl: 'http://fake.invalid', fallbackModels: [], cheapModel: '', backup: { apiKey: '', model: '' } })
config.memoryLearn = false
config.team.mode = 'mock'
globalThis.fetch = async () => {
  throw new Error('the demo makes no network call')
}
console.log = ((log) => (...a) => (String(a[0]).startsWith('[') ? undefined : log(...a)))(console.log)

const calls = []
const model = scriptedModel({ log: calls })
team._setForTest({ model, search: async (args) => ({ text: 'synthetic', options: mockOptions() }) })

const show = (who, text) => console.log(`\n── ${who} ──\n${text}`)
const events = (list) => list.map((e) => `  +${String(e.at).padStart(4)}ms  ${e.type.padEnd(12)} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['at', 'type'].includes(k))))}`).join('\n')

const ask = 'מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות'
show('הוא כותב', ask)
const e1 = []
show('Helper', await runTurn(ask, { source: 'whatsapp', msgId: 'demo-1', teamEvents: e1 }))
console.log(events(e1))
show('הוא עונה (פרטים סינתטיים)', DETAILS_REPLY)
const e2 = []
const reply = await runTurn(DETAILS_REPLY, { source: 'whatsapp', msgId: 'demo-2', teamEvents: e2 })
console.log('\nאירועים:')
console.log(events(e2))
show('Helper (התשובה האחת שהוא מקבל)', reply)
console.log(`\nקריאות מודל לצוות: ${calls.length} (${calls.map((c) => `${c.role} עד ${c.maxTokens} טוקני פלט`).join(', ')}). עלות: $0, מודל מדומה.`)
fs.rmSync(dir, { recursive: true, force: true })
