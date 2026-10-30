// node src/routing-selftest.js: which tools and instructions a message gets (src/domains.js), offline.
// Real asks, the way he writes them, must reach the tool that does them; small talk must not drag in the computer,
// the TV and the phone; and nothing routing leaves out is ever out of reach.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-routing-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1', PC_BRIDGE_SECRET: 'test-bridge' })

const { pickDomains, routed, routingText, searchDomains, DOMAINS, BASE, domainOf } = await import('./domains.js')
const { tools, activeTools, toolDefs } = await import('./tools.js')
const { config } = await import('./config.js')
const { persona, _test, runTurn, resetHistory } = await import('./agent.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// ── real asks -> the tool that does them ─────────────────────────────────────
const CASES = [
  ['חפש לי טיסה זולה מישראל באזור יולי אוגוסט', 'find_flights'],
  ['לאן הכי זול לטוס בחנוכה?', 'find_flights'],
  ['תמצא לי דיל לאתונה', 'find_flights'],
  ['תמצא לי אוזניות אלחוטיות עד 300 שקל', 'compare_prices'],
  ['תזמין לי פיצה הביתה', 'run_errand'],
  ['תכבה מסכים', 'pc_display_off'],
  ['לילה טוב', 'pc_display_off'],
  ['תנמיך את הווליום', 'pc_media'],
  ['תשים שיר של עומר אדם בספוטיפיי', 'play_spotify'],
  ['תפתח יוטיוב', 'open'],
  ['תזמין לי מונית הביתה בגט', 'run_on_phone'],
  ['תכוון שעון מעורר ל-7', 'run_on_phone'],
  ['תפעיל בטלוויזיה את נפוליאון בסטרימיו', 'tv_play'],
  ['תכבה את האור בסלון', 'google_home_control'],
  ['תצייר לי תמונה של חתול אסטרונאוט', 'create_image'],
  ['תבנה לי אתר נחיתה לעסק', 'claude_code'],
  ['תריץ סקריפט פייתון שמחשב את זה', 'vm_run'],
  ['תשלח לאמא בוואטסאפ שאני בדרך', 'send_whatsapp_to'],
  ['מה פספסתי בקבוצה של הכיתה?', 'whatsapp_groups'],
  ['מה המטלות שלי בקלאסרום?', 'classroom_assignments'],
  ['מה יש לי מחר במערכת?', 'get_timetable'],
  ['יש לי מבחן בכימיה ביום חמישי, תכין לי תוכנית למידה', 'study_plan'],
  ['תשאל את ג\'מיני מה דעתו', 'ask_gemini'],
  ['איפה החבילה שלי מעלי אקספרס?', 'track_package'],
  ['מתי נכנסת שבת?', 'get_jewish_calendar'],
  ['כמה זה 50 דולר בשקלים?', 'get_currency_rate'],
  ['היו אזעקות בחיפה?', 'israel_red_alert'],
  ['תעקוב אחרי המחיר של האייפון ותודיע לי כשיירד', 'add_watcher'],
  ['תשכח את מה שאמרתי על הקפה', 'forget'],
  // base: always there
  ['מה יש לי ביומן מחר?', 'get_calendar'],
  ['יש לי מייל חדש?', 'check_mail'],
  ['תזכיר לי בשמונה לקחת כביסה', 'add_reminder'],
  ['מה מזג האוויר בחיפה?', 'get_weather'],
  ['מי זה איינשטיין', 'web_search'],
]
for (const [text, tool] of CASES) ok(routed(tool, pickDomains(text)), `"${text}" reaches ${tool}`)

// ── small talk stays small ───────────────────────────────────────────────────
for (const text of ['מה נשמע?', 'תודה אחי', 'סבבה', 'מה דעתך על זה?']) {
  const d = pickDomains(text)
  ok(!d.has('pc') && !d.has('tv') && !d.has('phone') && !d.has('create'), `"${text}" opens no device domain`)
}

// "כן" after an offer keeps the offer's domain.
{
  const msgs = [
    { role: 'user', content: 'תמצא לי טיסה לרומא' },
    { role: 'assistant', content: 'לאיזה תאריכים? ורוצה שאחפש גם מילאנו?' },
    { role: 'user', content: 'כן' },
  ]
  ok(pickDomains(routingText(msgs)).has('travel'), 'a short yes keeps the domain of the conversation')
}

// ── the tool list a message gets ─────────────────────────────────────────────
{
  const all = activeTools()
  const chat = activeTools(new Set(), pickDomains('מה נשמע?'))
  const pc = activeTools(new Set(), pickDomains('תכבה מסכים'))
  ok(all.some((t) => t.name === 'pc_display_off'), 'the PC tools are on in this test (bridge set)')
  ok(chat.length < all.length / 2, `small talk gets far fewer tools (${chat.length} of ${all.length})`)
  ok(!chat.some((t) => t.name === 'pc_display_off') && pc.some((t) => t.name === 'pc_display_off'), 'the PC tools come with a PC request only')
  ok(chat.every((t) => BASE.has(t.name) || !domainOf(t.name)), 'small talk gets only base tools')
  const defsAll = JSON.stringify(toolDefs(all)).length
  const defsChat = JSON.stringify(toolDefs(chat)).length
  ok(defsChat < defsAll * 0.6, `tool definitions shrink for small talk (${defsChat} vs ${defsAll} chars)`)
  // Every core tool is either base or in exactly one domain.
  for (const t of tools) {
    const n = DOMAINS.filter((d) => d.has(t.name)).length
    ok(n <= 1, `${t.name} is in at most one domain`)
    ok(!(n === 1 && BASE.has(t.name)), `${t.name} is not both base and in a domain`)
  }
  config.routing = false
  ok(activeTools(new Set(), pickDomains('מה נשמע?')).length === all.length, 'TOOL_ROUTING=off sends every tool')
  config.routing = true
}

// ── tool_search opens a domain ───────────────────────────────────────────────
{
  ok(searchDomains('pc').includes('pc') && searchDomains('טלוויזיה').includes('tv') && searchDomains('flight').includes('travel'), 'domains are found by id, Hebrew and English')
  const ctx = { unlocked: new Set(), domains: pickDomains('מה נשמע?') }
  const search = tools.find((t) => t.name === 'tool_search')
  const out = search.run({ query: 'pc' }, ctx)
  ok(/נפתח: המחשב בבית/.test(out) && ctx.unlocked.has('pc_display_off') && ctx.domains.has('pc'), 'tool_search("pc") opens the computer tools for the turn')
  ok(activeTools(ctx.unlocked, ctx.domains).some((t) => t.name === 'pc_media'), 'and they are sent from then on')
}

// ── the system prompt a message gets ─────────────────────────────────────────
{
  const full = _test.systemPrompt('', '', '', undefined, true)
  const chat = _test.systemPrompt('', '', '', pickDomains('מה נשמע?'), false)
  const pc = _test.systemPrompt('', '', '', pickDomains('תכבה מסכים'), false)
  const travel = _test.systemPrompt('', '', '', pickDomains('תמצא לי טיסה זולה'), false)
  ok(chat.length < full.length * 0.75, `small talk gets a much shorter system prompt (${chat.length} vs ${full.length} chars)`)
  ok(!/pc_display_off/.test(chat) && /pc_display_off/.test(pc), 'the computer rules come with a computer request only')
  ok(/tool_search/.test(chat) && /pc \(המחשב בבית\)/.test(chat), 'small talk still sees the menu of what it can open')
  ok(/find_flights/.test(travel) && /שאלה אחת/.test(travel), 'a flight request gets the travel playbook')
  ok(!/find_flights/.test(chat), 'and small talk does not')
}

// ── persona: notification rules only when Helper writes first ───────────────
{
  const whole = persona()
  const chat = persona(new Set(), false)
  const task = persona(new Set(), true)
  ok(/## 6\. Timing/.test(whole) && /## 6\. Timing/.test(task) && !/## 6\. Timing/.test(chat), 'quiet-hours rules: in a scheduled task, not in a reply')
  ok(/## 2\. Your voice/.test(chat) && /## 10\. Permission/.test(chat), 'voice and permission rules are always there')
  ok(!/## 16\. Teaching/.test(chat) && /## 16\. Teaching/.test(persona(new Set(['school']), false)), 'teaching rules come with school')
  ok(chat.length < whole.length * 0.8, `a reply carries a shorter persona (${chat.length} vs ${whole.length})`)
}

// ── a tool routing left out still runs when the model names it ──────────────
{
  config.llm.apiKey = 'test-key'
  config.llm.model = 'fake-model'
  config.llm.fallbackModels = []
  config.llm.cheapModel = ''
  config.llm.baseUrl = 'http://fake.invalid'
  config.llm.backup = { apiKey: '', model: '' }
  config.memoryLearn = false
  const ran = []
  tools.push({ name: 'tv_zz_test', description: 'x', parameters: { type: 'object', properties: {} }, run: () => (ran.push(1), 'done') })
  const script = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tv_zz_test', arguments: '{}' } }] },
    { role: 'assistant', content: 'סגור' },
  ]
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() || { role: 'assistant', content: 'סוף' } }] }) }
  }
  resetHistory()
  const reply = await runTurn('מה נשמע?', { source: 'whatsapp', confirm: async () => true })
  ok(!sent[0].tools.some((t) => t.function.name === 'tv_zz_test'), 'the TV tool was not sent for small talk')
  ok(ran.length === 1 && reply === 'סגור', 'but it ran when the model called it by name')
  ok(sent[1].tools.some((t) => t.function.name === 'tv_zz_test'), 'and its domain stays open for the rest of the turn')
}

console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
