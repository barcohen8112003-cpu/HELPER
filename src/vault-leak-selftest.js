// node src/vault-leak-selftest.js: a password the vault filled never reaches the browser agent's model, its probes,
// control labels, tool results or screenshots; after a fill no picture of the browser or this machine's screen is
// sent at all. VAULT_LEAK_EVIDENCE=<dir> saves the compared crops as PNG files. Runs the production fill (vault-fill.js), the production probe and
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
  ok(sr.redact(`x ${SECRET} y`) === `x ${SECRET} y` && !sr.imagesBlocked(), 'nothing is scrubbed or blocked before a password is filled')
  sr.holdForRedaction(SECRET, { ttlMs: 60000 })
  ok(!leaks(sr.redact(`label: ${SECRET}`)), 'a whole password is scrubbed')
  ok(!leaks(sr.redact(`label: ${SECRET.slice(0, 15)}`)), 'a cut password (as a 120-character label cuts it) is scrubbed')
  ok(!leaks(sr.redact(`a ${SECRET.slice(5)} b`)), 'a copied tail of the password is scrubbed')
  ok(!leaks(sr.redact('send   SYNTHETIC-VAULT-SECRET')), 'a password with its spaces collapsed or widened is scrubbed')
  ok(sr.redact('send the report') === 'send the report', 'ordinary text that shares a short word is left alone')
  const msgs = [{ role: 'user', content: [{ type: 'text', text: SECRET }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]
  const deep = sr.redactDeep(msgs)
  ok(!leaks(JSON.stringify(deep)) && !JSON.stringify(deep).includes('data:image') && deep[0].content.every((p) => p.type === 'text'), 'after a fill, every image part of a model request is replaced by a note (fails closed)')
  const kept = sr.redactDeep(msgs, { keepImages: true })
  ok(!leaks(JSON.stringify(kept)) && kept[0].content[1].image_url.url === 'data:image/jpeg;base64,AAAA', 'a body that cannot show this browser (phone, TV) keeps its image; its text is still scrubbed')
  sr.forgetAll()
  sr.holdForRedaction(SECRET, { ttlMs: 1, now: Date.now() - 10 })
  ok(sr.heldCount() === 0 && sr.imagesBlocked(), 'a hold given a short time expires, and images stay blocked anyway until restart')
  sr.forgetAll()
  sr.holdForRedaction(SECRET)
  ok(sr.HOLD_MS === Infinity && sr.heldCount() === 1, 'a fill holds the password (memory only) until Helper restarts')
  sr.forgetAll()
}

// ---- a real Chrome ----
const { launchChrome, chromePath } = await import('./testing/local-chrome.js')
const binary = chromePath()
const evidenceDir = process.env.VAULT_LEAK_EVIDENCE || ''
const sha = async (b64) => (await import('node:crypto')).createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 12)
if (!binary) {
  console.log('SKIP real Chrome leak checks: no Chrome or Chromium binary here (set CHROME_PATH)')
} else {
  const { fillLogin } = await import('./vault-fill.js')
  const { probeOn, captureOn, maskSecrets } = await import('./errand-browser.js')
  const { runGoal, _test } = await import('./computer-use.js')
  // The reviewer's page: the password field's input listener copies the value into a button's text.
  const form = (echoText = 'ריק') => `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif">
<form><input id=u autocomplete=username style="width:300px;height:40px"><br>
<input id=p type=password name=p style="width:300px;height:40px;font-size:20px"><br>
<button type=button id=show onclick="p.type = p.type === 'password' ? 'text' : 'password'">הצג סיסמה</button>
<button type=button id=echo style="width:300px;height:40px;font-size:16px">${echoText}</button>
<button type=submit id=go>כניסה</button></form>`
  const LOGIN = `${form()}<script>p.addEventListener('input', () => { echo.innerText = p.value })</script>`
  // A same-origin frame that the page writes the password into.
  const FRAME = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif">
<form><input id=u autocomplete=username style="width:300px;height:40px"><br>
<input id=p type=password name=p style="width:300px;height:40px"><br><button type=submit id=go>כניסה</button></form>
<iframe id=f srcdoc="<body style='margin:0;font:20px sans-serif'><div id=d>empty</div>" style="width:400px;height:60px;border:0"></iframe>
<script>p.addEventListener('input', () => { f.contentDocument.getElementById('d').textContent = p.value })</script>`
  const PLAIN = `<!doctype html><meta charset=utf-8><body style="margin:0"><input id=t type=text style="width:300px;height:40px;font-size:20px">`
  const pages = {
    '/plain': PLAIN,
    '/frame': FRAME,
    // Reference pages for the pixel comparison: the same layout with fixed button text and no listener.
    '/ref-secret': form(SECRET),
    '/ref-other': form('send SYNTHETIC-OTHER-TEXTS'),
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages[req.url] || LOGIN)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const site = `http://127.0.0.1:${server.address().port}`
  const chrome = await launchChrome({ binary })
  try {
    const { call, navigate, evaluate } = chrome
    const rect = async (id) => evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, width: r.width, height: r.height } })()`)
    const crop = async (r) => (await call('Page.captureScreenshot', { format: 'png', clip: { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 } })).data
    const save = (name, b64) => evidenceDir && fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(b64, 'base64'))
    if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true })
    // Every model request, whole: text and image parts as sent, nothing stripped.
    const recorder = (plan) => {
      const sent = []
      let turn = 0
      return {
        sent,
        think: async (messages) => {
          sent.push(JSON.parse(JSON.stringify(messages)))
          const action = plan[Math.min(turn++, plan.length - 1)]
          return { content: JSON.stringify({ thought: 'synthetic', action }) }
        },
      }
    }
    const imageParts = (reqs) => reqs.flatMap((m) => m.flatMap((x) => (Array.isArray(x.content) ? x.content.filter((p) => p.type !== 'text') : [])))
    const browser = (extra = {}) => ({
      ..._test.BODIES.browser,
      maxSteps: 4,
      settled: true,
      screenshot: () => captureOn(call),
      probe: (a) => probeOn(call, a),
      act: async (a) => (a.type === 'key' ? undefined : call('Runtime.evaluate', { expression: `document.elementFromPoint(${a.x}, ${a.y})?.focus()` })),
      ...extra,
    })

    // 1. Before any fill, pictures flow: the production capture returns an image and the model request carries it,
    // so the payload inspection below does see images when there are any.
    await navigate(`${site}/login`)
    const before = await captureOn(call)
    ok(!sr.imagesBlocked() && before.image?.startsWith('data:image/jpeg;base64,') && before.buffer?.length > 0, 'before any fill the production capture returns an image')
    const r0 = recorder([{ type: 'done', summary: 'synthetic' }])
    await runGoal({ goal: 'synthetic', body: browser(), think: r0.think })
    ok(imageParts(r0.sent).length === 1 && imageParts(r0.sent)[0].image_url.url.startsWith('data:image/jpeg;base64,'), 'before any fill the whole model request holds the screenshot (the inspection sees image parts)')

    // 2. The reviewer's case on the old path: the production fill, then the mask and a screenshot (what captureOn did
    // before this fix). The echo button's pixels are exactly those of a button whose text is the password.
    const filled = await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    ok(filled.filled && (await evaluate('p.value')) === SECRET, `the production fill put the synthetic password in the field (${binary.split('/').slice(-2).join('/')})`)
    ok(!leaks(JSON.stringify(filled)), 'the fill result carries no password')
    ok((await evaluate('echo.innerText')) === SECRET, 'the page echoed the password into the button (the reviewer\'s fixture)')
    const er = await rect('echo')
    const pr = await rect('p')
    await maskSecrets(call)
    const oldEcho = await crop(er)
    const oldField = await crop(pr)
    await navigate(`${site}/ref-secret`)
    const refSecret = await crop(await rect('echo'))
    await navigate(`${site}/ref-other`)
    const refOther = await crop(await rect('echo'))
    save('old-path-echo.png', oldEcho), save('ref-secret-echo.png', refSecret), save('ref-other-echo.png', refOther), save('old-path-field.png', oldField)
    // Decoded in the browser itself (canvas), pixel by pixel: how many pixels differ, by more than 8 of 255.
    const pixels = (x, y) => evaluate(`(async () => {
      const load = (b) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b })
      const [a, b] = await Promise.all([load(${JSON.stringify(x)}), load(${JSON.stringify(y)})])
      const read = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data }
      const p = read(a), q = read(b)
      let off = 0
      for (let k = 0; k < p.length; k += 4) if (Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2])) > 8) off++
      return { off, total: p.length / 4, same: a.width === b.width && a.height === b.height }
    })()`)
    const vsSecret = await pixels(oldEcho, refSecret)
    const vsOther = await pixels(oldEcho, refOther)
    ok(vsSecret.same && vsSecret.off === 0 && vsSecret.total > 1000, `pixels: on the old path (mask, then screenshot) the echo button draws the password: 0 of ${vsSecret.total} pixels differ from a button that reads it (${await sha(oldEcho)} vs ${await sha(refSecret)})`)
    ok(vsOther.off > 200, `pixels: the comparison tells texts apart: ${vsOther.off} of ${vsOther.total} pixels differ from a button with other text`)

    // 3. The fix: the production capture after a fill takes no picture at all.
    await navigate(`${site}/login`)
    await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    const withheld = await captureOn(call)
    ok(withheld.withheld === true && !withheld.image && !withheld.buffer && !JSON.stringify(withheld).includes('base64'), 'after a fill the production capture returns no image and no buffer (fails closed)')
    ok(!leaks(JSON.stringify(withheld)) && withheld.width > 0, 'the withheld capture says why, keeps the size, and holds no password')

    // 4. Probes: the focused password field, a click on it, shown as text, and the echo button.
    await evaluate('p.focus()')
    const key = await probeOn(call, { type: 'key', keys: 'enter' })
    ok(!leaks(JSON.stringify(key)) && key.label === '[שדה סיסמה]' && key.secret === true, `probe of the focused password field: named by kind, no value (${JSON.stringify(key.label)})`)
    const click = await probeOn(call, { type: 'click', x: pr.x, y: pr.y })
    ok(!leaks(JSON.stringify(click)), 'probe of a click on the password field: no value')
    await evaluate('show.click()')
    ok((await evaluate('p.type')) === 'text', 'the page shows the password as text')
    const shown = await probeOn(call, { type: 'click', x: pr.x, y: pr.y })
    ok(!leaks(JSON.stringify(shown)) && shown.label === '[שדה סיסמה]', 'a filled field turned into text by the page is still not read')
    const echo = await probeOn(call, { type: 'click', x: er.x, y: er.y })
    ok(!leaks(JSON.stringify(echo)) && echo.label.includes(sr.MARK), `a page that echoes the password into a control: the label is scrubbed (${JSON.stringify(echo.label)})`)

    // 5. The mask itself (still used for password fields when nothing was filled): a filled field, even as text,
    // draws the same pixels as the empty one; the same comparison on an unmasked field does tell them apart.
    await maskSecrets(call)
    const withValue = await crop(pr)
    await evaluate(`p.value = ''`)
    const empty = await crop(pr)
    ok(withValue === empty || (await pixels(withValue, empty)).off === 0, 'pixels: the masked password field (even as text) shows no characters')
    await navigate(`${site}/plain`)
    const tr = await rect('t')
    await evaluate(`t.value = ${JSON.stringify('VISIBLE-CONTROL-TEXT')}`)
    const a = await crop(tr)
    await evaluate(`t.value = ''`)
    ok(a !== (await crop(tr)), 'pixels control: an ordinary text field with text differs from an empty one')

    // 6. The whole agent loop after a fill, every request whole: Enter in the password field, a click on the echo
    // button, a gate whose card would carry a picture, then the owner says no.
    await navigate(`${site}/login`)
    await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    await evaluate('show.click(); p.focus()')
    const go = await rect('go')
    const r1 = recorder([{ type: 'key', keys: 'enter' }, { type: 'click', x: er.x, y: er.y }, { type: 'gate', kind: 'account', summary: 'synthetic', then: { type: 'click', x: go.x, y: go.y } }])
    const media = []
    const result = await runGoal({ goal: 'synthetic offline login continuation', body: browser(), think: r1.think, ctx: { confirm: async (text, m) => (media.push({ text, m }), false), sendMedia: async (m) => media.push({ m }) } })
    const whole = JSON.stringify(r1.sent)
    ok(r1.sent.length >= 3, `the stand-in model was asked ${r1.sent.length} times`)
    ok(imageParts(r1.sent).length === 0 && !whole.includes('data:image') && !whole.includes('base64'), 'after a fill no model request holds an image part or image data (whole payload, nothing stripped)')
    ok(!leaks(whole), `no model request holds the password or any 8 characters of it${leaks(whole) ? ` (found "${leaks(whole)}")` : ''}`)
    ok(whole.includes('No screenshot: a saved password was filled'), 'the model is told why there is no picture')
    ok(media.length === 1 && media[0].m === undefined && !leaks(media[0].text), 'the owner\'s approval card after a fill carries no picture and no password')
    ok(!leaks(result) && /^DENIED/.test(result), 'the loop result handed back to the main model holds no password')

    // 7. A same-origin frame that shows the password: no picture leaves either, and probes stay clean.
    await navigate(`${site}/frame`)
    await fillLogin(call, { origin: site, username: 'synthetic-user', password: SECRET })
    ok((await evaluate(`f.contentDocument.getElementById('d').textContent`)) === SECRET, 'the page wrote the password into a same-origin frame')
    const fr = await rect('f')
    const fprobe = await probeOn(call, { type: 'click', x: fr.x, y: fr.y })
    const fshot = await captureOn(call)
    ok(!fshot.image && !fshot.buffer && !leaks(JSON.stringify(fprobe)), 'same-origin frame: the capture takes no picture and the probe holds no password')
    const r2 = recorder([{ type: 'done', summary: 'synthetic' }])
    await runGoal({ goal: 'synthetic', body: browser(), think: r2.think })
    ok(imageParts(r2.sent).length === 0 && !leaks(JSON.stringify(r2.sent)), 'same-origin frame: the whole model request has no image and no password')

    // 8. Defence in depth: a body that hands back a real, unmasked screenshot anyway (the frame shows the password)
    // still sends no image to the model and none to the owner.
    const raw = (await call('Page.captureScreenshot', { format: 'jpeg', quality: 70 })).data
    const r3 = recorder([{ type: 'done', summary: 'synthetic' }])
    const sentMedia = []
    await runGoal({ goal: 'synthetic', body: browser({ finalShot: true, screenshot: async () => ({ image: `data:image/jpeg;base64,${raw}`, buffer: Buffer.from(raw, 'base64'), mime: 'image/jpeg', width: 1000, height: 700, scale: 1, left: 0, top: 0 }) }), think: r3.think, ctx: { sendMedia: async (m) => sentMedia.push(m) } })
    ok(imageParts(r3.sent).length === 0 && !JSON.stringify(r3.sent).includes(raw.slice(0, 200)) && sentMedia.length === 0, 'a body that returns a picture after a fill: the model and the chat get none')
    // The phone and the TV show their own screens, not this browser: their pictures still go, their text is scrubbed.
    const r4 = recorder([{ type: 'done', summary: 'synthetic' }])
    await runGoal({ goal: 'synthetic', body: browser({ vaultView: false, screenshot: async () => ({ text: `screen ${SECRET}`, image: 'data:image/jpeg;base64,AAAA', width: 10, height: 10 }) }), think: r4.think })
    ok(imageParts(r4.sent).length === 1 && !leaks(JSON.stringify(r4.sent)), 'a phone-like body (vaultView false) keeps its picture and its text is still scrubbed')
    // This machine's whole screen can show the browser: the desktop agent, the screenshot tool and the live errand
    // frame are refused after a fill.
    const desk = await runGoal({ goal: 'synthetic', body: _test.BODIES.desktop, think: async () => { throw new Error('the model must not be asked') } })
    ok(/^FAIL: No screenshot/.test(desk), 'the desktop agent stops before any screenshot after a fill')
    const pc = await import('./pc.js')
    ok(await pc.screenshot(0).then(() => false, (e) => e.code === 'withheld'), 'the PC screenshot tool is refused after a fill')
    const { captureFrame } = await import('./webtop-browser.js')
    ok(await captureFrame('errand').then(() => false, (e) => /מוסתרת/.test(e.message)), 'the live picture of the errand browser is refused after a fill')
  } finally {
    chrome.close()
    server.close()
  }
}

// Nothing about the password is left on disk.
const files = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile())
ok(!files.some((f) => leaks(fs.readFileSync(f, 'latin1'))), 'no file in the data folder holds the password')

done('vault-leak')
