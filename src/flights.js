// Flights: "תמצא לי טיסה זולה מישראל ביולי-אוגוסט" answered with real prices, the way a travel agent would.
//
//  1. Places: Hebrew or English city, country or airport -> IATA code (a table of common ones, then the free
//     Travelpayouts autocomplete).
//  2. Cheapest dates across his range: Travelpayouts (cached real fares, free token). It also answers "anywhere".
//  3. Live offers for the best dates: Duffel (times, airline, stops, layover length, fare) when a token is set,
//     filtered by his limits (direct only, max layover hours, budget).
//  4. The answer: a picture of the options (like a flights app), sent to the chat, plus a short list with links the
//     model turns into one recommendation line. No picture possible -> a tidy WhatsApp text card.
//  No token at all: a survey in Helper's own browser on Google Flights when that is set up, else direct search links.
//
// Read-only. Nothing is booked or paid here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from './config.js'
import { browserPath, SERVER_FLAGS } from './web.js'
import { errandBrowserEnabled } from './errand-browser.js'
import { runErrand } from './computer-use.js'

// Tests swap these for stand-ins.
let http = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(opts?.timeout || 25000) })
let renderer = renderPng
export const _setForTest = (opts = {}) => {
  if (opts.fetch) http = opts.fetch
  if ('render' in opts) renderer = opts.render === undefined ? renderPng : opts.render
}

// ── places ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Hebrew names he is likely to write -> city IATA code. English names and codes resolve through the API.
const PLACES = {
  ישראל: 'TLV', 'תל אביב': 'TLV', 'נתב"ג': 'TLV', נתבג: 'TLV', אילת: 'ETM', רמון: 'ETM',
  אתונה: 'ATH', יוון: 'ATH', רודוס: 'RHO', כרתים: 'HER', סלוניקי: 'SKG', קורפו: 'CFU', מיקונוס: 'JMK', סנטוריני: 'JTR',
  קפריסין: 'LCA', לרנקה: 'LCA', פאפוס: 'PFO',
  רומא: 'ROM', איטליה: 'ROM', מילאנו: 'MIL', ונציה: 'VCE', נאפולי: 'NAP', פירנצה: 'FLR',
  ברצלונה: 'BCN', ספרד: 'MAD', מדריד: 'MAD', מיורקה: 'PMI', ולנסיה: 'VLC',
  פריז: 'PAR', צרפת: 'PAR', ניס: 'NCE', ליון: 'LYS',
  לונדון: 'LON', אנגליה: 'LON', בריטניה: 'LON', "מנצ'סטר": 'MAN',
  אמסטרדם: 'AMS', הולנד: 'AMS', ברלין: 'BER', גרמניה: 'BER', מינכן: 'MUC', פרנקפורט: 'FRA',
  פראג: 'PRG', "צ'כיה": 'PRG', בודפשט: 'BUD', הונגריה: 'BUD', וינה: 'VIE', אוסטריה: 'VIE', ורשה: 'WAW', קרקוב: 'KRK', פולין: 'WAW',
  בוקרשט: 'BUH', רומניה: 'BUH', סופיה: 'SOF', בולגריה: 'SOF', בורגס: 'BOJ', וארנה: 'VAR', בלגרד: 'BEG', סרביה: 'BEG',
  טביליסי: 'TBS', גאורגיה: 'TBS', בטומי: 'BUS', באקו: 'BAK', ירוואן: 'EVN',
  ליסבון: 'LIS', פורטוגל: 'LIS', דובלין: 'DUB', ציריך: 'ZRH', שוויץ: 'ZRH', "ז'נבה": 'GVA', קופנהגן: 'CPH', שטוקהולם: 'STO',
  איסטנבול: 'IST', טורקיה: 'IST', אנטליה: 'AYT',
  דובאי: 'DXB', 'אבו דאבי': 'AUH', מרוקו: 'RAK', מרקש: 'RAK', מצרים: 'CAI', קהיר: 'CAI', שארם: 'SSH',
  'ניו יורק': 'NYC', 'ארה"ב': 'NYC', ארהב: 'NYC', אמריקה: 'NYC', מיאמי: 'MIA', 'לוס אנג\'לס': 'LAX', 'לוס אנגלס': 'LAX', בוסטון: 'BOS',
  טורונטו: 'YTO', קנדה: 'YTO', מקסיקו: 'MEX', קנקון: 'CUN',
  תאילנד: 'BKK', בנגקוק: 'BKK', פוקט: 'HKT', הודו: 'DEL', דלהי: 'DEL', גואה: 'GOI', וייטנאם: 'SGN', יפן: 'TYO', טוקיו: 'TYO',
  סיישל: 'SEZ', זנזיבר: 'ZNZ', 'סרי לנקה': 'CMB', מלדיביים: 'MLE',
}
// The way back: code -> a Hebrew name for the card.
const NAMES = {
  TLV: 'תל אביב', ETM: 'אילת', ATH: 'אתונה', RHO: 'רודוס', HER: 'כרתים', SKG: 'סלוניקי', CFU: 'קורפו', JMK: 'מיקונוס', JTR: 'סנטוריני',
  LCA: 'לרנקה', PFO: 'פאפוס', ROM: 'רומא', FCO: 'רומא', MIL: 'מילאנו', MXP: 'מילאנו', BGY: 'מילאנו', VCE: 'ונציה', NAP: 'נאפולי', FLR: 'פירנצה',
  BCN: 'ברצלונה', MAD: 'מדריד', PMI: 'מיורקה', VLC: 'ולנסיה', PAR: 'פריז', CDG: 'פריז', ORY: 'פריז', NCE: 'ניס', LYS: 'ליון',
  LON: 'לונדון', LHR: 'לונדון', LGW: 'לונדון', LTN: 'לונדון', STN: 'לונדון', MAN: "מנצ'סטר", AMS: 'אמסטרדם', BER: 'ברלין', MUC: 'מינכן', FRA: 'פרנקפורט',
  PRG: 'פראג', BUD: 'בודפשט', VIE: 'וינה', WAW: 'ורשה', KRK: 'קרקוב', BUH: 'בוקרשט', OTP: 'בוקרשט', SOF: 'סופיה', BOJ: 'בורגס', VAR: 'וארנה', BEG: 'בלגרד',
  TBS: 'טביליסי', BUS: 'בטומי', BAK: 'באקו', GYD: 'באקו', EVN: 'ירוואן', LIS: 'ליסבון', DUB: 'דובלין', ZRH: 'ציריך', GVA: "ז'נבה", CPH: 'קופנהגן', STO: 'שטוקהולם', ARN: 'שטוקהולם',
  IST: 'איסטנבול', SAW: 'איסטנבול', AYT: 'אנטליה', DXB: 'דובאי', AUH: 'אבו דאבי', RAK: 'מרקש', CAI: 'קהיר', SSH: 'שארם א-שייח',
  NYC: 'ניו יורק', JFK: 'ניו יורק', EWR: 'ניו יורק', MIA: 'מיאמי', LAX: "לוס אנג'לס", BOS: 'בוסטון', YTO: 'טורונטו', YYZ: 'טורונטו', MEX: 'מקסיקו סיטי', CUN: 'קנקון',
  BKK: 'בנגקוק', HKT: 'פוקט', DEL: 'דלהי', GOI: 'גואה', SGN: 'הו צ\'י מין', TYO: 'טוקיו', NRT: 'טוקיו', HND: 'טוקיו', SEZ: 'סיישל', ZNZ: 'זנזיבר', CMB: 'קולומבו', MLE: 'מלה',
}
export const placeName = (code) => NAMES[code] || code

const ANYWHERE = /^(|any|anywhere|everywhere|כל מקום|לא משנה|לאן שזול|הכי זול|איפה שזול|כל יעד|\*)$/i

export async function resolvePlace(text) {
  const raw = String(text || '').trim()
  if (ANYWHERE.test(raw)) return ''
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase()
  // "לאתונה" is "to Athens", but "לונדון" is London: the name as written first, then without the leading ל.
  const t = raw
  const key = Object.keys(PLACES).find((k) => k === raw || raw.startsWith(k + ' ')) || Object.keys(PLACES).find((k) => raw === `ל${k}` || raw.startsWith(`ל${k} `))
  if (key) return PLACES[key]
  try {
    const res = await http(`https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(t)}&locale=${/[א-ת]/.test(t) ? 'he' : 'en'}&types[]=city&types[]=airport`, { timeout: 8000 })
    const list = res.ok ? await res.json() : []
    const hit = list.find((p) => p.type === 'city') || list.find((p) => p.type === 'airport')
    if (hit?.code) return String(hit.city_code || hit.code).toUpperCase()
  } catch {}
  return null
}

// ── dates ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ymd = (d) => d.toISOString().slice(0, 10)
const day = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`)
const nightsBetween = (a, b) => Math.round((day(b) - day(a)) / 86400000)
function monthsIn(from, to) {
  const out = []
  const d = new Date(Date.UTC(day(from).getUTCFullYear(), day(from).getUTCMonth(), 1))
  while (d <= day(to) && out.length < 4) {
    out.push(d.toISOString().slice(0, 7))
    d.setUTCMonth(d.getUTCMonth() + 1)
  }
  return out
}

// ── sources ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Cheapest known fares per departure month (Travelpayouts / Aviasales data API v3). Each result is one itinerary.
async function cheapestDates(q) {
  const token = config.flights.travelpayoutsToken
  if (!token) return null
  const all = []
  for (const month of monthsIn(q.departFrom, q.departTo)) {
    const p = new URLSearchParams({
      origin: q.from, departure_at: month, one_way: String(q.oneWay), direct: String(Boolean(q.directOnly)),
      sorting: 'price', limit: '100', currency: config.flights.currency, token,
    })
    if (q.to) p.set('destination', q.to)
    else p.set('unique', 'true')
    const res = await http(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${p}`, { headers: { 'Accept-Encoding': 'gzip' } })
    if (res.status === 401 || res.status === 403) throw new Error('הטוקן של Travelpayouts לא עובד. אפשר לעדכן אותו באתר ההגדרות, בכרטיס "טיסות".')
    if (!res.ok) continue
    const body = await res.json()
    for (const r of body.data || []) all.push(r)
  }
  return all
    .map((r) => ({
      source: 'travelpayouts',
      from: r.origin, to: r.destination,
      depart: String(r.departure_at || '').slice(0, 10), back: r.return_at ? String(r.return_at).slice(0, 10) : '',
      price: Number(r.price), currency: config.flights.currency.toUpperCase(),
      airline: r.airline || '', stops: Number(r.transfers || 0), backStops: Number(r.return_transfers || 0),
      minutes: Number(r.duration_to || r.duration || 0),
      link: r.link ? `https://www.aviasales.com${r.link}` : '',
    }))
    .filter((r) => r.price > 0 && r.depart >= q.departFrom && r.depart <= q.departTo)
    .filter((r) => q.oneWay || !r.back || fitsNights(nightsBetween(r.depart, r.back), q))
    .filter((r) => !q.budget || r.price <= q.budget)
    .sort((a, b) => a.price - b.price)
}

const fitsNights = (n, q) => (!q.nightsMin || n >= q.nightsMin) && (!q.nightsMax || n <= q.nightsMax)

const isoMinutes = (s) => {
  const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/)
  return m ? (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0) : 0
}

// Live offers for exact dates (Duffel). Returns cards with every leg, or null without a token.
async function liveOffers(q, depart, back) {
  const token = config.flights.duffelToken
  if (!token || !q.to) return null
  const slices = [{ origin: q.from, destination: q.to, departure_date: depart }]
  if (back && !q.oneWay) slices.push({ origin: q.to, destination: q.from, departure_date: back })
  const res = await http('https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=20000', {
    method: 'POST',
    timeout: 40000,
    headers: { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: { slices, passengers: Array.from({ length: q.adults }, () => ({ type: 'adult' })), cabin_class: 'economy', max_connections: q.directOnly ? 0 : Math.min(q.maxStops ?? 1, 2) } }),
  })
  if (res.status === 401 || res.status === 403) throw new Error('הטוקן של Duffel לא עובד. אפשר לעדכן אותו באתר ההגדרות, בכרטיס "טיסות".')
  if (!res.ok) return []
  const body = await res.json()
  return (body.data?.offers || []).map(offerCard).filter((o) => fitsLimits(o, q))
}

function offerCard(o) {
  const legs = (o.slices || []).map((s) => {
    const segs = s.segments || []
    const first = segs[0] || {}
    const last = segs[segs.length - 1] || {}
    const layovers = segs.slice(1).map((g, i) => ({ at: g.origin?.iata_code, minutes: Math.round((new Date(g.departing_at) - new Date(segs[i].arriving_at)) / 60000) }))
    return {
      from: first.origin?.iata_code, to: last.destination?.iata_code,
      departs: first.departing_at, arrives: last.arriving_at,
      minutes: isoMinutes(s.duration), stops: Math.max(0, segs.length - 1), layovers,
      flights: segs.map((g) => `${g.marketing_carrier?.name || ''} ${g.marketing_carrier?.iata_code || ''}${g.marketing_carrier_flight_number || ''}`.trim()),
      fare: s.fare_brand_name || '',
    }
  })
  return {
    source: 'duffel',
    airline: o.owner?.name || '', logo: o.owner?.logo_symbol_url || '',
    price: Math.round(Number(o.total_amount)), currency: o.total_currency,
    legs, from: legs[0]?.from, to: legs[0]?.to, depart: String(legs[0]?.departs || '').slice(0, 10), back: String(legs[1]?.departs || '').slice(0, 10),
  }
}

function fitsLimits(o, q) {
  if (q.budget && o.price > q.budget) return false
  for (const leg of o.legs || []) {
    if (q.directOnly && leg.stops) return false
    if (q.maxStops != null && leg.stops > q.maxStops) return false
    if (q.maxLayoverHours && leg.layovers.some((l) => l.minutes > q.maxLayoverHours * 60)) return false
  }
  return true
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────

const money = (n, c) => `${c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'ILS' ? '₪' : ''}${Math.round(n).toLocaleString('en-US')}${['USD', 'EUR', 'ILS'].includes(c) ? '' : ` ${c}`}`
const hm = (min) => (min ? `${Math.floor(min / 60)}ש' ${String(min % 60).padStart(2, '0')}ד'` : '')
const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
const clock = (iso) => String(iso || '').slice(11, 16)
const dateHe = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }) : '')
const stopsHe = (n) => (n ? (n === 1 ? 'עצירה אחת' : `${n} עצירות`) : 'ישירה')

export function googleFlightsLink(from, to, depart, back) {
  const q = `Flights from ${from} to ${to || 'anywhere'} on ${depart}${back ? ` through ${back}` : ' one way'}`
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`
}

// One option as text, for the model and for a chat with no picture.
function optionText(o, i) {
  const route = `${placeName(o.from)} ⇄ ${placeName(o.to)}`
  const head = `*${i + 1}. ${route} · ${money(o.price, o.currency)}*`
  if (o.legs) {
    const legs = o.legs.map((l, k) => `${k ? 'חזור' : 'הלוך'} ${dateHe(l.departs)} ${clock(l.departs)}→${clock(l.arrives)} · ${stopsHe(l.stops)}${l.layovers.length ? ` (${l.layovers.map((x) => `${x.at} ${hm(x.minutes)}`).join(', ')})` : ''} · ${hm(l.minutes)}`)
    return [head, `${o.airline}${o.legs[0].fare ? ` · ${o.legs[0].fare}` : ''}`, ...legs, googleFlightsLink(o.from, o.to, o.depart, o.back)].join('\n')
  }
  const dates = `${dateHe(o.depart)}${o.back ? ` עד ${dateHe(o.back)} (${nightsBetween(o.depart, o.back)} לילות)` : ''}`
  return [head, `${dates} · ${o.airline ? `${o.airline} · ` : ''}${stopsHe(o.stops)}`, o.link || googleFlightsLink(o.from, o.to, o.depart, o.back)].join('\n')
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// The picture: one card per option, like a flights app. Left to right inside a leg (times read that way everywhere).
export function cardHtml(options, title) {
  const leg = (l) => `
    <div class="leg">
      <div class="when">${esc(dateHe(l.departs))}${String(l.arrives).slice(0, 10) !== String(l.departs).slice(0, 10) ? ` ← ${esc(dateHe(l.arrives))}` : ''}</div>
      <div class="row"><b>${esc(clock(l.departs))}</b><span class="line"><i dir="rtl">${esc(l.layovers.map((x) => x.at).join(' · ') || 'ישירה')}</i></span><b>${esc(clock(l.arrives))}</b></div>
      <div class="row small"><span>${esc(l.from)}</span><span dir="rtl">${esc(hhmm(l.minutes))} שעות${l.layovers.length ? ` · המתנה ${esc(l.layovers.map((x) => `${hhmm(x.minutes)} ב-${x.at}`).join(', '))}` : ''}</span><span>${esc(l.to)}</span></div>
    </div>`
  const simple = (o) => `
    <div class="leg">
      <div class="when">${esc(dateHe(o.depart))}${o.back ? ` ← ${esc(dateHe(o.back))} · ${nightsBetween(o.depart, o.back)} לילות` : ''}</div>
      <div class="row"><b>${esc(o.from)}</b><span class="line"><i dir="rtl">${esc(stopsHe(o.stops))}</i></span><b>${esc(o.to)}</b></div>
    </div>`
  const card = (o, i) => `
    <div class="card">
      <div class="top"><span class="n">${i + 1}</span>${o.logo ? `<img src="${esc(o.logo)}">` : ''}<span class="air">${esc(o.airline || placeName(o.to))}</span><span class="stops">${esc(o.legs ? stopsHe(Math.max(...o.legs.map((l) => l.stops))) : placeName(o.to))}</span><span class="price">${esc(money(o.price, o.currency))}</span></div>
      ${o.legs ? o.legs.map(leg).join('') : simple(o)}
      ${o.legs?.[0]?.fare ? `<div class="fare">${esc(o.legs.map((l) => l.flights.join(' + ')).join(' · '))} · ${esc(o.legs[0].fare)}</div>` : ''}
    </div>`
  return `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
    body{margin:0;padding:14px;background:#f2f4f7;font-family:'Noto Sans Hebrew','Segoe UI',Arial,sans-serif;width:520px;color:#1d2433}
    h1{font-size:17px;margin:2px 4px 10px}
    .card{background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .top{display:flex;align-items:center;gap:8px;font-size:14px}
    .n{background:#1d2433;color:#fff;border-radius:6px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
    .top img{width:20px;height:20px}
    .air{font-weight:700}.stops{color:#6b7385;font-size:12px}.price{margin-inline-start:auto;color:#14833b;font-weight:700;font-size:16px}
    .leg{border-top:1px solid #eef0f3;margin-top:10px;padding-top:8px}
    .when{font-size:12px;color:#6b7385;margin-bottom:4px;text-align:left}
    .row{display:flex;align-items:center;gap:10px;direction:ltr}.row b{font-size:17px}
    .line{flex:1;border-top:1.5px dashed #c5cad3;position:relative;height:0;text-align:center}
    .line i{position:relative;top:-9px;background:#fff;padding:0 6px;font-style:normal;font-size:11px;color:#6b7385}
    .small{font-size:11px;color:#6b7385;justify-content:space-between;margin-top:4px}
    .fare{font-size:11px;color:#8a91a1;margin-top:8px}
  </style></head><body><h1>${esc(title)}</h1>${options.map(card).join('')}</body></html>`
}

// HTML -> PNG with the installed Chrome/Chromium, headless, over the DevTools protocol (the --screenshot flag hangs
// in some Chromium builds). The page is measured first, so the picture is exactly as tall as the cards.
// Null when there is no browser or anything fails: the caller then sends the options as text.
async function renderPng(html, _height, timeoutMs = 30000) {
  const exe = process.env.CHROME_PATH || browserPath()
  if (!exe) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-flights-'))
  const file = path.join(dir, 'card.html')
  fs.writeFileSync(file, html)
  const proc = spawn(exe, ['--headless=new', ...SERVER_FLAGS, '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'p')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let socket
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  try {
    return await Promise.race([timer, (async () => {
      const browserWs = await new Promise((resolve, reject) => {
        let err = ''
        proc.stderr.on('data', (d) => {
          err += d
          const m = err.match(/DevTools listening on (ws:\/\/\S+)/)
          if (m) resolve(m[1])
        })
        proc.on('error', reject)
        proc.on('exit', () => reject(new Error('the browser closed')))
      })
      const port = new URL(browserWs).port
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((p) => p.type === 'page')
      const { default: WebSocket } = await import('ws')
      socket = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => (socket.once('open', resolve), socket.once('error', reject)))
      let id = 0
      const waiting = new Map()
      const events = []
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw)
        if (msg.id && waiting.has(msg.id)) {
          waiting.get(msg.id)(msg)
          waiting.delete(msg.id)
        } else if (msg.method) events.push(msg.method)
      })
      const call = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const n = ++id
          waiting.set(n, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
          socket.send(JSON.stringify({ id: n, method, params }))
        })
      await call('Page.enable')
      await call('Emulation.setDeviceMetricsOverride', { width: 548, height: 400, deviceScaleFactor: 2, mobile: false })
      await call('Page.navigate', { url: `file://${file.replace(/\\/g, '/')}` })
      for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await new Promise((r) => setTimeout(r, 50))
      const { result } = await call('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight' })
      const height = Math.min(4000, Math.max(200, Number(result.value) || 400))
      await call('Emulation.setDeviceMetricsOverride', { width: 548, height, deviceScaleFactor: 2, mobile: false })
      const { data } = await call('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(data, 'base64')
    })()])
  } catch {
    return null
  } finally {
    try {
      socket?.close()
    } catch {}
    proc.kill()
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000).unref()
  }
}

// ── the tool ─────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))

export async function findFlights(args, ctx = {}) {
  const from = (await resolvePlace(args.from || config.flights.home)) || config.flights.home
  const to = args.to ? await resolvePlace(args.to) : ''
  if (to === null) return `לא זיהיתי את היעד "${args.to}". בקש ממנו עיר או שדה תעופה.`
  const departFrom = String(args.depart_from || '').slice(0, 10)
  const departTo = String(args.depart_to || args.depart_from || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(departTo)) return 'חסר טווח תאריכים: depart_from ו-depart_to בפורמט YYYY-MM-DD (למשל יולי-אוגוסט = 2027-07-01 עד 2027-08-31).'
  const q = {
    from, to, departFrom, departTo,
    oneWay: Boolean(args.one_way),
    nightsMin: num(args.nights_min), nightsMax: num(args.nights_max),
    directOnly: Boolean(args.direct_only), maxStops: num(args.max_stops), maxLayoverHours: num(args.max_layover_hours),
    budget: num(args.budget), adults: Math.max(1, Math.min(9, num(args.adults) || 1)),
  }
  const where = to ? placeName(to) : 'כל יעד'
  const title = `${placeName(from)} → ${where} · ${dateHe(departFrom)}–${dateHe(departTo)}`

  // No data source: Helper's own browser does the survey on Google Flights, or he gets the links.
  if (!config.flights.travelpayoutsToken && !config.flights.duffelToken) {
    const link = googleFlightsLink(from, to, departFrom, q.oneWay ? '' : args.return_date || '')
    if (errandBrowserEnabled() && ctx && !ctx.noBrowser) {
      const goal = `Find the 3 cheapest ${q.oneWay ? 'one-way' : 'round-trip'} flights from ${from} to ${to || 'any destination (use Google Flights Explore)'}, departing between ${departFrom} and ${departTo}${q.nightsMin ? `, staying ${q.nightsMin}-${q.nightsMax || q.nightsMin} nights` : ''}${q.directOnly ? ', direct only' : q.maxLayoverHours ? `, layovers at most ${q.maxLayoverHours} hours` : ''}. Start at ${link} and use the date grid / price graph to find the cheapest dates. For each: airline, dates, times, stops and layover length, total price, link.`
      const result = await runErrand(goal, 'survey only: read prices, never book, never enter details', ctx, { survey: true })
      return `${result}\n[No flight data token is set, so this came from a browser survey. Reply in Hebrew: the 3 options (airline, dates, stops, price, link) in a tidy WhatsApp list, then ONE line: which you recommend and why. Mention once that adding a free Travelpayouts token on the settings site ("טיסות") makes this instant.]`
    }
    return `אין מקור נתוני טיסות מחובר. קישור לחיפוש מוכן: ${link}\n[Tell him in one line that the link is ready, and that a free Travelpayouts token on the settings site (card "טיסות") gives real prices here in seconds.]`
  }

  let options = []
  const dates = await cheapestDates(q)
  if (dates?.length && q.to && config.flights.duffelToken) {
    // The cheapest date pairs, priced live, checked against his limits.
    const pairs = [...new Map(dates.map((d) => [`${d.depart}|${d.back}`, d])).values()].slice(0, 3)
    for (const p of pairs) options.push(...((await liveOffers(q, p.depart, p.back)) || []))
  } else if (!dates && q.to && config.flights.duffelToken) {
    // Duffel only: exact dates are needed, so the start of the range and the length he gave.
    const back = q.oneWay ? '' : ymd(new Date(day(departFrom).getTime() + (q.nightsMin || 7) * 86400000))
    options = (await liveOffers(q, departFrom, back)) || []
  }
  if (!options.length) options = (dates || []).filter((d) => !q.maxStops || d.stops <= q.maxStops)
  // One per destination when he said anywhere; one per airline and date otherwise.
  const seen = new Set()
  options = options
    .sort((a, b) => a.price - b.price)
    .filter((o) => {
      const k = q.to ? `${o.airline}|${o.depart}|${o.back}` : o.to
      return !seen.has(k) && seen.add(k)
    })
    .slice(0, q.to ? 3 : 5)

  if (!options.length) {
    return `לא נמצאו טיסות ${placeName(from)} → ${where} בטווח ${departFrom} עד ${departTo} עם המגבלות האלה. קישור לחיפוש: ${googleFlightsLink(from, to, departFrom, '')}\n[Say so in one line and offer ONE way to widen it (more dates, a stop allowed, a nearby airport).]`
  }

  const text = options.map(optionText).join('\n\n')
  let sent = false
  if (ctx.sendMedia) {
    const png = renderer && await renderer(cardHtml(options, title), 70 + options.reduce((h, o) => h + (o.legs ? 60 + o.legs.length * 82 : 120), 0))
    if (png) {
      // The picture carries the options; the text below still goes to the model for its recommendation.
      await ctx.sendMedia({ buffer: png, mime: 'image/png', name: 'flights.png' })
      sent = true
    }
  }
  const limits = [q.directOnly && 'direct only', q.maxLayoverHours && `layovers ≤ ${q.maxLayoverHours}h`, q.nightsMin && `${q.nightsMin}-${q.nightsMax || q.nightsMin} nights`, q.budget && `budget ${q.budget}`].filter(Boolean).join(', ')
  return `${text}\n\n[${sent ? 'A picture of these options was already sent to him. Do NOT list them again.' : 'Send the options above as they are (WhatsApp format), then your line.'} Then write ONE or two short Hebrew lines: which option you would take and why (price${limits ? `, fits his limits: ${limits}` : ''}), and offer one way to widen the search (other dates, other cities). ${dates?.length && !config.flights.duffelToken ? 'Prices are recent cached fares; the final price shows on the link.' : ''}]`
}

export const flightTools = [
  {
    name: 'find_flights',
    network: true,
    description:
      'מוצא טיסות אמיתיות ומחירים: התאריכים הזולים בטווח (חודש, חודשיים), הצעות חיות עם שעות, עצירות וזמן קונקשן, ו"לאן הכי זול" בלי יעד. שולח למשתמש תמונה מסודרת של האפשרויות ומחזיר רשימה עם קישורים. לפני הקריאה: אם חסר יעד או אורך שהייה, שאלה אחת שמרכזת הכל (לאן, הלוך-חזור, לכמה זמן, מגבלות על שעות או קונקשן). אחרי: שורה אחת של המלצה ולמה.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'מאיפה: עיר, מדינה או קוד IATA. ריק = ישראל (TLV)' },
        to: { type: 'string', description: 'לאן: עיר, מדינה או קוד IATA. ריק או "anywhere" = היעדים הכי זולים' },
        depart_from: { type: 'string', description: 'תחילת טווח היציאה, YYYY-MM-DD' },
        depart_to: { type: 'string', description: 'סוף טווח היציאה, YYYY-MM-DD. תאריך מדויק = אותו תאריך' },
        one_way: { type: 'boolean', description: 'כיוון אחד' },
        nights_min: { type: 'number', description: 'מינימום לילות ביעד (חודש וחצי ≈ 40)' },
        nights_max: { type: 'number', description: 'מקסימום לילות ביעד (חודש וחצי ≈ 50)' },
        direct_only: { type: 'boolean', description: 'רק טיסות ישירות' },
        max_stops: { type: 'number', description: 'מקסימום עצירות לכל כיוון' },
        max_layover_hours: { type: 'number', description: 'משך קונקשן מקסימלי בשעות' },
        budget: { type: 'number', description: 'מחיר מקסימלי לנוסע, במטבע של המחירים' },
        adults: { type: 'number', description: 'מספר נוסעים, ברירת מחדל 1' },
      },
      required: ['depart_from', 'depart_to'],
    },
    run: (args, ctx) => findFlights(args, ctx),
  },
]

export const _render = (html, height) => renderPng(html, height)
export const _test = { offerCard, fitsLimits, optionText, monthsIn, nightsBetween, PLACES }
export { renderPng }
