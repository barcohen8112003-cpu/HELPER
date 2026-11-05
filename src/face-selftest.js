// node src/face-selftest.js
// The talking face stays off, refuses anonymous viewers, and falls back to the browser when the PC is down.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-face-'))
process.env.HELPER_ENV_FILE = path.join(process.env.HELPER_DATA_DIR, 'no.env')
process.env.PC_BRIDGE_SECRET = 'test-secret-not-real'
process.env.FACE_ENABLED = 'off'
process.env.FACE_ENGINE = 'auto'
process.env.FACE_TV = 'auto'
process.env.FACE_WEBRTC = 'off'
delete process.env.FACE_LOCAL_URL
delete process.env.UI_PUBLIC_HOST
delete process.env.PC_BRIDGE_EXECUTOR

const { config } = await import('./config.js')
const face = await import('./face.js')
const { visemeFromBins } = await import('./face-viseme.js')
const facePc = await import('./face-pc.js')
const { renderFace } = await import('../face/avatar/render-face.mjs')
const bridge = await import('./pc-bridge.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

ok(face.faceEnabled() === false && config.face.enabled === false, 'FACE_ENABLED defaults off')
let spoke = 0
const off = await face.presentSpeech({ text: 'שלום', source: 'test', speak: async () => { spoke++; return Buffer.from('nope') } })
ok(off.mode === 'off' && spoke === 0 && !off.ticket, 'while off, speech is not synthesized and nothing is returned')

ok(face.chooseEngine({ enabled: false, engine: 'auto', pcReady: true }) === 'off', 'off stays off even if the PC is ready')
ok(face.chooseEngine({ enabled: true, engine: 'browser', pcReady: true }) === 'browser', 'browser stays on the device')
ok(face.chooseEngine({ enabled: true, engine: 'pc', pcReady: false }) === 'browser', 'a missing PC falls back to the browser')
ok(face.chooseEngine({ enabled: true, engine: 'pc', pcReady: true }) === 'pc', 'pc is used when the service is up')
ok(face.chooseEngine({ enabled: true, engine: 'auto', pcReady: false }) === 'browser', 'auto uses the browser when the PC is down')
ok(face.chooseEngine({ enabled: true, engine: 'auto', pcReady: true }) === 'pc', 'auto uses the PC when it is up')

{
  const ticket = face.mintTicket('sess')
  const read = face.readTicket(ticket)
  ok(read.ok && read.sessionId === 'sess', 'a face ticket opens')
  ok(!ticket.includes(process.env.PC_BRIDGE_SECRET), 'the ticket is not the bridge secret')
  ok(face.readTicket(ticket + 'a').ok === false, 'a tampered ticket is rejected')
  ok(face.readTicket(face.mintTicket('old', Date.now() - 120000, 1000)).error === 'expired', 'an old ticket is rejected')
  const saved = config.pcBridge.secret
  config.pcBridge.secret = 'another-secret-value'
  ok(face.readTicket(ticket).ok === false, 'a ticket signed with another secret is rejected')
  config.pcBridge.secret = saved
  ok(face.readTicket(ticket).ok, 'the original secret still opens the ticket')
}

{
  ok(visemeFromBins([]).shape === 'closed' && visemeFromBins([0, 0, 0]).open === 0, 'silence closes the mouth')
  const low = visemeFromBins([0.8, 0.8, 0.8, 0, 0, 0, 0, 0, 0])
  ok(low.shape === 'oh' && low.open > 0.5, 'low energy is a round mouth')
  const high = visemeFromBins([0, 0, 0, 0, 0, 0, 0.9, 0.9, 0.9])
  ok(high.shape === 'wide' && high.open > 0.6, 'high energy opens wide')
}

{
  const drawn = renderFace()
  const png = fs.readFileSync(path.join(root, 'src', 'face-avatar.png'))
  const box = JSON.parse(fs.readFileSync(path.join(root, 'face', 'avatar', 'box.json'), 'utf8'))
  ok(png.equals(drawn.png), 'the shipped portrait is the renderer output')
  ok(png.readUInt32BE(16) === 256 && png.readUInt32BE(20) === 256, 'the portrait is 256x256')
  ok(box.y1 === drawn.box.y1 && box.x2 === drawn.box.x2, 'the wav2lip box matches the portrait')
  ok(drawn.mouthY > box.y1 && drawn.mouthY < box.y2 && box.x1 < 128 && box.x2 > 128, 'the closed mouth sits inside the box')
}

{
  process.env.FACE_LOCAL_URL = 'http://evil.example:8771'
  ok(facePc.localFaceUrl() === '', 'a non-local face URL is ignored')
  process.env.FACE_LOCAL_URL = 'http://user:pass@127.0.0.1:8771'
  ok(facePc.localFaceUrl() === '', 'credentials in the face URL are ignored')
  process.env.FACE_LOCAL_URL = 'https://127.0.0.1:8771'
  ok(facePc.localFaceUrl() === '', 'https is not the local face service')
  process.env.FACE_LOCAL_URL = 'http://127.0.0.1:9876'
  ok(facePc.localFaceUrl() === 'http://127.0.0.1:9876', 'loopback http is accepted')
  delete process.env.FACE_LOCAL_URL
}

function mockRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(body) { this.body = body || '' },
  }
}
const anon = { signedIn: () => false, bearerOk: () => false }

{
  const res = mockRes()
  ok(await face.handleFaceHttp({ method: 'GET', url: '/face', headers: {} }, res, anon) === true, 'the face route is handled')
  ok(res.status === 403, 'an anonymous face page is refused')
  const sneaky = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face/avatar.png', headers: {} }, sneaky, anon)
  ok(sneaky.status === 403, 'the portrait is not a public file')
  const bad = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face?ticket=not-a-ticket', headers: {} }, bad, anon)
  ok(bad.status === 403, 'a bad ticket is refused')
  const ticket = face.mintTicket('page')
  const res2 = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face?ticket=' + ticket, headers: {} }, res2, anon)
  const cookie = String(res2.headers['Set-Cookie'] || '')
  ok(res2.status === 302 && cookie.startsWith('helper_face=') && !cookie.includes('helper_session') && res2.headers.Location === '/face', 'a good ticket becomes a face-only cookie')
  const page = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face', headers: { cookie: cookie.split(';')[0] } }, page, anon)
  const html = String(page.body)
  ok(page.status === 200 && html.includes('/face/client.js') && html.includes('HELPER') && !html.includes(process.env.PC_BRIDGE_SECRET), 'the page is served and does not contain the secret')
  const script = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face/client.js', headers: { cookie: cookie.split(';')[0] } }, script, anon)
  ok(script.status === 200 && String(script.body).includes('visemeFromBins'), 'the browser lip-sync script is served')
  const portrait = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/face/avatar.png', headers: { cookie: cookie.split(';')[0] } }, portrait, anon)
  ok(portrait.status === 200 && portrait.headers['Content-Type'] === 'image/png', 'the portrait is served to a signed-in viewer')
  const status = mockRes()
  await face.handleFaceHttp({ method: 'GET', url: '/api/face/status', headers: { cookie: cookie.split(';')[0] } }, status, anon)
  const body = JSON.parse(status.body)
  ok(body.enabled === false && body.path === '/face', 'status reports the feature off')
  ok(await face.handleFaceHttp({ method: 'GET', url: '/not-face', headers: {} }, mockRes(), anon) === false, 'other paths are left to the settings site')
}

{
  config.face.enabled = true
  const seen = []
  const stop = face.addWatcher((m) => seen.push(m))
  const out = await face.presentSpeech({
    text: 'בוקר טוב',
    source: 'brief',
    synthesize: false,
    speak: async () => Buffer.from('abc'),
  })
  ok(out.mode === 'browser' && out.track.kind === 'video' && out.track.label === 'HELPER', 'an enabled speech returns a pluggable video track')
  ok(seen.some((m) => m.t === 'speech' && m.text === 'בוקר טוב' && m.audio && m.sessionId === out.sessionId), 'watchers receive the audio')
  let sunk = 0
  const unsub = out.track.subscribe(() => { sunk++ })
  ok(typeof unsub === 'function' && sunk >= 1, 'a later publisher can subscribe to the same speech')
  unsub()
  let threw = false
  try { out.track.subscribe(null) } catch { threw = true }
  ok(threw, 'a track sink must be a function')
  await face.onViewerMessage(JSON.stringify({ t: 'offer', sdp: 'v=0\r\n' + 'x'.repeat(40), type: 'offer' }), () => { threw = false })
  ok(threw, 'WebRTC offers are ignored while FACE_WEBRTC is off')
  const liveSeen = []
  const stopLive = face.addWatcher((m) => liveSeen.push(m))
  const live = await face.presentSpeech({
    text: 'אני איתך',
    source: 'live',
    audio: Buffer.from('RIFF'),
    mime: 'audio/wav',
    synthesize: false,
  })
  const drop = live.track.subscribe(() => {})
  ok(live.mode === 'browser' && live.track.kind === 'video' && typeof drop === 'function', 'a live call can hold attachFaceTrack')
  ok(liveSeen.some((m) => m.t === 'speech' && m.source === 'live' && m.silent === true), 'live speech is silent on the face page so the call is not heard twice')
  drop()
  stopLive()
  stop()
  face._resetFace()
  config.face.enabled = false
}

{
  config.face.enabled = true
  const frames = []
  const stop = face.addWatcher((m) => { if (m.t === 'frame') frames.push(m) })
  const srv = bridge.startPcBridgeServer({ port: 0, host: '127.0.0.1' })
  const addr = await srv.ready
  const link = await bridge.connectHome({
    url: `ws://127.0.0.1:${addr.port}/pc`,
    secret: config.pcBridge.secret,
    handlers: { faceStatus: () => ({ running: false, engine: 'unavailable', relay: false }) },
  })
  link.sendEvent({ t: 'frame', sid: 's1', seq: 1, jpeg: 'aGVsbG8=' })
  await new Promise((r) => setTimeout(r, 80))
  ok(frames.length === 1 && frames[0].jpeg === 'aGVsbG8=' && frames[0].sessionId === 's1', 'a frame from the home PC reaches face watchers')
  stop()
  link.close()
  await srv.close()
  face._resetFace()
  config.face.enabled = false
}

{
  const install = fs.readFileSync(path.join(root, 'face', 'install-face.ps1'), 'utf8')
  const start = fs.readFileSync(path.join(root, 'face', 'start-face.ps1'), 'utf8')
  const runner = fs.readFileSync(path.join(root, 'face', 'pc', 'run_livetalking.py'), 'utf8')
  const service = fs.readFileSync(path.join(root, 'face', 'pc', 'helper_face.py'), 'utf8')
  ok(install.includes('127.0.0.1') && install.includes('LiveTalking') && install.includes('PC_BRIDGE_SECRET') === false, 'the installer does not embed the bridge secret')
  ok(install.includes('wav2lip.pth') && install.includes('-Autostart'), 'the installer documents the model file and optional autostart')
  ok(!start.includes('Write-Host $secret') && start.includes('127.0.0.1:8771'), 'the start script does not print the secret')
  ok(runner.includes("super().__init__(runner, '127.0.0.1'"), 'LiveTalking is forced onto loopback')
  ok(service.includes("BIND = '127.0.0.1'") && service.includes('ThreadingHTTPServer((BIND, port)'), 'the face service binds loopback only')
  const py = process.env.PYTHON || 'python3'
  const compiled = await new Promise((resolve) => {
    const child = spawn(py, ['-m', 'py_compile', 'face/pc/helper_face.py', 'face/pc/prepare_avatar.py', 'face/pc/run_livetalking.py'], { cwd: root })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(null))
  })
  ok(compiled === true || compiled === null, compiled === null ? 'python is not installed here' : 'the face Python compiles')
  if (compiled === true) {
    const child = spawn(py, ['face/pc/helper_face.py', '--port', '0'], {
      cwd: root,
      env: { ...process.env, PC_BRIDGE_SECRET: 'test-secret-not-real', HELPER_FACE_NO_GPU: '1', HELPER_LIVETALKING_DIR: '' },
    })
    child.stderr.on('data', () => {})
    let out = ''
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('face service did not listen')), 8000)
      child.stdout.on('data', (buf) => {
        out += buf.toString()
        const m = out.match(/HELPER_FACE 127\.0\.0\.1 (\d+)/)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
      })
      child.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('face service exited: ' + out))
      })
    }).catch((e) => {
      ok(false, e.message)
      return 0
    })
    if (port) {
      const base = `http://127.0.0.1:${port}`
      const noAuth = await fetch(base + '/health')
      const yes = await fetch(base + '/health', { headers: { authorization: 'Bearer test-secret-not-real' } })
      const wrong = await fetch(base + '/health', { headers: { authorization: 'Bearer wrong-secret-value' } })
      const health = await yes.json()
      ok(noAuth.status === 401 && wrong.status === 401, 'the local face service rejects a missing or wrong secret')
      ok(yes.status === 200 && health.running === false && health.engine === 'unavailable', 'without a model the service stays up and reports unavailable')
      child.kill('SIGTERM')
    } else {
      child.kill('SIGTERM')
    }
  }
}

console.log(failed ? `${failed} failed, ${passed} passed` : `ok ${passed}`)
process.exit(failed ? 1 : 0)
