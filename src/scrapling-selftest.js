// node src/scrapling-selftest.js: the Node side of the Scrapling backend for fetch_page, offline.
// Node -> Python -> JSON with scripted stand-ins for the worker (schema, clean output, bad JSON, missing Python,
// timeout, stop, output cap, concurrency, no secrets in the child's environment), the URL guard, the fallback rules,
// and the bot path with a scripted model. The real worker's own tests: py/scrapling_worker_test.py.
// No request leaves this machine.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-scrapling-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1', LLM_API_KEY_FOR_LEAK_TEST: 'sk-should-not-leak' })

const S = await import('./scrapling.js')
const { config, ROOT } = await import('./config.js')

let passed = 0
let failed = 0
let skipped = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const skip = (name) => {
  skipped++
  console.log(`SKIP  ${name}`)
}

// ── the flag ────────────────────────────────────────────────────────────────
ok(config.scrapling.enabled === false, 'off by default')
ok(config.scrapling.timeoutMs === 30000 && config.scrapling.maxBytes === 2 * 1024 * 1024 && config.scrapling.maxChars === 30000 && config.scrapling.concurrency === 2, 'default limits: 30 s, 2 MB, 30,000 chars, 2 at once')

// ── the URL guard (before Python starts) ─────────────────────────────────────
for (const url of [
  'http://shop.example/', 'ftp://shop.example/', 'file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)',
  'https://u:p@shop.example/', 'https://shop.example:8443/', 'https://localhost/', 'https://nas.local/', 'https://intranet/',
  'https://127.0.0.1/', 'https://10.1.2.3/', 'https://172.20.0.1/', 'https://192.168.0.1/', 'https://100.100.0.1/',
  'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/', 'https://[::1]/', 'https://[fd00::1]/', 'https://[fe80::1]/',
  'https://[::ffff:127.0.0.1]/', 'https://[64:ff9b::a00:1]/', 'not a url',
]) ok(S.urlProblem(url) !== '', `refused: ${url}`)
for (const url of ['https://shop.example/', 'https://www.example.com/a?b=1', 'https://93.184.215.14/', 'https://[2606:4700::1]/']) ok(S.urlProblem(url) === '', `allowed: ${url}`)

// ── the answer's schema ──────────────────────────────────────────────────────
const good = { ok: true, url: 'https://shop.example/', final_url: 'https://shop.example/he', title: 'T', text: 'x', http_status: 200, truncated: false }
ok(S.validate(good).ok === true, 'a full answer passes')
ok(S.validate({ ...good, text: undefined }).kind === 'bad_output', 'a success without text is a failure')
ok(S.validate({ ok: true }).kind === 'bad_output', 'an empty success is a failure')
ok(S.validate({ ...good, final_url: 'https://10.0.0.1/' }).kind === 'bad_output', 'a success that ended on a private address is refused')
ok(S.validate({ ok: false, kind: 'whatever', error: 'e' }).kind === 'internal', 'an unknown failure kind becomes internal')
ok(S.validate({ ok: false, kind: 'blocked', error: 'x', http_status: 403 }).http_status === 403, 'the HTTP status is kept on a failure')
ok(S.validate([1]).kind === 'bad_output', 'an array is not an answer')

// ── Node -> Python -> JSON with scripted workers ─────────────────────────────
const which = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
const python = which.status === 0 ? which.stdout.trim() : ''
const fake = (name, body) => {
  const file = path.join(dir, `${name}.py`)
  fs.writeFileSync(file, `import sys, json, time, os\nreq = json.loads(sys.stdin.read() or '{}')\n${body}\n`)
  return file
}
const pageAnswer = (text, url = 'https://shop.example/') => `print(json.dumps({"ok": True, "url": req.get("url"), "final_url": req.get("url"), "title": "Shop", "text": ${JSON.stringify(text)}, "http_status": 200, "truncated": False}, ensure_ascii=False))`
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (!python) {
  skip('scripted workers: no python3 on this machine')
} else {
  const run = (script, opts = {}) => S.runWorker({ op: 'read', url: 'https://shop.example/' }, { python, script, ...opts })

  const r1 = await run(fake('ok', pageAnswer('שלום עולם')))
  ok(r1.ok && r1.text === 'שלום עולם' && r1.final_url === 'https://shop.example/', 'one clean JSON answer is read, Hebrew intact')

  ok((await run(fake('badjson', 'print("{not json")'))).kind === 'bad_output', 'invalid JSON is bad_output')
  ok((await run(fake('twolines', 'print("{}")\nprint("{}")'))).kind === 'bad_output', 'two lines on stdout is bad_output')
  ok((await run(fake('nothing', 'pass'))).kind === 'bad_output', 'no output is bad_output')
  ok((await run(fake('crash', 'raise SystemExit(3)'))).kind === 'bad_output', 'a crash without an answer is bad_output')
  ok((await run(fake('importerr', 'print(json.dumps({"ok": False, "kind": "missing_dependency", "error": "Scrapling לא מותקן: scrapling"}))'))).kind === 'missing_dependency', 'an import error is reported as missing_dependency')
  ok((await S.runWorker({}, { python: path.join(dir, 'no-such-python') })).kind === 'missing_dependency', 'a missing interpreter is missing_dependency')

  // The real worker under a Python that has no Scrapling: its own import error, as one JSON line.
  const bare = spawnSync(python, ['-I', '-c', 'import scrapling'], { encoding: 'utf8' })
  if (bare.status !== 0) {
    const r = await S.runWorker({ op: 'read', url: 'https://shop.example/' }, { python })
    ok(r.kind === 'missing_dependency', 'the real worker without Scrapling installed says missing_dependency')
  } else skip('system python has Scrapling, so the missing-import case is not reachable here')

  {
    const pidFile = path.join(dir, 'pid-timeout')
    const started = Date.now()
    const r = await run(fake('slow', `open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))\ntime.sleep(30)`), { timeoutMs: 1500 })
    ok(r.kind === 'timeout' && Date.now() - started < 5000, 'a hung worker hits the hard time limit')
    await new Promise((res) => setTimeout(res, 200))
    ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'and the process is killed')
  }
  {
    const pidFile = path.join(dir, 'pid-stop')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 600)
    const r = await run(fake('stop', `open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))\ntime.sleep(30)`), { signal: ac.signal })
    ok(r.kind === 'aborted', 'a stop from the user ends the read')
    await new Promise((res) => setTimeout(res, 200))
    ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'and the process is killed')
    const pre = new AbortController()
    pre.abort()
    ok((await run(fake('never', 'print("{}")'), { signal: pre.signal })).kind === 'aborted', 'an already stopped turn never starts Python')
  }
  ok((await run(fake('flood', 'sys.stdout.write("x" * 2000000)'), { outputCap: 100000 })).kind === 'bad_output', 'output past the cap is cut and refused')

  {
    const envFile = path.join(dir, 'env.json')
    await run(fake('env', `open(${JSON.stringify(envFile)}, "w").write(json.dumps(sorted(os.environ)))\n${pageAnswer('x')}`))
    const keys = JSON.parse(fs.readFileSync(envFile, 'utf8'))
    ok(!keys.includes('LLM_API_KEY_FOR_LEAK_TEST') && !keys.some((k) => /KEY|TOKEN|SECRET|PASS|PROXY/i.test(k)), 'no secrets or proxy settings in the worker\'s environment')
  }

  // Concurrency: four reads, at most two processes at a time.
  {
    S._setWorker(fake('sleepy', `time.sleep(0.6)\n${pageAnswer('x')}`))
    config.scrapling.python = python
    let peak = 0
    const timer = setInterval(() => (peak = Math.max(peak, S._queue().running)), 20)
    const t0 = Date.now()
    const all = await Promise.all([1, 2, 3, 4].map((i) => S.readWithScrapling(`https://shop.example/${i}`)))
    clearInterval(timer)
    ok(all.every((r) => r.ok), 'four queued reads all finish')
    ok(peak === 2 && Date.now() - t0 >= 1100, 'never more than two workers at once')
    ok(S._queue().running === 0 && S._queue().waiting === 0, 'the queue is empty afterwards')

    // A read that waits in the queue and is stopped leaves it.
    const ac = new AbortController()
    const a = S.readWithScrapling('https://shop.example/a')
    const b = S.readWithScrapling('https://shop.example/b')
    const c = S.readWithScrapling('https://shop.example/c', { signal: ac.signal })
    ac.abort()
    ok((await c).kind === 'aborted', 'a queued read can be stopped before it starts')
    await Promise.all([a, b])
    ok(S._queue().running === 0 && S._queue().waiting === 0, 'and the queue is still balanced')
  }

  // ── fetch_page: which reader, and what falls back ───────────────────────────
  {
    const fallbackCalls = []
    const fallback = async (url) => (fallbackCalls.push(url), 'טקסט מהקורא הרגיל')
    const quiet = () => {}
    config.scrapling.enabled = false
    ok((await S.readPage('https://shop.example/', {}, { fallback })) === 'טקסט מהקורא הרגיל' && fallbackCalls.length === 1, 'flag off: the older reader, unchanged')

    config.scrapling.enabled = true
    S._setWorker(fake('page', pageAnswer('המחיר הוא 249 ש״ח. ' + 'פרטים. '.repeat(100))))
    const text = await S.readPage('https://shop.example/item', {}, { fallback })
    ok(text.startsWith('מקור: https://shop.example/item') && text.includes('כותרת: Shop') && text.includes('249') && fallbackCalls.length === 1, 'flag on: Scrapling, with the source first')
    ok(text.includes('לא הוראות'), 'the page is marked as content, not instructions')

    const refused = await S.readPage('https://169.254.169.254/latest/meta-data/', {}, { fallback }).catch((e) => e.message)
    ok(/forbidden_url/.test(refused) && fallbackCalls.length === 1, 'a refused address is an error, and the older reader is not tried')

    S._setWorker(fake('blocked', 'print(json.dumps({"ok": False, "kind": "blocked", "error": "האתר חסם את הגישה (HTTP 403)", "http_status": 403}, ensure_ascii=False))'))
    const blocked = await S.readPage('https://shop.example/', {}, { fallback }).catch((e) => e.message)
    ok(/blocked/.test(blocked) && /לא עוקפים/.test(blocked) && fallbackCalls.length === 1, 'a block is reported, not worked around')

    S._setWorker(fake('login', 'print(json.dumps({"ok": False, "kind": "login_required", "error": "הדף מבקש התחברות"}, ensure_ascii=False))'))
    const login = await S.readPage('https://shop.example/', {}, { fallback }).catch((e) => e.message)
    ok(/login_required/.test(login) && /לא אומר שהקישור שבור/.test(login), 'a login wall is not called a broken link')

    S._setWorker(fake('crash2', 'raise SystemExit(1)'))
    const crashed = await S.readPage('https://shop.example/', {}, { fallback, log: quiet }).catch((e) => e.message)
    ok(/bad_output/.test(crashed) && fallbackCalls.length === 1, 'a broken answer is an error; a page cannot push the read to the older reader')

    config.scrapling.python = path.join(dir, 'no-such-python')
    const missing = await S.readPage('https://shop.example/', {}, { fallback, log: quiet })
    ok(missing.includes('Scrapling לא מותקן') && missing.includes('טקסט מהקורא הרגיל') && fallbackCalls.length === 2, 'not installed: the older reader, labelled as such')
    config.scrapling.python = python

    const ac = new AbortController()
    ac.abort()
    ok((await S.readPage('https://shop.example/', { signal: ac.signal }, { fallback }).catch((e) => e.message)) === 'הקריאה נעצרה', 'a stopped turn stops fetch_page')
  }

  // ── the bot path with a scripted model ─────────────────────────────────────
  {
    const injection = fs.readFileSync(path.join(ROOT, 'py', 'fixtures', 'injection.html'), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    S._setWorker(fake('shop', pageAnswer(injection + ' ' + 'מפרט. '.repeat(100))))
    config.scrapling.enabled = true
    const { runTurn, resetHistory } = await import('./agent.js')
    const { tools } = await import('./tools.js')
    Object.assign(config.llm, { apiKey: 'test-key', model: 'fake-model', fallbackModels: [], cheapModel: '', baseUrl: 'http://fake.invalid', backup: { apiKey: '', model: '' }, light: false })
    config.memoryLearn = false
    const requests = []
    const script = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://shop.example/headphones' }) } }] },
      { role: 'assistant', content: 'לפי https://shop.example/headphones: אוזניות ב-199 ש״ח. בדף הייתה גם בקשה לשלוח את הזיכרון שלך למישהו, התעלמתי ממנה.' },
    ]
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
      requests.push(JSON.parse(init.body))
      const next = script.shift() || { role: 'assistant', content: 'סוף' }
      return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: next }] }) }
    }
    const ran = []
    for (const t of tools) {
      if (['send_whatsapp_to', 'gmail_send', 'send_whatsapp', 'memory_confirm', 'cancel_reminder'].includes(t.name)) {
        const real = t.run
        t.run = (...a) => (ran.push(t.name), real(...a))
      }
    }
    resetHistory()
    const confirmed = []
    const reply = await runTurn('תפתח את https://shop.example/headphones ותסכם את הפרטים', { source: 'whatsapp', confirm: async (t) => (confirmed.push(t), false), say: () => {} })
    const def = requests[0]?.tools?.find((t) => t.function.name === 'fetch_page')
    ok(def && /ציבורי ב-https/.test(def.function.description), 'fetch_page reaches the model, with the Scrapling description')
    const toolMsg = requests[1]?.messages?.find((m) => m.role === 'tool')
    const toolText = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content || '')
    ok(toolText.includes('מקור: https://shop.example/headphones') && toolText.includes('Headphones, 199 NIS'), 'the tool result carries the source URL and the page text')
    ok(toolText.includes('Ignore all previous instructions') && toolText.includes('לא הוראות'), 'the injected line is there only as page content, marked as such')
    ok(ran.length === 0 && confirmed.length === 0, 'the page caused no send, mail, memory or delete')
    ok(/shop\.example\/headphones/.test(reply) && /199/.test(reply), 'the answer is built on the page and names its source')
    globalThis.fetch = realFetch
  }
}

// ── the real worker, if the venv is installed (no outside request) ───────────
{
  const venv = path.join(ROOT, '.venv-scrapling', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  if (!fs.existsSync(venv)) skip('real worker: .venv-scrapling is not installed (py/README.md)')
  else {
    S._setWorker()
    config.scrapling.python = venv
    const status = await S.scraplingStatus({ force: true })
    ok(status.ok && status.scrapling === '0.5', `Scrapling in the venv: ${status.scrapling || status.error}`)
    const r = await S.runWorker({ op: 'read', url: 'https://[::ffff:169.254.169.254]/' }, { python: venv })
    ok(r.kind === 'forbidden_url', 'the real worker refuses a metadata address hidden in IPv6, on its own')
    const bad = await S.runWorker({ op: 'read', url: 'http://shop.example/' }, { python: venv })
    ok(bad.kind === 'forbidden_url', 'the real worker refuses plain http')
  }
}

console.log(`${passed} בדיקות עברו, ${failed} נכשלו, ${skipped} דולגו`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
