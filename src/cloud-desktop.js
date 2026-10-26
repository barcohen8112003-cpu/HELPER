// One X display for the cloud browsers, plus a window manager and a VNC web client.
// x11vnc listens on localhost only. noVNC listens on 6080 inside the container and is not published.
// The settings site reverse-proxies /desktop/ after the session cookie. Tailscale Serve is the other door.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { config } from './config.js'

export const NOVNC_QUERY = 'autoconnect=1&resize=scale&reconnect=1&show_dot=1&path=desktop/websockify'
export const NOVNC_DIRECT_QUERY = 'autoconnect=1&resize=scale&reconnect=1&show_dot=1'
const HOME = '/tmp/cloud-desktop/home'
const NOVNC_WEB = '/usr/share/novnc'

const children = []
let started = false

export function isDesktopPath(pathname) {
  return pathname === '/desktop' || pathname.startsWith('/desktop/')
}

export function desktopClientPath() {
  return `/desktop/vnc.html?${NOVNC_QUERY}`
}

function which(names) {
  for (const name of names) {
    if (name.includes(path.sep) && fs.existsSync(name)) return name
    for (const dir of (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return ''
}

function displaySocket(display) {
  const n = String(display || ':99').replace(/^:/, '').split('.')[0]
  return `/tmp/.X11-unix/X${n}`
}

export function xvfbArgs() {
  const display = config.desktop.display || ':99'
  const geometry = /^\d+x\d+$/.test(config.desktop.geometry) ? config.desktop.geometry : '1280x800'
  return [display, '-screen', '0', `${geometry}x24`, '-ac', '-nolisten', 'tcp']
}

export function x11vncArgs(passfile = '') {
  const args = [
    '-display', config.desktop.display || ':99',
    '-localhost',
    '-rfbport', String(config.desktop.vncPort || 5900),
    '-forever',
    '-shared',
    '-noxdamage',
    '-repeat',
    '-nolookup',
  ]
  if (config.desktop.vncPassword && passfile) args.push('-passwdfile', passfile)
  else args.push('-nopw')
  return args
}

export function websockifyArgs() {
  return [
    '--web', NOVNC_WEB,
    `0.0.0.0:${config.desktop.webPort || 6080}`,
    `127.0.0.1:${config.desktop.vncPort || 5900}`,
  ]
}

export function fluxboxMenu(raise = path.join(HOME, 'raise.sh')) {
  return `[begin] (שולחן העבודה)
[exec] (Webtop) {${raise} helper-webtop}
[exec] (Google Home) {${raise} helper-google-home}
[exec] (קניות) {${raise} helper-errand}
[exec] (Gemini) {${raise} helper-gemini}
[end]
`
}

export function raiseScript() {
  return `#!/bin/sh
class=$1
if command -v wmctrl >/dev/null 2>&1; then
  id=$(wmctrl -lx | awk -v c="$class" 'index($3, c) { print $1; exit }')
  if [ -n "$id" ]; then exec wmctrl -i -a "$id"; fi
fi
if command -v xdotool >/dev/null 2>&1; then
  exec xdotool search --class "$class" windowactivate windowraise
fi
exit 1
`
}

export function writeDesktopFiles(home = HOME) {
  const dir = path.join(home, '.fluxbox')
  fs.mkdirSync(dir, { recursive: true })
  const raise = path.join(home, 'raise.sh')
  fs.writeFileSync(raise, raiseScript(), { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'menu'), fluxboxMenu(raise))
  fs.writeFileSync(path.join(dir, 'init'), 'session.menuFile: ~/.fluxbox/menu\nsession.screen0.toolbar.visible: true\n')
  return { home, raise }
}

function track(child) {
  children.push(child)
  child.on('error', (e) => console.log(`[desktop] ${e.message}`))
  child.on('exit', (code, signal) => {
    if (code || signal) console.log(`[desktop] תהליך יצא (${code ?? signal})`)
  })
  return child
}

function spawnDesktop(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: 'ignore', env })
  return track(child)
}

async function waitForSocket(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('מסך ה-Xvfb לא עלה.')
}

export async function startCloudDesktop() {
  if (!config.desktop.enabled || started) return false
  started = true
  const display = config.desktop.display || ':99'
  process.env.DISPLAY = display
  const { home } = writeDesktopFiles(HOME)
  const env = { ...process.env, DISPLAY: display, HOME: home, LANG: process.env.LANG || 'C.UTF-8' }
  const sock = displaySocket(display)
  if (!fs.existsSync(sock)) {
    const xvfb = which(['Xvfb', '/usr/bin/Xvfb'])
    if (!xvfb) throw new Error('Xvfb לא מותקן, אי אפשר להרים שולחן עבודה.')
    spawnDesktop(xvfb, xvfbArgs(), env)
    await waitForSocket(sock, 10000)
  }
  const fluxbox = which(['fluxbox'])
  if (fluxbox) spawnDesktop(fluxbox, [], env)
  else console.log('[desktop] fluxbox לא נמצא, החלונות בלי מנהל חלונות.')
  const passfile = path.join(HOME, 'vncpass')
  if (config.desktop.vncPassword) fs.writeFileSync(passfile, config.desktop.vncPassword + '\n', { mode: 0o600 })
  const x11vnc = which(['x11vnc'])
  if (!x11vnc) throw new Error('x11vnc לא מותקן.')
  spawnDesktop(x11vnc, x11vncArgs(passfile), env)
  const websockify = which(['websockify'])
  if (!websockify) throw new Error('websockify לא מותקן.')
  spawnDesktop(websockify, websockifyArgs(), env)
  console.log('[desktop] noVNC על פורט 6080 בתוך הקונטיינר, בלי פרסום החוצה. באתר ההגדרות: /desktop/')
  return true
}

// On exit, not on the signal: the browsers on this display close cleanly first (index.js), then the display goes.
process.on('exit', () => {
  for (const child of children) child.kill('SIGTERM')
})

export function desktopShellHtml() {
  const src = desktopClientPath()
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>שולחן עבודה בענן</title>
<style>
  html, body { margin:0; height:100%; background:#111; }
  iframe { border:0; width:100%; height:100%; }
  #keys { position:fixed; z-index:5; top:10px; inset-inline-start:10px; font:16px/1.2 system-ui, sans-serif; padding:10px 14px; border:0; border-radius:10px; background:#1f1d1a; color:#fff; }
</style>
</head>
<body>
<iframe id="vnc" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<button id="keys" type="button">מקלדת</button>
<script>
document.getElementById('keys').addEventListener('click', () => {
  const doc = document.getElementById('vnc').contentDocument
  if (!doc) return
  const btn = doc.querySelector('#noVNC_keyboard_button')
  if (btn) { btn.click(); return }
  const input = doc.querySelector('#noVNC_keyboardinput, textarea')
  if (input) input.focus()
})
</script>
</body>
</html>`
}

// /desktop/vnc.html and /desktop/websockify map onto the noVNC root.
// /desktop and /desktop/ are our own page, so the phone gets a keyboard button.
export function mapDesktopTarget(reqUrl, upstreamBase = config.desktop.upstream) {
  const incoming = new URL(reqUrl, 'http://127.0.0.1')
  const pathname = incoming.pathname
  if (!isDesktopPath(pathname)) return null
  if (pathname === '/desktop' || pathname === '/desktop/') return { shell: true }
  const rest = pathname.slice('/desktop'.length)
  if (!rest.startsWith('/') || rest.includes('..')) return null
  const target = new URL(upstreamBase)
  return {
    hostname: target.hostname,
    port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    path: rest + incoming.search,
  }
}

function upstreamHeaders(req, mapped) {
  const headers = { ...req.headers, host: `${mapped.hostname}:${mapped.port}` }
  delete headers.cookie
  delete headers.Cookie
  delete headers.authorization
  return headers
}

export function proxyDesktopHttp(req, res, upstreamBase = config.desktop.upstream) {
  const mapped = mapDesktopTarget(req.url, upstreamBase)
  if (!mapped || mapped.shell) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('לא נמצא')
    return
  }
  const preq = http.request({
    hostname: mapped.hostname,
    port: mapped.port,
    path: mapped.path,
    method: req.method,
    headers: upstreamHeaders(req, mapped),
  }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers)
    pres.pipe(res)
  })
  preq.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<body dir="rtl" style="font-family:system-ui;padding:48px">שולחן העבודה לא עלה.</body>')
  })
  req.pipe(preq)
}

export function proxyDesktopUpgrade(req, socket, head, upstreamBase = config.desktop.upstream) {
  const mapped = mapDesktopTarget(req.url || '/', upstreamBase)
  const reject = (status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }
  if (!mapped || mapped.shell) return reject(404, 'Not Found')
  const preq = http.request({
    hostname: mapped.hostname,
    port: mapped.port,
    path: mapped.path,
    method: 'GET',
    headers: upstreamHeaders(req, mapped),
  })
  preq.on('upgrade', (up, usock, uhead) => {
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (const [key, value] of Object.entries(up.headers)) {
      const list = Array.isArray(value) ? value : [value]
      for (const item of list) raw += `${key}: ${item}\r\n`
    }
    raw += '\r\n'
    socket.write(raw)
    if (uhead?.length) socket.write(uhead)
    if (head?.length) usock.write(head)
    usock.pipe(socket)
    socket.pipe(usock)
    const drop = (other) => () => other.destroy()
    usock.on('error', drop(socket))
    socket.on('error', drop(usock))
  })
  preq.on('response', (up) => {
    reject(up.statusCode || 502, 'Bad Gateway')
    up.resume()
  })
  preq.on('error', () => reject(502, 'Bad Gateway'))
  preq.end()
}
