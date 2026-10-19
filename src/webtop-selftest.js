// node src/webtop-selftest.js
// Offline: no Chromium, no WhatsApp. Covers .env precedence, UI_PUBLIC_HOST allow-lists, cloud routing,
// and the one-shot re-login notice.
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-webtop-'))
const port = await new Promise((resolve) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
process.env.BOT_NAME = 'stale-container'
process.env.NEWS_BRIEF_TIME = 'stale-time'
process.env.WEBTOP_CLOUD = '1'
process.env.WEBTOP_URL = 'https://not-from-file.example/'
process.env.UI_PORT = String(port)
process.env.UI_PUBLIC_HOST = '203.0.113.10:3210'
delete process.env.WEBTOP_PROXY
delete process.env.PC_BRIDGE_SECRET
delete process.env.PC_BRIDGE_EXECUTOR
fs.writeFileSync(process.env.HELPER_ENV_FILE, [
  'BOT_NAME=from-file',
  'NEWS_BRIEF_TIME=',
  'WEBTOP_URL=https://school.example/home',
  '# ignored',
  'export LLM_LIGHT=false',
].join('\n'))

const { config } = await import('./config.js')
const session = await import('./session.js')
const browser = await import('./webtop-browser.js')
const { uiPolicy, startUi } = await import('./ui.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

ok(config.botName === 'from-file', 'a value in .env replaces the stale container env')
ok(config.newsTime === '', 'an empty .env value clears a stale container env')
ok(config.webtop.url === 'https://school.example/home', 'WEBTOP_URL is taken from the file')
ok(config.webtop.cloud === true, 'WEBTOP_CLOUD stays when the file does not mention it')
ok(config.webtop.proxy === '', 'WEBTOP_PROXY is empty until it is set')
ok(process.env.LLM_LIGHT === 'false', 'an export line in .env is applied')

const pub = '203.0.113.10:3210'
const policy = uiPolicy(port, { UI_PUBLIC_HOST: pub })
ok(policy.hosts.includes(`127.0.0.1:${port}`) && policy.hosts.includes(`localhost:${port}`), 'loopback hosts stay allowed')
ok(policy.hosts.includes(pub), 'UI_PUBLIC_HOST is an allowed Host')
ok(policy.origins.includes(`http://127.0.0.1:${port}`) && policy.origins.includes(`http://localhost:${port}`), 'loopback origins stay allowed')
ok(policy.origins.includes(`http://${pub}`), 'the public origin is allowed for POSTs')
ok(policy.publicBase === `http://${pub}`, 'printed links use the public base')
const loop = uiPolicy(port, {})
ok(!loop.hosts.includes(pub) && loop.publicBase === `http://127.0.0.1:${port}`, 'without UI_PUBLIC_HOST only loopback is offered')

const route = session.sessionTransport({ cloud: true, remote: true, bridgeUp: true })
ok(route.primary === 'cloud' && route.fallback === 'home', 'cloud Webtop is read locally, with the home bridge as fallback')
ok(session.sessionTransport({ cloud: true, remote: true, bridgeUp: false }).fallback === null, 'a disconnected home bridge is not a fallback')
ok(session.sessionTransport({ cloud: false, remote: true, bridgeUp: true }).primary === 'home', 'without WEBTOP_CLOUD, Webtop stays on the home bridge')
ok(session.sessionTransport({ cloud: false, remote: false, bridgeUp: false }).primary === 'local', 'on the home PC the local window is used')
ok(session.sessionTransport().primary === 'cloud', 'the running config with WEBTOP_CLOUD chooses the cloud browser')

const login = Object.assign(new Error('Webtop לא מחובר.'), { code: 'webtop-login' })
ok(session.isWebtopLoginError(login), 'a login page is recognized')
let homeCalls = 0
const fromHome = await session.runSessionRead(
  async () => { throw login },
  async () => { homeCalls++; return 'מערכת שעות' },
  { primary: 'cloud', fallback: 'home' },
)
ok(fromHome === 'מערכת שעות' && homeCalls === 1, 'a signed-in home window answers when the cloud session is logged out')
let both = 0
try {
  await session.runSessionRead(
    async () => { throw login },
    async () => { both++; throw login },
    { primary: 'cloud', fallback: 'home' },
  )
  ok(false, 'both sessions logged out should throw')
} catch (e) {
  ok(session.isWebtopLoginError(e) && both === 1, 'when the home window is also logged out the reply stays Webtop לא מחובר')
}
let other = 0
try {
  await session.runSessionRead(
    async () => { throw new Error('דפדפן ה-Webtop בענן לא זמין.') },
    async () => { other++; return 'nope' },
    { primary: 'cloud', fallback: 'home' },
  )
  ok(false, 'a browser failure should not be swallowed')
} catch (e) {
  ok(e.message.includes('לא זמין') && other === 0, 'a browser failure does not fall back to the home bridge')
}

const CLOUDFRONT = [
  '403 ERROR',
  'The request could not be satisfied.',
  'Request blocked.',
  "We can't connect to the server for this app or website at this time.",
  'Generated by cloudfront (CloudFront)',
  'Request ID: abc',
].join('\n')
const timetable = 'מערכת שעות\nשיעור 1\nמתמטיקה, כהן, חדר 12\nשלישי'
ok(session.webtopPageBlocked(CLOUDFRONT), 'a CloudFront 403 page is detected as blocked')
ok(session.webtopPageBlocked('Request blocked'), 'the Request blocked line alone is enough')
ok(session.webtopPageBlocked('The request could not be satisfied'), 'the CloudFront satisfaction line is enough')
ok(!session.webtopPageBlocked(timetable), 'a Hebrew timetable is not a block page')
ok(!session.webtopPageBlocked('שגיאה בטעינת המערכת'), 'an ordinary Hebrew error is not a block page')
ok(!session.webtopPageBlocked('חדר 403'), 'a room number is not a block page')
ok(!session.webtopPageBlocked(''), 'an empty page is not a block page')

ok(session.classifyWebtopSnapshot({ href: 'https://school.example/home', login: false, text: CLOUDFRONT }) === 'blocked', 'a blocked snapshot is classified before a login check')
ok(session.webtopCloudBlockedNow(), 'the blocked flag stays up for the settings page')
ok(session.classifyWebtopSnapshot({ href: 'https://school.example/home', login: true, text: 'סיסמה' }) === 'login', 'a real login page is not a block')
ok(!session.webtopCloudBlockedNow(), 'reaching Webtop clears the blocked flag')
session.classifyWebtopSnapshot({ href: 'https://school.example/home', login: false, text: CLOUDFRONT })

const blocked = Object.assign(new Error(session.WEBTOP_BLOCKED_STATUS), { code: 'webtop-blocked' })
ok(session.isWebtopBlockedError(blocked) && blocked.message === 'וובטופ חוסם את כתובת השרת, משתמשים במחשב הביתי', 'the blocked error carries the Hebrew status')
ok(!session.isWebtopLoginError(blocked), 'a block is not a signed-out session')
ok(session.webtopKeepAliveFailure(blocked) === 'silent', 'a block does not become a WhatsApp notice')
ok(session.webtopKeepAliveFailure(login) === 'login', 'a login page still plans the re-login notice')
ok(session.webtopKeepAliveFailure(new Error('דפדפן ה-Webtop בענן לא זמין.')) === 'track', 'other failures are still reported after they repeat')
ok(session.keepAliveAfterCloudError(blocked, true) === 'home', 'keepalive warms the home window when the cloud IP is blocked')
ok(session.keepAliveAfterCloudError(blocked, false) === 'throw', 'without the bridge a block is not pretended to succeed')
ok(session.keepAliveAfterCloudError(login, true) === 'throw', 'a cloud login page is not hidden by the home window')

let blockedHome = 0
const viaHome = await session.runSessionRead(
  async () => { throw blocked },
  async () => { blockedHome++; return 'ציונים' },
  { primary: 'cloud', fallback: 'home' },
)
ok(viaHome === 'ציונים' && blockedHome === 1, 'a blocked cloud page falls back to the home bridge')
let blockedBoth = 0
try {
  await session.runSessionRead(
    async () => { throw blocked },
    async () => { blockedBoth++; throw new Error('הגשר לא ענה') },
    { primary: 'cloud', fallback: 'home' },
  )
  ok(false, 'a blocked page with a dead home window should throw')
} catch (e) {
  ok(session.isWebtopBlockedError(e) && blockedBoth === 1, 'when the home window also fails the blocked status stands')
}
let noBridge = 0
try {
  await session.runSessionRead(
    async () => { throw blocked },
    async () => { noBridge++; return 'ציונים' },
    { primary: 'cloud', fallback: null },
  )
  ok(false, 'a block without a fallback should throw')
} catch (e) {
  ok(session.isWebtopBlockedError(e) && noBridge === 0, 'a disconnected bridge is not asked to read a blocked page')
}

ok(browser.webtopProxySwitch('') === '', 'an empty proxy adds no flag')
ok(browser.webtopProxySwitch('http://127.0.0.1:8888') === '--proxy-server=http://127.0.0.1:8888', 'an http proxy becomes --proxy-server')
ok(browser.webtopProxySwitch('socks5://proxy.example:1080') === '--proxy-server=socks5://proxy.example:1080', 'a socks5 proxy becomes --proxy-server')
ok(browser.webtopProxySwitch('not a url') === '' && browser.webtopProxySwitch('--disable-web-security') === '', 'a proxy value cannot smuggle extra flags')
config.webtop.proxy = 'http://il.example:8080'
const withProxy = browser.browserLaunchArgs('webtop')
const homeArgs = browser.browserLaunchArgs('google-home')
ok(withProxy.includes('--proxy-server=http://il.example:8080'), 'the cloud Webtop Chromium receives the proxy')
ok(!homeArgs.some((a) => String(a).startsWith('--proxy-server')), 'Google Home Chromium does not receive WEBTOP_PROXY')
config.webtop.proxy = ''
ok(!browser.browserLaunchArgs('webtop').some((a) => String(a).startsWith('--proxy-server')), 'clearing WEBTOP_PROXY drops the flag')

session.setWebtopLoginUrl(() => 'http://203.0.113.10:3210/webtop?t=token')
const box = {}
const first = session.planWebtopLoginNotice(box, 1_000_000)
ok(first.includes('התחברות מחדש') && first.includes('http://203.0.113.10:3210/webtop?t=token'), 'the notice is Hebrew and carries the login link')
ok(session.planWebtopLoginNotice(box, 1_000_000 + 60_000) === '', 'the same outage does not send another notice')
session.clearWebtopLoginNotice(box)
ok(session.planWebtopLoginNotice(box, 1_000_000 + 60_000) === '', 'a flap inside 12 hours still does not send')
const later = session.planWebtopLoginNotice(box, 1_000_000 + session.WEBTOP_LOGIN_NOTIFY_MS + 1)
ok(later.includes('/webtop'), 'after the gap, and after the session had recovered, a new notice can go out')

const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'webtop.html'), 'utf8')
ok(page.includes('dir="rtl"') && page.includes('התחברות ל-Webtop') && page.includes('הסיסמה לא נשמרת'), 'the login page is Hebrew, RTL, and does not claim to store the password')
ok(page.includes('וובטופ חוסם את כתובת השרת, משתמשים במחשב הביתי') && page.includes('/api/state'), 'the Webtop page can show the blocked-server status')
ok(page.includes('data-site="google-home"') && page.includes('התחברות ל-Google Home'), 'the login page lets the user choose Google Home')
ok(page.includes("type: 'click'") && page.includes("type: 'type'") && page.includes("type: 'key'") && page.includes("type: 'scroll'"), 'the page forwards clicks, typing, keys and scrolling')
const settingsHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf8')
ok(settingsHtml.includes('התחברות ל-Webtop') && settingsHtml.includes("href: '/webtop'"), 'the connections section links to the login page')
ok(settingsHtml.includes("href: '/google-home'") && settingsHtml.includes('התחברות ל-Google Home'), 'the connections section links to Google Home login')
ok(settingsHtml.includes('וובטופ חוסם את כתובת השרת, משתמשים במחשב הביתי'), 'the settings page can show the blocked-server status')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
ok(/\bxauth\b/.test(docker), 'the image installs xauth so xvfb-run can start')
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
ok(example.includes('WEBTOP_PROXY') && readme.includes('WEBTOP_PROXY'), 'WEBTOP_PROXY is documented for a non-Israeli server')

function hit(method, urlPath, { host, origin, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        host: host || `127.0.0.1:${port}`,
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const settingsUrl = startUi({ connectedSince: () => 0, restart: () => {} })
ok(settingsUrl.startsWith(`http://${pub}/?t=`), 'the printed settings URL uses UI_PUBLIC_HOST')
const token = new URL(settingsUrl).searchParams.get('t')
let ready = null
for (let i = 0; i < 20 && !ready; i++) {
  try {
    ready = await hit('GET', `/?t=${token}`)
  } catch {
    await new Promise((r) => setTimeout(r, 50))
  }
}
ok(ready && ready.status === 302, 'the token link is accepted on loopback')
const cookie = String(ready.headers['set-cookie'] || '').split(';')[0]
ok(cookie.startsWith('helper_session='), 'the token is swapped for the session cookie')

const evil = await hit('GET', '/', { host: 'evil.example' })
ok(evil.status === 403 && evil.body.includes('גישה נדחתה'), 'a foreign Host is rejected')
const pubHost = await hit('GET', '/', { host: pub })
ok(pubHost.status === 403 && pubHost.body.includes('כדי להיכנס') && !pubHost.body.includes('גישה נדחתה'), 'UI_PUBLIC_HOST passes the Host check')
const open = await hit('GET', '/webtop', { cookie })
ok(open.status === 200 && open.body.includes('התחברות ל-Webtop'), 'a signed-in visitor gets the login view')
const gh = await hit('GET', '/google-home', { cookie })
ok(gh.status === 200 && gh.body.includes('data-site="google-home"'), 'a signed-in visitor can open the Google Home login view')
const ghLink = await hit('GET', `/google-home?t=${token}`, { host: pub })
ok(ghLink.status === 302 && ghLink.headers.location === '/google-home', 'the WhatsApp link signs in and lands on /google-home')
const closed = await hit('GET', '/webtop')
ok(closed.status === 403, 'the login view requires the settings cookie')
const fromPhone = await hit('GET', `/webtop?t=${token}`, { host: pub })
ok(fromPhone.status === 302 && fromPhone.headers.location === '/webtop', 'the WhatsApp link signs in and lands on /webtop')

const badOrigin = await hit('POST', '/api/settings', { cookie, origin: 'http://evil.example', body: '{}' })
ok(badOrigin.status === 403 && badOrigin.body.includes('מקור לא מורשה'), 'a foreign Origin is rejected')
const pubOrigin = await hit('POST', '/api/settings', { cookie, origin: `http://${pub}`, body: '{}' })
ok(pubOrigin.status === 200, 'the public origin may POST')
const loopOrigin = await hit('POST', '/api/settings', { cookie, origin: `http://127.0.0.1:${port}`, body: '{}' })
ok(loopOrigin.status === 200, 'the loopback origin still may POST')

session.classifyWebtopSnapshot({ href: 'https://school.example/home', login: false, text: CLOUDFRONT })
const blockedState = await hit('GET', '/api/state', { cookie })
const blockedJson = JSON.parse(blockedState.body)
ok(blockedState.status === 200 && blockedJson.webtop.blocked === true && blockedJson.webtop.blockedStatus === 'וובטופ חוסם את כתובת השרת, משתמשים במחשב הביתי', 'the settings API reports the cloud block in Hebrew')
session.classifyWebtopSnapshot({ href: 'https://school.example/home', login: false, text: timetable })
const clearState = JSON.parse((await hit('GET', '/api/state', { cookie })).body)
ok(clearState.webtop.blocked === false, 'a real Webtop page clears the blocked status')

config.google.clientId = 'test-client'
config.google.clientSecret = 'test-secret'
const oauth = await hit('GET', '/google/connect', { cookie, host: pub })
const loc = decodeURIComponent(oauth.headers.location || '')
ok(oauth.status === 302 && loc.includes(`http://${pub}/google/callback`), 'Google OAuth redirect uses the public base')

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
