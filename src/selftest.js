// Offline checks plus one live search. Does not touch WhatsApp or the LLM.
import assert from 'node:assert/strict'
import { htmlToText, webSearch, fetchPage } from './web.js'
import { nextOccurrence } from './scheduler.js'
import { tools, activeTools } from './tools.js'

assert.equal(htmlToText('<p>a &amp; b</p><script>x()</script><div>c</div>'), 'a & b\nc')

const now = Date.parse('2026-10-11T12:00:00Z')
assert.equal(nextOccurrence('2026-10-09T08:00:00Z', 'daily', now), '2026-10-12T08:00:00.000Z')
assert.equal(nextOccurrence('2026-10-09T08:00:00Z', 'weekly', now), '2026-10-16T08:00:00.000Z')

for (const t of tools) {
  assert.match(t.name, /^[a-z_]+$/)
  assert.equal(t.parameters.type, 'object')
  for (const r of t.parameters.required) assert.ok(r in t.parameters.properties, `${t.name}: ${r}`)
}
console.log('כלים פעילים:', activeTools().map((t) => t.name).join(', '))

const results = await webSearch('PS5 DualSense controller price')
console.log(`חיפוש: ${results.length} תוצאות, ראשונה: ${results[0]?.title} | ${results[0]?.url}`)
assert.ok(results.length > 0, 'החיפוש לא החזיר תוצאות')

const page = await fetchPage('https://example.com')
assert.match(page, /documentation examples/)
console.log('הכול עבר ✔')
process.exit(0)
