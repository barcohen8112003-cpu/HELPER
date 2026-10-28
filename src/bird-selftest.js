// Offline checks for the Bird WhatsApp channel: number format, template values, the exact request sent to Bird,
// errors in Hebrew, and that the tool asks before sending. No network: Bird's client gets a stand-in fetch.
import assert from 'node:assert/strict'
process.env.HELPER_ENV_FILE = '/nonexistent/.env'
process.env.BIRD_API_KEY = 'bk_eu1_selftest'
process.env.BIRD_WHATSAPP_FROM = '0731234567'
const { toE164, templateParams, sendWhatsAppTemplate, sendWhatsAppText } = await import('./bird.js')
const { tools } = await import('./tools.js')
let passed = 0

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

console.log(`bird: ${passed} checks passed`)
