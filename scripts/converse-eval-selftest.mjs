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
import { loadCases, planRuns, planMin, preflightText, refusal, routeOf, wholeNumber, childProcessEnv, writeEvalEnv, INHERITED, REAL_REQUEST_CEILING } from './converse-eval.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'converse-eval.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-converse-selftest-'))
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
    proc.on('close', (code) => {
      const files = fs.readdirSync(out)
      const json = files.find((f) => f.endsWith('.json'))
      const written = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n')
      resolve({ code, text, files, written, report: json ? JSON.parse(fs.readFileSync(path.join(out, json), 'utf8')) : null })
    })
  })
}

// A model stand-in on this machine: counts what arrives and answers one plain line.
function standIn() {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      hits.push({ url: req.url, auth: req.headers.authorization || '', model: JSON.parse(body || '{}').model })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'בסדר' } }] }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ hits, port: server.address().port, close: () => server.close() })))
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
  const ok = { real: true, cap: 10, confirm: 'm@h', plan: small }
  assert.equal(refusal(ok), '')
  assert.match(refusal({ ...ok, cap: null }), /needs --max-requests/)
  assert.match(refusal({ ...ok, cap: NaN }), /whole number/)
  assert.match(refusal({ ...ok, cap: REAL_REQUEST_CEILING + 1 }), /over the ceiling/)
  assert.match(refusal({ ...ok, cap: 2 }), /at least 3 requests and the cap is 2/)
  assert.match(refusal({ ...ok, confirm: '' }), /--confirm-route/)
  assert.match(refusal({ ...ok, plan: [] }), /no run matches/)
  assert.ok(planMin(everything(true)) > REAL_REQUEST_CEILING, 'the whole set cannot be a real batch: a subset has to be chosen')
  assert.match(refusal({ real: true, cap: REAL_REQUEST_CEILING, confirm: 'm@h', plan: everything(true) }), /smaller subset/)
  assert.equal(refusal({ real: false, cap: null, confirm: '', plan: everything(false) }), '', 'offline needs no cap: the stand-in answers')
  assert.match(refusal({ real: false, cap: 2, confirm: '', plan: small }), /cap is 2/, 'but a cap given offline holds too')
  assert.equal(routeOf({ LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.example.invalid/v1' }), 'm@api.example.invalid')
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
  for (const [args, env, why] of [
    [['--real'], { HELPER_ENV_FILE: unreadable }, /needs --max-requests/],
    [['--real', '--max-requests'], { HELPER_ENV_FILE: unreadable }, /whole number/],
    [['--real', '--max-requests', '1000', '--confirm-route', 'stand-in-model@127.0.0.1'], { HELPER_ENV_FILE: unreadable }, /over the ceiling/],
    [['--real', '--max-requests', '100', '--confirm-route', 'stand-in-model@127.0.0.1'], { HELPER_ENV_FILE: unreadable }, /smaller subset/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1'], { HELPER_ENV_FILE: unreadable }, /--confirm-route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'other-model@elsewhere.invalid'], { HELPER_ENV_FILE: withKey }, /does not match the route/],
    [['--real', '--max-requests', '10', '--only', 'chosen-option', '--max-runs', '1', '--confirm-route', 'stand-in-model@127.0.0.1'], { HELPER_ENV_FILE: path.join(tmp, 'no-such.env') }, /LLM_API_KEY and LLM_MODEL are needed/],
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
  const args = ['--real', '--only', 'listen-first', '--conditions', 'compacted', '--max-runs', '1', '--confirm-route', 'stand-in-model@127.0.0.1']
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
    assert.equal(model.hits.length, 0)
  } finally {
    model.close()
    backup.close()
  }
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed${process.exitCode ? ', some failed' : ''}`)
