// node src/pc-bridge-selftest.js
// The cloud routes computer actions to a home bridge: signature, replay, a real loopback socket,
// a disconnected PC, COMPUTER_MODE=ask refusing a state change before anything is sent,
// reconnect backoff, and the Windows logon-task installer.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import winPath from 'node:path/win32'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-pc-bridge-'))
process.env.HELPER_ENV_FILE = path.join(process.env.HELPER_DATA_DIR, 'no.env')
process.env.PC_BRIDGE_SECRET = 'test-secret-not-real'
process.env.COMPUTER_MODE = 'ask'
process.env.PC_BRIDGE_PORT = '0'
delete process.env.PC_BRIDGE_EXECUTOR
delete process.env.WEBTOP_CLOUD
delete process.env.GOOGLE_HOME_CLOUD
delete process.env.PC_BRIDGE_ON_PORT
delete process.env.PORT
delete process.env.WAKE_MAC
process.env.WEBTOP_URL = 'https://school.example/'

const bridge = await import('./pc-bridge.js')
const { tools, activeTools } = await import('./tools.js')
const { config } = await import('./config.js')
const pc = await import('./pc.js')
const session = await import('./session.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const tool = (name) => tools.find((t) => t.name === name)
const SECRET = config.pcBridge.secret

// ── config path: home-relay/pc-bridge.config.json, including Windows ────────
{
  const realDir = bridge.homeRelayDir()
  ok(fs.existsSync(path.join(realDir, 'pc-bridge.mjs')), 'home-relay is resolved beside the bridge module')
  ok(fs.existsSync(path.join(realDir, 'pc-bridge.config.example.json')), 'the example config is in the resolved home-relay directory')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-bridge-cfg-'))
  try {
    const home = path.join(root, 'home-relay')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'pc-bridge.config.json'), JSON.stringify({
      url: 'ws://cloud.example:3212/pc',
      secret: 'from-file-secret',
    }))
    const moduleUrl = pathToFileURL(path.join(root, 'src', 'pc-bridge.js')).href
    const found = bridge.bridgeConfig({}, moduleUrl)
    ok(found.url === 'ws://cloud.example:3212/pc' && found.secret === 'from-file-secret', 'a config file next to home-relay is found')
    const absent = bridge.bridgeConfig({}, pathToFileURL(path.join(root, 'missing', 'src', 'pc-bridge.js')).href)
    ok(absent.url === '' && absent.secret === '', 'a missing config file does not invent url or secret')
    const over = bridge.bridgeConfig({ PC_BRIDGE_URL: 'ws://from-env/pc', PC_BRIDGE_SECRET: 'env-secret' }, moduleUrl)
    ok(over.url === 'ws://from-env/pc' && over.secret === 'env-secret', 'PC_BRIDGE_URL and PC_BRIDGE_SECRET override the file')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  const winModule = 'file:///C:/Users/yokos/OneDrive/Desktop/HELPER/src/pc-bridge.js'
  const cfgPath = winPath.join(bridge.homeRelayDir(winModule, winPath), 'pc-bridge.config.json')
  ok(
    winPath.normalize(cfgPath) === winPath.normalize('C:\\Users\\yokos\\OneDrive\\Desktop\\HELPER\\home-relay\\pc-bridge.config.json'),
    'a Windows module URL resolves to home-relay/pc-bridge.config.json',
  )
  const spaced = 'file:///C:/Users/yokos/OneDrive/Desktop/My%20HELPER/src/pc-bridge.js'
  ok(
    winPath.normalize(winPath.join(bridge.homeRelayDir(spaced, winPath), 'pc-bridge.config.json')) ===
      winPath.normalize('C:\\Users\\yokos\\OneDrive\\Desktop\\My HELPER\\home-relay\\pc-bridge.config.json'),
    'a Windows path with a space still resolves beside home-relay',
  )
  const broken = winPath.normalize(winPath.join(winPath.dirname(new URL(winModule).pathname), '..', 'home-relay', 'pc-bridge.config.json'))
  ok(broken !== winPath.normalize(cfgPath) && broken.startsWith('\\C:\\'), 'URL.pathname would look beside a root folder named C:')
}

// ── signature, encryption, replay ───────────────────────────────────────────
{
  const body = { t: 'call', id: '1', name: 'media', args: ['mute'] }
  const frame = bridge.seal(SECRET, body)
  ok(!frame.includes('"name":"media"'), 'the call is not plaintext on the wire')
  const seen = new Map()
  const opened = bridge.openFrame(SECRET, frame, seen)
  ok(opened.ok && opened.payload.name === 'media' && opened.payload.args[0] === 'mute', 'a signed frame opens')
  ok(bridge.openFrame(SECRET, frame, seen).error === 'repeat', 'a replayed frame is rejected')
  ok(bridge.openFrame('other-secret-value', frame, new Map()).error === 'bad signature', 'a wrong secret is rejected')
  const stale = bridge.seal(SECRET, { t: 'call', id: '2', name: 'status', args: [] }, Date.now() - 120000)
  ok(bridge.openFrame(SECRET, stale, new Map()).error === 'too old', 'an old frame is rejected')

  ok(bridge.verifyHello(SECRET, bridge.signHello(SECRET)) === null, 'a fresh hello is accepted')
  ok(bridge.verifyHello(SECRET, bridge.signHello('nope-nope-nope')) === 'bad signature', 'a hello signed with the wrong secret is rejected')
  ok(bridge.verifyHello(SECRET, bridge.signHello(SECRET, Date.now() - 120000)) === 'too old', 'an old hello is rejected')
  const hello = bridge.signHello(SECRET)
  ok(bridge.verifyHello(SECRET, hello) === null && bridge.verifyHello(SECRET, hello) === 'repeat', 'a replayed hello is rejected')

  const tmp = path.join(os.tmpdir(), `helper-pack-${Date.now()}.png`)
  fs.writeFileSync(tmp, Buffer.from('PNGDATA'))
  const packed = bridge.pack({ width: 2, file: tmp }, true)
  ok(!fs.existsSync(tmp), 'a temp screenshot is removed on the sender after it is packed')
  const back = bridge.unpack(packed)
  ok(back.width === 2 && fs.readFileSync(back.file).toString() === 'PNGDATA', 'the screenshot is restored on the receiver')
  fs.rmSync(back.file, { force: true })
  const round = bridge.unpack(bridge.pack({ data: Buffer.from('hi') }))
  ok(Buffer.isBuffer(round.data) && round.data.toString() === 'hi', 'file bytes survive the bridge')

  let ran = 0
  const session = bridge.createHomeSession({
    secret: SECRET,
    handlers: { media: () => { ran++; return 'ok' } },
  })
  const call = bridge.seal(SECRET, { t: 'call', id: 'abc', name: 'media', args: ['mute'] })
  await session.handle(call)
  const second = await session.handle(call)
  ok(ran === 1 && second.error === 'repeat', 'a replayed call does not run twice')

  const sent = []
  const unknown = bridge.createHomeSession({ secret: SECRET, handlers: {} })
  unknown.attach({ readyState: WebSocket.OPEN, send: (frame) => sent.push(frame) })
  await unknown.handle(bridge.seal(SECRET, { t: 'call', id: 'z', name: 'nope', args: [] }))
  const reply = bridge.openFrame(SECRET, sent[0], new Map())
  ok(reply.ok && reply.payload.ok === false && reply.payload.error.includes('לא מוכרת'), 'an unknown action is refused')
}

// ── loopback: routing, refusal, disconnected PC ─────────────────────────────
const srv = bridge.startPcBridgeServer({ port: 0, host: '127.0.0.1' })
try {
  const addr = await srv.ready
  const url = `ws://127.0.0.1:${addr.port}/pc`
  const health = await fetch(`http://127.0.0.1:${addr.port}/pc/health`)
  ok(health.ok && (await health.json()).home === false, 'health answers before the PC connects')

  await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'x-helper-pc': bridge.signHello('wrong-secret-value') }, handshakeTimeout: 3000 })
    let done = false
    const finish = (cond, name) => {
      if (done) return
      done = true
      ok(cond, name)
      try { ws.terminate() } catch {}
      resolve()
    }
    ws.on('unexpected-response', (_req, res) => finish(res.statusCode === 401, 'the cloud refuses a bad hello'))
    ws.on('open', () => finish(false, 'the cloud refuses a bad hello'))
    ws.on('error', () => {})
    setTimeout(() => finish(false, 'the cloud refuses a bad hello'), 3000)
  })

  ok(activeTools().some((t) => t.name === 'pc_status'), 'computer tools are offered when the bridge is configured')
  config.computerMode = 'off'
  ok(!activeTools().some((t) => t.name === 'pc_status'), 'COMPUTER_MODE=off hides the computer tools')
  config.computerMode = 'ask'

  let offline = ''
  try {
    await tool('pc_status').run()
  } catch (e) {
    offline = e.message
  }
  ok(offline.includes('לא מחובר') && offline.includes('שום פעולה לא בוצעה'), 'a disconnected PC is reported, not a silent failure')
  let webtopOff = ''
  try {
    await session.readSessionPage('https://school.example/home')
  } catch (e) {
    webtopOff = e.message
  }
  ok(webtopOff.includes('לא מחובר') && webtopOff.includes('אי אפשר לשלוט'), 'Webtop is not read when the home bridge is down')

  const calls = []
  const link = await bridge.connectHome({
    url,
    secret: SECRET,
    handlers: {
      status: () => '{"cpu":1}',
      power: (action) => {
        calls.push(action)
        return `power:${action}`
      },
      typeText: (text) => {
        calls.push(`type:${text}`)
        return 'typed'
      },
      screenshot: () => {
        const file = path.join(os.tmpdir(), `helper-screen-${Date.now()}.png`)
        fs.writeFileSync(file, Buffer.from('SHOT'))
        return { file, width: 3, height: 4, scale: 1, left: 0, top: 0 }
      },
      readSessionPage: (url) => {
        calls.push(`webtop:${url}`)
        return 'מערכת שעות'
      },
      sessionKeepAlive: () => {
        const err = new Error('Webtop לא מחובר.')
        err.hint = 'צריך להיכנס שוב בחלון ה-Webtop.'
        throw err
      },
    },
  })
  ok(bridge.bridgeConnected(), 'the home bridge shows as connected')
  ok((await tool('pc_status').run()) === '{"cpu":1}', 'pc_status runs on the bridge and the answer comes back')

  ok((await session.readSessionPage('https://school.example/home')) === 'מערכת שעות', 'Webtop is read on the home PC through the bridge')
  ok(calls.includes('webtop:https://school.example/home'), 'the Webtop address is sent to the home window')
  let hinted = null
  try {
    await session.sessionKeepAlive()
  } catch (e) {
    hinted = e
  }
  ok(hinted?.message.includes('Webtop לא מחובר') && hinted?.hint.includes('חלון ה-Webtop'), 'a Webtop failure keeps its hint across the bridge')

  const shot = await pc.screenshot(100)
  ok(shot.width === 3 && shot.height === 4 && fs.readFileSync(shot.file).toString() === 'SHOT', 'a screenshot is taken on the home side and returned as a file')
  fs.rmSync(shot.file, { force: true })

  const denied = await tool('pc_power').run({ action: 'shutdown', minutes: 0 }, { confirm: async () => false })
  ok(denied.includes('לא אישר'), 'COMPUTER_MODE=ask tells the model the user refused')
  ok(!calls.includes('shutdown'), 'a refused shutdown is not sent to the PC')

  const allowed = await tool('pc_power').run({ action: 'shutdown', minutes: 0 }, { confirm: async () => true })
  ok(allowed === 'power:shutdown' && calls.includes('shutdown'), 'an approved shutdown is routed to the PC')

  {
    const { runTurn } = await import('./agent.js')
    config.llm.apiKey = 'test-key'
    config.llm.model = 'fake-model'
    config.llm.baseUrl = 'http://fake.invalid'
    config.llm.fallbackModels = []
    config.llm.cheapModel = ''
    config.llm.backup = { apiKey: '', model: '' }
    config.llm.light = false
    const realFetch = globalThis.fetch
    const seen = []
    let script = []
    globalThis.fetch = async (fetchUrl, init) => {
      if (!String(fetchUrl).startsWith('http://fake.invalid')) return realFetch(fetchUrl, init)
      const body = JSON.parse(init.body)
      seen.push(body.messages.filter((m) => m.role === 'tool').map((m) => m.content))
      return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() }] }) }
    }
    const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    script = [
      { role: 'assistant', content: '', tool_calls: [call('pc_type', { text: 'hello' }, '1')] },
      { role: 'assistant', content: 'לא הוקלד' },
    ]
    const before = calls.length
    await runTurn('תקליד hello', { confirm: async () => false })
    ok(calls.length === before, 'CONFIRM_ALWAYS refusal does not reach the PC')
    ok(seen.some((batch) => batch.some((x) => String(x).includes('לא אישר'))), 'the model is told the typing was refused')

    script = [
      { role: 'assistant', content: '', tool_calls: [call('pc_type', { text: 'hello' }, '2')] },
      { role: 'assistant', content: 'הוקלד' },
    ]
    await runTurn('תקליד hello', { confirm: async () => true })
    ok(calls.includes('type:hello'), 'approved typing is routed to the PC')
    globalThis.fetch = realFetch
  }

  link.close()
  await new Promise((r) => setTimeout(r, 50))
  config.wake.mac = '74563CE517D9'
  let woke = ''
  try {
    await tool('pc_status').run()
  } catch (e) {
    woke = e.message
  }
  ok(woke.includes('לא מחובר') && woke.includes('תדליק את המחשב') && woke.includes('Wake-on-LAN'), 'when the PC drops off, the answer names Wake-on-LAN')
  ok(!bridge.bridgeConnected(), 'the bridge is marked disconnected after the socket closes')
} finally {
  await bridge.stopPcBridgeServer()
}

// ── reconnect: backoff, no give-up, secret stays out of the log ─────────────
{
  ok(bridge.BRIDGE_BACKOFF_START_MS === 2000 && bridge.BRIDGE_BACKOFF_MAX_MS === 60000, 'backoff starts at 2s and caps at a minute')
  ok(bridge.BRIDGE_PING_MS >= 20000 && bridge.BRIDGE_PING_MS <= 60000, 'a busy desktop is not treated as a dead server')
  ok(
    bridge.nextBridgeDelay(2000) === 4000 && bridge.nextBridgeDelay(50000) === 60000 && bridge.nextBridgeDelay(60000) === 60000,
    'the wait doubles and then stays at a minute',
  )
  ok(bridge.scrubSecret('bad super-secret-value-99 here', 'super-secret-value-99') === 'bad [secret] here', 'the secret is stripped from a log line')
  ok(bridge.scrubSecret('status ok', 'ok') === 'status ok', 'a short token is not treated as the secret')

  const logs = []
  const spun = await bridge.runBridgeLoop({
    maxCycles: 2,
    sleep: async () => {},
    connect: async () => { throw new Error('refused super-secret-value-99') },
    onRetry: (e) => logs.push(bridge.scrubSecret(e.message, 'super-secret-value-99')),
  })
  ok(spun.cycles === 2 && logs.length === 1 && logs[0] === 'refused [secret]', 'one failed dial is not the end, and the secret stays out of the retry log')

  const waits = []
  const many = await bridge.runBridgeLoop({
    maxCycles: 8,
    sleep: async (ms) => { waits.push(ms) },
    connect: async () => { throw new Error('down') },
  })
  ok(
    many.cycles === 8 && JSON.stringify(waits) === JSON.stringify([2000, 4000, 8000, 16000, 32000, 60000, 60000]),
    'the bridge keeps retrying and the wait caps at one minute',
  )

  let n = 0
  const resetWaits = []
  await bridge.runBridgeLoop({
    maxCycles: 4,
    sleep: async (ms) => { resetWaits.push(ms) },
    connect: async () => {
      n += 1
      if (n === 2) return { closed: Promise.resolve() }
      throw new Error('down')
    },
  })
  ok(JSON.stringify(resetWaits) === JSON.stringify([2000, 2000, 4000]), 'a connection that came up resets the backoff before the next drop')

  const src = fs.readFileSync(new URL('./pc-bridge.js', import.meta.url), 'utf8')
  ok(src.includes('stopBeat = watchBridgeSocket(ws)'), 'the home process closes a quiet socket so the loop can dial again')
  ok(src.includes('scrubSecret(line, cfg.secret)'), 'home-bridge logs go through the secret scrub')

  function fakeSocket({ answer } = {}) {
    const listeners = {}
    return {
      readyState: 1,
      pings: 0,
      terminated: false,
      on(ev, fn) { (listeners[ev] ||= []).push(fn) },
      once(ev, fn) { this.on(ev, fn) },
      off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
      ping() {
        this.pings += 1
        if (answer) for (const fn of listeners.pong || []) fn()
      },
      terminate() {
        this.terminated = true
        this.readyState = 3
        for (const fn of [...(listeners.close || [])]) fn()
      },
    }
  }
  {
    let dead = 0
    const quiet = fakeSocket()
    const stopQuiet = bridge.watchBridgeSocket(quiet, { pingMs: 20, onDead: () => { dead += 1 } })
    try {
      await new Promise((r) => setTimeout(r, 400))
      ok(quiet.terminated && dead === 1 && quiet.pings >= 1, 'a socket that never answers a ping is closed so the bridge can reconnect')
    } finally {
      stopQuiet()
    }
  }
  {
    let dead = 0
    const live = fakeSocket({ answer: true })
    const stopLive = bridge.watchBridgeSocket(live, { pingMs: 20, onDead: () => { dead += 1 } })
    try {
      await new Promise((r) => setTimeout(r, 400))
      ok(!live.terminated && dead === 0 && live.pings >= 2, 'pings that are answered keep the bridge connected')
    } finally {
      stopLive()
    }
  }

  await bridge.stopPcBridgeServer()
  const again = bridge.startPcBridgeServer({ port: 0, host: '127.0.0.1' })
  try {
    const addr = await again.ready
    const url = `ws://127.0.0.1:${addr.port}/pc`
    let attempts = 0
    const delays = []
    const result = await bridge.runBridgeLoop({
      maxCycles: 3,
      startMs: 30,
      maxMs: 200,
      sleep: async (ms) => {
        delays.push(ms)
        await new Promise((r) => setTimeout(r, ms))
      },
      connect: async () => {
        attempts += 1
        if (attempts === 2) throw new Error('ECONNREFUSED')
        const link = await bridge.connectHome({ url, secret: SECRET, handlers: { status: () => 'up' } })
        setTimeout(() => { try { link.close() } catch { /* already closed */ } }, 40)
        return { closed: new Promise((resolve) => link.ws.once('close', resolve)) }
      },
    })
    ok(attempts === 3 && result.cycles === 3, 'a drop and a refused connection are both retried until the next dial')
    ok(delays[0] === 30 && delays[1] === 60, 'after a live session the next wait starts over, then grows if the server is still down')
  } finally {
    await bridge.stopPcBridgeServer()
  }
}

// ── Windows: hidden logon task, same config, no secret in the scripts ──────
{
  const relay = bridge.homeRelayDir()
  const repoRoot = path.join(relay, '..')
  const read = (name) => {
    const text = fs.readFileSync(path.join(relay, name), 'utf8')
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  }
  const bom = (name) => {
    const b = fs.readFileSync(path.join(relay, name))
    return b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF
  }
  const install = read('install-bridge-service.ps1')
  const service = read('bridge-service.ps1')
  const vbs = read('bridge-hidden.vbs')
  const bat = read('start-bridge.bat')
  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')

  ok(bom('install-bridge-service.ps1') && bom('bridge-service.ps1'), 'the PowerShell scripts are UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew')
  ok(install.includes("TaskName = 'HELPER PC Bridge'"), 'the task has a stable name')
  ok(install.includes('-AtLogOn'), 'the task starts when the user logs on')
  ok(/-LogonType Interactive/.test(install) && /-RunLevel Limited/.test(install), 'the task runs in the interactive user session')
  ok(!/S4U/.test(install) && !/LocalSystem/.test(install) && !/RunLevel Highest/.test(install), 'the task is not a SYSTEM or highest-privileges service')
  ok(install.includes('-AllowStartIfOnBatteries') && install.includes('-DontStopIfGoingOnBatteries'), 'a laptop on battery still runs the bridge')
  ok(install.includes('-MultipleInstances IgnoreNew'), 'a second logon does not start a second bridge')
  ok(install.includes('-RestartCount 999'), 'if the wrapper dies, Task Scheduler starts it again')
  ok(/ExecutionTimeLimit/.test(install) && /PT0S/.test(install) && /\[TimeSpan\]::Zero/.test(install), 'the task is not capped at three days')
  const cfgCall = install.indexOf('if (-not (Test-BridgeConfig')
  const stopCall = install.indexOf('Stop-ScheduledTask')
  ok(cfgCall !== -1 && stopCall !== -1 && cfgCall < stopCall, 'a bad config does not stop a bridge that is already running')
  ok(install.includes('Register-ScheduledTask') && install.includes('-Force'), 'install can be run again')
  ok(install.includes('-Uninstall') && install.includes('Unregister-ScheduledTask'), 'uninstall removes the task')
  ok(install.includes('pc-bridge.config.json') && install.includes('paste-the-same') && install.includes('YOUR_SERVER'), 'install uses the existing config and rejects the placeholder')
  ok(!/PC_BRIDGE_SECRET\s*=/.test(install) && !/Set-Content[\s\S]{0,120}pc-bridge\.config\.json/.test(install), 'install does not invent or write a secret')
  ok(!/Write-Host[^\n]*\$sec\b/.test(install) && !/Write-Host[^\n]*\$cfg\b/.test(install), 'install does not print the secret or the config object')
  ok(install.includes('*\\bridge-service.ps1*'), 'stopping the service does not match the installer script name')
  ok(install.includes('בלי חלון') && install.includes('התחברות'), 'the installer tells the owner, in Hebrew, that there is no window and that it starts at logon')
  ok(install.includes('wscript.exe') && vbs.includes('sh.Run cmd, 0, True') && vbs.includes('WindowStyle Hidden'), 'the launcher hides the console')
  ok(service.includes('CreateNoWindow = $true') && service.includes('pc-bridge.mjs'), 'the service starts node with no console')
  ok(service.includes('while ($true)') && service.includes('Start-Sleep -Seconds 15'), 'if node exits, the service starts it again')
  ok(service.includes('חלון הגשר כבר פתוח'), 'an open debug window is left alone instead of opening a second connection')
  const marker = service.indexOf('# webtop-once-before-loop\n    Start-WebtopOnce')
  const loopAt = service.indexOf('while ($true)', marker === -1 ? 0 : marker)
  ok(marker !== -1 && loopAt > marker && !service.slice(loopAt).includes('Start-WebtopOnce'), 'Webtop opens once when the service starts, not on every reconnect')
  ok(service.includes('WEBTOP_URL') && service.includes('webtop-browser.bat'), 'a configured Webtop window still comes up with the bridge')
  ok(service.includes('Hide-Secret') && !/Write-Host/.test(service), 'the hidden service does not print, and log lines can drop the secret')
  ok(!service.includes('paste-the-same') && !/secret\s*=\s*['"][^'"]{8,}['"]/.test(service), 'the service script does not embed a secret')
  ok(bat.includes(':loop') && bat.includes('timeout /t 15') && bat.includes('node home-relay\\pc-bridge.mjs') && bat.includes('install-bridge-service.ps1'), 'the visible window remains for a manual run and points at the background task')
  ok(ignore.includes('home-relay/pc-bridge.config.json'), 'the real bridge config stays gitignored')
  ok(fs.readFileSync(path.join(relay, 'pc-bridge.config.example.json'), 'utf8').includes('paste-the-same-PC_BRIDGE_SECRET'), 'the example config is still only a placeholder')

  let pwsh = process.env.PWSH || ''
  if (!pwsh || !fs.existsSync(pwsh)) {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' })
    pwsh = (which.stdout || '').trim().split(/\r?\n/).find((line) => line && fs.existsSync(line)) || ''
  }
  if (pwsh) {
    const files = ['install-bridge-service.ps1', 'bridge-service.ps1'].map((f) => path.join(relay, f).replace(/'/g, "''"))
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
      `$bad = @(); foreach ($f in @('${files.join("','")}')) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e); if ($e.Count) { $bad += "$($f): $($e[0].Message)" } }; $bad -join '; '`,
    ], { encoding: 'utf8' })
    ok(run.status === 0 && !(run.stdout || '').trim(), `the installer and the service parse${(run.stdout || '').trim() ? `: ${(run.stdout || '').trim()}` : ''}`)
  }
}

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
