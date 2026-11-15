// Offline: Israeli pairing numbers, and the QR / pairing code only on the signed-in settings page.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-wa-link-'))
const port = await new Promise((resolve) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, 'empty.env')
process.env.UI_PORT = String(port)
delete process.env.UI_PUBLIC_HOST
delete process.env.GOOGLE_CLIENT_ID
delete process.env.GOOGLE_CLIENT_SECRET
fs.writeFileSync(process.env.HELPER_ENV_FILE, '')

const { pairingNumber, pairingInfo, publishPairing } = await import('./whatsapp.js')
const { startUi } = await import('./ui.js')

let passed = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  passed++
}

ok(pairingNumber('050-123-4567') === '972501234567', '050 with dashes')
ok(pairingNumber('+972 050 123 4567') === '972501234567', '+972 with a leading 0')
ok(pairingNumber('00972501234567') === '972501234567', '00 international prefix')
ok(pairingNumber('9720501234567') === '972501234567', '972 then a leading 0')
ok(pairingNumber('972501234567') === '972501234567', 'already country code')
ok(pairingNumber('123') === '', 'too short is refused')
ok(pairingNumber('') === '', 'empty is refused')

const CODE = 'ABCD1234'
const QR = '2@wa-link-selftest-qr'
publishPairing({ qr: QR, code: CODE, number: '972501234567' })
ok(pairingInfo().code === CODE && pairingInfo().qr === QR, 'the page can read the live code')

const src = fs.readFileSync(new URL('./whatsapp.js', import.meta.url), 'utf8')
ok(!/console\.(log|info|warn|error|debug)\([^)]*authState/.test(src), 'auth state is not logged')
ok(!/console\.(log|info|warn|error|debug)\([^)]*\bcreds\b/.test(src), 'WhatsApp creds are not logged')
ok(!src.includes('קוד צימוד לוואטסאפ:'), 'asking for a code does not print it')
ok(/if \(process\.stdout\.isTTY\) \{[\s\S]*QRCode\.toString/.test(src), 'the terminal QR is only the home window')

function hit(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
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

let linked = false
const settingsUrl = startUi({ connectedSince: () => (linked ? Date.now() : 0), restart: () => {} })
const token = new URL(settingsUrl).searchParams.get('t')
let ready = null
for (let i = 0; i < 30 && !ready; i++) {
  try {
    ready = await hit('GET', `/?t=${token}`)
  } catch {
    await new Promise((r) => setTimeout(r, 50))
  }
}
ok(ready && ready.status === 302, 'the settings token is accepted')
const cookie = String(ready.headers['set-cookie'] || '').split(';')[0]

const locked = await hit('GET', '/api/state')
ok(locked.status === 403 && !locked.body.includes(CODE) && !locked.body.includes(QR), 'without the token the code and QR are not returned')
const lockedPost = await hit('POST', '/api/whatsapp/pair', { body: JSON.stringify({ number: '0501234567' }) })
ok(lockedPost.status === 403 && !lockedPost.body.includes(CODE), 'asking for a code without the token is refused')

const open = await hit('GET', '/api/state', { cookie })
ok(open.status === 200, 'the token cookie can read the page state')
const state = JSON.parse(open.body)
ok(state.whatsapp.code === CODE && state.whatsapp.qr.includes('data:image') && state.whatsapp.number === '972501234567', 'the signed-in page gets the code and QR')
ok(!JSON.stringify(state).includes('noiseKey') && !JSON.stringify(state).includes('signedIdentityKey'), 'the page state has no auth creds')
const page = await hit('GET', '/', { cookie })
ok(page.status === 200 && page.body.includes('קבל קוד צימוד') && !page.body.includes(CODE), 'the page shell has the card, not a baked-in code')

linked = true
const after = JSON.parse((await hit('GET', '/api/state', { cookie })).body)
ok(after.whatsapp.connected && !after.whatsapp.code && !after.whatsapp.qr, 'once linked, the code and QR leave the page')

console.log(`${passed} בדיקות עברו, 0 נכשלו`)
process.exit(0)
