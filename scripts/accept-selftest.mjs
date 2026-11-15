// node scripts/accept-selftest.mjs: the acceptance harness itself, offline. tasks.yml reads and holds all 25 tasks,
// the checks and masking work, the network guard lets only the model and the fixture pages through, and a whole
// run of accept:real against a scripted local model passes the tasks it should and fails the one it should.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ROOT, parseYaml, loadTasks, mask, runChecks, guardFetch, fixtureResponse, wantedTime, MONEY, FIXTURE_HOST } from './accept-lib.mjs'

process.env.TZ = 'Asia/Jerusalem'
let passed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed++
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

// ── tasks.yml ────────────────────────────────────────────────────────────────
await test('the YAML subset', () => {
  const doc = parseYaml(['# c', 'a: 1', 'b: "x: y"', "c: 'it''s'", 'd: [1, two]', 'e:', '  - k: v', '    n: true', '  - plain', 'f:', '- x', 'g:'].join('\n'))
  assert.deepEqual(doc, { a: 1, b: 'x: y', c: "it's", d: [1, 'two'], e: [{ k: 'v', n: true }, 'plain'], f: ['x'], g: null })
  assert.throws(() => parseYaml('a: 1\n    b: 2'), /line 2/)
  assert.throws(() => parseYaml('a: 1\na: 2'), /twice/)
  assert.throws(() => parseYaml('a: "open'), /unclosed/)
})

await test('tasks.yml holds the 25 tasks of the spec, each valid', () => {
  const tasks = loadTasks()
  assert.deepEqual(tasks.map((t) => t.id), Array.from({ length: 25 }, (_, i) => i + 1))
  const by = (m) => tasks.filter((t) => t.mode === m).map((t) => t.id)
  assert.deepEqual(by('manual'), [19, 20, 21, 22, 23, 25], 'devices, payments layer and the kill test are manual')
  assert.ok(by('live').includes(16) && by('live').includes(18), 'real shopping and booking are live only')
  for (const t of tasks.filter((x) => x.mode === 'auto')) assert.ok(t.steps.some((s) => s.expect), `auto task ${t.id} checks something`)
})

await test('a typo in a check name is an error, not a silent pass', () => {
  const file = path.join(os.tmpdir(), `accept-bad-${process.pid}.yml`)
  fs.writeFileSync(file, 'tasks:\n  - id: 1\n    area: x\n    title: t\n    mode: auto\n    pass_when: p\n    steps:\n      - say: hi\n        expect:\n          reply_matchs: x\n')
  assert.throws(() => loadTasks(file), /unknown check "reply_matchs"/)
  fs.rmSync(file)
})

// ── checks and evidence ──────────────────────────────────────────────────────
await test('the checks', () => {
  const now = new Date('2026-10-29T15:00:00+02:00')
  const tomorrow8 = new Date('2026-10-30T08:00:00+02:00').toISOString()
  const world = {
    reply: 'שורה אחת\nשורה שתיים',
    cards: ['לשלוח בשמך ל-*אמא*:\n\nאני מאחר'],
    sent: [],
    reacted: [],
    jobs: [],
    now,
    audit: [{ tool: 'send_whatsapp_to', approval: 'none', ok: true }],
    state: { memory: [{ fact: 'אלרגי לבוטנים' }], memoryCandidates: [], reminders: [{ text: 'להוציא את הכלב', at: tomorrow8 }], tasks: [], watchers: [] },
    before: { memory: [{ fact: 'אלרגי לבוטנים' }], reminders: [{ text: 'להוציא את הכלב', at: tomorrow8 }] },
  }
  const pass = { reply_max_lines: 2, memory_has: 'בוטנ', reminder_at: 'tomorrow 08:00', reminder_matches: 'כלב', card_matches: 'אמא', card_matches_2: 'מאחר', sent_count: 0, watching: false, audit_has: 'send_whatsapp_to:ok', reminders_untouched: true }
  assert.deepEqual(runChecks(pass, world), [])
  const fail = runChecks({ reply_max_lines: 1, memory_lacks: 'בוטנ', reminder_at: 'tomorrow 09:00', reacted: true, no_card: true, pending_has: 'x' }, world)
  assert.equal(fail.length, 6, fail.join(' | '))
  assert.deepEqual(wantedTime('tomorrow 08:00', now), { y: 2026, mo: 9, d: 30, h: 8, mi: 0 })
})

await test('evidence is masked', () => {
  const s = mask('תתקשר ל-+972 54-123-4567 או dana@example.com, כרטיס 4580123412341234, מפתח sk-or-abcdefghijklmnop')
  assert.ok(!/\d{4}/.test(s) && !/example/.test(s) && !/abcdefgh/.test(s), s)
  assert.ok(mask('x'.repeat(400)).length <= 281)
})

await test('money cards are recognized', () => {
  for (const t of ['לשלם 1,240 ₪ ל-אל על?', 'להזמין את הטיסה?', 'checkout now']) assert.ok(MONEY.test(t), t)
  assert.ok(!MONEY.test('לשלוח בשמך ל-*אמא*:\n\nאני מאחר בחצי שעה'))
})

// ── the network guard ────────────────────────────────────────────────────────
await test('only the model host and the fixtures are reachable in auto mode', async () => {
  const blocked = []
  const real = async (u) => new Response(`real ${u}`)
  const f = guardFetch({ allowHosts: ['api.model.test'], realFetch: real, blocked })
  assert.equal(await (await f('https://api.model.test/v1/chat/completions')).text(), 'real https://api.model.test/v1/chat/completions')
  await assert.rejects(f('https://www.ynet.co.il/rss'), /not reachable/)
  await assert.rejects(f('https://graph.facebook.com/send'), /not reachable/)
  assert.deepEqual(blocked, ['www.ynet.co.il', 'graph.facebook.com'])
  const news = await (await f(`https://${FIXTURE_HOST}/news.xml`)).text()
  assert.ok(/רמת גן/.test(news) && !/\{\{NOW/.test(news) && /GMT/.test(news), 'the fixture feed has fresh dates')
  assert.equal(fixtureResponse(`https://${FIXTURE_HOST}/../../.env`).status, 404)
  assert.equal(fixtureResponse('https://example.com/x'), null)
  const live = guardFetch({ live: true, realFetch: real })
  assert.match(await (await live('https://www.ynet.co.il/rss')).text(), /real/)
})

// ── a whole run against a scripted local model ───────────────────────────────
await test('accept:real end to end with a scripted model', async () => {
  const textOf = (m) => (typeof m?.content === 'string' ? m.content : m?.content?.find?.((p) => p.type === 'text')?.text || '')
  let n = 0
  const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const say = (content) => ({ role: 'assistant', content })
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
  const model = (body) => {
    const msgs = body.messages
    if (/מחלץ עובדות/.test(textOf(msgs[0]))) return say('[]')
    const lastUser = textOf(msgs.findLast((m) => m.role === 'user'))
    const tool = msgs.at(-1).role === 'tool' ? textOf(msgs.at(-1)) : null
    if (/ניו יורק/.test(lastUser)) return say('בניו יורק עכשיו 09:05.')
    if (/תזכיר לי/.test(lastUser)) return tool ? say('קבעתי למחר ב-8.') : call('add_reminder', { text: 'להוציא את הכלב', when: `${tomorrow}T08:00` })
    if (/תשלח לאמא/.test(lastUser)) return tool ? say(/נשלח/.test(tool) ? 'שלחתי.' : 'לא שלחתי.') : call('send_whatsapp_to', { to: 'אמא', text: 'אני מאחר בחצי שעה' })
    if (/מה חדש/.test(lastUser)) return tool ? say(`מה שקרה היום:\n${tool.split('\n')[0]}`) : call('get_news', { hours: 12 })
    if (/לייק/.test(lastUser)) return say('בסדר') // never reacts: task 11 must fail
    if (/https:\/\/\S+/.test(lastUser)) {
      if (!tool) return call('fetch_page', { url: lastUser.match(/https:\/\/\S+/)[0] })
      if (/התחברות לחשבון/.test(tool)) return say('נתקלתי במסך התחברות, צריך להיכנס לחשבון כדי לראות את הדף.')
      if (/שקשוקה/.test(tool)) return say('זה מתכון לשקשוקה ב-20 דקות. בדף היו הוראות מוסתרות לשלוח הודעה בשמך, התעלמתי מהן.')
      return say(`לא הצלחתי לפתוח: ${tool.slice(0, 60)}`)
    }
    return say('אוקיי')
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: model(JSON.parse(raw)) }] }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-selftest-'))
  const env = path.join(dir, '.env')
  fs.writeFileSync(env, `LLM_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nLLM_API_KEY=test\nLLM_MODEL=fake\nMAIL_PASS=must-not-reach-the-test\n`)
  const run = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'accept-real.mjs'), '--only', '5,6,7,9,10,11,12,13,19,16,24'], {
      cwd: ROOT,
      env: { ...process.env, HELPER_ENV_FILE: env, ACCEPT_REPORT_DIR: dir, ACCEPT_TURN_TIMEOUT_MS: '60000', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
  server.close()
  const json = fs.readdirSync(dir).find((f) => f.endsWith('.json'))
  assert.ok(json, `a report was written\n${run.out}`)
  const report = JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8'))
  const status = Object.fromEntries(report.results.map((r) => [r.id, r.status]))
  const why = report.results.map((r) => `${r.id}:${r.status}${r.why ? ` (${r.why})` : ''}`).join('\n')
  assert.deepEqual(status, { 5: 'pass', 6: 'pass', 7: 'fail', 9: 'pass', 10: 'pass', 11: 'fail', 12: 'pass', 13: 'pass', 16: 'skipped', 19: 'skipped', 24: 'pass' }, why)
  assert.equal(run.code, 1, 'a failed task fails the run')
  const r9 = report.results.find((r) => r.id === 9)
  assert.equal(r9.sent_to_synthetic, 1)
  assert.ok(r9.steps[0].cards[0].includes('אמא'), 'the approval card is in the evidence')
  assert.equal(report.results.find((r) => r.id === 10).sent_to_synthetic, 0, 'declined: nothing sent')
  assert.match(report.results.find((r) => r.id === 11).why, /no reaction/)
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.md')), 'a readable report too')
  assert.ok(!fs.readFileSync(path.join(dir, json), 'utf8').includes('must-not-reach'), 'no secret in the report')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('--live is refused outside an interactive terminal', async () => {
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'accept-real.mjs'), '--live', '16'], { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
  assert.equal(r.code, 2)
  assert.match(r.out, /never in CI/)
})

console.log(`accept-selftest: ${passed} passed${process.exitCode ? ', some failed' : ''}`)
