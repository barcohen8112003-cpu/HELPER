// node scripts/converse-eval-selftest.mjs: the safety of the conversation evaluation harness itself, offline.
// What reaches the evaluation's child process (a short list of system variables, never the parent's keys, service
// settings or NODE_OPTIONS), the preflight, and the hard request cap, which holds on the real path too: here
// "real" is a stand-in server on 127.0.0.1 with a made-up key. No model, no .env of his, nothing leaves the machine.
// Every secret-looking value in this file is synthetic and carries the word "sentinel".
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCases, planRuns, planMin, preflightText, refusal, routeOf, endpointOf, targetOf, batchStatus, wholeNumber, childProcessEnv, writeEvalEnv, INHERITED, REAL_REQUEST_CEILING } from './converse-eval.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'converse-eval.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-converse-selftest-'))
let passed = 0
const test = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    if (process.env.SELFTEST_TIMES) console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${name}`)
    passed++
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

// Things a parent shell may hold that the child has no use for. All made up.
const SENTINELS = {
  LLM_API_KEY: 'sentinel-llm-key',
  LLM_BACKUP_API_KEY: 'sentinel-backup-key',
  LLM_FALLBACK_MODEL: 'sentinel-fallback-model',
  OPENAI_API_KEY: 'sentinel-openai',
  GMAIL_APP_PASSWORD: 'sentinel-mail',
  GOOGLE_CLIENT_SECRET: 'sentinel-google',
  TELNYX_API_KEY: 'sentinel-telnyx',
  BACKUP_PASSPHRASE: 'sentinel-passphrase',
  WEBTOP_PASSWORD: 'sentinel-webtop',
  HTTPS_PROXY: 'http://sentinel-proxy.invalid:1',
  COMPUTER_MODE: 'sentinel-full',
  EVAL_UNRELATED_SETTING: 'sentinel-unrelated',
}

// One batch of the script, as a user would start it.
function run(args, env = {}) {
  const out = fs.mkdtempSync(path.join(tmp, 'report-'))
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, CONVERSE_REPORT_DIR: out, HELPER_ENV_FILE: path.join(tmp, 'no-such.env'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    proc.stdout.on('data', (d) => (text += d))
    proc.stderr.on('data', (d) => (text += d))
    // A batch that hangs is a failure of its own, not a test run that never ends.
    const limit = setTimeout(() => proc.kill('SIGKILL'), 90000)
    proc.on('close', (code) => {
      clearTimeout(limit)
      const files = fs.readdirSync(out)
      const json = files.find((f) => f.endsWith('.json'))
      const written = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n')
      resolve({ code, text, files, written, report: json ? JSON.parse(fs.readFileSync(path.join(out, json), 'utf8')) : null })
    })
  })
}

// A model stand-in on this machine: counts what arrives and answers one plain line, unless `answer` says otherwise
// (answer(hit, n) returns { status, headers, body } or nothing for the plain line). Listens on every loopback name.
const OK = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'בסדר' } }] })
const summaryRequest = (body) => !body.tools && /^סיכום קודם:/.test(String(body.messages?.[1]?.content || ''))
function standIn(answer = () => null) {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const hit = { url: req.url, host: req.headers.host, auth: req.headers.authorization || '', model: parsed.model, summary: summaryRequest(parsed), bytes: body.length }
      hits.push(hit)
      const a = answer(hit, hits.length) || { status: 200, body: OK }
      res.writeHead(a.status, { 'Content-Type': 'application/json', ...(a.headers || {}) })
      res.end(a.body || '{"error":{"message":"synthetic"}}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ hits, port: server.address().port, close: () => server.close() })))
}
const routeEnv = (name, port) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, [`LLM_BASE_URL=http://127.0.0.1:${port}/v1`, 'LLM_API_KEY=synthetic-route-key', 'LLM_MODEL=stand-in-model'].join('\n'))
  return file
}

const data = loadCases()
const everything = (real) => planRuns(data, { roots: [0], modes: real ? ['configured'] : ['full', 'light', 'voice'], conditions: ['fresh', 'compacted'] })

// ── what the child inherits ──────────────────────────────────────────────────
await test('the child gets system variables by name and nothing else of the parent', () => {
  const parent = { PATH: '/usr/bin', HOME: '/home/someone', TMPDIR: '/tmp/x', LANG: 'he_IL.UTF-8', NODE_OPTIONS: '--require /sentinel/preload.cjs', HELPER_DATA_DIR: '/sentinel/live-data', HELPER_ENV_FILE: '/sentinel/.env', ...SENTINELS }
  const env = childProcessEnv(parent, { HELPER_DATA_DIR: '/tmp/run', HELPER_ENV_FILE: '/tmp/run/eval.env', HELPER_OFFLINE: '1' }, 'linux')
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/someone', TMPDIR: '/tmp/x', LANG: 'he_IL.UTF-8', HELPER_DATA_DIR: '/tmp/run', HELPER_ENV_FILE: '/tmp/run/eval.env', HELPER_OFFLINE: '1' })
  assert.ok(!JSON.stringify(env).includes('sentinel'), 'no unrelated value, and not the parent\'s NODE_OPTIONS, data folder or .env path')
  assert.ok(!INHERITED.some((k) => /KEY|TOKEN|SECRET|PASS|PROXY|NODE_|LLM|HELPER/i.test(k)), 'the list itself holds only system names')
})

await test('on Windows the names match whatever their case', () => {
  const env = childProcessEnv({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', Temp: 'C:\\T', llm_api_key: 'sentinel' }, {}, 'win32')
  assert.deepEqual(env, { Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', Temp: 'C:\\T' })
  assert.deepEqual(childProcessEnv({ path: '/x', PATH: '/usr/bin' }, {}, 'linux'), { PATH: '/usr/bin' }, 'elsewhere the name is exact')
})

await test('the settings file of a real run holds the one route and no other model, provider or account', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'env-'))
  const envFile = path.join(dir, 'source.env')
  fs.writeFileSync(envFile, ['LLM_BASE_URL=https://route.invalid/v1', 'LLM_API_KEY="synthetic-route-key"', 'LLM_MODEL=route-model', 'LLM_LIGHT=true', 'LLM_FALLBACK_MODEL=sentinel-a,sentinel-b', 'LLM_CHEAP_MODEL=sentinel-cheap', 'LLM_STRONG_MODEL=sentinel-strong', 'LLM_BACKUP_BASE_URL=https://sentinel-backup.invalid/v1', 'LLM_BACKUP_API_KEY=sentinel-backup-key', 'LLM_BACKUP_MODEL=sentinel-backup-model', 'GMAIL_APP_PASSWORD=sentinel-mail', 'OWNER_NUMBER=sentinel-number', 'TIMEZONE=Asia/Jerusalem'].join('\n'))
  const real = fs.readFileSync(writeEvalEnv(dir, { real: true, envFile, mode: 'configured' }), 'utf8')
  assert.deepEqual(real.trim().split('\n').map((l) => l.split('=')[0]).sort(), ['COMPUTER_MODE', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_LIGHT', 'LLM_MODEL', 'MEMORY_LEARN', 'TEAM_MODE', 'TIMEZONE'])
  assert.ok(!real.includes('sentinel'))
  const offline = fs.readFileSync(writeEvalEnv(dir, { real: false, envFile, mode: 'light' }), 'utf8')
  assert.equal(offline, 'LLM_LIGHT=true\nCOMPUTER_MODE=off\nMEMORY_LEARN=off\nTEAM_MODE=off\n', 'offline, the source .env is not read at all')
})

// ── the plan and the gate ────────────────────────────────────────────────────
await test('the plan counts runs and the least requests they mean', () => {
  const variants = data.cases.reduce((n, c) => n + c.variants.length, 0)
  const messages = data.cases.reduce((n, c) => n + c.variants.reduce((m, v) => m + v.turns.filter((t) => !t.event).length, 0), 0)
  assert.equal(everything(false).length, variants * 6)
  assert.equal(planMin(everything(false)), messages * 6)
  assert.equal(everything(true).length, variants * 2)
  assert.equal(planMin(everything(true)), messages * 2)
  const two = planRuns(data, { roots: [0, 1], only: ['chosen-option'], modes: ['light'], conditions: ['fresh', 'compacted'], maxRuns: 1 })
  assert.deepEqual(two.map((p) => [p.root, p.id, p.v, p.condition, p.min]), [[0, 'chosen-option', 0, 'fresh', 3], [1, 'chosen-option', 0, 'fresh', 3]], 'a subset is the same run on every checkout')
  const text = preflightText(two, { real: true, cap: 8, labels: ['baseline', 'candidate'] })
  assert.match(text, /real model: 1 cases, 1 variants, 2 runs \(baseline 1, candidate 1\)/)
  assert.match(text, /at least 6 /)
  assert.match(text, /request cap: 8, the batch stops before request 9/)
})

await test('numbers are whole numbers or nothing', () => {
  assert.equal(wholeNumber(null), null)
  assert.equal(wholeNumber('30'), 30)
  for (const bad of ['', '0', '-5', '1e9', '12.5', 'all', 'Infinity', '--real', '9999999999']) assert.ok(Number.isNaN(wholeNumber(bad)), bad)
})

await test('a real batch is refused without a cap, over the ceiling, over its cap, or without the typed route', () => {
  const small = planRuns(data, { roots: [0], only: ['chosen-option'], modes: ['configured'], conditions: ['fresh'], maxRuns: 1 })
  const ok = { real: true, cap: 10, confirm: 'm@https://h.invalid/v1', plan: small }
  assert.equal(refusal(ok), '')
  assert.match(refusal({ ...ok, cap: null }), /needs --max-requests/)
  assert.match(refusal({ ...ok, cap: NaN }), /whole number/)
  assert.match(refusal({ ...ok, cap: REAL_REQUEST_CEILING + 1 }), /over the ceiling/)
  assert.match(refusal({ ...ok, cap: 2 }), /at least 3 requests and the cap is 2/)
  assert.match(refusal({ ...ok, confirm: '' }), /--confirm-route/)
  assert.match(refusal({ ...ok, plan: [] }), /no run matches/)
  assert.ok(planMin(everything(true)) > REAL_REQUEST_CEILING, 'the whole set cannot be a real batch: a subset has to be chosen')
  assert.match(refusal({ real: true, cap: REAL_REQUEST_CEILING, confirm: 'm@https://h.invalid/v1', plan: everything(true) }), /smaller subset/)
  assert.match(refusal({ ...ok, missing: ['baseline (/x)'] }), /not a Helper checkout/)
  assert.equal(refusal({ real: false, cap: null, confirm: '', plan: everything(false) }), '', 'offline needs no cap: the stand-in answers')
  assert.match(refusal({ real: false, cap: 2, confirm: '', plan: small }), /cap is 2/, 'but a cap given offline holds too')
})

await test('the route is the whole endpoint: scheme, host, port and path', () => {
  assert.equal(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.example.invalid/v1/' }), 'm@https://api.example.invalid/v1')
  assert.equal(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'http://127.0.0.1:5000/v1' }), 'm@http://127.0.0.1:5000/v1')
  assert.notEqual(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'http://127.0.0.1:5000/v1' }), routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'http://127.0.0.1:5001/v1' }), 'another port is another route')
  assert.notEqual(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.example.invalid/v1' }), routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.example.invalid/v2' }), 'another path is another route')
  assert.notEqual(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'https://127.0.0.1/v1' }), routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'http://127.0.0.1/v1' }), 'another scheme is another route')
  for (const bad of ['http://api.example.invalid/v1', 'ftp://127.0.0.1/v1', 'https://user:pw@api.example.invalid/v1', 'https://api.example.invalid/v1?k=1', 'https://api.example.invalid/v1#x', 'not a url', 'file:///etc']) {
    assert.equal(endpointOf(bad), null, bad)
    assert.equal(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: bad }), '', bad)
  }
  const at = endpointOf('http://127.0.0.1:5000/v1')
  assert.equal(targetOf('http://127.0.0.1:5000/v1/chat/completions'), at)
  for (const other of ['http://localhost:5000/v1/chat/completions', 'http://127.0.0.1:5001/v1/chat/completions', 'https://127.0.0.1:5000/v1/chat/completions', 'http://127.0.0.1:5000/v1/chat/completions/x', 'http://127.0.0.1:5000/elsewhere', 'http://127.0.0.1:5000/v1/chat/completions?x=1', 'http://u:p@127.0.0.1:5000/v1/chat/completions']) assert.notEqual(targetOf(other), at, other)
})

await test('the batch status: only a whole, finished batch is a success', () => {
  const run = (root, status, extra = {}) => ({ root, case: 'c', variant: 'v', mode: 'm', condition: 'x', status, ...extra })
  assert.equal(batchStatus([run('this', 'complete')], { planned: 1, roots: ['this'] }).code, 0)
  assert.equal(batchStatus([run('this', 'failed')], { planned: 1, roots: ['this'] }).code, 1)
  assert.equal(batchStatus([run('this', 'complete')], { planned: 2, roots: ['this'] }).code, 1, 'fewer runs than planned is not a success')
  assert.equal(batchStatus([run('this', 'stopped', { capHit: true })], { planned: 1, roots: ['this'], stopped: 'cap' }).code, 3)
  assert.equal(batchStatus([run('this', 'failed', { routeViolation: 'r' })], { planned: 1, roots: ['this'], stopped: 'r' }).code, 4)
  const pair = batchStatus([run('baseline', 'failed'), run('candidate', 'complete')], { planned: 2, roots: ['baseline', 'candidate'] })
  assert.deepEqual([pair.code, pair.comparable, pair.pairs, pair.word], [1, 0, 1, 'FAILED'])
})

// ── whole batches ────────────────────────────────────────────────────────────
// A folder where the .env would be: reading it as a file throws, so a pass shows it was never opened.
const unreadable = fs.mkdtempSync(path.join(tmp, 'env-is-a-folder-'))

await test('a dry run prints the plan and does nothing else', async () => {
  const r = await run(['--dry-run', '--real', '--only', 'chosen-option,draft-edit'], { ...SENTINELS, HELPER_ENV_FILE: unreadable })
  assert.equal(r.code, 0, r.text)
  assert.match(r.text, /preflight, real model: 2 cases, 4 variants, 8 runs \(this 8\)/)
  assert.match(r.text, /at least 20 /)
  assert.match(r.text, /no \.env read, no process started, nothing sent/)
  assert.deepEqual(r.files, [], 'no report, because nothing ran')
  assert.ok(!r.text.includes('sentinel'))
  const all = await run(['--dry-run'])
  assert.match(all.text, new RegExp(`${everything(false).length} runs`))
})

await test('--real with a key in reach and nothing else starts nothing', async () => {
  const withKey = path.join(tmp, 'with-key.env')
  fs.writeFileSync(withKey, 'LLM_BASE_URL=http://127.0.0.1:9/v1\nLLM_API_KEY=sentinel-file-key\nLLM_MODEL=stand-in-model\n')
  const plainHttp = path.join(tmp, 'plain-http.env')
  fs.writeFileSync(plainHttp, 'LLM_BASE_URL=http://198.51.100.7/v1\nLLM_API_KEY=sentinel-file-key\nLLM_MODEL=stand-in-model\n')
  for (const [args, env, why] of [
    [['--real'], { HELPER_ENV_FILE: unreadable }, /needs --max-requests/],
    [['--real', '--max-requests'], { HELPER_ENV_FILE: unreadable }, /whole number/],
    [['--real', '--max-requests', '1000', '--confirm-route', 'stand-in-model@http://127.0.0.1:9/v1'], { HELPER_ENV_FILE: unreadable }, /over the ceiling/],
    [['--real', '--max-requests', '100', '--confirm-route', 'stand-in-model@http://127.0.0.1:9/v1'], { HELPER_ENV_FILE: unreadable }, /smaller subset/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1'], { HELPER_ENV_FILE: unreadable }, /--confirm-route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'other-model@elsewhere.invalid'], { HELPER_ENV_FILE: withKey }, /does not match the route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@127.0.0.1'], { HELPER_ENV_FILE: withKey }, /does not match the route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@http://127.0.0.1:10/v1'], { HELPER_ENV_FILE: withKey }, /does not match the route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@https://127.0.0.1:9/v1'], { HELPER_ENV_FILE: withKey }, /does not match the route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@http://127.0.0.1:9/v1'], { HELPER_ENV_FILE: path.join(tmp, 'no-such.env') }, /LLM_API_KEY and LLM_MODEL are needed/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@http://198.51.100.7/v1'], { HELPER_ENV_FILE: plainHttp }, /not an endpoint a real run may use/],
  ]) {
    const r = await run(args, { ...SENTINELS, ...env })
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.text}`)
    assert.match(r.text, why)
    assert.match(r.text, /Nothing ran\./)
    assert.deepEqual(r.files, [])
    assert.ok(!r.text.includes('sentinel'), 'no key or unrelated value is printed')
  }
})

await test('what the parent holds does not reach the child, and the run still works', async () => {
  const marker = path.join(tmp, 'preloaded.txt')
  const preload = path.join(tmp, 'sentinel-preload.cjs')
  fs.writeFileSync(preload, `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' ') + '\\n')\n`)
  const r = await run(['--only', 'chosen-option', '--modes', 'light', '--conditions', 'fresh', '--max-runs', '1'], { ...SENTINELS, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${preload}`.trim() })
  assert.equal(r.code, 0, r.text)
  const [one] = r.report.runs
  assert.ok(!one.error && one.needs.length && one.needs.every((n) => n.verdict === 'ok'), 'the run itself is whole')
  const own = ['HELPER_DATA_DIR', 'HELPER_ENV_FILE', 'HELPER_OFFLINE']
  const extra = one.inheritedEnv.filter((k) => !own.includes(k) && !INHERITED.some((a) => a.toUpperCase() === k.toUpperCase()) && k !== '__CF_USER_TEXT_ENCODING')
  assert.deepEqual(extra, [], 'only listed names reached the child')
  for (const k of [...Object.keys(SENTINELS), 'NODE_OPTIONS', 'CONVERSE_REPORT_DIR']) assert.ok(!one.inheritedEnv.includes(k), k)
  for (const k of own) assert.ok(one.inheritedEnv.includes(k), k)
  assert.ok(!(r.text + r.written).includes('sentinel'), 'no value of them in the output or the report')
  const loaded = fs.readFileSync(marker, 'utf8').trim().split('\n')
  assert.ok(loaded.length >= 1 && !loaded.some((l) => l.includes('--child')), 'the parent\'s NODE_OPTIONS preload ran in the parent only')
  assert.deepEqual(one.blocked, [])
})

await test('offline, the cap stops the batch before the request over it', async () => {
  const args = ['--only', 'chosen-option', '--modes', 'light', '--conditions', 'compacted']
  const free = await run(args)
  assert.equal(free.code, 0, free.text)
  const each = free.report.runs.map((x) => x.modelRequests)
  assert.ok(each.length === 2 && each.every((n) => n > 3), 'each run asks more than its minimum (a tool round, a summary)')
  assert.equal(free.report.requestsUsed, each[0] + each[1])
  // Room for the first run and for the start of the second: the second is cut in the middle.
  const cap = each[0] + 4
  const cut = await run([...args, '--max-requests', String(cap)])
  assert.equal(cut.code, 3, cut.text)
  assert.equal(cut.report.requestsUsed, cap)
  assert.ok(cut.report.runs[1].capHit && /request cap/.test(cut.report.runs[1].error))
  assert.match(cut.report.stopped, new RegExp(`${cap} of ${cap} used, request ${cap + 1} was not sent`))
  // Not enough left for the second run's minimum: it does not start.
  const short = await run([...args, '--max-requests', String(each[0] + 2)])
  assert.equal(short.code, 3, short.text)
  assert.equal(short.report.runs.length, 1)
  assert.equal(short.report.planned, 2)
  assert.equal(short.report.requestsUsed, each[0])
  assert.match(short.report.stopped, /the next run needs at least 3/)
})

await test('on the real path the cap holds at the wire, on the one route', async () => {
  const model = await standIn()
  const backup = await standIn()
  const envFile = path.join(tmp, 'route.env')
  fs.writeFileSync(envFile, [`LLM_BASE_URL=http://127.0.0.1:${model.port}/v1`, 'LLM_API_KEY=synthetic-route-key', 'LLM_MODEL=stand-in-model', 'LLM_FALLBACK_MODEL=sentinel-fallback', 'LLM_CHEAP_MODEL=sentinel-cheap', `LLM_BACKUP_BASE_URL=http://127.0.0.1:${backup.port}/v1`, 'LLM_BACKUP_API_KEY=sentinel-backup-key', 'LLM_BACKUP_MODEL=sentinel-backup-model', 'GMAIL_APP_PASSWORD=sentinel-mail'].join('\n'))
  const args = ['--real', '--only', 'listen-first', '--conditions', 'compacted', '--max-runs', '1', '--confirm-route', `stand-in-model@http://127.0.0.1:${model.port}/v1`]
  try {
    // The minimum is 3 (three messages, no tool in this case); folding adds a summary request, so a cap of 3 is reached.
    const cut = await run([...args, '--max-requests', '3'], { ...SENTINELS, HELPER_ENV_FILE: envFile })
    assert.equal(cut.code, 3, cut.text)
    assert.equal(model.hits.length, 3, 'exactly the cap arrived, the next request never left')
    assert.equal(cut.report.requestsUsed, 3)
    assert.ok(cut.report.runs[0].capHit)
    model.hits.length = 0
    const whole = await run([...args, '--max-requests', '20'], { ...SENTINELS, HELPER_ENV_FILE: envFile })
    assert.equal(whole.code, 0, whole.text)
    assert.equal(whole.report.status, 'COMPLETE')
    assert.ok(model.hits.length > 3 && model.hits.length <= 20)
    assert.equal(whole.report.requestsUsed, model.hits.length, 'the count is what arrived')
    assert.ok(model.hits.every((h) => h.model === 'stand-in-model' && h.auth === 'Bearer synthetic-route-key' && h.url === '/v1/chat/completions'))
    assert.equal(backup.hits.length, 0, 'no other provider')
    assert.ok(!(whole.text + whole.written + cut.text + cut.written).includes('sentinel'))
    assert.ok(!(whole.text + whole.written + cut.text + cut.written).includes('synthetic-route-key'), 'the key is in no output and no report')
    for (const k of Object.keys(SENTINELS)) assert.ok(!whole.report.runs[0].inheritedEnv.includes(k), k)

    // The child on its own, as if someone skipped the parent: no allowance, no request.
    model.hits.length = 0
    for (const extra of [[], ['--allowance', String(REAL_REQUEST_CEILING + 1)], ['--allowance', 'all']]) {
      const dir = fs.mkdtempSync(path.join(tmp, 'child-'))
      const code = await new Promise((resolve) => spawn(process.execPath, [SCRIPT, '--child', 'chosen-option', '--variant', '0', '--condition', 'fresh', '--mode', 'configured', '--src', ROOT, '--real', ...extra], { cwd: ROOT, env: { ...process.env, HELPER_DATA_DIR: dir, HELPER_ENV_FILE: envFile, HELPER_OFFLINE: '1' }, stdio: 'ignore' }).on('close', resolve))
      assert.equal(code, 2, extra.join(' '))
    }
    // With an allowance but a route that is not the one its settings lead to (another port): nothing is sent.
    for (const route of [[], ['--route', `stand-in-model@http://127.0.0.1:${model.port + 1}/v1`], ['--route', `stand-in-model@http://localhost:${model.port}/v1`]]) {
      const dir = fs.mkdtempSync(path.join(tmp, 'child-'))
      const code = await new Promise((resolve) => spawn(process.execPath, [SCRIPT, '--child', 'chosen-option', '--variant', '0', '--condition', 'fresh', '--mode', 'configured', '--src', ROOT, '--real', '--allowance', '5', ...route], { cwd: ROOT, env: { ...process.env, HELPER_DATA_DIR: dir, HELPER_ENV_FILE: envFile, HELPER_OFFLINE: '1' }, stdio: 'ignore' }).on('close', resolve))
      assert.equal(code, 2, route.join(' ') || 'no route')
    }
    assert.equal(model.hits.length, 0)
  } finally {
    model.close()
    backup.close()
  }
})

// ── redirects: the endpoint may not send the conversation anywhere else ─────
await test('a redirect from the model endpoint is never followed, whatever its target', async () => {
  const elsewhere = await standIn()
  const cases = [
    ['cross-port 307', 307, (p) => `http://localhost:${elsewhere.port}/elsewhere`],
    ['cross-host, same port 307', 307, (p) => `http://localhost:${p}/v1/chat/completions`],
    ['same origin, other path 307', 307, () => '/v1/elsewhere'],
    ['scheme change 308', 308, (p) => `https://127.0.0.1:${p}/v1/chat/completions`],
    ['cross-port 302', 302, (p) => `http://127.0.0.1:${elsewhere.port}/v1/chat/completions`],
    ['cross-port 301 with a query', 301, (p) => `http://127.0.0.1:${elsewhere.port}/v1/chat/completions?k=1`],
  ]
  for (const [name, status, where] of cases) {
    let port = 0
    const model = await standIn((hit) => (hit.url === '/v1/chat/completions' && hit.host === `127.0.0.1:${port}` ? { status, headers: { Location: where(port) }, body: '{}' } : null))
    port = model.port
    elsewhere.hits.length = 0
    try {
      const r = await run(['--real', '--only', 'listen-first', '--conditions', 'compacted', '--max-runs', '1', '--max-requests', '20', '--confirm-route', `stand-in-model@http://127.0.0.1:${port}/v1`], { HELPER_ENV_FILE: routeEnv('redirect.env', port) })
      assert.equal(r.code, 4, `${name}: ${r.text}`)
      assert.deepEqual(model.hits.map((h) => h.url), ['/v1/chat/completions'], `${name}: only the first request reached the confirmed endpoint, and nothing else arrived at its server`)
      assert.equal(elsewhere.hits.length, 0, `${name}: the other server received nothing`)
      assert.equal(r.report.status, 'FAILED (route)')
      assert.equal(r.report.requestsUsed, 1, `${name}: the one request that left is counted`)
      const [one] = r.report.runs
      assert.ok(one.status === 'failed' && one.routeViolation && /not followed/.test(one.error), name)
      assert.ok(one.blocked.length, `${name}: the redirect target is listed as blocked`)
      assert.deepEqual(one.needs || [], [], `${name}: nothing is scored`)
      assert.match(r.text, /status: FAILED \(route\)/)
      assert.match(r.written, /FAILED, not counted, not conversational output/)
      assert.ok(!(r.text + r.written).includes('synthetic-route-key'))
    } finally {
      model.close()
    }
  }
  elsewhere.close()
})

// A checkout whose own client sends somewhere else than its settings say: the guard, not the route check, stops it.
await test('a model request to another port, path, host, scheme or model is not sent', async () => {
  const model = await standIn()
  const elsewhere = await standIn()
  const llm = fs.readFileSync(path.join(ROOT, 'src', 'llm.js'), 'utf8')
  const from = "provider.baseUrl + '/chat/completions'"
  assert.ok(llm.includes(from), 'the client builds its URL as expected')
  const variants = [
    ['another port', `'http://127.0.0.1:${elsewhere.port}/v1/chat/completions'`],
    ['another path', `'http://127.0.0.1:${model.port}/v2/chat/completions'`],
    ['another host name', `'http://localhost:${model.port}/v1/chat/completions'`],
    ['another scheme', `'https://127.0.0.1:${model.port}/v1/chat/completions'`],
  ]
  try {
    for (const [name, to] of [...variants, ['another model', null]]) {
      const root = fs.mkdtempSync(path.join(tmp, 'patched-checkout-'))
      fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true })
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'))
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
      fs.writeFileSync(path.join(root, 'src', 'llm.js'), to ? llm.replace(from, to) : llm.replace('const body = { messages, ...extra }', "const body = { messages, ...extra, model: 'sentinel-other-model' }").replace('return await request({ ...body, model }, signal)', 'return await request({ model, ...body }, signal)'))
      model.hits.length = 0
      elsewhere.hits.length = 0
      const r = await run(['--real', '--root', root, '--only', 'listen-first', '--conditions', 'fresh', '--max-runs', '1', '--max-requests', '20', '--confirm-route', `stand-in-model@http://127.0.0.1:${model.port}/v1`], { HELPER_ENV_FILE: routeEnv('patched.env', model.port) })
      assert.equal(r.code, 4, `${name}: ${r.text}`)
      assert.equal(model.hits.length + elsewhere.hits.length, 0, `${name}: nothing arrived anywhere`)
      assert.equal(r.report.requestsUsed, 0)
      assert.equal(r.report.runs.length, 1, `${name}: the batch stopped at the baseline`)
      assert.ok(r.report.runs[0].routeViolation && r.report.runs[0].status === 'failed', name)
      fs.rmSync(root, { recursive: true, force: true })
    }
  } finally {
    model.close()
    elsewhere.close()
  }
})

// ── failed and incomplete runs are never presented as results ───────────────
await test('a checkout that is not one is refused before anything runs', async () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-checkout-'))
  const r = await run(['--root', empty, '--only', 'chosen-option', '--modes', 'light', '--conditions', 'fresh', '--max-runs', '1'])
  assert.equal(r.code, 2, r.text)
  assert.match(r.text, /not a Helper checkout/)
  assert.match(r.text, /Nothing ran\./)
  assert.deepEqual(r.files, [])
})

await test('a baseline that cannot even load fails the batch and the comparison', async () => {
  const broken = fs.mkdtempSync(path.join(tmp, 'broken-checkout-'))
  fs.mkdirSync(path.join(broken, 'src'))
  fs.writeFileSync(path.join(broken, 'src', 'config.js'), "throw new Error('synthetic broken checkout')\n")
  for (const f of ['store.js', 'agent.js', 'jobs.js', 'tools.js']) fs.writeFileSync(path.join(broken, 'src', f), 'export {}\n')
  const r = await run(['--root', broken, '--only', 'chosen-option', '--modes', 'light', '--conditions', 'fresh,compacted'])
  assert.equal(r.code, 1, r.text)
  assert.equal(r.report.status, 'FAILED')
  const base = r.report.runs.filter((x) => x.root === 'baseline')
  const cand = r.report.runs.filter((x) => x.root === 'candidate')
  assert.ok(base.length === 4 && base.every((x) => x.status === 'failed' && /crashed/.test(x.error)), 'every baseline run is a failure, with the reason')
  assert.ok(cand.length === 4 && cand.every((x) => x.status === 'complete'))
  assert.equal(r.report.comparablePairs, 0)
  assert.match(r.text, /0 of 4 pairs finished on every checkout .*comparison is incomplete/)
  assert.match(r.text, /candidate: 0\/0 needs in reach/, 'no number for the candidate stands against a missing baseline')
  assert.match(r.text, /Not valid evidence/)
  assert.match(r.written, /synthetic broken checkout/, 'the reason is kept in the report')
})

await test('a refused key: every message failed, the run is a diagnostic and the batch fails', async () => {
  const model = await standIn(() => ({ status: 401, body: '{"error":{"message":"synthetic: invalid key"}}' }))
  try {
    const r = await run(['--real', '--only', 'listen-first', '--conditions', 'fresh', '--max-runs', '1', '--max-requests', '20', '--confirm-route', `stand-in-model@http://127.0.0.1:${model.port}/v1`], { HELPER_ENV_FILE: routeEnv('refused.env', model.port) })
    assert.equal(r.code, 1, r.text)
    assert.equal(r.report.status, 'FAILED')
    const [one] = r.report.runs
    assert.equal(one.status, 'failed')
    assert.equal(one.scored, false)
    assert.deepEqual(one.needs, [], 'needs are not scored on a failed run')
    assert.equal(one.failures.length, 3, 'all three messages failed')
    assert.ok(one.modelErrors.includes('HTTP 401'))
    assert.ok(one.turns.filter((t) => !t.event).every((t) => t.failed && /turn failed: LLM HTTP 401/.test(t.reply)), 'the transcript keeps what happened')
    assert.equal(r.report.requestsUsed, model.hits.length)
    assert.match(r.text, /this: 0\/0 needs in reach.*1 runs failed or stopped and are not counted/)
    assert.match(r.written, /FAILED, not counted, not conversational output/)
    assert.match(r.written, /model endpoint: HTTP 401/)
  } finally {
    model.close()
  }
})

await test('one failed message among good ones still fails the run, and a real batch stops there', async () => {
  const model = await standIn((hit, n) => (n === 2 ? { status: 401 } : null))
  try {
    const r = await run(['--real', '--only', 'listen-first', '--conditions', 'fresh,compacted', '--max-runs', '2', '--max-requests', '40', '--confirm-route', `stand-in-model@http://127.0.0.1:${model.port}/v1`], { HELPER_ENV_FILE: routeEnv('partial.env', model.port) })
    assert.equal(r.code, 1, r.text)
    const [one] = r.report.runs
    assert.equal(r.report.runs.length, 1, 'the batch did not go on after the failed run')
    assert.equal(r.report.planned, 2)
    assert.equal(one.status, 'failed')
    assert.equal(one.failures.length, 1)
    assert.equal(one.turns.filter((t) => !t.event && !t.failed).length, 2, 'the good messages stay in the transcript')
    assert.match(r.text, /stopped after a failed run/)
    assert.equal(r.report.comparablePairs, 0)
  } finally {
    model.close()
  }
})

await test('a failed summary, which compaction swallows, still fails the run', async () => {
  // The first summary request gets a 503 and Helper's client tries again, which then succeeds: still not a clean run.
  let refusedOnce = false
  const model = await standIn((hit) => (hit.summary && !refusedOnce ? ((refusedOnce = true), { status: 503 }) : null))
  try {
    const r = await run(['--real', '--only', 'listen-first', '--conditions', 'compacted', '--max-runs', '1', '--max-requests', '40', '--confirm-route', `stand-in-model@http://127.0.0.1:${model.port}/v1`], { HELPER_ENV_FILE: routeEnv('summary.env', model.port) })
    assert.ok(model.hits.some((h) => h.summary), 'a summary was asked for')
    assert.equal(r.code, 1, r.text)
    const [one] = r.report.runs
    assert.equal(one.failures.length, 0, 'every message was answered')
    assert.ok(one.modelErrors.some((e) => /503 \(summary\)/.test(e)))
    assert.ok(model.hits.filter((h) => h.summary).length >= 2, 'the client tried the summary again')
    assert.equal(one.status, 'failed')
    assert.deepEqual(one.needs, [])
    assert.equal(r.report.requestsUsed, model.hits.length, 'every try is counted, retries included')
  } finally {
    model.close()
  }
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed${process.exitCode ? ', some failed' : ''}`)
