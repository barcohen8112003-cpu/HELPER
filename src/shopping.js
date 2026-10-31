// Price comparison through SerpApi's Google Shopping API: one call instead of a browser walking zap and shops.
// Key: SERPAPI_KEY (the same key as places to stay; 250 free searches a month at serpapi.com).
// Without a key, compare_prices falls back to the agent browser as before.

const T = 20000

export const shoppingEnabled = () => Boolean(process.env.SERPAPI_KEY)

let http = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(T) })
export const _setHttpForTest = (fn) => {
  http = fn
}

export function shoppingUrl(query, { country = 'il', key = process.env.SERPAPI_KEY } = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('חסר מה לחפש')
  const p = new URLSearchParams({ engine: 'google_shopping', q, api_key: key || '', num: '40' })
  if (country === 'il') {
    p.set('gl', 'il')
    p.set('hl', 'iw')
    p.set('google_domain', 'google.co.il')
    p.set('location', 'Israel')
  }
  return `https://serpapi.com/search.json?${p}`
}

const USED = /refurb|renewed|pre-?owned|\bused\b|second[- ]hand|open box|מחודש|משומש|יד שנייה/i
const MONTHLY = /\/\s*mo\b|per month|month|לחודש|תשלומים/i

// One clean row per offer. Monthly and used offers are kept but marked, never ranked as "the cheapest".
export function normalize(r) {
  const price = Number(r?.extracted_price)
  if (!r?.title || !Number.isFinite(price) || price <= 0) return null
  const monthly = MONTHLY.test(String(r.price ?? '')) || Boolean(r.installment)
  const used = Boolean(r.second_hand_condition) || USED.test(r.title)
  return {
    title: String(r.title).slice(0, 120),
    price,
    priceText: String(r.price ?? price),
    oldPrice: Number(r.extracted_old_price) || null,
    shop: r.source || '',
    delivery: r.delivery || '',
    rating: r.rating ?? null,
    reviews: r.reviews ?? null,
    used,
    condition: r.second_hand_condition || (used ? 'מחודש/משומש' : ''),
    monthly,
    link: r.product_link || r.link || '',
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

// Cheapest new, full-price offers first. Very cheap rows (under a third of the median) are usually accessories
// (a case for the phone), so they go to the end instead of the top.
export function rank(results, { includeUsed = false, budget } = {}) {
  const rows = (results ?? []).map(normalize).filter(Boolean)
  const full = rows.filter((r) => !r.monthly && (includeUsed || !r.used))
  const mid = median(full.map((r) => r.price))
  const likelyAccessory = (r) => mid > 0 && r.price < mid / 3
  const within = (r) => !budget || r.price <= budget
  const main = full.filter((r) => !likelyAccessory(r) && within(r)).sort((a, b) => a.price - b.price)
  const other = rows.filter((r) => !main.includes(r))
  return { main, other, total: rows.length }
}

export async function searchShopping(query, { includeUsed = false, budget, country = 'il' } = {}) {
  const res = await http(shoppingUrl(query, { country }))
  const body = await res.text()
  let d
  try {
    d = JSON.parse(body)
  } catch {
    throw new Error(`SerpApi החזיר תשובה לא תקינה (${res.status})`)
  }
  if (!res.ok || d.error) {
    const msg = String(d.error || res.status)
    if (/run out|limit|quota/i.test(msg)) throw new Error('נגמרה המכסה החודשית של SerpApi')
    if (/invalid api key/i.test(msg)) throw new Error('מפתח SerpApi לא תקין')
    throw new Error(`SerpApi: ${msg.slice(0, 160)}`)
  }
  return rank(d.shopping_results, { includeUsed, budget })
}

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function formatOffers({ main, other, total }, query, max = 8) {
  if (!main.length && !other.length) return ''
  const line = (r, i) =>
    [
      `${i + 1}. ${r.title}: ${r.priceText}${r.oldPrice && r.oldPrice > r.price ? ` (במקום ${fmt(r.oldPrice)})` : ''}`,
      r.shop && `ב-${r.shop}`,
      r.delivery,
      r.used && r.condition,
      r.rating && `דירוג ${r.rating}${r.reviews ? ` (${fmt(r.reviews)} ביקורות)` : ''}`,
    ]
      .filter(Boolean)
      .join(' · ') + (r.link ? `\n${r.link}` : '')
  const out = [`Google Shopping, "${query}": ${total} הצעות. הזולות קודם:`, ...main.slice(0, max).map(line)]
  const used = other.filter((r) => r.used && !r.monthly).sort((a, b) => a.price - b.price)
  const monthly = other.filter((r) => r.monthly)
  if (used.length) out.push('', 'מחודשים / משומשים:', ...used.slice(0, 3).map(line))
  if (monthly.length) out.push('', `${monthly.length} הצעות בתשלום חודשי (בדרך כלל עם מסלול), לא נכללו בדירוג.`)
  return out.join('\n')
}
