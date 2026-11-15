// Offline checks for the Bird WhatsApp channel: number format, template values, the exact request sent to Bird,
// errors in Hebrew, and that the tool asks before sending. No network: Bird's client gets a stand-in fetch.
// The personal WhatsApp transport stays on Baileys, and a key alone does not turn Bird on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.HELPER_ENV_FILE = '/nonexistent/.env'
process.env.BIRD_API_KEY = 'bk_eu1_selftest'
process.env.BIRD_WHATSAPP_FROM = '0731234567'
process.env.BIRD_OWNER_NUMBER = '0512909911'
process.env.BIRD_WEBHOOK_SECRET = 'whsec_' + Buffer.from('selftest-secret-selftest-secret').toString('base64')
delete process.env.BIRD_ENABLED
const { toE164, templateParams, sendWhatsAppTemplate, sendWhatsAppText, handleBirdWebhook, birdEnabled, birdOptedIn } = await import('./bird.js')
const { Webhook } = await import('standardwebhooks')
const { tools } = await import('./tools.js')
let passed = 0

const waSrc = fs.readFileSync(new URL('./whatsapp.js', import.meta.url), 'utf8')
assert.match(waSrc, /@whiskeysockets\/baileys/); passed++
assert.doesNotMatch(waSrc, /bird\.js|BirdClient|BIRD_/); passed++
assert.equal(birdOptedIn(), false); passed++
assert.equal(birdEnabled(), false); passed++
const toolOff = tools.find((t) => t.name === 'bird_whatsapp')
assert.equal(toolOff.enabled(), false); passed++
assert.equal((await handleBirdWebhook('{}', {}, { wait: true })).status, 404); passed++
process.env.BIRD_ENABLED = 'true'
assert.equal(birdEnabled(), true); passed++

assert.equal(toE164('050-123 4567'), '+972501234567'); passed++
assert.equal(toE164('972501234567'), '+972501234567'); passed++
assert.equal(toE164('+1 (555) 123-4567'), '+15551234567'); passed++
assert.equal(toE164('00447700900123'), '+447700900123'); passed++
assert.deepEqual(templateParams('ref=A1B2C3D4, date=10 Jul 2026'), [
  { type: 'text', name: 'ref', text: 'A1B2C3D4' },
  { type: 'text', name: 'date', text: '10 Jul 2026' },
]); passed++
assert.deepEqual(templateParams('{"ref":"X"}'), [{ type: 'text', name: 'ref', text: 'X' }]); passed++
assert.deepEqual(templateParams(''), []); passed++

const calls = []
// Bird's client hands fetch a Request; the address, headers and body are read back from it.
const fake = (status, body) => async (input, init = {}) => {
  const r = new Request(input, init)
  calls.push({ url: r.url, headers: r.headers, body: await r.text() })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The same message as Bird's own example: template bird_delivery_update with ref and date.
const sent = await sendWhatsAppTemplate({ to: '+15551234567', slug: 'bird_delivery_update', params: { ref: 'A1B2C3D4', date: '10 Jul 2026' } }, { fetchFn: fake(202, { id: 'wam_1', status: 'accepted' }) })
assert.deepEqual(sent, { id: 'wam_1', status: 'accepted', to: '+15551234567' }); passed++
const req = calls.at(-1)
assert.match(req.url, /whatsapp/); passed++
const sentBody = JSON.parse(req.body)
assert.equal(sentBody.to, '+15551234567'); passed++
assert.equal(sentBody.from, '+972731234567'); passed++
assert.deepEqual(sentBody.template, {
  slug: 'bird_delivery_update',
  components: [{ type: 'body', parameters: [{ type: 'text', name: 'ref', text: 'A1B2C3D4' }, { type: 'text', name: 'date', text: '10 Jul 2026' }] }],
}); passed++
const auth = req.headers.get('authorization') || ''
assert.ok(auth.includes('bk_eu1_selftest')); passed++

await sendWhatsAppText({ to: '0501234567', text: 'שלום' }, { fetchFn: fake(202, { id: 'wam_2', status: 'accepted' }) })
assert.deepEqual(JSON.parse(calls.at(-1).body).text, { body: 'שלום' }); passed++

await assert.rejects(
  sendWhatsAppTemplate({ to: '0501234567', slug: 'x' }, { fetchFn: fake(401, { error: { type: 'authentication_error', message: 'bad key' } }) }),
  /BIRD_API_KEY/,
); passed++
await assert.rejects(sendWhatsAppTemplate({ to: '', slug: 'x' }), /נמען/); passed++

const tool = tools.find((t) => t.name === 'bird_whatsapp')
assert.ok(tool && tool.enabled()); passed++
assert.equal(tool.risk, 'write'); passed++
const asked = tool.describe({ to: '050-1234567', template: 'bird_delivery_update', params: 'ref=A1B2C3D4' })
assert.match(asked, /\+972501234567/); passed++
assert.match(asked, /ref: A1B2C3D4/); passed++

// ── inbound chat: signed webhook from the owner is answered through Bird; anyone else, or a bad signature, is not ──
const signer = new Webhook(process.env.BIRD_WEBHOOK_SECRET)
const inbound = (id, phone, body) => JSON.stringify({ type: 'whatsapp.received', timestamp: new Date().toISOString(), data: { whatsapp_id: id, direction: 'inbound', from: { phone_number: phone }, to: { phone_number: '+972731234567' }, text: { body } } })
const signed = (raw, msgId) => {
  const ts = new Date()
  return { 'webhook-id': msgId, 'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)), 'webhook-signature': signer.sign(msgId, ts, raw) }
}
const turns = []
const agent = async (text, opts) => (turns.push({ text, opts }), 'שלום מ-Helper')
const raw1 = inbound('wam_in_1', '+972512909911', 'מה המצב?')
const out1 = await handleBirdWebhook(raw1, signed(raw1, 'msg_1'), { agent, fetchFn: fake(202, { id: 'wam_out', status: 'accepted' }), wait: true })
assert.equal(out1.status, 200); passed++
assert.equal(turns.length, 1); passed++
assert.equal(turns[0].text, 'מה המצב?'); passed++
assert.equal(turns[0].opts.source, 'bird'); passed++
const replyBody = JSON.parse(calls.at(-1).body)
assert.equal(replyBody.to, '+972512909911'); passed++
assert.equal(replyBody.from, '+972731234567'); passed++
assert.equal(replyBody.text.body, 'שלום מ-Helper'); passed++
// the same delivery again is not answered twice
await handleBirdWebhook(raw1, signed(raw1, 'msg_1'), { agent, fetchFn: fake(202, { id: 'x' }), wait: true })
assert.equal(turns.length, 1); passed++
// another sender is ignored
const raw2 = inbound('wam_in_2', '+972500000000', 'היי')
await handleBirdWebhook(raw2, signed(raw2, 'msg_2'), { agent, fetchFn: fake(202, { id: 'x' }), wait: true })
assert.equal(turns.length, 1); passed++
// a wrong signature is refused
const raw3 = inbound('wam_in_3', '+972512909911', 'עוד')
const bad = await handleBirdWebhook(raw3, { ...signed(raw3, 'msg_3'), 'webhook-signature': 'v1,AAAA' }, { agent, wait: true })
assert.equal(bad.status, 400); passed++
assert.equal(turns.length, 1); passed++

console.log(`bird: ${passed} checks passed`)
