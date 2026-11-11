// node src/vault-selftest.js: Helper's credential vault (src/vault.js, src/vault-tools.js, src/vault-fill.js) with
// synthetic secrets only. Off by default; the secure input page over real HTTP (sign-in, host, Origin, CSRF, expiry,
// cancel); encryption and origin binding on disk; lock and lockout; and filling a login in a real Chromium (when
// Playwright is installed) with redirects, cross-site frames and ambiguous forms refused. Throughout, the synthetic
// secret is looked for in every tool result, question, log line, the audit folder and the backup set.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { makeChecker, askingCtx, scriptedModel, fakeFetch } from './testing/fake-services.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-vault-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1', CREDENTIAL_VAULT: '', CREDENTIAL_AUTOFILL: '', BACKUP_PASSPHRASE: 'backup-passphrase-for-tests' })

const SECRET = 'Synthetic-PW-7f3a9c!'
const USER = 'synthetic.user@example.test'
const PASS = 'correct horse battery staple'

// Every line printed from here on is kept, to prove the secret never reaches a log.
const printed = []
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console)
  console[m] = (...a) => (printed.push(a.map(String).join(' ')), orig(...a))
}

const { ok, done } = makeChecker()
const vault = await import('./vault.js')
const { tools } = await import('./tools.js')
const byName = new Map(tools.map((t) => [t.name, t]))
const results = []
const runTool = async (name, args, answers = [], extra = {}) => {
  const said = []
  const { ctx, asked } = askingCtx(answers, { say: async (t) => said.push(t), ...extra })
  const r = await byName.get(name).run(args, ctx)
  const text = typeof r === 'string' ? r : r.text
  results.push(text, ...asked)
  return { r, text, status: r?.status, asked, said }
}

// ---- off by default ----
{
  ok(byName.has('credential_status') && byName.has('credential_add'), 'credential_status and credential_add are registered')
  ok(!tools.some((t) => t.name === 'credential_fill' && (!t.enabled || t.enabled())), 'credential_fill is not switched on while the vault is off')
  const s = await runTool('credential_status', {})
  const a = await runTool('credential_add', { site: 'https://bank.example', label: 'בנק' })
  ok(s.status === 'setup_needed' && a.status === 'setup_needed' && a.said.length === 0, 'vault off: status and add say setup needed, no link is sent')
  let err = ''
  try { vault.createRequest('setup') } catch (e) { err = e.code }
  ok(err === 'setup_needed' && !fs.existsSync(path.join(dir, 'vault')), 'vault off: no request and no vault folder')
}

// ---- the secure input page over HTTP ----
process.env.CREDENTIAL_VAULT = 'on'
const TOKEN = 'ui-token-for-tests'
let server
const port = await new Promise((resolve) => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const signedIn = (r) => String(r.headers.cookie || '').includes(`helper_session=${TOKEN}`)
    if (!(await vault.handleVaultHttp(req, res, url, { signedIn, origins: [`http://127.0.0.1:${server.address().port}`] }))) {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
vault.setVaultInputBase(`http://127.0.0.1:${port}`)
const ORIGIN = `http://127.0.0.1:${port}`
const COOKIE = `helper_session=${TOKEN}`
async function hit(p, { method = 'GET', form, cookie = COOKIE, origin = ORIGIN, host, type = 'application/x-www-form-urlencoded' } = {}) {
  const headers = { ...(cookie && { cookie }), ...(origin && { origin }), ...(host && { host }), ...(form && { 'content-type': type }) }
  const res = await fetch(`${ORIGIN}${p}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}
const linkIn = (said) => (said.join('\n').match(/\/vault\/r\/([A-Za-z0-9_-]{43})/) || [])[1]
const csrfIn = (body) => (body.match(/name="csrf" value="([^"]+)"/) || [])[1]

let setupId
{
  const a = await runTool('credential_add', { site: 'https://bank.example', label: 'בנק' })
  setupId = linkIn(a.said)
  ok(a.status === 'done' && setupId && !a.text.includes(setupId), 'no vault yet: a setup link goes to the owner\'s chat, not to the model')
  const anon = await hit(`/vault/r/${setupId}`, { cookie: '' })
  ok(anon.status === 403, 'input page: not signed in is refused')
  // fetch() may not set Host, so this one goes out as a plain HTTP request with a foreign Host header.
  const foreignHost = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/vault/r/${setupId}`, headers: { host: `evil.example:${port}`, cookie: COOKIE } }, (res) => (res.resume(), resolve(res.statusCode))))
  ok(foreignHost === 403, 'input page: a non-loopback host is refused')
  const page = await hit(`/vault/r/${setupId}`)
  const csrf = csrfIn(page.body)
  ok(page.status === 200 && csrf && /frame-ancestors 'none'/.test(page.headers.get('content-security-policy')) && page.headers.get('x-frame-options') === 'DENY' && page.headers.get('cache-control') === 'no-store', 'input page: served with a CSRF token, no framing, no caching')
  const form = { csrf, passphrase: PASS, confirm: PASS }
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form, origin: '' })).status === 403, 'POST without Origin is refused')
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form, origin: 'https://evil.example' })).status === 403, 'POST from another origin is refused')
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form: { ...form, csrf: 'x'.repeat(43) } })).status === 403, 'POST with a wrong CSRF token is refused')
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form, type: 'application/json' })).status === 400, 'POST that is not a form is refused')
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form: { csrf, passphrase: 'backup-passphrase-for-tests', confirm: 'backup-passphrase-for-tests' } })).status === 400, 'the vault passphrase may not be the backup passphrase')
  const made = await hit(`/vault/r/${setupId}`, { method: 'POST', form })
  ok(made.status === 200 && vault.status().created && vault.status().unlocked && !made.body.includes(PASS), 'setup: the vault is created and open; the answer does not repeat the passphrase')
  ok((await hit(`/vault/r/${setupId}`, { method: 'POST', form })).status === 410, 'a used link cannot be used again')
}
let entryId
{
  const a = await runTool('credential_add', { site: `${ORIGIN}/login?next=/home`, label: 'אתר בדיקה' })
  const id = linkIn(a.said)
  const page = await hit(`/vault/r/${id}`)
  ok(page.body.includes(ORIGIN) && !page.body.includes('/login'), 'store: the page names the exact origin, not the path')
  const r = await hit(`/vault/r/${id}`, { method: 'POST', form: { csrf: csrfIn(page.body), username: USER, password: SECRET } })
  entryId = vault.status().entries[0]?.id
  ok(r.status === 200 && entryId && !r.body.includes(SECRET), 'store: saved; the answer does not repeat the secret')
  const disk = fs.readFileSync(path.join(dir, 'vault', 'vault.json'), 'utf8')
  ok(!disk.includes(SECRET) && !disk.includes(USER) && !disk.includes(PASS), 'on disk: neither the secret, the username nor the passphrase in plain text')
  ok((fs.statSync(path.join(dir, 'vault', 'vault.json')).mode & 0o777) === 0o600, 'on disk: the file is readable by its owner only')
}
{
  const a = await runTool('credential_add', { site: 'https://other.example' })
  const id = linkIn(a.said)
  const csrf = csrfIn((await hit(`/vault/r/${id}`)).body)
  ok((await hit(`/vault/r/${id}/cancel`, { method: 'POST', form: { csrf } })).status === 200, 'cancel: the owner can cancel a request')
  ok((await hit(`/vault/r/${id}`, { method: 'POST', form: { csrf, username: 'u', password: 'p' } })).status === 410 && vault.status().entries.length === 1, 'cancel: a cancelled request stores nothing')
  const old = vault.createRequest('store', { origin: 'https://late.example' }, Date.now() - 11 * 60000)
  ok((await hit(`/vault/r/${old.id}`)).status === 410, 'expiry: a request older than 10 minutes is gone')
}

// ---- crypto, lock and lockout ----
{
  vault.lock()
  let err = ''
  process.env.CREDENTIAL_AUTOFILL = 'on'
  try { await vault.withSecret(entryId, ORIGIN, () => {}) } catch (e) { err = e.code }
  ok(err === 'locked', 'locked: nothing decrypts')
  for (let i = 0; i < 5; i++) try { vault.unlock('wrong passphrase!!') } catch {}
  err = ''
  try { vault.unlock(PASS) } catch (e) { err = e.message }
  ok(/יותר מדי ניסיונות/.test(err), 'five wrong passphrases lock unlocking, even for the right one')
  vault.unlock(PASS, Date.now() + 16 * 60000)
  const got = await vault.withSecret(entryId, ORIGIN, (s) => s.password === SECRET && s.username === USER)
  ok(got === true, 'the right passphrase after the lockout decrypts the entry')
  err = ''
  try { await vault.withSecret(entryId, 'https://evil.example', () => {}) } catch (e) { err = e.message }
  ok(/שמורה ל-/.test(err), 'an entry is never given out for another origin')
  // Moving the ciphertext to another site on disk does not decrypt (the origin is bound into the encryption).
  const file = path.join(dir, 'vault', 'vault.json')
  const saved = fs.readFileSync(file, 'utf8')
  const v = JSON.parse(saved)
  v.entries[entryId].origin = 'https://evil.example'
  fs.writeFileSync(file, JSON.stringify(v))
  err = ''
  try { await vault.withSecret(entryId, 'https://evil.example', () => {}) } catch (e) { err = e.message }
  ok(/auth|decrypt|Unsupported state/i.test(err), `an entry edited on disk to another origin fails to decrypt (${err.slice(0, 60)})`)
  fs.writeFileSync(file, saved)
  process.env.CREDENTIAL_AUTOFILL = ''
}

// ---- fill: off until chosen ----
{
  const f = await runTool('credential_fill', { entry_id: entryId }, [true])
  ok(f.status === 'setup_needed' && f.asked.length === 0, 'autofill off: fill says setup needed and asks nothing')
}

// ---- fill in a real browser ----
// Playwright when it is installed, otherwise a local Chrome over CDP (src/testing/local-chrome.js) behind the same
// small page interface, so this part runs wherever any Chrome binary exists. Only with neither is it skipped.
let pw = null
try {
  pw = createRequire(import.meta.url)('playwright')
} catch {}
// HELPER_TEST_NO_PLAYWRIGHT=1 runs the same checks on the CDP path, as on a machine without Playwright.
if (process.env.HELPER_TEST_NO_PLAYWRIGHT === '1') pw = null
const { launchChrome, chromePath } = await import('./testing/local-chrome.js')
async function cdpBrowser() {
  const chrome = await launchChrome()
  const { call, navigate } = chrome
  let frames = []
  const refresh = async () => {
    await new Promise((r) => setTimeout(r, 300))
    const list = []
    const walk = (t) => { list.push(t.frame); for (const c of t.childFrames || []) walk(c) }
    walk((await call('Page.getFrameTree')).frameTree)
    frames = list
  }
  const inFrame = async (frameId, expression) => {
    const { executionContextId } = await call('Page.createIsolatedWorld', { frameId, worldName: 'vault-test' })
    return (await call('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true })).result.value
  }
  const frameOf = (f) => {
    const locator = (sel) => {
      const one = { inputValue: () => inFrame(f.id, `document.querySelector(${JSON.stringify(sel)})?.value ?? ''`) }
      return { ...one, first: () => one }
    }
    return { url: () => f.url, locator }
  }
  const page = {
    goto: async (url) => { await navigate(url); await refresh() },
    url: () => frames[0]?.url || '',
    frames: () => frames.map(frameOf),
    mainFrame: () => null,
    locator: (sel) => frameOf(frames[0]).locator(sel),
    evaluate: async (fn) => inFrame(frames[0].id, `(${fn})()`),
  }
  // A frame object other than the main one is told apart by its url.
  page.frames = () => frames.map((f, i) => (i === 0 ? mainMarker : frameOf(f)))
  const mainMarker = { url: () => frames[0]?.url || '', locator: (sel) => frameOf(frames[0]).locator(sel) }
  page.mainFrame = () => mainMarker
  return { page, send: (m, p) => call(m, p), close: async () => chrome.close() }
}
const realBrowser = pw ? 'playwright' : chromePath() ? 'local Chrome over CDP' : null
if (!realBrowser) {
  console.log('SKIP real browser fill: neither playwright nor a Chrome binary is available here (set CHROME_PATH)')
} else {
  console.log(`real browser fill: ${realBrowser}`)
  process.env.CREDENTIAL_AUTOFILL = 'on'
  const LOGIN = `<form><input name="u" autocomplete="username"><input id="p" name="p" type="password"><button>כניסה</button></form>`
  const site = (routes) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const r = routes(req.url)
      if (r?.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end() }
      res.writeHead(r ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(r || '')
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const b = await site((u) => (u === '/login' ? LOGIN : null))
  const B = `http://127.0.0.1:${b.address().port}`
  const a = await site((u) => ({ '/login': LOGIN, '/go-elsewhere': { redirect: `${B}/login` }, '/framed-other': `<p>top</p><iframe src="${B}/login" width=400 height=200></iframe>`, '/framed-same': `<p>top</p><iframe src="/login" width=400 height=200></iframe>`, '/two': `<form><input type="password"><input type="password"></form>`, '/text-pass': `<form><input name="p" type="text" placeholder="password"></form>` }[u] ?? null))
  const A = `http://127.0.0.1:${a.address().port}`
  // An entry for A (saved through the page, like the real flow).
  vault.unlock(PASS, Date.now() + 16 * 60000)
  const addA = await runTool('credential_add', { site: `${A}/login`, label: 'A' })
  const pageA = await hit(`/vault/r/${linkIn(addA.said)}`)
  await hit(`/vault/r/${linkIn(addA.said)}`, { method: 'POST', form: { csrf: csrfIn(pageA.body), username: USER, password: SECRET } })
  const idA = vault.status().entries.find((e) => e.origin === A).id

  let browser, page, cdp
  if (pw) {
    browser = await pw.chromium.launch()
    page = await browser.newPage()
    cdp = await page.context().newCDPSession(page)
  } else {
    const c = await cdpBrowser()
    page = c.page
    cdp = { send: c.send }
    browser = { close: c.close }
  }
  const browserTab = (run) => run((method, params) => cdp.send(method, params))
  const fill = (answers, extra = {}) => runTool('credential_fill', { entry_id: idA, confirmed: true }, answers, { browserTab, ...extra })
  const values = async (frame = page) => ({ u: await frame.locator('input').first().inputValue().catch(() => ''), p: await frame.locator('input[type=password]').first().inputValue().catch(() => '') })

  await page.goto(`${A}/login`)
  const no = await fill([false])
  ok(no.status === 'declined' && (await values()).p === '' && /A/.test(no.asked[0]) && no.asked[0].includes(A), 'fill: a no (with confirmed=true from the model) fills nothing; the question names the site')
  const yes = await fill([true])
  const v = await values()
  ok(yes.status === 'done' && v.p === SECRET && v.u === USER, `fill: a yes fills username and password on the exact site (${yes.text})`)
  ok(!yes.text.includes(SECRET) && !yes.text.includes(USER), 'fill: the result names the site, never the secret or the username')
  const again = await fill([true])
  ok(again.status === 'done' && again.asked.length === 1, 'fill: a later fill on the same site is asked about again, not skipped')

  await page.goto(`${A}/go-elsewhere`)
  ok(page.url().startsWith(B), 'redirect: the test page really redirected to another origin')
  const red = await fill([true])
  ok(red.status === 'refused' && red.asked.length === 0 && (await values()).p === '', 'redirect: after a redirect to another site nothing is asked or filled')

  await page.goto(`${A}/framed-other`)
  const fo = await fill([true])
  const otherFrame = page.frames().find((f) => f.url().startsWith(B))
  ok(fo.status === 'refused' && fo.asked.length === 0 && /מסגרת מאתר אחר/.test(fo.text) && (await otherFrame.locator('input[type=password]').inputValue()) === '', `iframe: a login form from another site inside the page is refused (${fo.status})`)

  await page.goto(`${A}/framed-same`)
  const fs1 = await fill([true])
  const sameFrame = page.frames().find((f) => f !== page.mainFrame())
  ok(fs1.status === 'done' && (await sameFrame.locator('input[type=password]').inputValue()) === SECRET, 'iframe: a same-site login frame inside the same site is filled')

  await page.goto(`${A}/two`)
  const two = await fill([true])
  ok(two.status === 'refused' && two.asked.length === 0 && /יותר משדה סיסמה/.test(two.text), 'ambiguous: two password fields are refused')
  await page.goto(`${A}/text-pass`)
  const txt = await fill([true])
  ok(txt.status === 'refused' && txt.asked.length === 0 && (await page.locator('input').inputValue()) === '', 'no typing into a text field that only looks like a password field')

  await page.goto(`${A}/login`)
  const moved = await fill([], { confirm: async () => { await page.goto(`${B}/login`); return true } })
  ok(moved.status === 'changed' && (await values()).p === '', 'the page moved to another site during the question: nothing filled')

  vault.lock()
  await page.goto(`${A}/login`)
  const locked = await fill([true])
  ok(locked.status === 'setup_needed' && locked.asked.length === 0 && (await values()).p === '', 'locked vault: nothing is asked or filled')

  // Screenshots of the page show the password field masked.
  vault.unlock(PASS, Date.now() + 16 * 60000)
  await fill([true])
  const shown = await page.evaluate(() => document.body.innerText)
  ok(!shown.includes(SECRET), 'the filled password is not in the page\'s visible text (the field is masked)')
  await browser.close()
  a.close()
  b.close()
}

// ---- through the real agent loop ----
{
  const { config } = await import('./config.js')
  const model = scriptedModel(config, fakeFetch().fetch)
  const { runTurn, resetHistory } = await import('./agent.js')
  resetHistory()
  const asked = []
  process.env.CREDENTIAL_AUTOFILL = 'on'
  model.next = [['credential_fill', { entry_id: entryId, confirmed: true, approved: true }]]
  await runTurn('תתחבר לאתר', { source: 'whatsapp', confirm: async (q) => (asked.push(q), false), say: async () => {}, browserTab: async (run) => run(async (m) => ({ 'Page.getFrameTree': { frameTree: { frame: { id: 'f', url: `${ORIGIN}/login` } } }, 'Page.createIsolatedWorld': { executionContextId: 1 }, 'Runtime.evaluate': { result: { value: 1 } } })[m]) })
  ok(asked.length === 1 && model.toolResults().some((t) => /\[declined\]/.test(t)), 'agent loop: confirmed=true from the model does not fill; the owner is asked')
  results.push(...model.toolResults())
}

// ---- where the secret must never be ----
{
  const { collect } = await import('./backup.js')
  const files = collect(dir, path.join(dir, '.env'))
  ok(!Object.keys(files).some((k) => k.includes('vault')), 'backup: the vault folder is not in the backup set')
  const all = Object.values(files).map((b) => Buffer.from(b, 'base64').toString('utf8')).join('\n')
  ok(!all.includes(SECRET), 'backup: the secret is in none of the backed-up files')
  const audit = path.join(dir, 'audit')
  const auditText = fs.existsSync(audit) ? fs.readdirSync(audit).map((f) => fs.readFileSync(path.join(audit, f), 'utf8')).join('\n') : ''
  ok(!auditText.includes(SECRET) && !auditText.includes(PASS), 'audit log: no secret and no passphrase')
  ok(!results.join('\n').includes(SECRET) && !results.join('\n').includes(PASS), 'no tool result or question ever contained the secret or the passphrase')
  ok(!printed.join('\n').includes(SECRET) && !printed.join('\n').includes(PASS), 'no log line ever contained the secret or the passphrase')
  const state = fs.existsSync(path.join(dir, 'state.json')) ? fs.readFileSync(path.join(dir, 'state.json'), 'utf8') : ''
  ok(!state.includes(SECRET), 'conversation state: no secret')
}

server.close()
done('vault')
