// node src/logs-selftest.js: keys never reach the log, and LOG_FORMAT=json gives one parseable line per entry.
import assert from 'node:assert/strict'

process.env.LLM_API_KEY = 'my-very-private-llm-key'
const { redact, toEntry, isSecretSessionLog } = await import('./secret-logs.js')
let passed = 0
const t = (fn) => (fn(), passed++)

t(() => assert.equal(redact('LLM HTTP 401: key my-very-private-llm-key is invalid'), 'LLM HTTP 401: key •••• is invalid'))
t(() => assert.equal(redact('Authorization: Bearer abcdefghijklmnop123'), 'Authorization: Bearer ••••'))
t(() => assert.equal(redact('using sk-proj-abcdefghijklmnopqrstuv now'), 'using •••• now'))
t(() => assert.equal(redact('GET https://x.example/v1?key=AIzaSyA1234567890abcdefghijklmnopqrstu&alt=json'), 'GET https://x.example/v1?key=••••&alt=json'))
t(() => assert.equal(redact('{"refresh_token":"1//0gabcdefghijklmnopqrstuvwxyz","scope":"x"}'), '{"refresh_token":"••••","scope":"x"}'))
t(() => assert.equal(redact('token ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz'), 'token ••••'))
t(() => assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123 leaked'), '•••• leaked'))
t(() => assert.equal(redact('[scheduler] 3 reminders sent'), '[scheduler] 3 reminders sent'))
t(() => assert.equal(redact('שלום, זו הודעה רגילה עם מספר 0501234567'), 'שלום, זו הודעה רגילה עם מספר 0501234567'))

const e = toEntry('warn', ['[backup] failed: %s', 'Bearer abcdefghijkl12345'], new Date('2026-10-21T10:00:00Z'))
t(() => assert.deepEqual(e, { t: '2026-10-21T10:00:00.000Z', level: 'warn', tag: 'backup', msg: 'failed: Bearer ••••' }))
t(() => assert.deepEqual(toEntry('info', ['plain line'], new Date(0)), { t: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'plain line' }))
t(() => assert.ok(isSecretSessionLog('Closing session: SessionEntry {') && !isSecretSessionLog('[wa] connected')))

// The console itself is wrapped: what reaches stdout is masked.
const lines = []
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), true)
console.log('[llm] key=%s', 'my-very-private-llm-key')
process.env.LOG_FORMAT = 'json'
console.log('[jobs] done')
delete process.env.LOG_FORMAT
process.stdout.write = write
t(() => assert.equal(lines[0], '[llm] key=••••\n'))
t(() => assert.deepEqual({ ...JSON.parse(lines[1]), t: 'x' }, { t: 'x', level: 'info', tag: 'jobs', msg: 'done' }))

console.log(`כל ${passed} בדיקות הלוגים עברו`)
