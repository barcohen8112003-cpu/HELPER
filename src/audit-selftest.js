// node src/audit-selftest.js
// Offline: no model reached, no network, temp data folder. The activity log: what is written, what is never written,
// how it is searched, and that every kind of tool call in the agent loop leaves a line.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-audit-'))
process.env.HELPER_DATA_DIR = dir
process.env.LLM_API_KEY = 'fake-test-key-0123456789abcdef0123456789abcdef'

const audit = await import('./audit.js')
const { tools } = await import('./tools.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const lines = (file) => fs.readFileSync(path.join(audit.AUDIT_DIR(), file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ── what is written ──────────────────────────────────────────────────────────
const t0 = new Date(2026, 9, 20, 22, 30, 0)
audit.record({ tool: 'send_whatsapp_to', args: { to: 'דני', text: 'אני מאחר בעשר דקות' }, source: 'whatsapp', approval: 'approved', ok: true, result: 'נשלח', ms: 412, now: t0 })
audit.record({ tool: 'pc_type', args: { text: '1234', pin: '9876' }, source: 'tv', approval: 'declined', ok: false, result: 'המשתמש לא אישר', now: new Date(2026, 9, 20, 22, 31) })
audit.record({ tool: 'web_search', args: { query: 'מחיר אוזניות' }, source: 'task', ok: true, result: 'x'.repeat(500), ms: 90, now: new Date(2026, 9, 21, 3, 0) })
audit.record({ tool: 'gmail_read', args: { id: 'abc' }, source: 'whatsapp', ok: false, error: 'Google HTTP 401', result: 'שגיאה: Google HTTP 401', now: new Date(2026, 9, 21, 9, 0) })
const rows = lines('2026-10.jsonl')
ok(rows.length === 4, 'one line per call')
ok(rows[0].t === t0.toISOString() && rows[0].source === 'whatsapp' && rows[0].approval === 'approved' && rows[0].ms === 412, 'when, where from, approval and time taken')
ok(rows[0].args.to === 'דני' && rows[0].args.text === 'אני מאחר בעשר דקות', 'what a message said and to whom is kept: that is the point')
ok(rows[1].args.pin === '••••' && rows[1].args.text === '1234', 'an argument named like a secret is never stored')
ok(!JSON.stringify(rows).includes('9876'), 'and its value appears nowhere')
ok(rows[2].result.length <= 161, 'a long result is cut to its opening')
ok(rows[3].ok === false && rows[3].error === 'Google HTTP 401', 'a failure keeps its reason')

audit.record({ tool: 'x', args: { url: 'https://api.test/x?key=abcdef123456&q=1', note: `la ${process.env.LLM_API_KEY} la` }, result: `Bearer ${process.env.LLM_API_KEY}`, now: new Date(2026, 9, 21, 10, 0) })
const masked = lines('2026-10.jsonl').at(-1)
ok(!JSON.stringify(masked).includes('abcdef123456') && !JSON.stringify(masked).includes('0123456789abcdef'), 'keys in a url or text are masked, and so is Helper\'s own key')
ok(audit.maskArgs({ a: { nested: true }, token: 't', n: 5 }).a === '{"nested":true}' && audit.maskArgs({ token: 't' }).token === '••••' && audit.maskArgs(null) && Object.keys(audit.maskArgs(undefined)).length === 0, 'odd arguments do not break it')

// ── searching ────────────────────────────────────────────────────────────────
const all = audit.searchAudit({ limit: 100 })
ok(all.length === 5 && all[0].t > all.at(-1).t, 'newest first')
ok(audit.searchAudit({ tool: 'whatsapp' }).length === 1, 'by tool name')
ok(audit.searchAudit({ q: 'דני' }).length === 1 && audit.searchAudit({ q: 'דני' })[0].tool === 'send_whatsapp_to', 'by what was in it')
ok(audit.searchAudit({ q: 'http 401' }).length === 1, 'by error')
ok(audit.searchAudit({ approval: 'declined' }).length === 1 && audit.searchAudit({ approval: 'approved' }).length === 1, 'by approval')
ok(audit.searchAudit({ source: 'task' }).length === 1, 'by where it came from')
ok(audit.searchAudit({ from: new Date(2026, 9, 21).toISOString() }).length === 3 && audit.searchAudit({ to: new Date(2026, 9, 21).toISOString() }).length === 2, 'by time')
ok(audit.searchAudit({ limit: 2 }).length === 2, 'with a limit')
ok(audit.searchAudit({ q: 'nothing like this' }).length === 0, 'and nothing when nothing fits')

// ── across months, retention, damage ─────────────────────────────────────────
audit.record({ tool: 'old_one', args: {}, now: new Date(2026, 8, 5, 12, 0) })
ok(audit.searchAudit({ q: 'old_one' }).length === 1 && audit.searchAudit({ limit: 100 }).length === 6, 'a search reaches into earlier months')
fs.writeFileSync(path.join(audit.AUDIT_DIR(), '2025-01.jsonl'), '{"t":"2025-01-01T00:00:00.000Z","tool":"ancient","args":{},"approval":"none","ok":true,"result":""}\n')
audit.record({ tool: 'new_month', args: {}, now: new Date(2026, 10, 2, 8, 0) })
ok(!fs.existsSync(path.join(audit.AUDIT_DIR(), '2025-01.jsonl')) && fs.existsSync(path.join(audit.AUDIT_DIR(), '2026-09.jsonl')), 'a new month drops what is past the retention window and keeps the rest')
fs.appendFileSync(path.join(audit.AUDIT_DIR(), '2026-11.jsonl'), 'not json at all\n')
ok(audit.searchAudit({ q: 'new_month' }).length === 1, 'a damaged line is skipped, not fatal')
fs.writeFileSync(path.join(dir, 'blocker'), 'x')
process.env.HELPER_DATA_DIR = path.join(dir, 'blocker', 'under-a-file')
// (DATA_DIR was read at startup, so this only checks that a failing write is swallowed)
const realAppend = fs.appendFileSync
fs.appendFileSync = () => { throw new Error('disk full') }
let threw = false
try { audit.record({ tool: 'x', args: {} }) } catch { threw = true }
fs.appendFileSync = realAppend
ok(!threw, 'a failing log never stops a tool')

// ── the numbers for the dashboard ────────────────────────────────────────────
const stats = audit.auditStats(7, new Date(2026, 9, 22, 12, 0))
ok(stats.total === 5 && stats.approved === 1 && stats.declined === 1 && stats.failed === 1 && stats.top[0].n >= 1, 'counts: total, approved, declined, failed')
ok(audit.auditStats(1, new Date(2026, 9, 21, 23, 0)).total === 3, 'and over a shorter window, ending when it was asked')

// ── the model can ask ────────────────────────────────────────────────────────
const tool = tools.find((t) => t.name === 'audit_search')
ok(tool && !tool.risk, 'audit_search is a core tool and a plain read')
const answer = tool.run({ q: 'דני', days: 3650 })
ok(answer.includes('send_whatsapp_to') && answer.includes('אושר') && answer.includes('וואטסאפ'), 'it answers in words: when, from where, the tool, approved')
ok(tool.run({ q: 'zzz-nothing', days: 3650 }) === 'אין פעולות מתאימות ביומן', 'and says so when there is nothing')

// ── the agent loop writes a line for every kind of call ──────────────────────
{
  const { runTurn } = await import('./agent.js')
  const { config } = await import('./config.js')
  config.llm.apiKey = 'test-key'
  config.llm.model = 'fake-model'
  config.llm.fallbackModels = []
  config.llm.cheapModel = ''
  config.llm.baseUrl = 'http://fake.invalid'
  config.llm.backup = { apiKey: '', model: '' }
  config.llm.light = false
  config.memoryLearn = false
  const realFetch = globalThis.fetch
  let script = []
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() }] }) }
  }
  const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  tools.push(
    { name: 'zz_ok', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, run: () => 'done' },
    { name: 'zz_boom', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, run: () => { throw new Error('exploded') } },
    { name: 'zz_write', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, risk: 'write', run: () => 'wrote' }
  )
  const before = audit.searchAudit({ limit: 200 }).length
  script = [{ role: 'assistant', content: '', tool_calls: [call('zz_ok', { password: 'hunter2', what: 'a' }, '1'), call('zz_boom', {}, '2'), call('zz_write', {}, '3')] }, { role: 'assistant', content: 'סיימתי' }]
  await runTurn('תעשה שלושה דברים', { source: 'tv', confirm: async () => false })
  const added = audit.searchAudit({ limit: 200 }).slice(0, audit.searchAudit({ limit: 200 }).length - before)
  const by = (n) => audit.searchAudit({ tool: n, limit: 5 })[0]
  ok(audit.searchAudit({ limit: 200 }).length === before + 3, 'three calls, three lines')
  ok(by('zz_ok').ok === true && by('zz_ok').source === 'tv' && by('zz_ok').approval === 'none' && by('zz_ok').args.password === '••••', 'a plain call: where from, no approval needed, secret hidden')
  ok(by('zz_boom').ok === false && by('zz_boom').error === 'exploded', 'a failing call is logged as failed, with the reason')
  ok(by('zz_write').approval === 'declined' && by('zz_write').ok === false, 'a declined approval is logged as declined')
  script = [{ role: 'assistant', content: '', tool_calls: [call('zz_write', {}, '4')] }, { role: 'assistant', content: 'בוצע' }]
  await runTurn('תכתוב', { source: 'whatsapp', confirm: async () => true })
  ok(by('zz_write').approval === 'approved' && by('zz_write').ok === true && by('zz_write').source === 'whatsapp', 'and an approved one as approved')
  globalThis.fetch = realFetch
  void added
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
