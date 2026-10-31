// node src/shopping-selftest.js — offline checks for src/shopping.js and compare_prices on the API path.
// ROWS are 20 real rows from a SerpApi Google Shopping answer for "iPhone" (Austin, 31 Oct 2026), trimmed.
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-shopping-'))
const ROWS = [{"position": 1, "title": "Apple iPhone 18 Pro", "price": "$1,199.00", "extracted_price": 1199.0, "source": "Apple", "delivery": "Free delivery", "rating": 4.5, "reviews": 1400, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 2, "title": "Apple iPhone 16e Black", "price": "$248.00", "extracted_price": 248.0, "old_price": "Usually $315", "extracted_old_price": 315, "source": "Walmart", "delivery": "Free delivery", "rating": 3.9, "reviews": 1900, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 3, "title": "Apple iPhone 16 128GB Pink", "price": "$33.29/mo", "extracted_price": 33.29, "source": "Apple", "delivery": "Free delivery", "rating": 4.3, "reviews": 28, "installment": {"price": "$33.29/mo", "extracted_price": 33.29, "period": 24}, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 4, "title": "Apple iPhone 17e", "price": "$699.00", "extracted_price": 699.0, "source": "Apple", "delivery": "Free next-day delivery", "rating": 4.5, "reviews": 4400, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 5, "title": "Apple iPhone 17", "price": "$37.45/mo", "extracted_price": 37.45, "source": "Apple", "delivery": "Free next-day delivery", "rating": 4.7, "reviews": 23000, "installment": {"price": "$37.45/mo", "extracted_price": 37.45, "period": 24}, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 6, "title": "Apple iPhone 15", "price": "$428.00", "extracted_price": 428.0, "source": "Walmart - Wombat Reserve", "rating": 4.7, "reviews": 44000, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 7, "title": "Apple iPhone 15 - Black - 128GB (with 36 monthly payments + plan)", "price": "$17.50/mo", "extracted_price": 17.5, "source": "T-Mobile", "delivery": "Free delivery", "rating": 4.7, "reviews": 44000, "installment": {"price": "$17.50/mo", "extracted_price": 17.5, "period": 36}, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 8, "title": "Apple iPhone 16e", "price": "$283.48", "extracted_price": 283.48, "source": "Walmart - YYWireless", "rating": 4.6, "reviews": 9400, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 9, "title": "Apple iPhone 15 128GB Black - Available With Cricket Wireless Plan", "price": "$349.99", "extracted_price": 349.99, "source": "Cricket Wireless", "delivery": "Free delivery", "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 10, "title": "Apple iPhone Air", "price": "$41.67/mo", "extracted_price": 41.67, "source": "Consumer Cellular", "delivery": "Free delivery by Wed", "rating": 4.5, "reviews": 5000, "installment": {"price": "$41.67/mo", "extracted_price": 41.67, "period": 36}, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 11, "title": "Apple iPhone 14", "price": "$258.00", "extracted_price": 258.0, "old_price": "Usually $278", "extracted_old_price": 278, "source": "Walmart - Reebelo", "delivery": "Free delivery", "rating": 4.3, "reviews": 13000, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 12, "title": "Apple iPhone 17 Pro", "price": "$984.00", "extracted_price": 984.0, "source": "Swappa", "delivery": "Free delivery", "rating": 4.2, "reviews": 10000, "second_hand_condition": "pre-owned", "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 13, "title": "Apple iPhone 16", "price": "$558.99", "extracted_price": 558.99, "old_price": "Usually $829", "extracted_old_price": 829, "source": "Walmart - BREED", "rating": 4.4, "reviews": 12000, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 14, "title": "Apple iPhone 18 Pro Max", "price": "$2,499.00 now", "extracted_price": 2499.0, "source": "Visible", "delivery": "Free delivery by Wed", "rating": 2.4, "reviews": 1300, "installment": {"price": "$69.42/mo", "extracted_price": 69.42, "period": 36}, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 15, "title": "Apple iPhone 15 Pro", "price": "$459.96", "extracted_price": 459.96, "old_price": "$505", "extracted_old_price": 505, "source": "Walmart - Reebelo", "delivery": "Free delivery", "rating": 4.4, "reviews": 9800, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 16, "title": "Apple iPhone 12", "price": "$159.99", "extracted_price": 159.99, "source": "Best Buy", "delivery": "Free delivery", "rating": 4.5, "reviews": 15000, "second_hand_condition": "pre-owned", "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 17, "title": "Apple iPhone 17 Pro - 5G smartphone - dual-SIM / Internal Memory 256 GB - OLED display - 6.3\" - 2622 x 1206 pixels (120 Hz) - 3x rear cameras 48 ...", "price": "$879.99", "extracted_price": 879.99, "source": "Walmart - YYWireless", "rating": 4.8, "reviews": 8100, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 18, "title": "Apple iPhone 17 Pro 5G", "price": "$1,279.00", "extracted_price": 1279.0, "source": "Mint Mobile", "delivery": "Free delivery by Fri", "rating": 4.6, "reviews": 2300, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 19, "title": "Apple iPhone 16 Plus", "price": "$622.00", "extracted_price": 622.0, "source": "Swappa", "delivery": "Free delivery", "rating": 4.7, "reviews": 6500, "second_hand_condition": "refurbished", "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}, {"position": 20, "title": "Apple iPhone 17 Pro Max", "price": "$927.00", "extracted_price": 927.0, "old_price": "$999", "extracted_old_price": 999, "source": "Walmart - Reebelo", "delivery": "Free delivery", "rating": 4.3, "reviews": 24000, "product_link": "https://www.google.com/search?ibp=oshop&q=iPhone"}]

const sh = await import('./shopping.js')

// the request
delete process.env.SERPAPI_KEY
assert.equal(sh.shoppingEnabled(), false)
const u = new URL(sh.shoppingUrl('אוזניות סוני', { key: 'k123' }))
assert.equal(u.searchParams.get('engine'), 'google_shopping')
assert.equal(u.searchParams.get('gl'), 'il')
assert.equal(u.searchParams.get('hl'), 'iw')
assert.equal(u.searchParams.get('q'), 'אוזניות סוני')
assert.throws(() => sh.shoppingUrl('  '))

// rows
const monthly = sh.normalize(ROWS.find((r) => /\/mo/.test(r.price)))
assert.equal(monthly.monthly, true)
const used = sh.normalize(ROWS.find((r) => r.second_hand_condition))
assert.equal(used.used, true)
assert.equal(sh.normalize({ title: 'x' }), null)
assert.equal(sh.normalize({ title: 'Refurbished iPhone 14', extracted_price: 400, price: '$400' }).used, true)

// ranking: new, full price, cheapest first; monthly and used are not "the cheapest"
const r = sh.rank(ROWS)
assert.ok(r.main.length >= 5)
assert.ok(r.main.every((x) => !x.monthly && !x.used))
for (let i = 1; i < r.main.length; i++) assert.ok(r.main[i - 1].price <= r.main[i].price)
assert.ok(!r.main.some((x) => x.price < 100), 'a $33/mo plan is never ranked as a $33 phone')
assert.ok(sh.rank(ROWS, { includeUsed: true }).main.some((x) => x.used))
assert.ok(sh.rank(ROWS, { budget: 300 }).main.every((x) => x.price <= 300))

// an accessory far below the median goes to the end
const withCase = sh.rank([...ROWS, { title: 'iPhone case', extracted_price: 9.99, price: '$9.99', source: 'Amazon' }])
assert.ok(!withCase.main.some((x) => x.title === 'iPhone case'))

// text
const text = sh.formatOffers(r, 'iPhone')
assert.match(text, /^Google Shopping, "iPhone": 20 הצעות/)
assert.match(text, /1\. .*\$\d/)
assert.match(text, /מחודשים \/ משומשים:/)
assert.match(text, /בתשלום חודשי/)
assert.match(text, /https:\/\/www\.google\.com\/search/)

// errors
const answer = (status, body) => sh._setHttpForTest(async () => new Response(JSON.stringify(body), { status }))
answer(401, { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' })
await assert.rejects(sh.searchShopping('x'), /מפתח SerpApi לא תקין/)
answer(429, { error: 'Your account has run out of searches.' })
await assert.rejects(sh.searchShopping('x'), /נגמרה המכסה/)

// compare_prices takes the API path when there is a key, and never opens the browser for it
process.env.SERPAPI_KEY = 'test-key'
let asked = ''
sh._setHttpForTest(async (url) => {
  asked = String(url)
  return new Response(JSON.stringify({ shopping_results: ROWS }), { status: 200 })
})
const { tools } = await import('./tools.js')
const cp = tools.find((t) => t.name === 'compare_prices')
assert.ok(cp && (!cp.enabled || cp.enabled()), 'compare_prices is on with only a SerpApi key')
const out = await cp.run({ goal: 'iPhone 16', budget: '₪3,000' }, {})
assert.match(asked, /engine=google_shopping/)
assert.match(out, /Google Shopping, "iPhone 16"/)
assert.match(out, /Do not say you ordered or paid/)

delete process.env.SERPAPI_KEY
console.log('shopping: הכול תקין')
