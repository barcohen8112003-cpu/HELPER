// node src/desktop-vault-leak-selftest.js: the desktop agent (use_computer) after the vault filled a password.
// A real local Chrome (over CDP, 127.0.0.1 only) shows a login page whose button echoes the password, the production
// fill (vault-fill.js) puts a synthetic password in it, and a real Chrome screenshot of that page (the pixels hold
// the password) is what the desktop "screen" returns. The production agent loop (computer-use.js runGoal) then runs
// with a stand-in model that records every request exactly as it would go out: the assertions read the whole
// payload as one string and strip nothing. Before the fill the same path does carry the picture, so the check can see
// one. Synthetic secret only; no network, no real site, no Windows. Without a Chrome binary this is reported as SKIP.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-desktop-vault-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })
delete process.env.PC_BRIDGE_SECRET

let passed = 0
let failed = 0
const ok = (cond, name) => (cond ? passed++ : (failed++, console.log(`FAIL  ${name}`)))

const sr = await import('./secret-redact.js')
const { runGoal, _test } = await import('./computer-use.js')
const { desktopBody } = await import('./desktop-body.js')
const { launchChrome, chromePath } = await import('./testing/local-chrome.js')
const SECRET = 'desk SYNTHETIC-VAULT-SECRET-42'
const leaks = (text) => {
  const t = String(text)
  for (let i = 0; i + 8 <= SECRET.length; i++) if (t.includes(SECRET.slice(i, i + 8))) return SECRET.slice(i, i + 8)
  return null
}

const binary = chromePath()
if (!binary) {
  console.log('SKIP desktop vault leak checks: no Chrome or Chromium binary here (set CHROME_PATH)')
} else {
  const { fillLogin } = await import('./vault-fill.js')
  const LOGIN = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif">
<form><input id=u autocomplete=username style="width:300px;height:40px"><br>
<input id=p type=password name=p style="width:300px;height:40px;font-size:20px"><br>
<button type=button id=echo style="display:block;width:420px;height:40px;font-size:18px">ריק</button>
<button type=submit id=go>כניסה</button></form>
<script>p.addEventListener('input', () => { echo.innerText = p.value })</script>`
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(LOGIN)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const site = `http://127.0.0.1:${server.address().port}`
  const chrome = await launchChrome({ binary })
  try {
    const { call, navigate, evaluate } = chrome
    await navigate(`${site}/login`)
    // A "desktop" whose screen is this Chrome window: every screenshot is a real PNG of the page right now.
    const shots = []
    const realScreen = async () => {
      const data = (await call('Page.captureScreenshot', { format: 'png' })).data
      shots.push(data)
      const file = path.join(dir, `screen-${shots.length}.png`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      return { file, width: 1000, height: 700, scale: 1, left: 0, top: 0, sig: '00'.repeat(64 * 36), window: { hwnd: '7', title: `Sign in - ${await evaluate('echo.innerText')}`, process: 'chrome' } }
    }
    const acts = []
    const api = {
      screenshot: realScreen,
      inspectAt: async () => ({ at: { hwnd: '7', title: `Sign in - ${await evaluate('echo.innerText')}`, process: 'chrome' }, fg: { hwnd: '7', title: 'Sign in', process: 'chrome' }, el: { label: await evaluate('echo.innerText'), role: 'Button' } }),
      focusInfo: async () => ({ fg: { hwnd: '7', title: `Sign in - ${await evaluate('echo.innerText')}`, process: 'chrome' }, el: { label: 'Username', role: 'Edit' } }),
      focusWindow: async () => ({ ok: false, reason: 'none' }),
      act: async (a) => acts.push(a),
    }
    // A stand-in model: records each request exactly as runGoal hands it over, and replies from a script.
    const recorder = (replies) => {
      const sent = []
      let i = 0
      const think = async (messages) => {
        sent.push(JSON.stringify(messages))
        return { content: JSON.stringify({ thought: 't', action: replies[i++] ?? { type: 'done', summary: 'x' } }) }
      }
      return { sent, think }
    }
    // Desktop-shaped, but not called "desktop": stands for any future screen body. The name check does not cover it,
    // so only the generic image block (shot strip, redactDeep, gate media, final picture) stands between it and a leak.
    // It also has its own capture() for the approval card, as the phone body does, so the gate's own picture block
    // is tested on its own and not only through the stripped screenshot.
    const shaped = () => ({ ...desktopBody(api), name: 'screen-under-test', maxSteps: 4, capture: async () => ({ buffer: Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'), mime: 'image/png' }) })

    // 1. Control, before any fill: the same path carries the whole picture to the model.
    {
      const r = recorder([{ type: 'done', summary: 'x' }])
      await runGoal({ goal: 'synthetic', body: shaped(), ctx: {}, think: r.think })
      ok(!sr.imagesBlocked() && shots.length >= 1 && r.sent[0].includes(shots[0]), '1. before a fill, the full screenshot (byte-for-byte base64) is in the model request, so the check can see a leak')
    }

    // 2. The production fill; the page now shows the password in pixels.
    const filled = await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    ok(filled.filled && sr.imagesBlocked(), '2. the production fill filled the synthetic password and latched the image block')
    ok((await evaluate('echo.innerText')) === SECRET, '2. the page echoes the password into a button, so a screenshot now shows it')
    const shotsBefore = shots.length

    // 3. The real desktop body and any copy of it stop before a screenshot or a model call.
    {
      const r = recorder([])
      const out = await runGoal({ goal: 'synthetic', body: _test.BODIES.desktop, ctx: { sendMedia: async () => ok(false, '3. no picture may be sent') }, think: r.think })
      ok(out.startsWith('FAIL') && out.includes(sr.IMAGE_WITHHELD) && r.sent.length === 0, '3. use_computer ends with the clean withheld FAIL, no model request')
      const r2 = recorder([])
      const out2 = await runGoal({ goal: 'synthetic', body: { ...desktopBody(api), maxSteps: 4 }, ctx: {}, think: r2.think })
      ok(out2.startsWith('FAIL') && r2.sent.length === 0 && shots.length === shotsBefore, '3. a copy of the desktop body is refused the same way, and no screenshot is taken')
    }

    // 4. A desktop-shaped body that is not refused by name: real screenshots of the password are taken, and none of
    // them, nor the password as text (window title, probe label, gate card), goes anywhere.
    {
      const asked = []
      const media = []
      const gate = { type: 'gate', kind: 'send', site: 'x', items: `to ${SECRET}`, then: { type: 'click', x: 10, y: 10 } }
      const r = recorder([{ type: 'click', x: 10, y: 10 }, gate, { type: 'done', summary: `done ${SECRET}` }])
      const out = await runGoal({ goal: 'synthetic', body: shaped(), ctx: { confirm: async (t, m) => (asked.push({ t, m }), true), sendMedia: async (m) => media.push(m) }, think: r.think })
      const after = shots.slice(shotsBefore)
      ok(after.length >= 2, `4. real screenshots of the page were taken (${after.length})`)
      const whole = r.sent.join('\n')
      ok(after.every((b64) => !whole.includes(b64) && !whole.includes(b64.slice(0, 200)) && !whole.includes(b64.slice(-200))), '4. no screenshot taken after the fill, nor a piece of one, is in any model request')
      ok(!/data:image|iVBORw0KGgo|image_url|input_image/.test(whole), '4. no model request holds any image part or image data at all')
      ok(!leaks(whole), '4. the password (from the window title, the probe label and the model\'s own echo) never reaches the model')
      ok(asked.length === 1 && !asked[0].m && !leaks(asked[0].t), '4. the approval card carries no picture and no password')
      ok(media.length === 0, '4. no closing picture is sent to the chat')
      ok(!leaks(out), '4. the result text carries no password')
    }
  } finally {
    chrome.close()
    server.close()
    sr.forgetAll()
  }
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
