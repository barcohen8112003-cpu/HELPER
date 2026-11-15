// node src/obscura-selftest.js — Obscura routing with a fake CDP server. No live network, no Chromium profile.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-obscura-'))
process.env.HELPER_DATA_DIR = dir
process.env.HELPER_ENV_FILE = path.join(dir, 'empty.env')
process.env.HELPER_OFFLINE = '1'
fs.writeFileSync(process.env.HELPER_ENV_FILE, '')
delete process.env.SERPAPI_KEY
delete process.env.SEARCHAPI_KEY
delete process.env.TAVILY_API_KEY

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const obscura = await import('./obscura.js')
const { config, obscuraProxyFrom } = await import('./config.js')

const state = { identity: 'obscura', failNav: false }

function startMock() {
  const hits = { pages: 0 }
  let lastUrl = ''
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ Browser: 'Chrome/145.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser' }))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/devtools/browser')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      const ok = (result) => socket.send(JSON.stringify({ id: msg.id, result }))
      const bad = (message) => socket.send(JSON.stringify({ id: msg.id, error: { code: -32601, message } }))
      if (msg.method === 'LP.getMarkdown') return bad(state.identity === 'obscura' ? 'No page' : 'Unknown domain: LP')
      if (msg.method === 'Target.createTarget') return ok({ targetId: 'page-9' })
      if (msg.method === 'Target.attachToTarget') return ok({ sessionId: 'sess-9' })
      if (msg.method === 'Target.closeTarget') return ok({ success: true })
      if (msg.method === 'Page.navigate') {
        lastUrl = String(msg.params?.url || '')
        hits.pages++
        if (state.failNav) return bad('navigation exceeded 20000ms deadline')
        return ok({ frameId: 'page-9' })
      }
      if (msg.method === 'Runtime.evaluate') {
        return ok({ result: { type: 'string', value: JSON.stringify(fakePage(lastUrl)) } })
      }
      return bad('Unknown domain: X')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      hits,
      close: (cb) => {
        for (const client of wss.clients) client.terminate()
        server.close(cb)
      },
    }))
  })
}

function fakePage(url) {
  if (url.includes('blocked.example')) return { title: 'Just a moment', href: url, text: 'Just a moment... verify you are human. Cloudflare' }
  if (url.includes('bing.com')) {
    if (state.emptySearch) return { text: 'no results', rows: [] }
    return {
      text: 'results',
      rows: [
        { title: 'DualSense', url: 'https://www.bing.com/ck/a?p=1', cite: 'https://www.playstation.com › accessories', snippet: 'controller' },
        { title: 'Shop', url: 'https://shop.example/ds', cite: '', snippet: 'price' },
      ],
    }
  }
  if (url.includes('zap.co.il')) {
    if (state.emptyZap) return { text: 'אין תוצאות', rows: [] }
    return {
      text: 'זאפ',
      rows: [
        { title: 'Sony WH-1000XM5', price: '1,042', href: '/model.aspx?modelid=1', shop: 'השוואה ב-8 חנויות' },
        { title: 'Sony WH-1000XM4', price: '690', href: '/model.aspx?modelid=2', shop: 'השוואה ב-5 חנויות' },
        { title: 'Sony WF-1000XM5', price: '581', href: '/model.aspx?modelid=4', shop: 'השוואה ב-6 חנויות' },
        { title: 'משומש Sony WH', price: '200', href: '/model.aspx?modelid=3', shop: 'חנות' },
      ],
    }
  }
  if (url.includes('youtube.com')) return [{ id: 'abcdefghijk', title: 'הדרכה' }]
  return { title: 'Example', href: url, text: 'Example Domain. This domain is for documentation examples. '.repeat(20) }
}

const mock = await startMock()
obscura._setForTest({ base: `http://127.0.0.1:${mock.port}`, installed: true })

assert.equal(obscura.publicUrlProblem('file:///etc/passwd'), 'רק http/https')
assert.equal(obscura.publicUrlProblem('http://127.0.0.1/'), 'כתובת פנימית חסומה')
assert.equal(obscura.publicUrlProblem('http://169.254.169.254/'), 'כתובת פנימית חסומה')
assert.equal(obscura.publicUrlProblem('http://10.0.0.4/'), 'כתובת פנימית חסומה')
assert.equal(obscura.publicUrlProblem('http://localhost/x'), 'כתובת פנימית חסומה')
assert.equal(obscura.publicUrlProblem('https://93.184.215.14/'), '')
config.webtop.url = 'https://school.example/home'
assert.match(obscura.publicUrlProblem('https://school.example/grades'), /חלון/)
assert.match(obscura.publicUrlProblem('https://a.school.example/grades'), /חלון/)
config.webtop.url = ''

assert.equal(obscuraProxyFrom('http://own', 'http://errand', 'http://web'), 'http://own')
assert.equal(obscuraProxyFrom('direct', 'http://errand', 'http://web'), '')
assert.equal(obscuraProxyFrom('', 'direct', 'http://web'), '')
assert.equal(obscuraProxyFrom('', '', 'socks5://phone:1055'), 'socks5://phone:1055')
assert.equal(obscuraProxyFrom('', 'http://errand', 'http://web'), 'http://errand')

assert.equal(obscura.safePort(9223), 9228)
assert.equal(obscura.safePort(9224), 9228)
assert.equal(obscura.safePort(9226), 9228)
assert.equal(obscura.safePort(9227), 9228)
assert.equal(obscura.safePort(9228), 9228)
const savedPort = config.obscura.port
const savedProxy = config.obscura.proxy
config.obscura.port = 9223
config.obscura.proxy = 'http://il.example:8080'
const args = obscura.launchArgs()
assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
assert.equal(args[args.indexOf('--port') + 1], '9228')
assert.ok(args.includes('--max-connections') && args[args.indexOf('--max-connections') + 1] === '2')
assert.ok(args.some((a) => a.includes('--max-old-space-size=')))
assert.ok(args.includes('--proxy') && args.includes('http://il.example:8080'))
assert.ok(!args.includes('0.0.0.0'))
assert.ok(!args.some((a) => /9223|9224|9226|9227|user-data-dir|remote-debugging|errand-profile|webtop-profile|google-home-profile|\/var\/data/.test(String(a))))
config.obscura.port = savedPort
config.obscura.proxy = ''
assert.ok(!obscura.launchArgs().includes('--proxy'))
config.obscura.proxy = savedProxy

assert.equal(obscura.citeToUrl('https://www.playstation.com › accessories'), 'https://www.playstation.com')
const parsed = obscura.parseSearchRows([
  { title: 'DualSense', url: 'https://www.bing.com/ck/a?p=1', cite: 'https://shop.example/item › x', snippet: 'a' },
  { title: '', url: 'https://example.com' },
])
assert.equal(parsed[0].url, 'https://shop.example/item')
assert.equal(parsed.length, 1)

const offers = obscura.parseOffers({ rows: [{ title: 'Sony', price: '1,042', href: '/model.aspx?modelid=9', shop: 'חנויות' }, { title: 'משומש ישן', price: '100', href: '/model.aspx?modelid=1' }] })
assert.equal(offers[0].price, 1042)
assert.equal(offers[0].link, 'https://www.zap.co.il/model.aspx?modelid=9')
assert.equal(offers[1].used, true)
assert.deepEqual(obscura.rankOffers(offers, { budget: '₪500', includeUsed: true }).map((r) => r.price), [100])
assert.ok(obscura.rankOffers(offers, { includeUsed: false }).every((r) => !r.used))
assert.match(obscura.formatSurvey(obscura.rankOffers(offers, { includeUsed: true }), 'sony'), /זאפ/)
assert.equal(obscura.pageBlocked('Just a moment while we verify you are human'), true)
assert.equal(obscura.pageBlocked('מדריך ארוך על אוזניות'), false)

const read = await obscura.readPublicPage('https://example.com/docs')
assert.match(read, /documentation examples/)
assert.equal(await obscura.readPublicPage('https://blocked.example/'), '')
assert.equal(await obscura.readPublicPage('http://127.0.0.1/secret'), '')
const pagesAfterRefuse = mock.hits.pages
config.webtop.url = 'https://school.example'
assert.equal(await obscura.readPublicPage('https://school.example/grades'), '')
assert.equal(mock.hits.pages, pagesAfterRefuse)
config.webtop.url = ''

state.identity = 'chrome'
obscura._clearBreaker()
assert.equal(await obscura.readPublicPage('https://example.com/docs'), '')
state.identity = 'obscura'
obscura._clearBreaker()

const { webSearch, fetchPage } = await import('./web.js')
const realFetch = globalThis.fetch
let fetches = []
globalThis.fetch = async (url) => {
  fetches.push(String(url))
  const html = '<a class="result__a" href="https://fallback.example/a">Fallback title</a> <a class="result__snippet">from duck</a>'
  const thin = String(url).includes('example.com/thin') || String(url).includes('127.0.0.1')
  return new Response(thin ? '<html><body><p>short</p></body></html>' : html, { status: 200, headers: { 'content-type': 'text/html' } })
}
fetches = []
const found = await webSearch('ps5 controller')
assert.equal(fetches.length, 0)
assert.equal(found[0].title, 'DualSense')
assert.match(found[0].url, /^https:\/\//)
state.emptySearch = true
obscura._clearBreaker()
fetches = []
const fell = await webSearch('ps5 controller')
assert.ok(fetches.some((u) => u.includes('duckduckgo')))
assert.equal(fell[0].title, 'Fallback title')
state.emptySearch = false

fetches = []
const page = await fetchPage('https://example.com/thin')
assert.match(page, /documentation examples/)
const local = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<html><body><p>short</p></body></html>')
})
await new Promise((r) => local.listen(0, '127.0.0.1', r))
state.failNav = true
obscura._clearBreaker()
const kept = await fetchPage(`http://127.0.0.1:${local.address().port}/thin`)
assert.match(kept, /short/)
assert.doesNotMatch(kept, /documentation examples/)
state.failNav = false
await new Promise((r) => local.close(r))
globalThis.fetch = realFetch

const yt = await obscura.youtubePublic('הדרכה', 3)
assert.equal(yt[0].id, 'abcdefghijk')

const surveyed = await obscura.surveyPrices('אוזניות סוני', { budget: '₪800' })
assert.match(surveyed, /690 ₪/)
assert.match(surveyed, /https:\/\/www\.zap\.co\.il\/model\.aspx\?modelid=2/)
assert.doesNotMatch(surveyed, /1,042/)
assert.doesNotMatch(surveyed, /משומש/)
state.emptyZap = true
assert.equal(await obscura.surveyPrices('אוזניות'), '')
state.emptyZap = false

const { tools } = await import('./tools.js')
const { runErrand, _setGoalForTest } = await import('./computer-use.js')
let errands = 0
_setGoalForTest(() => {
  errands++
  return 'DONE: from the signed-in window'
})
const cp = tools.find((t) => t.name === 'compare_prices')
assert.equal(cp.enabled(), true)
errands = 0
const prices = await cp.run({ goal: 'אוזניות סוני', budget: '₪800' }, {})
assert.match(prices, /זאפ/)
assert.match(prices, /690/)
assert.equal(errands, 0, 'a successful Obscura survey must not open the signed-in shop window')
state.emptyZap = true
config.computerMode = 'ask'
config.webtop.cloud = true
errands = 0
const fallback = await cp.run({ goal: 'אוזניות סוני' }, {})
assert.match(fallback, /signed-in window/)
assert.equal(errands, 1)
config.computerMode = 'off'
config.webtop.cloud = false
state.emptyZap = false

let seen = null
_setGoalForTest((run) => {
  seen = run
  return 'DONE'
})
await runErrand('מה המחיר של אוזניות סוני', 'budget: 800', {}, {})
assert.match(seen.constraints, /anonymous browser/)
assert.match(seen.constraints, /budget: 800/)
assert.equal(seen.survey, false)
seen = null
await runErrand('מה המחיר של אוזניות סוני', 'survey only', {}, { survey: true })
assert.equal(seen.constraints, 'survey only')
assert.equal(seen.survey, true)

config.obscura.enabled = false
obscura._clearBreaker()
const before = mock.hits.pages
assert.equal(await obscura.searchPublic('anything'), null)
assert.equal(await obscura.researchNotes('תזמין פיצה'), '')
assert.equal(mock.hits.pages, before)
assert.equal(obscura.obscuraInstalled(), false)
config.obscura.enabled = true

const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
assert.doesNotMatch(compose, /9228:9228/)
assert.match(compose, /9228/)
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
assert.match(dockerfile, /eed986e478c5ec5439f531f2d7fb6b0e36a356f1df7a6c44a8e8fd4f2486bd76/)
assert.match(dockerfile, /obscura --version/)
assert.doesNotMatch(dockerfile, /EXPOSE 9228/)
assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /OBSCURA_ENABLED/)
assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /compare_prices/)

await new Promise((r) => mock.close(r))
console.log('obscura: הכול תקין')
