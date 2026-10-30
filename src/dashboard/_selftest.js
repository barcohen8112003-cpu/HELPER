// node src/dashboard/_selftest.js
// Checks the dashboard API views, the HTTP handler (auth, GET-only, routing, headers) and the page itself
// (static safety rules, plus a real run of the page script against a tiny fake DOM with hostile data).
// Starts no server, opens no port, never calls a model, and points HELPER_DATA_DIR at a temp folder.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-dash-'))
const here = path.dirname(fileURLToPath(import.meta.url))

let failed = 0
let passed = 0
function ok(cond, msg) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${msg}`)
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
async function section(name, fn) {
  try {
    await fn()
  } catch (e) {
    failed++
    console.log(`FAIL  ${name} threw: ${e.stack || e.message}`)
  }
}

const api = await import('./api.js')
const { state } = await import('../store.js')
const audit = await import('../audit.js')

const EVIL = '<img src=x onerror=alert(1)>'
// The activity log page shows what tools were given, so it gets the hostile string too.
audit.record({ tool: `send_${EVIL}`, args: { text: EVIL }, source: 'whatsapp', approval: 'approved', ok: true, result: EVIL })
audit.record({ tool: 'gmail_read', args: { id: '1' }, source: 'task', ok: false, error: EVIL, result: 'x' })
const today = api.localDate()
const month = today.slice(0, 7)
const day = (n) => api.addDays(today, n)

// ---------- seed ----------
state.toolkit = {
  life_habits: [
    { id: 1, name: 'ריצה', dates: [day(0), day(-1), day(-2), day(-5)] },
    { id: 2, name: 'קריאה', dates: [day(-1), day(-2)] },
    { id: 3, name: EVIL, dates: [] },
    { id: 4, name: 'שבור', dates: ['not-a-date', null, day(0)] },
  ],
  life_expenses: [
    { id: 10, amount: 50, category: 'אוכל', note: 'פיצה', date: `${month}-01` },
    { id: 11, amount: 25.5, category: 'אוכל', note: '', date: `${month}-02` },
    { id: 12, amount: 100, category: 'תחבורה', note: EVIL, date: `${month}-03` },
    { id: 13, amount: 999, category: 'אחר', note: 'חודש קודם', date: '2020-01-05' },
    { id: 14, amount: 'x', category: '', note: 'סכום שבור', date: `${month}-04` },
  ],
  life_notes: [
    { id: 20, text: 'רעיון לפרויקט חדש', tags: 'work, idea', date: '2026-03-01' },
    { id: 21, text: 'לקנות מתנה', tags: 'home', date: '2026-03-05' },
    { id: 22, text: EVIL, tags: ['xss'], date: '2026-03-06' },
  ],
  life_shopping: [
    { id: 30, name: 'חלב', quantity: '2', checked: false },
    { id: 31, name: 'לחם', quantity: '', checked: true },
    { id: 32, name: EVIL, quantity: '', checked: false },
  ],
  life_lists: [
    { id: 40, list: 'עבודה', text: 'לשלוח דוח', done: false },
    { id: 41, list: 'עבודה', text: 'לסגור באג', done: true },
  ],
  life_goals: [
    { id: 50, name: 'חיסכון', target: 1000, current: 250, unit: 'ש"ח' },
    { id: 51, name: 'מרוץ', target: 10, current: 15, unit: 'ק"מ' },
    { id: 52, name: 'אפס', target: 0, current: 5, unit: '' },
  ],
  plan_okr: [{ id: 1, title: 'שנה טובה', krs: [{ id: 1, title: 'ספר', target: 4, current: 2 }, { id: 2, title: 'ריצה', target: 10, current: 10 }] }],
  study_exams: [
    { id: 60, name: 'מתמטיקה', date: day(5) },
    { id: 61, name: 'עבר', date: day(-3) },
    { id: 62, name: 'פיזיקה', date: day(1) },
    { id: 63, name: 'תאריך שבור', date: 'soon' },
  ],
  plan_countdowns: [
    { id: 1, label: 'טיול', date: day(30) },
    { id: 2, label: 'היום', date: day(0) },
  ],
}

// ---------- helpers ----------
await section('date helpers', () => {
  ok(api.isDay('2026-02-28') && !api.isDay('2026-02-30') && !api.isDay('26-1-1') && !api.isDay(null), 'isDay')
  ok(api.isMonth('2026-12') && !api.isMonth('2026-13') && !api.isMonth('2026-1') && !api.isMonth(undefined), 'isMonth')
  eq(api.addDays('2026-02-28', 1), '2026-03-01', 'addDays crosses month')
  eq(api.addDays('2024-02-28', 1), '2024-02-29', 'addDays leap year')
  eq(api.addDays('2026-01-01', -1), '2025-12-31', 'addDays backwards')
  eq(api.dayNum('2026-01-02') - api.dayNum('2026-01-01'), 1, 'dayNum diff')
  eq(api.round(1.005 * 100, 0), 100, 'round')
  eq(api.pad(5), '05', 'pad')
})

await section('streaks', () => {
  eq(api.streakOf([day(0), day(-1), day(-2)], today), 3, 'streak through today')
  eq(api.streakOf([day(-1), day(-2)], today), 2, 'streak alive if yesterday done')
  eq(api.streakOf([day(-2)], today), 0, 'streak broken')
  eq(api.streakOf([], today), 0, 'empty streak')
  eq(api.streakOf(undefined, today), 0, 'undefined dates')
  eq(api.bestStreak(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-10', '2026-01-11']), 3, 'best streak')
  eq(api.bestStreak(['2026-01-01', '2026-01-01']), 1, 'duplicates ignored')
  eq(api.bestStreak([]), 0, 'best of nothing')
  eq(api.bestStreak(['junk']), 0, 'best ignores junk')
})

await section('pct', () => {
  eq(api.pct(25, 100), 25, 'pct simple')
  eq(api.pct(15, 10), 100, 'pct capped')
  eq(api.pct(5, 0), 0, 'pct zero target')
  eq(api.pct(-5, 10), 0, 'pct negative')
  eq(api.pct('a', 10), 0, 'pct junk')
})

// ---------- views ----------
await section('habits view', () => {
  const hs = api.habitsView(today)
  eq(hs.length, 4, 'habit count')
  const run = hs.find((x) => x.id === 1)
  eq(run.streak, 3, 'run streak')
  eq(run.best, 3, 'run best')
  eq(run.total, 4, 'run total')
  ok(run.doneToday, 'run done today')
  eq(run.week.length, 7, 'week length')
  eq(run.week[6].date, today, 'week ends today')
  eq(run.week.filter((w) => w.done).length, 4, 'week done count')
  const read = hs.find((x) => x.id === 2)
  ok(!read.doneToday && read.streak === 2, 'reading streak alive')
  const bad = hs.find((x) => x.id === 4)
  eq(bad.total, 1, 'invalid dates dropped')
})

await section('expenses view', () => {
  const e = api.expensesView(month)
  eq(e.total, 175.5, 'month total')
  eq(e.count, 4, 'month rows')
  eq(e.categories[0], { name: 'תחבורה', total: 100 }, 'top category')
  eq(e.categories.map((c) => c.name).sort(), ['אוכל', 'תחבורה', 'כללי'].sort(), 'category names with default')
  ok(e.rows[0].date >= e.rows[e.rows.length - 1].date, 'rows newest first')
  const f = api.expensesView(month, 'אוכל')
  eq(f.count, 2, 'filtered rows')
  eq(f.total, 175.5, 'filter keeps month totals for the chart')
  const old = api.expensesView('2020-01')
  eq(old.total, 999, 'old month total')
  const bogus = api.expensesView('nonsense')
  eq(bogus.month, month, 'bad month falls back to current')
  const none = api.expensesView('1999-01')
  eq([none.total, none.count, none.categories.length], [0, 0, 0], 'empty month')
  const months = api.expenseMonths()
  ok(months.includes(month) && months.includes('2020-01'), 'months listed')
  ok(months[0] >= months[months.length - 1], 'months newest first')
})

await section('notes view', () => {
  eq(api.notesView().total, 3, 'notes total')
  eq(api.notesView('פרויקט').matched, 1, 'search by text')
  eq(api.notesView('IDEA').matched, 1, 'search matches tags, case-insensitive')
  eq(api.notesView('', 'home').matched, 1, 'tag filter')
  eq(api.notesView('', 'HOME').matched, 1, 'tag filter case-insensitive')
  eq(api.notesView('פרויקט', 'home').matched, 0, 'query and tag combine')
  eq(api.notesView('zzzz').matched, 0, 'no match')
  const all = api.notesView()
  eq(all.rows[0].id, 22, 'newest note first')
  eq(all.rows.find((n) => n.id === 20).tags, ['work', 'idea'], 'tag string split')
  eq(all.rows.find((n) => n.id === 22).tags, ['xss'], 'tag array kept')
  ok(all.tags.length === 4, 'tag counts')
  eq(api.notesView('', '', 1).rows.length, 1, 'limit')
})

await section('shopping and lists', () => {
  const s = api.shoppingView()
  eq([s.open, s.done, s.items.length], [2, 1, 3], 'shopping counts')
  const l = api.listsView()
  eq(l.length, 1, 'one list')
  eq([l[0].name, l[0].open, l[0].items.length], ['עבודה', 1, 2], 'list content')
})

await section('goals', () => {
  const g = api.goalsView()
  eq(g.goals.map((x) => x.percent), [25, 100, 0], 'goal percents')
  eq(g.okrs[0].percent, 75, 'okr average')
  eq(g.okrs[0].krs.map((k) => k.percent), [50, 100], 'kr percents')
})

await section('exams and countdowns', () => {
  const e = api.examsView(today)
  eq(e.map((x) => x.name), ['עבר', 'פיזיקה', 'מתמטיקה'], 'exams sorted, broken date dropped')
  eq(e.map((x) => x.daysLeft), [-3, 1, 5], 'days left')
  const c = api.countdownsView(today)
  eq(c.map((x) => x.daysLeft), [0, 30], 'countdown days')
})

await section('overview', () => {
  const o = api.overviewView(today)
  eq(o.counts.notes, 3, 'notes count')
  eq(o.counts.habits, 4, 'habits count')
  eq(o.counts.exams, 2, 'only upcoming exams')
  eq(o.counts.countdowns, 2, 'countdowns')
  eq(o.counts.shoppingOpen, 2, 'shopping open')
  eq(o.monthTotal, 175.5, 'month total')
  eq(o.topHabits[0].name, 'ריצה', 'best streak first')
  eq(o.nextExams[0].name, 'פיזיקה', 'next exam')
  eq(o.nextCountdowns[0].label, 'היום', 'today countdown counted as upcoming')
  ok(o.topCategories.length <= 5 && o.goals.length <= 4, 'limits')
})

await section('empty state is safe', () => {
  const saved = state.toolkit
  state.toolkit = undefined
  const o = api.overviewView(today)
  eq(o.counts.notes, 0, 'no toolkit: notes')
  eq(api.habitsView(today), [], 'no toolkit: habits')
  eq(api.expensesView(month).total, 0, 'no toolkit: expenses')
  eq(api.notesView().rows, [], 'no toolkit: notes list')
  state.toolkit = { life_habits: 'garbage', life_notes: { a: 1 }, life_goals: null }
  eq(api.habitsView(today), [], 'garbage bucket: habits')
  eq(api.notesView().total, 0, 'garbage bucket: notes')
  eq(api.goalsView().goals, [], 'garbage bucket: goals')
  state.toolkit = saved
})

await section('tool catalog', async () => {
  const t = await api.toolsView()
  ok(t.total > 0 && t.groups.length > 0, `catalog is not empty (${t.total} tools, error=${t.error || 'none'})`)
  ok(t.groups.every((g) => g.category && g.tools.every((x) => /^[a-z][a-z0-9_]*$/.test(x.name) && x.description)), 'tools have names and descriptions')
  ok(t.groups.some((g) => g.category === 'life'), 'life category present')
  const life = t.groups.find((g) => g.category === 'life')
  ok(life && life.tools.some((x) => x.name === 'life_note_add'), 'life_note_add listed')
  ok(Array.isArray(life.tools[0].params), 'params listed')
  const q = await api.toolsView('life_note')
  ok(q.total > 0 && q.total < t.total, 'search narrows the catalog')
  ok(q.groups.every((g) => g.tools.every((x) => `${x.name} ${x.description}`.toLowerCase().includes('life_note'))), 'search results all match')
  eq((await api.toolsView('zzzzqqqq')).total, 0, 'search with no match')
})

// ---------- HTTP handler (fake req/res, nothing listens) ----------
function fakeRes() {
  const r = new EventEmitter()
  r.status = 0
  r.headers = {}
  r.body = ''
  r.writeHead = (s, h) => {
    r.status = s
    r.headers = h
  }
  r.end = (b) => {
    r.body = b ?? ''
  }
  r.json = () => JSON.parse(r.body)
  return r
}
const call = async (method, pathname, search = '', signed = true, passFn = true) => {
  const res = fakeRes()
  const url = new URL(`http://127.0.0.1:3210${pathname}${search}`)
  const handled = await api.handleDashboard({ method, headers: {} }, res, url, passFn ? () => signed : undefined)
  return { handled, res }
}

await section('http routing and auth', async () => {
  let r = await call('GET', '/api/state')
  ok(r.handled === false && r.res.status === 0, 'foreign path is not handled')
  r = await call('GET', '/dashboard')
  ok(r.handled === false, '/dashboard (no slash) is not ours')
  r = await call('GET', '/dash/api/overview', '', false)
  ok(r.handled && r.res.status === 403, 'signed-out gets 403')
  r = await call('GET', '/dash/api/overview', '', true, false)
  ok(r.handled && r.res.status === 403, 'no auth function fails closed')
  r = await call('GET', '/dash', '', false)
  ok(r.handled && r.res.status === 403, 'page needs auth too')
  r = await call('GET', '/dash/api/nope')
  ok(r.handled && r.res.status === 404, 'unknown api 404')
  r = await call('GET', '/dash/api/constructor')
  ok(r.handled && r.res.status === 404, 'prototype names are not routes')
  r = await call('GET', '/dash/api/__proto__')
  ok(r.handled && r.res.status === 404, '__proto__ is not a route')
  r = await call('GET', '/dash/other')
  ok(r.handled && r.res.status === 404, 'unknown dash path 404')
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    r = await call(m, '/dash/api/notes')
    ok(r.handled && r.res.status === 405, `${m} refused with 405`)
  }
  r = await call('POST', '/dash/api/notes', '', false)
  ok(r.res.status === 403, 'auth is checked before method')
})

await section('http responses', async () => {
  for (const name of api.routeNames) {
    const r = await call('GET', `/dash/api/${name}`)
    ok(r.handled && r.res.status === 200, `${name}: 200`)
    ok(/application\/json/.test(r.res.headers['Content-Type']), `${name}: json content type`)
    ok(r.res.headers['Cache-Control'] === 'no-store', `${name}: no-store`)
    let body = null
    try {
      body = r.res.json()
    } catch {
      /* reported below */
    }
    ok(body && typeof body === 'object', `${name}: valid json`)
  }
  let r = await call('GET', '/dash/api/expenses', `?month=${month}&category=${encodeURIComponent('אוכל')}`)
  eq(r.res.json().count, 2, 'expenses query params')
  ok(r.res.json().months.includes(month), 'expenses lists months')
  r = await call('GET', '/dash/api/notes', `?q=${encodeURIComponent('פרויקט')}`)
  eq(r.res.json().matched, 1, 'notes query param')
  r = await call('GET', '/dash/api/notes', `?q=${encodeURIComponent('%')}&tag=${'x'.repeat(5000)}`)
  eq(r.res.status, 200, 'hostile query is fine')
  r = await call('GET', '/dash/api/habits')
  eq(r.res.json().habits.length, 4, 'habits endpoint')
  r = await call('GET', '/dash/api/shopping')
  ok(r.res.json().lists.length === 1, 'shopping includes lists')
  r = await call('GET', '/dash/api/exams')
  ok(Array.isArray(r.res.json().exams) && Array.isArray(r.res.json().countdowns), 'exams endpoint')
  r = await call('HEAD', '/dash/api/overview')
  eq(r.res.status, 200, 'HEAD allowed')
  r = await call('GET', '/dash')
  ok(r.res.status === 200 && /text\/html/.test(r.res.headers['Content-Type']), 'page served')
  ok(r.res.body.includes('<title>'), 'page body present')
  r = await call('GET', '/dash/')
  eq(r.res.status, 200, 'trailing slash page')
  const csp = r.res.headers['Content-Security-Policy']
  ok(/default-src 'none'/.test(csp) && /connect-src 'self'/.test(csp) && !/https?:/.test(csp), 'CSP locks everything down')
  ok(r.res.headers['X-Frame-Options'] === 'DENY' && r.res.headers['X-Content-Type-Options'] === 'nosniff', 'framing and sniffing headers')
})

// ---------- the page: static rules ----------
const html = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8')
const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''

await section('page static rules', () => {
  ok(script.length > 1000, 'script found')
  ok(/<html[^>]*dir="rtl"/.test(html) && /lang="he"/.test(html), 'rtl hebrew document')
  ok(/name="viewport"/.test(html), 'viewport meta')
  ok(/@media \(max-width/.test(html), 'responsive rules')
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(script), 'no HTML-string sinks, no eval')
  ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'no external URLs (CDN, fonts)')
  ok(!/<link\b|@import|<script[^>]+src=|<img\b|<iframe/i.test(html), 'no external resources or embeds')
  ok(/const esc = /.test(script), 'esc() helper defined')
  ok(/function h\(/.test(script), 'h() builder defined')
  ok(!/\bXMLHttpRequest\b|WebSocket|sendBeacon/.test(script), 'no other network channels')
  ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)/i.test(script), 'dashboard only reads')
  const fetches = script.match(/fetch\(([^)]*)\)/g) || []
  ok(fetches.length === 1 && /\/dash\/api\//.test(fetches[0]), 'single same-origin fetch to /dash/api/')
  for (const p of ['overview', 'habits', 'expenses', 'notes', 'shopping', 'goals', 'tools', 'audit']) ok(new RegExp(`pages\\.${p} = `).test(script), `page ${p} defined`)
  ok(/<svg|sv\('svg'/.test(script) && /createElementNS/.test(script), 'inline SVG chart code')
  ok(!/<style[^>]*>[\s\S]*url\(/.test(html), 'no css url() loads')
})

await section('page script compiles', () => {
  new vm.Script(script, { filename: 'dashboard.html<script>' })
  ok(true, 'compiles')
})

// ---------- the page: run it against a tiny fake DOM ----------
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super()
    this.text = String(t)
  }
  serialize() {
    return this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
class FakeEl extends FakeNode {
  constructor(tag, ns) {
    super()
    this.tag = tag
    this.ns = ns
    this.attrs = {}
    this.children = []
    this.listeners = {}
    this.value = ''
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return this.attrs[k] ?? null
  }
  addEventListener(t, fn) {
    ;(this.listeners[t] ||= []).push(fn)
  }
  appendChild(c) {
    this.children.push(c)
    return c
  }
  append(...cs) {
    for (const c of cs) this.children.push(c instanceof FakeNode ? c : new FakeText(c))
  }
  replaceChildren(...cs) {
    this.children = []
    this.append(...cs)
  }
  set textContent(t) {
    this.children = [new FakeText(t)]
  }
  serialize() {
    const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`).join('')
    return `<${this.tag}${a}>${this.children.map((c) => c.serialize()).join('')}</${this.tag}>`
  }
  walk(fn) {
    fn(this)
    for (const c of this.children) if (c instanceof FakeEl) c.walk(fn)
  }
}

function makeBrowser(failFetch = false) {
  const els = { view: new FakeEl('main'), tabs: new FakeEl('nav'), stamp: new FakeEl('span'), refresh: new FakeEl('button') }
  const ids = { view: els.view, tabs: els.tabs, stamp: els.stamp, refresh: els.refresh }
  const location = { hash: '' }
  const calls = []
  const sandbox = {
    document: {
      title: '',
      createElement: (t) => new FakeEl(t),
      createElementNS: (ns, t) => new FakeEl(t, ns),
      createTextNode: (t) => new FakeText(t),
      getElementById: (id) => ids[id],
    },
    Node: FakeNode,
    location,
    window: { addEventListener() {} },
    URLSearchParams,
    Intl,
    Date,
    Object,
    String,
    Number,
    Array,
    Math,
    JSON,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: async (u) => {
      calls.push(u)
      if (failFetch) return { ok: false, status: 500, json: async () => ({ error: 'שרת נפל' }) }
      const url = new URL(u, 'http://127.0.0.1:3210')
      const res = fakeRes()
      await api.handleDashboard({ method: 'GET', headers: {} }, res, url, () => true)
      return { ok: res.status === 200, status: res.status, json: async () => JSON.parse(res.body) }
    },
    console,
  }
  vm.createContext(sandbox)
  return { sandbox, els, location, calls }
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

await section('page renders every tab with hostile data', async () => {
  for (const tab of ['overview', 'habits', 'expenses', 'notes', 'shopping', 'goals', 'tools', 'audit']) {
    const b = makeBrowser()
    b.location.hash = `#${tab}`
    new vm.Script(script).runInContext(b.sandbox)
    await tick(80)
    const out = b.els.view.serialize()
    ok(out.length > 200, `${tab}: rendered content (${out.length} chars)`)
    ok(!/class="err"/.test(out), `${tab}: no error shown`)
    ok(!out.includes(EVIL), `${tab}: hostile string never appears unescaped`)
    let injected = false
    b.els.view.walk((el) => {
      if (el.tag === 'img' || el.tag === 'script' || Object.keys(el.attrs).some((k) => /^on/i.test(k))) injected = true
    })
    ok(!injected, `${tab}: no injected elements or handlers`)
    ok(b.calls.every((u) => u.startsWith('/dash/api/')), `${tab}: only /dash/api/ requests`)
    ok(b.els.tabs.children.length === 8, `${tab}: eight tabs`)
    const current = b.els.tabs.children.filter((a) => a.attrs['aria-current'] === 'page')
    ok(current.length === 1 && current[0].attrs.href === `#${tab}`, `${tab}: current tab marked`)
    ok(b.els.stamp.children.length > 0, `${tab}: update stamp set`)
  }
})

await section('page content spot checks', async () => {
  const text = async (tab) => {
    const b = makeBrowser()
    b.location.hash = `#${tab}`
    new vm.Script(script).runInContext(b.sandbox)
    await tick(80)
    return b.els.view.serialize()
  }
  let out = await text('habits')
  ok(out.includes('ריצה') && out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'habits: names shown, evil escaped')
  ok((out.match(/class="on today"|class="on "/g) || []).length >= 1, 'habits: week cells marked done')
  out = await text('expenses')
  ok(out.includes('<svg') && out.includes('<rect'), 'expenses: SVG bar chart present')
  ok(out.includes('תחבורה') && out.includes('פיצה'), 'expenses: categories and rows')
  ok(out.includes('<table'), 'expenses: table present')
  out = await text('notes')
  ok(out.includes('רעיון לפרויקט חדש') && out.includes('#work'), 'notes: text and tags')
  out = await text('shopping')
  ok(out.includes('חלב') && out.includes('לשלוח דוח'), 'shopping: items and lists')
  out = await text('goals')
  ok(out.includes('role="progressbar"') && out.includes('width:25%'), 'goals: progress bars')
  ok(out.includes('שנה טובה') && out.includes('מתמטיקה'), 'goals: okr and exams')
  out = await text('tools')
  ok(out.includes('life_note_add') && out.includes('<details'), 'tools: catalog grouped')
  out = await text('overview')
  ok(out.includes('ריצה') && out.includes('פיזיקה'), 'overview: habits and exams')
  const b = makeBrowser()
  b.location.hash = '#bogus'
  new vm.Script(script).runInContext(b.sandbox)
  await tick(80)
  ok(b.els.view.serialize().includes('סקירה'), 'unknown hash falls back to overview')
})

await section('page shows API failures as text', async () => {
  const b = makeBrowser(true)
  b.location.hash = '#habits'
  new vm.Script(script).runInContext(b.sandbox)
  await tick(80)
  const out = b.els.view.serialize()
  ok(out.includes('class="err"') && out.includes('שרת נפל'), 'error message displayed')
})

await section('page helpers behave', async () => {
  const b = makeBrowser()
  b.location.hash = '#overview'
  new vm.Script(script).runInContext(b.sandbox)
  await tick(50)
  const run = (code) => vm.runInContext(code, b.sandbox)
  eq(run(`esc('<a href="x">&\\'\`')`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&#96;', 'esc escapes all dangerous characters')
  eq(run(`esc(null)`), '', 'esc null')
  eq(run(`esc(5)`), '5', 'esc number')
  eq(run(`fmtDate('2026-03-09')`), '09.03.2026', 'fmtDate')
  eq(run(`fmtDate('junk')`), 'junk', 'fmtDate junk passthrough')
  eq(run(`monthName('2026-03')`), 'מרץ 2026', 'monthName')
  eq(run(`daysText(0)`), 'היום', 'daysText today')
  eq(run(`daysText(1)`), 'מחר', 'daysText tomorrow')
  eq(run(`daysText(5)`), 'בעוד 5 ימים', 'daysText future')
  eq(run(`daysText(-3)`), 'לפני 3 ימים', 'daysText past')
  eq(run(`daysClass(2)`), 'bad', 'daysClass soon')
  eq(run(`daysClass(100)`), 'good', 'daysClass far')
  const el = run(`h('div', {class: 'x', onclick: 'alert(1)', 'bad attr': 1, href: 'javascript:alert(1)', style: 'x:url(javascript:1)'}, '<b>t</b>')`)
  const s = el.serialize()
  ok(s.includes('&lt;b&gt;t&lt;/b&gt;') && !s.includes('<b>'), 'h(): strings become text')
  ok(!/onclick|href|bad attr|style/.test(s), 'h(): unsafe attributes dropped')
  const chart = run(`barChartSvg([{name:'<x>', total: 5},{name:'y', total: 10}], fmtNum)`).serialize()
  ok(chart.includes('&lt;x&gt;') && !chart.includes('<x>'), 'chart labels are escaped')
  ok((chart.match(/<rect/g) || []).length === 2, 'one bar per item')
})

// ---------- integration doc ----------
await section('integration doc', () => {
  const doc = fs.readFileSync(path.join(here, 'INTEGRATION.md'), 'utf8')
  ok(doc.includes("import { handleDashboard } from './dashboard/api.js'"), 'doc has the import line')
  ok(doc.includes('handleDashboard(req, res, url, signedIn)'), 'doc passes ui.js signedIn')
})

fs.rmSync(process.env.HELPER_DATA_DIR, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `dashboard selftest: all ${passed} checks passed`)
process.exit(failed ? 1 : 0)
