// node src/cloud-desktop-selftest.js
// Offline: no X server. Checks launch flags, the noVNC proxy auth, and that 6080 is not published.
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-desktop-'))
const uiPort = await new Promise((resolve) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
process.env.UI_PORT = String(uiPort)
delete process.env.CLOUD_DESKTOP
delete process.env.WEBTOP_PROXY
delete process.env.UI_PUBLIC_HOST
fs.writeFileSync(process.env.HELPER_ENV_FILE, 'WEBTOP_URL=https://school.example/home\n')

const { config } = await import('./config.js')
const browser = await import('./webtop-browser.js')
const desktop = await import('./cloud-desktop.js')
const { startUi } = await import('./ui.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

ok(config.desktop.enabled === false, 'CLOUD_DESKTOP is off unless set')
ok(browser.browserLaunchArgs('webtop').includes('--headless=new'), 'Webtop stays headless without the shared desktop')
ok(browser.browserLaunchArgs('google-home').includes('--disable-blink-features=AutomationControlled'), 'Google Home keeps the sign-in flag without the shared desktop')
config.webtop.proxy = 'socks5://tailscale:1055'
config.desktop.enabled = true
const webArgs = browser.browserLaunchArgs('webtop')
const homeArgs = browser.browserLaunchArgs('google-home')
ok(!webArgs.includes('--headless=new') && webArgs.includes('--class=helper-webtop'), 'Webtop is a real window on the shared desktop')
ok(webArgs.includes('--proxy-server=socks5://tailscale:1055') && webArgs.includes('--window-size=1280,800'), 'the desktop Webtop window keeps WEBTOP_PROXY and the phone-sized screen')
ok(!homeArgs.includes('--headless=new') && homeArgs.includes('--class=helper-google-home') && !homeArgs.some((a) => String(a).startsWith('--proxy-server')), 'Google Home is headed on the same display and does not take the Webtop proxy')
const webPlan = browser.browserProcessPlan('webtop')
const homePlan = browser.browserProcessPlan('google-home')
ok(webPlan.env.DISPLAY === ':99' && homePlan.env.DISPLAY === ':99' && !String(webPlan.command).includes('xvfb'), 'both browsers use DISPLAY=:99 and not a private xvfb-run')
config.desktop.enabled = false
config.webtop.proxy = ''
ok(browser.browserLaunchArgs('webtop').includes('--headless=new'), 'turning the desktop off returns Webtop to headless')

ok(desktop.xvfbArgs().includes(':99') && desktop.xvfbArgs().includes('1280x800x24') && desktop.xvfbArgs().includes('-nolisten'), 'Xvfb is :99 at 1280x800 and does not listen on TCP')
const vnc = desktop.x11vncArgs()
ok(vnc.includes('-localhost') && vnc.includes('-nopw') && !vnc.some((a) => String(a).includes('0.0.0.0')), 'x11vnc is localhost only and has no password unless one is set')
config.desktop.vncPassword = 'secret'
ok(desktop.x11vncArgs('/tmp/vncpass').includes('-passwdfile') && !desktop.x11vncArgs('/tmp/vncpass').includes('-nopw'), 'a VNC password is read from a file')
config.desktop.vncPassword = ''
const sock = desktop.websockifyArgs()
ok(sock.includes('--web') && sock.includes('0.0.0.0:6080') && sock.includes('127.0.0.1:5900'), 'noVNC listens on 6080 inside the container and dials local VNC')
const menu = desktop.fluxboxMenu('/tmp/raise.sh')
ok(menu.includes('(Webtop)') && menu.includes('(Google Home)') && menu.includes('helper-webtop') && menu.includes('helper-google-home'), 'the window menu can raise each browser')
const files = desktop.writeDesktopFiles(path.join(tmp, 'home'))
ok(fs.readFileSync(path.join(files.home, '.fluxbox', 'menu'), 'utf8').includes('Google Home') && fs.readFileSync(files.raise, 'utf8').includes('wmctrl'), 'the fluxbox menu and raise script are written')
ok(desktop.desktopClientPath().includes('autoconnect=1') && desktop.desktopClientPath().includes('resize=scale') && desktop.desktopClientPath().includes('path=desktop/websockify'), 'the settings client autoconnects, scales, and uses the proxied websocket')
ok(!desktop.desktopClientPath().includes('password'), 'the client URL does not carry a VNC password')
const shell = desktop.desktopShellHtml()
ok(shell.includes('מקלדת') && shell.includes('noVNC_keyboard_button') && shell.includes('resize=scale'), 'the phone page has a keyboard toggle over noVNC')
ok(desktop.mapDesktopTarget('/desktop/').shell === true, 'the desktop root is our page')
ok(desktop.mapDesktopTarget('/desktop/vnc.html?autoconnect=1').path === '/vnc.html?autoconnect=1', 'asset requests drop the /desktop prefix')
ok(desktop.mapDesktopTarget('/desktop/websockify').path === '/websockify', 'the websocket is forwarded to /websockify')
ok(desktop.mapDesktopTarget('/desktop/../secret') === null, 'a path that leaves /desktop is not proxied')

const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
ok(/\bfluxbox\b/.test(docker) && /\bx11vnc\b/.test(docker) && /\bnovnc\b/.test(docker) && /\bwebsockify\b/.test(docker), 'the image installs the desktop, VNC and noVNC')
ok(!/EXPOSE[^\n]*\b6080\b/.test(docker), 'the image does not expose 6080')
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
const tail = fs.readFileSync(path.join(root, 'docker-compose.tailscale.yml'), 'utf8')
ok(!/6080:6080/.test(compose) && !/6080:6080/.test(tail), 'compose does not publish 6080 to the host')
ok(tail.includes('TS_SERVE_CONFIG') && tail.includes('http://helper:6080') && tail.includes('hostname: helper-vps'), 'the tailscale example serves the desktop and keeps the helper-vps hostname')
const serve = JSON.parse(fs.readFileSync(path.join(root, 'tailscale-serve', 'desktop.json'), 'utf8'))
ok(serve.Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy === 'http://helper:6080', 'TS_SERVE_CONFIG proxies the tailnet to the helper noVNC port')
ok(serve.AllowFunnel['${TS_CERT_DOMAIN}:443'] === false && serve.TCP['443'].HTTPS === true, 'Tailscale Serve is HTTPS on the tailnet and Funnel stays off')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
ok(readme.includes('שולחן עבודה בענן') && readme.includes('helper-vps.tail526bd3.ts.net') && readme.includes('tailscale serve --bg --https=443 http://helper:6080'), 'the Hebrew docs include the tailnet URL and the serve command')
ok(example.includes('CLOUD_DESKTOP=') && example.includes('6080 לא נפתח'), 'CLOUD_DESKTOP is documented and 6080 stays unpublished')
const settings = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
ok(settings.includes("href: '/desktop/'") && settings.includes('שולחן עבודה בענן'), 'settings links to the cloud desktop')

const seen = { cookie: 'unset', path: '' }
const upstream = http.createServer((req, res) => {
  seen.cookie = req.headers.cookie || ''
  seen.path = req.url
  res.end('NOVNC-PAGE')
})
const wss = new WebSocketServer({ noServer: true })
upstream.on('upgrade', (req, socket, head) => {
  seen.wsCookie = req.headers.cookie || ''
  seen.wsPath = req.url
  if (new URL(req.url, 'http://127.0.0.1').pathname !== '/websockify') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => ws.send('desktop-open'))
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

function hit(method, urlPath, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: uiPort,
      path: urlPath,
      method,
      headers: {
        host: host || `127.0.0.1:${uiPort}`,
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

const settingsUrl = startUi({ connectedSince: () => 0, restart: () => {} })
const token = new URL(settingsUrl).searchParams.get('t')
let ready = null
for (let i = 0; i < 20 && !ready; i++) {
  try { ready = await hit('GET', `/?t=${token}`) } catch { await new Promise((r) => setTimeout(r, 50)) }
}
ok(ready && ready.status === 302, 'the settings site accepted the token')
const cookie = String(ready.headers['set-cookie'] || '').split(';')[0]

const closed = await hit('GET', '/desktop/', { cookie })
ok(closed.status === 503 && closed.body.includes('כבוי'), 'a signed-in visitor does not reach noVNC while the desktop is off')
config.desktop.enabled = true
config.desktop.upstream = `http://127.0.0.1:${upstreamPort}`

const anon = await hit('GET', '/desktop/')
ok(anon.status === 403 && anon.body.includes('כדי להיכנס'), 'the desktop proxy requires the session cookie')
const foreign = await hit('GET', '/desktop/', { cookie, host: 'evil.example' })
ok(foreign.status === 403 && foreign.body.includes('גישה נדחתה'), 'a foreign Host cannot open the desktop')
const page = await hit('GET', '/desktop/', { cookie })
ok(page.status === 200 && page.body.includes('מקלדת') && page.body.includes('resize=scale'), 'a signed-in visitor gets the mobile desktop page')
const asset = await hit('GET', '/desktop/vnc.html?autoconnect=1', { cookie })
ok(asset.status === 200 && asset.body.includes('NOVNC-PAGE') && seen.path === '/vnc.html?autoconnect=1' && seen.cookie === '', 'noVNC files are proxied and the session cookie is not forwarded')
const linked = await hit('GET', `/desktop/?t=${token}`)
ok(linked.status === 302 && linked.headers.location === '/desktop/' && /SameSite=Lax/i.test(String(linked.headers['set-cookie'] || '')), 'a WhatsApp desktop link sets a Lax cookie and lands on /desktop/')

function openSocket(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${uiPort}/desktop/websockify`, { headers })
    const done = (result) => { ws.close(); resolve(result) }
    ws.once('message', (buf) => done({ ok: true, text: String(buf) }))
    ws.once('unexpected-response', (_req, res) => done({ ok: false, status: res.statusCode }))
    ws.once('error', (e) => done({ ok: false, error: e.message }))
  })
}
const denied = await openSocket({ host: `127.0.0.1:${uiPort}` })
ok(denied.ok === false && denied.status === 403, 'the desktop websocket requires the session cookie')
const opened = await openSocket({ host: `127.0.0.1:${uiPort}`, cookie })
ok(opened.ok === true && opened.text === 'desktop-open' && seen.wsPath === '/websockify' && !seen.wsCookie, 'a signed-in websocket reaches noVNC and does not forward the cookie')

upstream.close()
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
