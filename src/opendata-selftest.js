// node src/opendata-selftest.js — offline checks for src/toolkit/opendata.js (no network: fetch is faked).
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-opendata-'))
const od = await import('./toolkit/opendata.js')
const tool = (name) => od.tools.find((t) => t.name === name)

// plates
assert.equal(od.plateDigits('12-345-67'), '1234567')
assert.throws(() => od.plateDigits('12'))
assert.throws(() => od.plateDigits(''))

// vehicle text
const v = od.formatVehicle({ mispar_rechev: 1234567, tozeret_nm: 'טויוטה', kinuy_mishari: 'COROLLA', shnat_yitzur: 2019, tzeva_rechev: 'לבן', mivchan_acharon_dt: '2026-03-01T00:00:00', tokef_dt: '2027-03-01' })
assert.match(v, /טויוטה COROLLA/)
assert.match(v, /טסט אחרון: 2026-03-01/)
assert.match(v, /בתוקף עד: 2027-03-01/)

// news
assert.match(od.newsUrl('טסלה'), /hl=iw&gl=IL/)
assert.match(od.newsUrl('tesla', 'en'), /hl=en-US/)
assert.deepEqual(od.splitSource('מחירי הדירות עלו - ynet'), { headline: 'מחירי הדירות עלו', source: 'ynet' })
assert.equal(od.splitSource('בלי מקור').source, '')

// overpass
assert.match(od.overpassQuery('atm', 32.08, 34.78, 800), /"amenity"="atm".*around:800,32.08,34.78/)
assert.throws(() => od.overpassQuery('casino', 0, 0, 100))
const near = od.nearestPlaces(
  [
    { lat: 32.09, lon: 34.78, tags: { name: 'רחוק' } },
    { center: { lat: 32.0801, lon: 34.7801 }, tags: { 'name:he': 'קרוב', 'addr:street': 'דיזנגוף', 'addr:housenumber': '50' } },
    { tags: { name: 'בלי מיקום' } },
  ],
  32.08,
  34.78,
)
assert.equal(near.length, 2)
assert.equal(near[0].name, 'קרוב')
assert.equal(near[0].street, 'דיזנגוף 50')
assert.ok(near[0].dist < 20)

// tools with a faked network
const realFetch = globalThis.fetch
// No DNS in tests: every public host resolves to a public address.
const dnsMod = (await import('node:dns/promises')).default
const realLookup = dnsMod.lookup
dnsMod.lookup = async () => [{ address: '93.184.215.14', family: 4 }]
const fake = (body, check) => {
  globalThis.fetch = async (url, opts) => {
    check?.(String(url), opts)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }
}
try {
  let asked = ''
  fake({ success: true, result: { records: [{ mispar_rechev: 1234567, tozeret_nm: 'מאזדה', shnat_yitzur: 2020 }] } }, (u) => (asked = u))
  const r = await tool('il_vehicle').run({ plate: '123-45-67' })
  assert.match(r, /מאזדה/)
  assert.match(decodeURIComponent(asked), /"mispar_rechev":1234567/)

  fake({ success: true, result: { records: [] } })
  assert.match(await tool('il_vehicle').run({ plate: '7654321' }), /לא נמצא/)

  fake('<rss><channel><item><title>כותרת ראשונה - כלכליסט</title><link>https://example.com/a</link><pubDate>Sat, 31 Oct 2026</pubDate></item></channel></rss>')
  const n = await tool('lookup_news_topic').run({ topic: 'כלכלה' })
  assert.match(n, /1\. כותרת ראשונה \(כלכליסט\)/)
  assert.match(n, /https:\/\/example.com\/a/)

  fake({ elements: [{ lat: 32.0802, lon: 34.7802, tags: { name: 'כספומט לאומי', opening_hours: '24/7' } }] }, (u) => assert.match(u, /overpass-api\.de/))
  const p = await tool('lookup_nearby').run({ kind: 'atm', lat: 32.08, lon: 34.78 })
  assert.match(p, /כספומט לאומי/)
  assert.match(p, /24\/7/)

  fake('Title: Example Domain\n\nThis domain is for examples.', (u, o) => {
    assert.equal(u, 'https://r.jina.ai/https://93.184.215.14/')
    assert.equal(o.headers.accept, 'text/plain')
  })
  assert.match(await tool('lookup_read_page').run({ url: 'https://93.184.215.14/' }), /מידע בלבד[\s\S]*Example Domain/)
} finally {
  globalThis.fetch = realFetch
  dnsMod.lookup = realLookup
}

// internal addresses never reach Jina
await assert.rejects(tool('lookup_read_page').run({ url: 'http://127.0.0.1:3210/' }), /פנימית/)
await assert.rejects(tool('lookup_read_page').run({ url: 'file:///etc/passwd' }))

console.log('opendata: הכול תקין')
