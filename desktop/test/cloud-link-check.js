// Offline checks for the PC's link to HELPER on the cloud: which asks go straight to the cloud (the house, a system
// check), the free ping of the cloud, and the API brain handing a request to the cloud with ask_helper.
// Runs on any OS with plain Node: Electron and the Windows parts are stood in for. Run: node test/cloud-link-check.js
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const Module = require('module')

// Stand-ins for what needs Windows or Electron. Only the hands' plumbing is used here, never a window.
const realLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { shell: { openExternal: async () => {} }, clipboard: { readText: () => '', writeText: () => {} } }
  if (/[\\/]src[\\/]hands\.js$/.test((parent && parent.filename) || '') && ['./win32', './uia', './apps'].includes(request)) return {}
  return realLoad.apply(this, arguments)
}

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message) }
}

const home = require('../src/home')
const { tidy } = require('../src/instant')
const store = require('../src/store')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-desktop-'))
store.init(dir)

function serve(handler) {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
      handler(req, res, seen[seen.length - 1])
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

;(async () => {
  // 1. Routing: the house and a system check go to the cloud; PC work stays here.
  const route = (t) => home.route(tidy(t))
  for (const t of ['תכבה את האורות', 'תדליק את האור בסלון', 'הלפר, תכבה בבקשה את הטלוויזיה', 'תפעיל את המזגן', 'תוריד את התריסים', 'תדליק את הדוד', 'מה דולק בבית החכם?', 'תכבה את כל האורות בבית', 'turn on google home'])
    await check('home: ' + t, () => assert.strictEqual(route(t), 'home'))
  for (const t of ['תבדוק את המערכת', 'בדיקת מערכת', 'מה מצב המערכת?', 'תבדוק מערכת', 'סטטוס', 'הכל עובד?'])
    await check('status: ' + t, () => assert.strictEqual(route(t), 'status'))
  for (const t of ['תפתח את כרום', 'תשים את ספוטיפיי בצד שמאל', 'מה כתוב במסך', 'תגביר את הבהירות במחשב', 'תשלח הודעה לאורח', 'מה השעה', 'תנגן את אור הגנוז ביוטיוב', 'תנגן את אור הגנוז', 'תשים לי את השיר אור', 'אורית', 'תבדוק את המייל', ''])
    await check('stays on the PC: ' + t, () => assert.strictEqual(route(t), null))

  await check('status line', () => {
    const line = home.statusLine({ pc: 'מעבד: 8 ליבות · זיכרון: 9/16GB', brain: 'Claude Code', cloud: { ok: true, ms: 120 } })
    assert.match(line, /^המחשב: מעבד: 8 ליבות, זיכרון/)
    assert.match(line, /המוח כאן: Claude Code/)
    assert.match(line, /מחובר \(120/)
    assert.match(home.statusLine({ cloud: { ok: false, reason: 'אין חיבור' } }), /HELPER בענן: אין חיבור/)
  })

  // 2. The ping: an empty ask, refused after the code is checked. No model runs on the cloud for it.
  const brain = require('../src/brain')
  const cloud = await serve((req, res, got) => {
    if (got.auth !== 'Bearer good') { res.writeHead(403); return res.end('{}') }
    if (!got.body.text) { res.writeHead(400); return res.end('{"error":"empty text"}') }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ reply: 'כיביתי את האורות בסלון' }))
  })
  store.saveSettings({ helperUrl: cloud.url, helperToken: 'good' })
  await check('ping: connected', async () => {
    const r = await brain.pingHelper()
    assert.strictEqual(r.ok, true)
    const last = cloud.seen[cloud.seen.length - 1]
    assert.strictEqual(last.url, '/bridge/ask')
    assert.strictEqual(last.body.text, '')
    assert.strictEqual(last.body.audio, false)
  })
  store.saveSettings({ helperToken: 'bad' })
  await check('ping: wrong code', async () => assert.deepStrictEqual(await brain.pingHelper(), { ok: false, reason: 'הקוד של המחשב לא נכון' }))
  store.saveSettings({ helperToken: '' })
  await check('ping: no code', async () => assert.strictEqual((await brain.pingHelper()).ok, false))
  store.saveSettings({ helperUrl: 'http://127.0.0.1:9', helperToken: 'good' })
  await check('ping: cloud down', async () => assert.deepStrictEqual(await brain.pingHelper(), { ok: false, reason: 'אין חיבור' }))

  // 3. The API brain (no Claude plan): "תכבה את האורות" inside a longer ask is handed to the cloud with ask_helper.
  store.saveSettings({ helperUrl: cloud.url, helperToken: 'good' })
  const hands = require('../src/hands')
  hands.setUi({ askHelper: async (q) => (await brain.askHelper(q)).reply })
  let turn = 0
  let toolsSent = null
  const llm = await serve((req, res, got) => {
    toolsSent = got.body.tools.map((t) => t.function.name)
    turn++
    const msg = turn === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ask_helper', arguments: JSON.stringify({ request: 'תכבה את האורות בסלון' }) } }] }
      : { role: 'assistant', content: 'כיביתי את האורות בסלון, ופתחתי לך את ספוטיפיי' }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: msg }] }))
  })
  process.env.LLM_API_KEY = 'test'
  process.env.LLM_BASE_URL = llm.url
  process.env.LLM_MODEL = 'test/model'
  const directLlm = require('../src/direct-llm')
  await check('api brain: ask_helper reaches the cloud', async () => {
    const before = cloud.seen.length
    const tools = []
    const r = await directLlm.ask('תכבה את האורות בסלון ותפתח ספוטיפיי', {}, (ev) => ev.type === 'tool' && tools.push(ev.name))
    assert.strictEqual(r.ok, true)
    assert.ok(toolsSent.includes('ask_helper'), 'ask_helper offered to the model')
    assert.deepStrictEqual(tools, ['ask_helper'])
    const sent = cloud.seen.slice(before)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].body.text, 'תכבה את האורות בסלון')
    assert.strictEqual(sent[0].body.source, 'pc')
    assert.strictEqual(sent[0].auth, 'Bearer good')
  })
  await check('api brain: the prompt says what the cloud is for', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'direct-llm.js'), 'utf8')
    assert.match(src, /כל מה שלא על המחשב הזה: ask_helper/)
  })

  cloud.server.close()
  llm.server.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
