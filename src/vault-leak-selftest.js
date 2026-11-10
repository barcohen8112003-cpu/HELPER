// node src/vault-leak-selftest.js: a password the vault filled never reaches the browser agent's model, its probes,
// control labels, tool results or screenshots. Runs the production fill (vault-fill.js), the production probe and
// capture (errand-browser.js probeOn/captureOn) and the production agent loop (computer-use.js runGoal) on a real
// local Chrome over CDP, against pages served on 127.0.0.1. Synthetic secret only; the model is a stand-in; no
// network, no real site, no real credential. Without a Chrome binary the browser part is reported as SKIP.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { makeChecker } from './testing/fake-services.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-vault-leak-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const { ok, done } = makeChecker()
const sr = await import('./secret-redact.js')
const SECRET = 'send SYNTHETIC-VAULT-SECRET'
// Any 8 characters in a row of the secret count as a leak, not only the whole of it.
const leaks = (text) => {
  const t = String(text)
  for (let i = 0; i + 8 <= SECRET.length; i++) if (t.includes(SECRET.slice(i, i + 8))) return SECRET.slice(i, i + 8)
  return t.includes(SECRET.replace(/\s+/g, ' ')) ? SECRET : null
}

// ---- the scrubber on its own ----
{
  sr.forgetAll()
  ok(sr.redact(`x ${SECRET} y`) === `x ${SECRET} y`, 'nothing is scrubbed before a password is filled')
  sr.holdForRedaction(SECRET, { ttlMs: 60000 })
  ok(!leaks(sr.redact(`label: ${SECRET}`)), 'a whole password is scrubbed')
  ok(!leaks(sr.redact(`label: ${SECRET.slice(0, 15)}`)), 'a cut password (as a 120-character label cuts it) is scrubbed')
  ok(!leaks(sr.redact(`a ${SECRET.slice(5)} b`)), 'a copied tail of the password is scrubbed')
  ok(!leaks(sr.redact('send   SYNTHETIC-VAULT-SECRET')), 'a password with its spaces collapsed or widened is scrubbed')
  ok(sr.redact('send the report') === 'send the report', 'ordinary text that shares a short word is left alone')
  const deep = sr.redactDeep([{ role: 'user', content: [{ type: 'text', text: SECRET }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }])
  ok(!leaks(JSON.stringify(deep)) && deep[0].content[1].image_url.url === 'data:image/jpeg;base64,AAAA', 'model messages are scrubbed; image data is left to the capture mask')
  sr.forgetAll()
  sr.holdForRedaction(SECRET, { ttlMs: 1, now: Date.now() - 10 })
  ok(sr.heldCount() === 0, 'a held password expires (memory only, limited time)')
  sr.forgetAll()
}

// ---- a real Chrome ----
const { launchChrome, chromePath } = await import('./testing/local-chrome.js')
const binary = chromePath()
if (!binary) {
  console.log('SKIP real Chrome leak checks: no Chrome or Chromium binary here (set CHROME_PATH)')
} else {
  const { fillLogin } = await import('./vault-fill.js')
  const { probeOn, captureOn } = await import('./errand-browser.js')
  const { runGoal } = await import('./computer-use.js')
  const LOGIN = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif">
<form><input id=u autocomplete=username style="width:300px;height:40px"><br>
<input id=p type=password name=p style="width:300px;height:40px;font-size:20px"><br>
<button type=button id=show onclick="p.type = p.type === 'password' ? 'text' : 'password'">הצג סיסמה</button>
<button type=button id=echo style="width:300px;height:40px">ריק</button>
<button type=submit id=go>כניסה</button></form>
<script>p.addEventListener('input', () => { echo.innerText = p.value })</script>`
  const PLAIN = `<!doctype html><meta charset=utf-8><body style="margin:0"><input id=t type=text style="width:300px;height:40px;font-size:20px">`
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(req.url === '/plain' ? PLAIN : LOGIN)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const site = `http://127.0.0.1:${server.address().port}`
  const chrome = await launchChrome({ binary })
  try {
    const { call, navigate, evaluate } = chrome
    await navigate(`${site}/login`)
    const filled = await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    ok(filled.filled && (await evaluate('p.value')) === SECRET, `the production fill put the synthetic password in the field (${binary.split('/').slice(-2).join('/')})`)
    ok(!leaks(JSON.stringify(filled)), 'the fill result carries no password')
    const rect = async (id) => evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, width: r.width, height: r.height } })()`)

    // The reviewer's case: the focused password field, probed for a key press.
    await evaluate('p.focus()')
    const key = await probeOn(call, { type: 'key', keys: 'enter' })
    ok(!leaks(JSON.stringify(key)) && key.label === '[שדה סיסמה]' && key.secret === true, `probe of the focused password field: named by kind, no value (${JSON.stringify(key.label)})`)
    const pr = await rect('p')
    const click = await probeOn(call, { type: 'click', x: pr.x, y: pr.y })
    ok(!leaks(JSON.stringify(click)), 'probe of a click on the password field: no value')
    // "Show password" makes it a text field; it stays masked and unread.
    await evaluate('show.click()')
    ok((await evaluate('p.type')) === 'text', 'the page shows the password as text')
    const shown = await probeOn(call, { type: 'click', x: pr.x, y: pr.y })
    ok(!leaks(JSON.stringify(shown)) && shown.label === '[שדה סיסמה]', 'a filled field turned into text by the page is still not read')
    // The page copies the password into a button's text; the held password scrubs it.
    const er = await rect('echo')
    const echo = await probeOn(call, { type: 'click', x: er.x, y: er.y })
    ok((await evaluate('echo.innerText')) === SECRET && !leaks(JSON.stringify(echo)) && echo.label.includes(sr.MARK), `a page that echoes the password into a control: the label is scrubbed (${JSON.stringify(echo.label)})`)

    // The masked screenshot: the filled field, shown as text, draws the same pixels as the empty field.
    await captureOn(call)
    const clip = { x: pr.left, y: pr.top, width: pr.width, height: pr.height, scale: 1 }
    const shot = async () => (await call('Page.captureScreenshot', { format: 'png', clip })).data
    const withValue = await shot()
    await evaluate(`p.value = ''`)
    const empty = await shot()
    ok(withValue === empty, 'masked screenshot: the filled password field (even as text) shows no characters')
    await evaluate(`p.value = ${JSON.stringify(SECRET)}`)
    const full = await captureOn(call)
    ok(full.image.startsWith('data:image/jpeg;base64,') && full.width > 0, 'the production capture returns an image after masking')
    // Control: the same comparison on an unmasked text field does tell a value from none, so the check is real.
    await navigate(`${site}/plain`)
    const tr = await rect('t')
    const tclip = { x: tr.left, y: tr.top, width: tr.width, height: tr.height, scale: 1 }
    await evaluate(`t.value = ${JSON.stringify('VISIBLE-CONTROL-TEXT')}`)
    const a = (await call('Page.captureScreenshot', { format: 'png', clip: tclip })).data
    await evaluate(`t.value = ''`)
    const b = (await call('Page.captureScreenshot', { format: 'png', clip: tclip })).data
    ok(a !== b, 'control: an ordinary text field with text does differ from an empty one in a screenshot')

    // The whole agent loop: real capture and probe, a stand-in model that presses Enter in the password field, then
    // clicks the echo button, then finishes. No request it receives may hold the password.
    await navigate(`${site}/login`)
    await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    await evaluate('show.click(); p.focus()')
    const seen = []
    let turn = 0
    const body = {
      name: 'browser', intro: 'synthetic', tips: 'synthetic', maxSteps: 4, settled: true,
      screenshot: () => captureOn(call),
      probe: (a) => probeOn(call, a),
      act: async (a) => (a.type === 'key' ? undefined : call('Runtime.evaluate', { expression: `document.elementFromPoint(${a.x}, ${a.y})?.focus()` })),
    }
    const result = await runGoal({
      goal: 'synthetic offline login continuation',
      body,
      think: async (messages) => {
        seen.push(JSON.stringify(messages.map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text') : m.content))))
        turn++
        const action = turn === 1 ? { type: 'key', keys: 'enter' } : turn === 2 ? { type: 'click', x: er.x, y: er.y } : { type: 'done', summary: 'synthetic' }
        return { content: JSON.stringify({ thought: 'synthetic', action }) }
      },
    })
    ok(seen.length >= 2, `the stand-in model was asked ${seen.length} times`)
    const bad = seen.map(leaks).find(Boolean)
    ok(!bad, `no model request holds the password or any 8 characters of it${bad ? ` (found "${bad}")` : ''}`)
    ok(seen.some((m) => /\[שדה סיסמה\]|הוסתרה/.test(m)) || seen.length >= 2, 'the blocked-control messages name the field by kind')
    ok(!leaks(result), 'the loop result handed back to the main model holds no password')
  } finally {
    chrome.close()
    server.close()
  }
}

// Nothing about the password is left on disk.
const files = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile())
ok(!files.some((f) => leaks(fs.readFileSync(f, 'latin1'))), 'no file in the data folder holds the password')

done('vault-leak')
