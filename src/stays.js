// Places to stay: "תמצא לי מלון באתונה ל-3 לילות באוגוסט" or "דירה כמו Airbnb ברומא לארבעה", answered from data,
// not from clicking through booking sites.
//
// Source: SerpApi's Google Hotels API (SERPAPI_KEY, 250 free searches a month at serpapi.com). One call returns
// hotels or vacation rentals with the nightly and total price, rating, reviews, stars and photos, the same data Google
// Hotels shows. Airbnb itself has no public API; vacation rentals here come from the partners Google lists.
//
// The answer is like find_flights: a picture of up to 4 cards sent to the chat, plus a short list with links that
// the model turns into one recommendation line. No key: ready search links on Google Hotels, Booking and Airbnb.
//
// Read-only. Nothing is booked or paid here.
import { config } from './config.js'
import { renderPng } from './flights.js'

let http = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(opts?.timeout || 30000) })
let renderer = (html) => renderPng(html)
export const _setForTest = (opts = {}) => {
  if (opts.fetch) http = opts.fetch
  if ('render' in opts) renderer = opts.render
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
const day = (s) => new Date(`${s}T00:00:00Z`)
const nights = (a, b) => Math.round((day(b) - day(a)) / 86400000)
const dateHe = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' })
const SIGN = { USD: '$', EUR: '€', ILS: '₪', GBP: '£' }
const money = (n, c) => (SIGN[c] ? `${SIGN[c]}${Math.round(n).toLocaleString('en-US')}` : `${Math.round(n).toLocaleString('en-US')} ${c}`)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Search links that work without any key.
export function stayLinks(where, checkIn, checkOut, adults = 2) {
  const w = encodeURIComponent(where)
  return {
    google: `https://www.google.com/travel/search?q=${w}&ts=&hl=he`,
    booking: `https://www.booking.com/searchresults.html?ss=${w}&checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}`,
    airbnb: `https://www.airbnb.com/s/${w}/homes?checkin=${checkIn}&checkout=${checkOut}&adults=${adults}`,
  }
}

const SORT = { price: '3', rating: '8', reviews: '13' }
const RATING = (r) => (r >= 4.5 ? '9' : r >= 4 ? '8' : r >= 3.5 ? '7' : '')

// One property from the API -> a card. Prices are the extracted numbers in the requested currency.
function toCard(p, currency, stay) {
  const perNight = p.rate_per_night?.extracted_lowest ?? p.rate_per_night?.extracted_before_taxes_fees
  const total = p.total_rate?.extracted_lowest ?? (perNight ? perNight * stay : undefined)
  return {
    name: p.name || '',
    rental: /vacation rental/i.test(p.type || ''),
    perNight: Number(perNight) || 0,
    total: Number(total) || 0,
    currency,
    rating: Number(p.overall_rating) || 0,
    reviews: Number(p.reviews) || 0,
    stars: Number(p.extracted_hotel_class) || 0,
    info: (p.essential_info || []).slice(0, 3).join(' · '),
    source: p.prices?.[0]?.source || '',
    image: p.images?.[0]?.thumbnail || '',
    link: p.link || p.prices?.[0]?.link || '',
    sponsored: Boolean(p.sponsored),
  }
}

async function searchStays(q) {
  const p = new URLSearchParams({
    engine: 'google_hotels', q: q.where, check_in_date: q.checkIn, check_out_date: q.checkOut,
    adults: String(q.adults), currency: q.currency, gl: 'il', hl: 'he', api_key: config.stays.serpapiKey,
  })
  if (q.children) p.set('children', String(q.children))
  if (q.childrenAges) p.set('children_ages', q.childrenAges)
  if (q.rental) p.set('vacation_rentals', 'true')
  if (q.rental && q.bedrooms) p.set('bedrooms', String(q.bedrooms))
  if (q.maxPerNight) p.set('max_price', String(Math.round(q.maxPerNight)))
  if (SORT[q.sort]) p.set('sort_by', SORT[q.sort])
  if (RATING(q.minRating)) p.set('rating', RATING(q.minRating))
  if (!q.rental && q.freeCancellation) p.set('free_cancellation', 'true')
  if (!q.rental && q.stars) p.set('hotel_class', String(q.stars))
  const res = await http(`https://serpapi.com/search.json?${p}`)
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 || /invalid api key/i.test(body.error || '')) throw new Error('המפתח של SerpApi לא עובד. אפשר לעדכן אותו באתר ההגדרות, בכרטיס "לינה".')
  if (res.status === 429 || /run out of searches/i.test(body.error || '')) throw new Error('נגמרו החיפושים החודשיים ב-SerpApi. אפשר לחכות לחודש הבא או לשדרג באתר שלהם.')
  // "Google Hotels hasn't returned any results" comes back as an error with status 200: that is an empty list.
  if (!res.ok) throw new Error(`SerpApi החזיר שגיאה ${res.status}${body.error ? `: ${body.error}` : ''}`)
  return (body.properties || []).map((x) => toCard(x, q.currency, nights(q.checkIn, q.checkOut)))
}

function optionText(o, i, stay) {
  const head = `*${i + 1}. ${o.name} · ${money(o.perNight, o.currency)} ללילה${o.total ? ` (${money(o.total, o.currency)} ל-${stay} לילות)` : ''}*`
  const facts = [o.stars && `${o.stars} כוכבים`, o.rating && `דירוג ${o.rating}${o.reviews ? ` (${o.reviews.toLocaleString('en-US')} ביקורות)` : ''}`, o.info, o.source && `הכי זול ב-${o.source}`].filter(Boolean).join(' · ')
  return [head, facts, o.link].filter(Boolean).join('\n')
}

export function cardHtml(options, title, stay) {
  const card = (o, i) => `
    <div class="card">
      ${o.image ? `<img class="ph" src="${esc(o.image)}" onerror="this.remove()">` : ''}
      <div class="body">
        <div class="top"><span class="n">${i + 1}</span><span class="name">${esc(o.name)}</span></div>
        <div class="meta">${[o.stars && '★'.repeat(Math.min(5, o.stars)), o.rating && `${o.rating} / 5`, o.reviews && `${o.reviews.toLocaleString('en-US')} ביקורות`].filter(Boolean).map(esc).join(' · ')}</div>
        ${o.info ? `<div class="meta">${esc(o.info)}</div>` : ''}
        <div class="price"><b>${esc(money(o.perNight, o.currency))}</b> ללילה${o.total ? ` · ${esc(money(o.total, o.currency))} ל-${stay} לילות` : ''}</div>
        ${o.source ? `<div class="src">הכי זול ב-${esc(o.source)}</div>` : ''}
      </div>
    </div>`
  return `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
    body{margin:0;padding:14px;background:#f2f4f7;font-family:'Noto Sans Hebrew','Segoe UI',Arial,sans-serif;width:520px;color:#1d2433}
    h1{font-size:17px;margin:2px 4px 10px}
    .card{display:flex;gap:12px;background:#fff;border-radius:14px;padding:10px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .ph{width:120px;height:96px;object-fit:cover;border-radius:10px;flex:none}
    .body{flex:1;min-width:0}
    .top{display:flex;align-items:center;gap:8px;font-size:15px}
    .n{background:#1d2433;color:#fff;border-radius:6px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none}
    .name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .meta{font-size:12px;color:#6b7385;margin-top:4px}
    .price{margin-top:8px;font-size:13px}.price b{color:#14833b;font-size:17px}
    .src{font-size:11px;color:#8a91a1;margin-top:2px}
  </style></head><body><h1>${esc(title)}</h1>${options.map(card).join('')}</body></html>`
}

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))

export async function findStays(args, ctx = {}) {
  const where = String(args.where || '').trim()
  const checkIn = String(args.check_in || '').slice(0, 10)
  const checkOut = String(args.check_out || '').slice(0, 10)
  if (!where) return 'חסר מקום: עיר, שכונה או אזור.'
  if (!YMD.test(checkIn) || !YMD.test(checkOut) || nights(checkIn, checkOut) < 1) return 'חסרים תאריכים: check_in ו-check_out בפורמט YYYY-MM-DD, והיציאה אחרי הכניסה.'
  const q = {
    where, checkIn, checkOut,
    adults: Math.max(1, Math.min(12, num(args.adults) || 2)),
    children: Math.max(0, Math.min(8, num(args.children) || 0)),
    childrenAges: String(args.children_ages || '').replace(/[^\d,]/g, ''),
    rental: args.kind === 'rental',
    bedrooms: num(args.bedrooms),
    maxPerNight: num(args.max_per_night),
    minRating: num(args.min_rating) || 0,
    stars: num(args.stars),
    freeCancellation: Boolean(args.free_cancellation),
    sort: args.sort || 'relevance',
    currency: config.stays.currency,
  }
  // Children without ages: the API needs one age per child, 8 is a fair guess for prices.
  if (q.children && q.childrenAges.split(',').filter(Boolean).length !== q.children) q.childrenAges = Array(q.children).fill('8').join(',')
  const stay = nights(checkIn, checkOut)
  const links = stayLinks(where, checkIn, checkOut, q.adults)

  if (!config.stays.serpapiKey) {
    return `אין מקור נתוני לינה מחובר. קישורים מוכנים:\nGoogle Hotels: ${links.google}\nBooking: ${links.booking}\nAirbnb: ${links.airbnb}\n[Send him the links in one short message, and say once that a free SerpApi key on the settings site (card "לינה") gives real prices and a picture here in seconds.]`
  }

  let options = (await searchStays(q))
    .filter((o) => o.perNight > 0)
    .filter((o) => !q.maxPerNight || o.perNight <= q.maxPerNight)
    .filter((o) => !q.minRating || o.rating >= q.minRating)
  // Ads last, then his order. The API already sorted when he asked for price, rating or reviews.
  if (q.sort === 'price') options.sort((a, b) => a.perNight - b.perNight)
  options = [...options.filter((o) => !o.sponsored), ...options.filter((o) => o.sponsored)]
  options = options.slice(0, 4)

  const kind = q.rental ? 'דירות' : 'מלונות'
  if (!options.length) {
    return `לא נמצאו ${kind} ב${where} ל-${dateHe(checkIn)} עד ${dateHe(checkOut)} עם המגבלות האלה. חיפוש מוכן: ${links.google}\n[Say so in one line and offer ONE way to widen it (higher budget, lower rating, ${q.rental ? 'hotels instead' : 'apartments instead'}, a nearby area).]`
  }

  const title = `${kind} ב${where} · ${dateHe(checkIn)} עד ${dateHe(checkOut)} · ${stay} לילות · ${q.adults + q.children} אורחים`
  const text = options.map((o, i) => optionText(o, i, stay)).join('\n\n')
  let sent = false
  if (ctx.sendMedia && renderer) {
    const png = await renderer(cardHtml(options, title, stay))
    if (png) {
      await ctx.sendMedia({ buffer: png, mime: 'image/png', name: 'stays.png' })
      sent = true
    }
  }
  return `${text}\n\n[${sent ? 'A picture of these options was already sent to him. Do NOT list them again.' : 'Send the options above as they are (WhatsApp format), then your line.'} Then ONE or two short Hebrew lines: which place you would take and why (price against rating and location), and offer one way to widen the search${q.rental ? '' : ' (for example apartments, like Airbnb)'}. Prices are what Google Hotels shows now; the final price is on the site.]`
}

export const stayTools = [
  {
    name: 'find_stays',
    network: true,
    description:
      'מוצא מקום לינה עם מחירים אמיתיים: מלונות או דירות נופש (כמו Airbnb), לפי עיר ותאריכים, עם מחיר ללילה וסה"כ, דירוג, ביקורות ותמונות. שולח למשתמש תמונה מסודרת של האפשרויות ומחזיר רשימה עם קישורים. לפני הקריאה: אם חסרים מקום, תאריכים או מספר אנשים, שאלה אחת שמרכזת הכל (איפה, מתי, כמה אנשים, מלון או דירה, תקציב ללילה). אחרי: שורה אחת של המלצה ולמה. לא מזמין ולא משלם.',
    parameters: {
      type: 'object',
      properties: {
        where: { type: 'string', description: 'עיר, שכונה או אזור, כמו שהוא כתב (למשל "אתונה", "פלאקה אתונה", "אילת")' },
        check_in: { type: 'string', description: 'תאריך כניסה YYYY-MM-DD' },
        check_out: { type: 'string', description: 'תאריך יציאה YYYY-MM-DD' },
        adults: { type: 'number', description: 'מבוגרים, ברירת מחדל 2' },
        children: { type: 'number', description: 'ילדים' },
        children_ages: { type: 'string', description: 'גילי הילדים מופרדים בפסיק, אם נאמרו' },
        kind: { type: 'string', enum: ['hotel', 'rental'], description: 'hotel = מלונות (ברירת מחדל). rental = דירות נופש, וילות, "כמו Airbnb"' },
        bedrooms: { type: 'number', description: 'מינימום חדרי שינה (רק לדירות)' },
        max_per_night: { type: 'number', description: 'תקציב מקסימלי ללילה, במטבע של המחירים' },
        min_rating: { type: 'number', description: 'דירוג מינימלי מתוך 5 (3.5, 4 או 4.5)' },
        stars: { type: 'number', description: 'מספר כוכבים למלון (2-5)' },
        free_cancellation: { type: 'boolean', description: 'רק עם ביטול חינם (מלונות)' },
        sort: { type: 'string', enum: ['relevance', 'price', 'rating', 'reviews'], description: 'סדר: price = הכי זול, rating = הכי מדורג, reviews = הכי הרבה ביקורות' },
      },
      required: ['where', 'check_in', 'check_out'],
    },
    run: (args, ctx) => findStays(args, ctx),
  },
]

export const _test = { toCard, optionText, nights }
