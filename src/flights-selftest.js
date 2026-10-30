// node src/flights-selftest.js: find_flights (src/flights.js) offline, against stand-ins for Travelpayouts and
// Duffel shaped like their real answers. The picture is rendered for real when a Chrome/Chromium is installed.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-flights-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const { findFlights, resolvePlace, cardHtml, _setForTest, _test } = await import('./flights.js')
const { config } = await import('./config.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// ── stand-ins ────────────────────────────────────────────────────────────────
const calls = []
const tp = (rows) => ({ success: true, currency: 'usd', data: rows })
const row = (destination, departure_at, return_at, price, transfers = 0, airline = 'IZ') => ({ origin: 'TLV', destination, departure_at: `${departure_at}T10:00:00+03:00`, return_at: return_at && `${return_at}T18:00:00+03:00`, price, airline, transfers, return_transfers: transfers, duration_to: 240, link: `/search/TLV${destination}?t=x` })
const seg = (o, d, dep, arr, carrier = 'Iberia', code = 'IB', n = '1674') => ({ origin: { iata_code: o }, destination: { iata_code: d }, departing_at: dep, arriving_at: arr, marketing_carrier: { name: carrier, iata_code: code }, marketing_carrier_flight_number: n })
const offer = (price, slices, owner = 'Iberia') => ({ total_amount: String(price), total_currency: 'USD', owner: { name: owner, logo_symbol_url: '' }, slices })
let duffelOffers = []
let tpRows = {}
_setForTest({
  fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const u = new URL(url)
    if (u.hostname === 'api.travelpayouts.com') {
      if (u.searchParams.get('token') === 'bad') return { ok: false, status: 401, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => tp(tpRows[u.searchParams.get('departure_at')] || []) }
    }
    if (u.hostname === 'api.duffel.com') return { ok: true, status: 200, json: async () => ({ data: { offers: duffelOffers } }) }
    if (u.hostname === 'autocomplete.travelpayouts.com') return { ok: true, status: 200, json: async () => (u.searchParams.get('term') === 'Reykjavik' ? [{ type: 'city', code: 'REK' }] : []) }
    throw new Error(`unexpected ${url}`)
  },
  render: null,
})

// ── places ───────────────────────────────────────────────────────────────────
ok((await resolvePlace('לונדון')) === 'LON' && (await resolvePlace('ניו יורק')) === 'NYC' && (await resolvePlace('לאתונה')) === 'ATH' && (await resolvePlace('ישראל')) === 'TLV', 'Hebrew places resolve from the table')
ok((await resolvePlace('jfk')) === 'JFK' && (await resolvePlace('Reykjavik')) === 'REK', 'codes pass through, other names go to the autocomplete')
ok((await resolvePlace('לא משנה')) === '' && (await resolvePlace('')) === '', '"anywhere" means no destination')
ok((await resolvePlace('Nowhereville')) === null, 'an unknown place is null, not a guess')
ok(JSON.stringify(_test.monthsIn('2027-07-01', '2027-08-31')) === '["2027-07","2027-08"]', 'July-August is two months of searches')

// ── no source at all ─────────────────────────────────────────────────────────
{
  const out = await findFlights({ to: 'אתונה', depart_from: '2027-07-01', depart_to: '2027-08-31' }, { noBrowser: true })
  ok(/google\.com\/travel\/flights/.test(out) && /Travelpayouts/.test(out), 'no token and no browser: a ready Google Flights link and how to get real prices')
}
ok(/חסר טווח תאריכים/.test(await findFlights({ to: 'אתונה' }, {})), 'no dates: says what is missing')

// ── Travelpayouts only: cheapest dates across two months ─────────────────────
config.flights.travelpayoutsToken = 'tp-token'
{
  tpRows = {
    '2027-07': [row('ATH', '2027-07-03', '2027-08-15', 180), row('ATH', '2027-07-05', '2027-07-12', 120), row('ATH', '2027-07-20', '2027-09-01', 210, 1)],
    '2027-08': [row('ATH', '2027-08-02', '2027-09-14', 150), row('ATH', '2027-06-28', '2027-08-10', 90)],
  }
  calls.length = 0
  const media = []
  const out = await findFlights({ to: 'אתונה', depart_from: '2027-07-01', depart_to: '2027-08-31', nights_min: 40, nights_max: 50 }, { sendMedia: (m) => media.push(m) })
  const tpCalls = calls.filter((c) => c.url.includes('prices_for_dates'))
  ok(tpCalls.length === 2 && tpCalls.every((c) => c.url.includes('origin=TLV') && c.url.includes('destination=ATH')), 'one Travelpayouts call per month, TLV to ATH')
  ok(/\$150/.test(out) && /\$180/.test(out), 'trips of 40-50 nights are kept')
  ok(!/\$120/.test(out), 'a 7-night trip is dropped (outside 40-50 nights)')
  ok(!/\$90/.test(out), 'a departure before the range is dropped')
  ok(out.indexOf('$150') < out.indexOf('$180'), 'cheapest first')
  ok(/aviasales\.com\/search\/TLVATH/.test(out), 'each option has a link')
  ok(/ONE or two short Hebrew lines/.test(out) && /Send the options above as they are/.test(out), 'no picture: the model is told to send the list and add one recommendation')
  ok(media.length === 0, 'no renderer, no picture')
}

// Anywhere: one option per destination, the cheapest five.
{
  tpRows = { '2027-07': ['ATH', 'ATH', 'RHO', 'BUD', 'PRG', 'LCA', 'ROM'].map((d, i) => row(d, '2027-07-10', '2027-07-17', 100 + i * 10)) }
  calls.length = 0
  const out = await findFlights({ to: 'לא משנה', depart_from: '2027-07-01', depart_to: '2027-07-31', one_way: false }, {})
  ok(calls.some((c) => c.url.includes('unique=true') && !c.url.includes('destination=')), 'anywhere asks for one fare per destination')
  ok((out.match(/^\*\d\./gm) || []).length === 5 && (out.match(/אתונה/g) || []).length === 1, 'five options, one per destination')
}

// A bad token is said plainly.
config.flights.travelpayoutsToken = 'bad'
{
  let error = ''
  try {
    await findFlights({ to: 'ATH', depart_from: '2027-07-01', depart_to: '2027-07-31' }, {})
  } catch (e) {
    error = e.message
  }
  ok(/Travelpayouts לא עובד/.test(error) && /טיסות/.test(error), 'a rejected token says where to fix it')
}

// ── Travelpayouts + Duffel: the cheapest dates priced live, his limits applied ──
config.flights.travelpayoutsToken = 'tp-token'
config.flights.duffelToken = 'duffel_test_x'
{
  tpRows = { '2027-07': [row('NYC', '2027-07-01', '2027-08-12', 1100), row('NYC', '2027-07-02', '2027-08-14', 1150)], '2027-08': [] }
  duffelOffers = [
    // Nonstop, the dearest.
    offer(1383, [{ duration: 'PT12H15M', segments: [seg('TLV', 'JFK', '2027-07-01T00:05:00', '2027-07-01T05:20:00', 'Arkia', 'IZ', '991')] }, { duration: 'PT10H55M', segments: [seg('JFK', 'TLV', '2027-08-12T17:00:00', '2027-08-13T10:55:00', 'Arkia', 'IZ', '992')] }], 'Arkia Israeli Airlines'),
    // One stop in Madrid, 2h45 and 1h45 connections: fits "max 4 hours".
    offer(1124, [{ duration: 'PT16H10M', fare_brand_name: 'Main Cabin Flexible', segments: [seg('TLV', 'MAD', '2027-07-01T05:30:00', '2027-07-01T09:30:00'), seg('MAD', 'JFK', '2027-07-01T12:15:00', '2027-07-01T14:40:00')] }, { duration: 'PT13H55M', segments: [seg('JFK', 'MAD', '2027-08-12T20:40:00', '2027-08-13T10:00:00'), seg('MAD', 'TLV', '2027-08-13T11:45:00', '2027-08-13T17:35:00')] }], 'American'),
    // Cheapest, but a 9-hour connection: dropped.
    offer(900, [{ duration: 'PT22H', segments: [seg('TLV', 'IST', '2027-07-01T06:00:00', '2027-07-01T08:00:00', 'Pegasus', 'PC', '1'), seg('IST', 'JFK', '2027-07-01T17:00:00', '2027-07-01T21:00:00', 'Pegasus', 'PC', '2')] }], 'Pegasus'),
  ]
  calls.length = 0
  const media = []
  _setForTest({ render: async (html) => (html.includes('Main Cabin Flexible') ? Buffer.from('png') : null) })
  const out = await findFlights({ to: 'ניו יורק', depart_from: '2027-07-01', depart_to: '2027-08-31', nights_min: 40, nights_max: 50, max_layover_hours: 4 }, { sendMedia: (m) => media.push(m) })
  const duffel = calls.filter((c) => c.url.includes('api.duffel.com'))
  ok(duffel.length === 2, 'the two cheapest date pairs are priced live')
  const body = JSON.parse(duffel[0].init.body).data
  ok(body.slices.length === 2 && body.slices[0].origin === 'TLV' && body.slices[0].destination === 'NYC' && body.slices[0].departure_date === '2027-07-01' && body.slices[1].departure_date === '2027-08-12', 'a round trip on the dates Travelpayouts found')
  ok(duffel[0].init.headers['Duffel-Version'] === 'v2' && /Bearer duffel_test_x/.test(duffel[0].init.headers.Authorization), 'Duffel is called the documented way')
  ok(/\$1,124/.test(out) && /\$1,383/.test(out) && !/\$900/.test(out), 'the 9-hour connection is dropped, the 2h45 one is kept')
  ok(out.indexOf('$1,124') < out.indexOf('$1,383'), 'cheapest that fits first')
  ok(/MAD 2ש' 45ד'/.test(out), 'the connection airport and length are spelled out')
  ok(media.length === 1 && media[0].mime === 'image/png', 'a picture of the options is sent to the chat')
  ok(/already sent to him\. Do NOT list them again/.test(out) && /layovers ≤ 4h/.test(out), 'the model is told the picture went and to recommend against his limits')
  const card = _test.offerCard(duffelOffers[1])
  ok(card.legs[0].stops === 1 && card.legs[0].layovers[0].minutes === 165 && card.legs[0].minutes === 970, 'an offer becomes legs, stops and layover minutes')
  ok(!_test.fitsLimits(card, { directOnly: true }) && _test.fitsLimits(card, { maxLayoverHours: 3 }) && !_test.fitsLimits(card, { maxLayoverHours: 2 }), 'direct-only and layover limits apply per leg')
}

// ── the picture, rendered for real ───────────────────────────────────────────
{
  const html = cardHtml([_test.offerCard(duffelOffers[1])], 'תל אביב → ניו יורק')
  ok(html.includes('dir="rtl"') && html.includes('$1,124') && html.includes('MAD'), 'the card holds price, route and connection')
  ok(!cardHtml([{ ..._test.offerCard(duffelOffers[1]), airline: '<script>x</script>' }], 't').includes('<script>x'), 'text from the provider is escaped')
  const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p))
  if (chrome) {
    process.env.CHROME_PATH = chrome
    _setForTest({ render: undefined })
    const { _render } = await import('./flights.js')
    const png = await _render(html, 360)
    ok(png && png.subarray(1, 4).toString() === 'PNG' && png.length > 5000, `the card renders to a PNG in ${path.basename(chrome)}`)
    if (process.env.FLIGHTS_CARD_OUT && png) fs.writeFileSync(process.env.FLIGHTS_CARD_OUT, png)
  } else console.log('skip: no Chrome/Chromium to render the card')
}

console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
