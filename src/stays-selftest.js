// node src/stays-selftest.js: find_stays (src/stays.js) and YouTube search (src/youtube.js) offline, against
// stand-ins shaped like the real SerpApi Google Hotels and YouTube Data API answers.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-stays-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })

const stays = await import('./stays.js')
const yt = await import('./youtube.js')
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

// ── stays: stand-in ──────────────────────────────────────────────────────────
const calls = []
const prop = (name, perNight, extra = {}) => ({
  type: 'hotel', name, link: `https://example.com/${encodeURIComponent(name)}`,
  rate_per_night: { lowest: `₪${perNight}`, extracted_lowest: perNight }, total_rate: { extracted_lowest: perNight * 3 },
  overall_rating: 4.3, reviews: 1200, extracted_hotel_class: 4, images: [{ thumbnail: 'https://example.com/t.jpg' }],
  prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: perNight } }], ...extra,
})
let reply = { status: 200, body: {} }
stays._setForTest({
  fetch: async (url) => {
    calls.push(new URL(url))
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  },
  render: null,
})
const args = { where: 'אתונה', check_in: '2027-08-10', check_out: '2027-08-13' }

{
  config.stays.serpapiKey = ''
  const out = await stays.findStays(args, {})
  ok(/booking\.com/.test(out) && /airbnb\.com/.test(out) && /SerpApi/.test(out) && !calls.length, 'no key: ready links, how to get real prices, no call')
}
config.stays.serpapiKey = 'k'
ok(/חסרים תאריכים/.test(await stays.findStays({ where: 'אתונה' }, {})), 'no dates: says what is missing')
ok(/חסרים תאריכים/.test(await stays.findStays({ ...args, check_out: '2027-08-10' }, {})), 'zero nights is not a stay')
ok(/חסר מקום/.test(await stays.findStays({ check_in: '2027-08-10', check_out: '2027-08-13' }, {})), 'no place: says so')

{
  reply = { status: 200, body: { properties: [prop('Ad Hotel', 300, { sponsored: true }), prop('Plaka Inn', 450), prop('Cheap Rooms', 0), prop('Acropolis View', 620, { overall_rating: 3.2 })] } }
  calls.length = 0
  const out = await stays.findStays({ ...args, adults: 3, children: 1, max_per_night: 600, min_rating: 4, sort: 'price' }, {})
  const u = calls[0]
  ok(u?.hostname === 'serpapi.com' && u.searchParams.get('engine') === 'google_hotels' && u.searchParams.get('q') === 'אתונה', 'asks Google Hotels on SerpApi for the place')
  ok(u.searchParams.get('check_in_date') === '2027-08-10' && u.searchParams.get('adults') === '3' && u.searchParams.get('children_ages') === '8', 'dates, guests, and an age for each child')
  ok(u.searchParams.get('max_price') === '600' && u.searchParams.get('rating') === '8' && u.searchParams.get('sort_by') === '3' && u.searchParams.get('currency') === 'ILS', 'budget, rating and sort go to the API')
  ok(!u.searchParams.has('vacation_rentals'), 'hotels by default')
  ok(/Plaka Inn/.test(out) && /₪450 ללילה/.test(out) && /₪1,350 ל-3 לילות/.test(out), 'nightly and total price')
  ok(!/Acropolis View/.test(out) && !/Cheap Rooms/.test(out), 'under his rating or with no price: left out')
  ok(out.indexOf('Plaka Inn') < out.indexOf('Ad Hotel'), 'ads come after the real results')
  ok(/Booking\.com/.test(out) && /example\.com/.test(out), 'cheapest source and a link')
}
{
  reply = { status: 200, body: { properties: [prop('Villa Roma', 800, { type: 'vacation rental', essential_info: ['Entire villa', 'Sleeps 6', '3 bedrooms'] })] } }
  calls.length = 0
  const out = await stays.findStays({ ...args, where: 'רומא', kind: 'rental', bedrooms: 2 }, {})
  ok(calls[0].searchParams.get('vacation_rentals') === 'true' && calls[0].searchParams.get('bedrooms') === '2', 'rental = vacation rentals, with bedrooms')
  ok(/Sleeps 6/.test(out), 'rental details are shown')
}
{
  reply = { status: 200, body: { properties: [] } }
  ok(/לא נמצאו מלונות/.test(await stays.findStays(args, {})), 'nothing found: says so, offers to widen')
  reply = { status: 401, body: { error: 'Invalid API key.' } }
  let msg = ''
  await stays.findStays(args, {}).catch((e) => (msg = e.message))
  ok(/לינה/.test(msg), 'a bad key points to the settings card')
  reply = { status: 429, body: { error: 'Your account has run out of searches.' } }
  msg = ''
  await stays.findStays(args, {}).catch((e) => (msg = e.message))
  ok(/נגמרו/.test(msg), 'out of searches is said plainly')
}
{
  reply = { status: 200, body: { properties: [prop('Plaka Inn', 450)] } }
  let media = null
  stays._setForTest({ render: async (html) => (/Plaka Inn/.test(html) && /₪450/.test(html) ? Buffer.from('png') : null) })
  const out = await stays.findStays(args, { sendMedia: async (m) => (media = m) })
  ok(media?.mime === 'image/png' && /Do NOT list them again/.test(out), 'a picture is sent and the model is told not to repeat it')
  ok(/<img class="ph"/.test(stays.cardHtml([stays._test.toCard(prop('A', 1), 'ILS', 1)], 't', 1)), 'the card has the photo')
}

// ── YouTube ──────────────────────────────────────────────────────────────────
let ytMode = 'api'
const ytCalls = []
yt._setForTest({
  fetch: async (url) => {
    const u = new URL(url)
    ytCalls.push(u)
    if (u.hostname === 'www.googleapis.com') {
      if (ytMode === 'quota') return { ok: false, status: 403, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'Rock &amp; Roll &#39;live&#39;', channelTitle: 'Chan', publishedAt: '2026-01-02T00:00:00Z' } }] }) }
    }
    return { ok: true, status: 200, text: async () => '"videoRenderer":{"videoId":"zzzzzzzzzzz","x":1,"title":{"runs":[{"text":"From page"}]}' }
  },
})
config.youtubeKey = ''
ok((await yt.firstYouTubeVideo('x'))?.id === 'zzzzzzzzzzz' && ytCalls.every((u) => u.hostname === 'www.youtube.com'), 'no key: reads the results page as before')
config.youtubeKey = 'k'
ytCalls.length = 0
const v = await yt.firstYouTubeVideo('שיר')
ok(v?.id === 'abcdefghijk' && v.title === "Rock & Roll 'live'" && ytCalls[0].searchParams.get('relevanceLanguage') === 'he', 'with a key: the Data API, titles unescaped')
ytMode = 'quota'
ok((await yt.firstYouTubeVideo('x'))?.id === 'zzzzzzzzzzz', 'API refused (quota): falls back to the page')
ytMode = 'api'
const list = await yt.youtubeTools[0].run({ query: 'x' })
ok(/youtu\.be\/abcdefghijk/.test(list) && /Chan/.test(list), 'youtube_search lists title, channel and link')
const pcTools = await import('./pc-tools.js')
ok(typeof pcTools.firstYouTubeVideo === 'function', 'pc-tools still exports firstYouTubeVideo')

console.log(`stays+youtube: ${passed} passed, ${failed} failed`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
