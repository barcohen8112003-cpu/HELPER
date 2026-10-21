// node src/phone-selftest.js
// Offline: a local SOCKS5 proxy and an echo server stand in for Tailscale and the phone.
// No adb binary is required. Pairing messages, shell policy, approval and Hebrew typing are pure.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-phone-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
process.env.PHONE_ADB_HOST = '100.110.143.89'
process.env.PHONE_MODE = 'ask'
process.env.PHONE_PROXY = 'socks5://127.0.0.1:1'
delete process.env.WEBTOP_PROXY
fs.writeFileSync(process.env.HELPER_ENV_FILE, 'BOT_NAME=phone-test\n')

const { config } = await import('./config.js')
const phone = await import('./phone.js')
const { phoneTools } = await import('./phone-tools.js')
const { activeTools } = await import('./tools.js')
const { parseSocksProxy, startTcpForward } = await import('./socks-forward.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

ok(config.phone.host === '100.110.143.89' && config.phone.mode === 'ask', 'phone host and ask mode come from the env')
ok(phone.phoneEnabled(), 'a host with PHONE_MODE=ask turns phone tools on')
ok(parseSocksProxy('socks5://tailscale:1055')?.host === 'tailscale' && parseSocksProxy('socks5://tailscale:1055')?.port === 1055, 'the tailscale SOCKS address parses')
ok(parseSocksProxy('http://proxy:8080') === null, 'an http proxy is not accepted for ADB')
ok(phone.resolvePhoneProxy('', 'socks5://tailscale:1055')?.port === 1055, 'an empty PHONE_PROXY reuses a socks5 Webtop proxy')
ok(phone.resolvePhoneProxy('', 'http://il.example:8080')?.host === 'tailscale', 'an http Webtop proxy falls back to socks5://tailscale:1055')
ok(phone.resolvePhoneProxy('direct', 'socks5://tailscale:1055') === null, 'PHONE_PROXY=direct skips the tunnel')

ok(phone.parseEndpoint('41234', '100.110.143.89')?.port === 41234, 'a bare port uses the saved tailnet host')
ok(phone.parseEndpoint('100.110.143.89:37123').host === '100.110.143.89' && phone.parseEndpoint('100.110.143.89:37123').port === 37123, 'host:port is accepted')
ok(phone.parseEndpoint('not a port') === null && phone.parseEndpoint('99999', '100.110.143.89') === null, 'a bad endpoint is rejected')

const pair = phone.parsePhoneMessage('צמד טלפון 37123 123456')
ok(pair?.kind === 'pair' && pair.endpoint === '37123' && pair.code === '123456', 'צמד טלפון parses port and code')
const pairHost = phone.parsePhoneMessage('צמד טלפון 100.110.143.89:37123 654321')
ok(pairHost?.endpoint === '100.110.143.89:37123' && pairHost.code === '654321', 'צמד טלפון accepts host:port')
const connect = phone.parsePhoneMessage('חבר טלפון 41234')
ok(connect?.kind === 'connect' && connect.endpoint === '41234', 'חבר טלפון parses the connect port')
ok(phone.parsePhoneMessage('חבר טלפון 100.110.143.89:41234.')?.endpoint === '100.110.143.89:41234', 'a trailing period does not break the port')
ok(phone.parsePhoneMessage('תשלוט לי בטלפון') === null, 'a normal request is left for the model')
ok(phone.parsePhoneMessage('צמד טלפון 37123 12345') === null, 'a pairing code must be 6 digits')

ok(phone.phoneNeedsApproval('ask', 'read') === 'allow', 'ask lets a screenshot run')
ok(phone.phoneNeedsApproval('ask', 'write') === 'ask', 'ask requires כן before a tap')
ok(phone.phoneNeedsApproval('ask-writes', 'read') === 'allow' && phone.phoneNeedsApproval('ask-writes', 'write') === 'ask', 'ask-writes matches ask')
ok(phone.phoneNeedsApproval('ask-all', 'read') === 'ask', 'ask-all also asks before a read')
ok(phone.phoneNeedsApproval('auto', 'write') === 'allow', 'auto runs a normal write')
ok(phone.phoneNeedsApproval('auto', 'dangerous') === 'ask' && phone.phoneNeedsApproval('ask', 'dangerous') === 'ask', 'a dangerous command always asks')
ok(phone.phoneNeedsApproval('off', 'read') === 'deny', 'off hides the phone')

const shellTool = phoneTools.find((t) => t.name === 'phone_shell')
const blocked = await shellTool.run({ command: 'pm uninstall com.foo' }, { confirm: async () => false })
ok(blocked.includes('לא אישר'), 'uninstall is refused when the user says no')
const chained = await shellTool.run({ command: 'echo hello; rm -rf /' }, { confirm: async () => true })
ok(chained.includes('נחסמה'), 'a chained command is blocked even if the user says yes')
const reset = await shellTool.run({ command: 'settings put secure android_id 1' }, { confirm: async () => false })
ok(reset.includes('לא אישר'), 'settings put secure waits for an explicit yes')
ok(phone.classifyShell('pm clear com.foo') === 'dangerous', 'pm clear is dangerous')
ok(phone.classifyShell('rm /sdcard/x') === 'dangerous', 'rm is dangerous')
ok(phone.classifyShell('reboot') === 'dangerous', 'reboot is dangerous')
ok(phone.classifyShell('echo $(id)') === 'deny', 'command substitution is denied')
ok(phone.classifyShell('getprop ro.build.version.release') === 'ok', 'a read-only getprop is allowed')
try {
  await phone.phoneShell('pm uninstall com.foo')
  ok(false, 'a dangerous shell without confirmed must throw')
} catch (e) {
  ok(e.message.includes('אישור'), 'a dangerous shell does not run without an explicit yes')
}

const hebrew = phone.typeTextPlan('שלום עולם')
ok(hebrew.method === 'clipboard' && Buffer.from(hebrew.b64, 'base64').toString('utf8') === 'שלום עולם', 'Hebrew is typed through a base64 clipboard paste')
ok(hebrew.pasteKey === '279', 'the paste key is KEYCODE_PASTE')
const ascii = phone.typeTextPlan('hello world')
ok(ascii.method === 'input' && ascii.text === 'hello%sworld', 'ASCII uses input text with spaces as %s')
ok(phone.typeTextPlan('100%').method === 'clipboard', 'a percent sign does not go through input text escapes')

const nodes = phone.summarizeUi(`<hierarchy><node text="הגדרות" content-desc="" clickable="true" bounds="[10,20][110,80]" /><node text="" content-desc="מצלמה" clickable="true" bounds="[0,100][40,140]" /></hierarchy>`)
ok(nodes.length === 2 && nodes[0].cx === 60 && nodes[0].cy === 50, 'a UI dump keeps the center of a tappable node')
ok(phone.findTapTarget(nodes, 'מצלמה')?.cx === 20, 'a tap can target an element by its text')
ok(phone.formatUi(nodes).includes('הגדרות') && phone.formatUi(nodes).includes('60,50'), 'the dump the model sees includes the label and the center')
ok(phone.resolveApp('וואטסאפ', ['com.whatsapp', 'com.android.settings']) === 'com.whatsapp', 'a Hebrew app name maps to its package')
ok(phone.resolveApp('com.android.settings', ['com.android.settings']) === 'com.android.settings', 'a package name opens itself')

const notes = phone.summarizeNotifications(`NotificationRecord(0x1) pkg=com.whatsapp extras={ android.title=String (דן) android.text=String (היי) }`)
ok(notes[0]?.title === 'דן' && notes[0].text === 'היי' && notes[0].pkg === 'com.whatsapp', 'a notification dump keeps title, text and package')
const bat = phone.parseBattery('  level: 81\n  status: 3\n  temperature: 292\n')
ok(bat.level === 81 && bat.status === 'מתרוקנת' && bat.tempC === 29.2, 'battery level, state and temperature are parsed')

const png = Buffer.alloc(24)
png.write('IHDR', 12, 'ascii')
png.writeUInt32BE(1080, 16)
png.writeUInt32BE(2400, 20)
ok(phone.pngSize(png)?.width === 1080 && phone.pngSize(png)?.height === 2400, 'a screenshot size is read from the PNG header')

const keys = phone.adbPaths(tmp)
ok(keys.keys.endsWith(`${path.sep}.android${path.sep}adbkey`) && fs.existsSync(keys.android), 'ADB keys are created under the data volume')
ok(phone.adbEnv(tmp).ADB_MDNS === '0' && phone.adbEnv(tmp).ADB_VENDOR_KEYS === keys.keys, 'adb is told not to use mDNS and where the key lives')

const box = {}
ok(phone.planPhoneDisconnectNotice(box, 1_000_000).includes('ניפוי אלחוטי'), 'the disconnect note explains how to turn wireless debugging back on')
ok(phone.planPhoneDisconnectNotice(box, 1_000_000 + 1000) === '', 'the same outage does not send another note')
phone.clearPhoneDisconnectNotice(box)
ok(phone.planPhoneDisconnectNotice(box, 1_000_000 + 60_000) === '', 'a flap inside 12 hours still does not send')
ok(phone.planPhoneDisconnectNotice(box, 1_000_000 + phone.PHONE_DISCONNECT_MS + 1).includes('חבר טלפון'), 'after the gap a new note can go out')

config.phone.mode = 'off'
ok(!phone.phoneEnabled() && !activeTools().some((t) => t.name === 'phone_tap'), 'PHONE_MODE=off hides the phone tools')
config.phone.mode = 'ask'
ok(activeTools().some((t) => t.name === 'phone_screenshot') && activeTools().some((t) => t.name === 'phone_type_text'), 'ask mode exposes the phone tools')
ok(phone.phonePrompt(false).includes('תשלוט לי בטלפון') && phone.phonePrompt(false).includes('מה יש לי בטלפון') && phone.phonePrompt(false).includes('5555'), 'the Hebrew prompt routes phone requests and mentions port 5555')
ok(phone.phoneRoutePrompt(false) === phone.phonePrompt(false), 'with ADB and no app, the prompt stays the ADB one')
const missing = phone.phoneAppMissingPrompt(false)
ok(missing.includes('HELPER: שליטה בטלפון') && missing.includes('חבר טלפון') && missing.includes('אל תציע ניפוי אלחוטי') && !missing.includes('5555'), 'without the app, ask for the HELPER accessibility service and mention ADB only as a fallback')
const ready = phone.phoneAppReadyPrompt(false)
ok(ready.includes('run_on_phone') && ready.includes('שליטה מלאה') && !ready.includes('phone_open_app') && !ready.includes('חבר טלפון'), 'a connected app is told to use run_on_phone and not to ask him to connect')
config.phone.mode = 'off'
ok(phone.phoneRoutePrompt(false).includes('HELPER: שליטה בטלפון') && !activeTools().some((t) => t.name.startsWith('phone_')), 'no ADB and no app asks him to open HELPER, and hides the ADB tools')
config.phone.mode = 'ask'
ok(activeTools().some((t) => t.name === 'phone_open_app') && !activeTools().some((t) => t.name === 'run_on_phone'), 'ADB tools are back when the app is not connected')
ok(JSON.stringify(phone.reconnectPorts(41234)) === JSON.stringify([41234, 5555]) && JSON.stringify(phone.reconnectPorts(5555)) === JSON.stringify([5555]), 'reconnect tries the saved port, then 5555')

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
const aptInstall = docker.slice(docker.indexOf('apt-get install'), docker.indexOf('curl -fsSL'))
ok(docker.includes('https://dl.google.com/android/repository/platform-tools-latest-linux.zip') && docker.includes('ADB_PATH=/opt/platform-tools/adb'), 'the image installs current platform-tools adb')
ok(!/(^|[\s\\])adb([\s\\]|$)/.test(aptInstall), 'the image does not install Debian adb, which has no pair command')
const compose = fs.readFileSync(path.join(root, 'docker-compose.tailscale.yml'), 'utf8')
const exampleEnv = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
const tailExample = fs.readFileSync(path.join(root, '.tailscale.env.example'), 'utf8')
ok(compose.includes('tailscale/tailscale:stable') && compose.includes('TS_USERSPACE') && compose.includes('.tailscale.env'), 'the tailscale sidecar is an optional compose file')
ok(compose.includes('socks5://tailscale:1055') && compose.includes('helper-vps'), 'helper reaches the phone through the userspace SOCKS proxy')
ok(!compose.includes('TS_AUTHKEY=') && !exampleEnv.includes('TS_AUTHKEY='), 'the auth key is not written into the compose file or .env')
ok(tailExample.includes('TS_AUTHKEY=') && fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.tailscale.env'), '.tailscale.env holds the key and is gitignored')
const page = fs.readFileSync(path.join(root, 'src', 'phone.html'), 'utf8')
ok(page.includes('dir="rtl"') && page.includes('ניפוי אלחוטי') && page.includes('צמד') && page.includes('חבר') && page.includes('5555') && page.includes('סלולר'), 'the phone page is Hebrew, RTL, and explains port 5555')
ok(page.includes('id="kbd"') && page.includes('id="txt"') && page.includes('position:fixed') && page.includes('לוחצים על שדה בתמונה, ואז מקלידים כאן') && page.includes('שלח טקסט') && page.includes('/api/phone/type') && page.includes('/api/phone/key'), 'the phone live view types from a real text field')
ok(/fromEnter && !text[\s\S]{0,160}type: 'key', key: 'Enter'/.test(page) && page.includes('data-key="Tab"') && page.includes('מחק ⮌'), 'Enter in an empty phone field sends Enter, and Tab and Backspace have buttons')
ok(phone.phoneKeyCode('Enter') === '66' && phone.phoneKeyCode('tab') === '61' && phone.phoneKeyCode('Backspace') === '67', 'the live-view keys map to Android enter, tab and delete')
const settings = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
ok(settings.includes("href: '/phone'") && settings.includes('טלפון'), 'settings links to the phone page')
ok(settings.includes('פורט 5555 עד אתחול, גם בנתונים סלולריים'), 'settings explains that the phone moves to port 5555')
const help = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')
ok(help.includes('אחר כך העוזר עובר לפורט 5555 עד אתחול, גם בנתונים סלולריים'), 'WhatsApp help explains the move to port 5555')

function listen(handler) {
  return new Promise((resolve) => {
    const server = net.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const echo = await listen((socket) => socket.pipe(socket))
const echoPort = echo.address().port

const socks = await listen((socket) => {
  let buf = Buffer.alloc(0)
  let stage = 'hello'
  const take = (n) => {
    if (buf.length < n) return null
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    return out
  }
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (stage === 'hello') {
      const hello = take(2)
      if (!hello) return
      const methods = take(hello[1])
      if (!methods) return
      socket.write(Buffer.from([0x05, 0x00]))
      stage = 'request'
    }
    if (stage !== 'request' || buf.length < 4) return
    const atyp = buf[3]
    const need = atyp === 0x01 ? 10 : atyp === 0x03 && buf.length >= 5 ? 5 + buf[4] + 2 : 0
    if (!need || buf.length < need) return
    const req = take(need)
    const host = atyp === 0x01 ? [...req.subarray(4, 8)].join('.') : req.subarray(5, 5 + req[4]).toString()
    const port = req.readUInt16BE(req.length - 2)
    socket.off('data', onData)
    if (buf.length) socket.unshift(buf)
    stage = 'open'
    const remote = net.connect({ host, port }, () => {
      const reply = Buffer.alloc(10)
      reply[0] = 0x05
      reply[1] = 0x00
      reply[3] = 0x01
      socket.write(reply)
      socket.pipe(remote)
      remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy())
  }
  socket.on('data', onData)
})

const fwd = await startTcpForward({
  targetHost: '127.0.0.1',
  targetPort: echoPort,
  proxy: { host: '127.0.0.1', port: socks.address().port },
})
const echoed = await new Promise((resolve, reject) => {
  const client = net.connect({ host: '127.0.0.1', port: fwd.port }, () => client.write('שלום-adb'))
  client.on('data', (chunk) => {
    client.end()
    resolve(chunk.toString())
  })
  client.on('error', reject)
  setTimeout(() => reject(new Error('tunnel timed out')), 3000)
})
ok(echoed === 'שלום-adb', 'a TCP connection is forwarded through SOCKS5 to the target port')
await fwd.close()
await new Promise((resolve) => socks.close(resolve))
await new Promise((resolve) => echo.close(resolve))

const calls = []
const up = new Set()
let failWireless = false
let tcpipFails = false
let miss5555 = 0
phone.setPhoneIoForTests({
  tunnel: async (host, port) => {
    calls.push(['tunnel', host, port])
    return { port, host, close: async () => {} }
  },
  closeTunnel: async (host, port) => {
    calls.push(['close', host, port])
  },
  runAdb: async (args) => {
    calls.push(['adb', ...args])
    if (args[0] === 'connect') {
      if (failWireless && String(args[1]).endsWith(':41234')) throw new Error('failed to connect')
      if (String(args[1]).endsWith(':5555') && miss5555 > 0) {
        miss5555--
        throw new Error('connection refused')
      }
      up.add(args[1])
      return `connected to ${args[1]}`
    }
    if (args[0] === 'disconnect') {
      up.delete(args[1])
      return ''
    }
    if (args.includes('get-state')) {
      const serial = args[args.indexOf('-s') + 1]
      if (!up.has(serial)) throw new Error('not connected')
      return 'device\n'
    }
    if (args.includes('tcpip')) {
      if (tcpipFails) throw new Error('tcpip refused')
      return 'restarting in TCP mode port: 5555\n'
    }
    if (args.includes('getprop')) return 'SM-S938B\n'
    if (args.includes('dumpsys')) return 'level: 80\n'
    return ''
  },
})
const tcpipCount = () => calls.filter((c) => c[0] === 'adb' && c.includes('tcpip')).length
const host = '100.110.143.89'

miss5555 = 1
const switched = await phone.connectPhone({ host, port: 41234 })
ok(tcpipCount() === 1, 'the first wireless connect runs adb tcpip 5555 once')
ok(calls.some((c) => c[0] === 'adb' && c[1] === '-s' && c[2] === '127.0.0.1:41234' && c[3] === 'tcpip' && c[4] === '5555'), 'tcpip is sent to the wireless serial')
ok(calls.some((c) => c[0] === 'adb' && c[1] === 'connect' && c[2] === '127.0.0.1:5555'), 'the forwarder reconnects to host port 5555')
ok(phone.phoneBox().port === 5555 && phone.phoneBox().host === host && phone.phoneBox().serial === '127.0.0.1:5555', 'port 5555 is saved after the switch')
ok(switched.message.includes('5555') && switched.message.includes('סלולר'), 'the connect reply says 5555 stays up on cellular data')
ok(miss5555 === 0, 'a refused first try on 5555 is retried')

const tcpipAfterSwitch = tcpipCount()
up.delete('127.0.0.1:5555')
const stayed = await phone.connectPhone({ host, port: 5555 })
ok(tcpipCount() === tcpipAfterSwitch && phone.phoneBox().port === 5555 && stayed.message.includes('מחובר'), 'connecting to 5555 does not run tcpip again')

const beforeReconnect = tcpipCount()
await phone.reconnectPhone()
ok(tcpipCount() === beforeReconnect && phone.phoneBox().port === 5555, 'reconnect on a saved 5555 does not run tcpip')

failWireless = true
up.clear()
phone.phoneBox().port = 41234
phone.phoneBox().serial = '127.0.0.1:41234'
const beforeFallback = tcpipCount()
const fellBack = await phone.reconnectPhone()
ok(tcpipCount() === beforeFallback && phone.phoneBox().port === 5555 && fellBack.message.includes('מחובר'), 'reconnect tries the saved port, then 5555, without tcpip')
ok(calls.some((c) => c[0] === 'adb' && c[1] === 'connect' && c[2] === '127.0.0.1:41234'), 'the dead wireless port is attempted before 5555')

up.delete('127.0.0.1:5555')
phone.phoneBox().serial = '127.0.0.1:41234'
phone.phoneBox().port = 41234
const kept = await phone.phoneKeepAlive()
ok(kept === '' && phone.phoneBox().port === 5555, 'keepalive falls through to 5555 when the saved wireless port is down')

tcpipFails = true
failWireless = false
const beforeFail = phone.phoneBox().port
let tcpipThrew = false
try {
  await phone.connectPhone({ host, port: 39999 })
} catch (e) {
  tcpipThrew = e.message.includes('5555')
}
ok(tcpipThrew && phone.phoneBox().port === beforeFail && phone.phoneBox().port !== 39999, 'a failed move to 5555 does not save the wireless port')

phone.setPhoneIoForTests({})

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
