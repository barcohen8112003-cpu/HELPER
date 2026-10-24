// Read-only JSON API + page for the toolkit dashboard. Mounted by ui.js (see INTEGRATION.md).
//   handleDashboard(req, res, url, isSignedIn) -> true when the request was ours (and has been answered).
// Auth: this module does not invent its own. ui.js passes its own `signedIn(req)` check; with no check, or a check
// that says no, every /dash request is refused (fail closed).
import fs from 'node:fs'
import { auditStats, searchAudit } from '../audit.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { state } from '../store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(here, 'dashboard.html')

// ---------- small pure helpers (exported for the self-test) ----------

export const pad = (n) => String(n).padStart(2, '0')
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
export const dayNum = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000)
export const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
export const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p
const arr = (v) => (Array.isArray(v) ? v : [])
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const text = (v, max = 2000) => (v === undefined || v === null ? '' : String(v).slice(0, max))
const bucket = (name, fallback) => {
  const tk = state && state.toolkit
  const v = tk && tk[name]
  return v === undefined || v === null ? fallback : v
}

export function streakOf(dates, today) {
  const set = new Set(arr(dates))
  let d = set.has(today) ? today : addDays(today, -1)
  let n = 0
  while (set.has(d)) {
    n++
    d = addDays(d, -1)
  }
  return n
}

export function bestStreak(dates) {
  const days = [...new Set(arr(dates).filter(isDay))].sort()
  let best = 0
  let run = 0
  let prev = null
  for (const d of days) {
    run = prev && dayNum(d) - dayNum(prev) === 1 ? run + 1 : 1
    if (run > best) best = run
    prev = d
  }
  return best
}

export const pct = (current, target) => {
  const c = num(current)
  const t = num(target)
  if (t <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((c / t) * 100)))
}

function tagList(t) {
  if (Array.isArray(t)) return t.map((x) => text(x, 40).trim()).filter(Boolean)
  return String(t || '').split(',').map((x) => x.trim().slice(0, 40)).filter(Boolean)
}

// ---------- data views ----------

export function habitsView(today = localDate()) {
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6))
  return arr(bucket('life_habits', [])).map((h) => {
    const dates = arr(h.dates).filter(isDay)
    return {
      id: h.id,
      name: text(h.name, 200),
      streak: streakOf(dates, today),
      best: bestStreak(dates),
      total: dates.length,
      doneToday: dates.includes(today),
      week: week.map((d) => ({ date: d, done: dates.includes(d) })),
    }
  })
}

export function expensesView(month, category) {
  const m = isMonth(month) ? month : localDate().slice(0, 7)
  let rows = arr(bucket('life_expenses', [])).filter((x) => typeof x.date === 'string' && x.date.startsWith(m))
  const catOf = (x) => text(x.category, 50) || 'כללי'
  const byCat = {}
  for (const x of rows) byCat[catOf(x)] = round((byCat[catOf(x)] || 0) + num(x.amount))
  if (category) rows = rows.filter((x) => catOf(x) === category)
  rows = rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || num(b.id) - num(a.id))
  const categories = Object.entries(byCat)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
  return {
    month: m,
    total: round(categories.reduce((s, c) => s + c.total, 0)),
    count: rows.length,
    categories,
    rows: rows.slice(0, 500).map((x) => ({ id: x.id, date: text(x.date, 10), amount: num(x.amount), category: catOf(x), note: text(x.note, 300) })),
  }
}

export function expenseMonths() {
  const set = new Set(arr(bucket('life_expenses', [])).map((x) => String(x.date || '').slice(0, 7)).filter(isMonth))
  set.add(localDate().slice(0, 7))
  return [...set].sort().reverse()
}

export function notesView(query = '', tag = '', limit = 200) {
  const q = String(query).trim().toLowerCase()
  const t = String(tag).trim().toLowerCase()
  const all = arr(bucket('life_notes', []))
  const tags = {}
  for (const n of all) for (const x of tagList(n.tags)) tags[x] = (tags[x] || 0) + 1
  let rows = all.filter((n) => {
    if (t && !tagList(n.tags).map((x) => x.toLowerCase()).includes(t)) return false
    if (q && !`${text(n.text)} ${tagList(n.tags).join(' ')}`.toLowerCase().includes(q)) return false
    return true
  })
  rows = rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || num(b.id) - num(a.id))
  return {
    total: all.length,
    matched: rows.length,
    tags: Object.entries(tags).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    rows: rows.slice(0, limit).map((n) => ({ id: n.id, date: text(n.date, 10), text: text(n.text), tags: tagList(n.tags) })),
  }
}

export function shoppingView() {
  const items = arr(bucket('life_shopping', [])).map((x) => ({ id: x.id, name: text(x.name, 200), quantity: text(x.quantity, 50), checked: !!x.checked }))
  return { items, open: items.filter((x) => !x.checked).length, done: items.filter((x) => x.checked).length }
}

export function listsView() {
  const by = {}
  for (const x of arr(bucket('life_lists', []))) {
    const name = text(x.list, 100) || 'כללי'
    ;(by[name] ||= []).push({ id: x.id, text: text(x.text, 300), done: !!x.done })
  }
  return Object.entries(by).map(([name, items]) => ({ name, items, open: items.filter((i) => !i.done).length }))
}

export function goalsView() {
  const goals = arr(bucket('life_goals', [])).map((g) => ({ id: g.id, name: text(g.name, 200), unit: text(g.unit, 30), current: num(g.current), target: num(g.target), percent: pct(g.current, g.target) }))
  const okrs = arr(bucket('plan_okr', [])).map((o) => {
    const krs = arr(o.krs).map((k) => ({ id: k.id, title: text(k.title, 200), current: num(k.current), target: num(k.target), percent: pct(k.current, k.target) }))
    return { id: o.id, title: text(o.title, 200), krs, percent: krs.length ? Math.round(krs.reduce((s, k) => s + k.percent, 0) / krs.length) : 0 }
  })
  return { goals, okrs }
}

export function examsView(today = localDate()) {
  return arr(bucket('study_exams', []))
    .filter((e) => isDay(e.date))
    .map((e) => ({ id: e.id, name: text(e.name, 120), date: e.date, daysLeft: dayNum(e.date) - dayNum(today) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
}

export function countdownsView(today = localDate()) {
  return arr(bucket('plan_countdowns', []))
    .filter((c) => isDay(c.date))
    .map((c) => ({ id: c.id, label: text(c.label, 120), date: c.date, daysLeft: dayNum(c.date) - dayNum(today) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
}

export function overviewView(today = localDate()) {
  const habits = habitsView(today)
  const month = expensesView(today.slice(0, 7))
  const upcomingExams = examsView(today).filter((e) => e.daysLeft >= 0)
  const upcomingCountdowns = countdownsView(today).filter((c) => c.daysLeft >= 0)
  const shop = shoppingView()
  const g = goalsView()
  return {
    today,
    counts: {
      notes: arr(bucket('life_notes', [])).length,
      habits: habits.length,
      shoppingOpen: shop.open,
      goals: g.goals.length,
      exams: upcomingExams.length,
      countdowns: upcomingCountdowns.length,
      expensesThisMonth: month.count,
    },
    monthTotal: month.total,
    month: month.month,
    topHabits: habits.slice().sort((a, b) => b.streak - a.streak).slice(0, 5).map((h) => ({ name: h.name, streak: h.streak, doneToday: h.doneToday })),
    nextExams: upcomingExams.slice(0, 3),
    nextCountdowns: upcomingCountdowns.slice(0, 3),
    topCategories: month.categories.slice(0, 5),
    goals: g.goals.slice(0, 4),
  }
}

let registryPromise
const registry = () => (registryPromise ||= import('../toolkit/registry.js'))

export async function toolsView(query = '') {
  let reg
  try {
    reg = await registry()
  } catch (e) {
    return { total: 0, groups: [], error: text(e.message, 200) }
  }
  const q = String(query).trim().toLowerCase()
  const groups = reg.categories
    .map((c) => {
      const tools = reg.extendedTools
        .filter((t) => t.category === c.category)
        .filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q))
        .map((t) => ({ name: t.name, description: text(t.description, 400), write: t.risk === 'write', network: !!t.network, params: Object.keys(t.parameters?.properties || {}) }))
      return { category: c.category, blurb: c.blurb, count: tools.length, tools }
    })
    .filter((g) => g.tools.length)
  return { total: groups.reduce((s, g) => s + g.count, 0), groups }
}

// ---------- HTTP ----------

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Everything is inline and same-origin: no CDN, no fonts, no outside requests.
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function reply(res, status, body, type) {
  const json = type === undefined
  res.writeHead(status, { ...HEADERS, 'Content-Type': json ? 'application/json; charset=utf-8' : type })
  res.end(json ? JSON.stringify(body) : body)
}

const ROUTES = {
  overview: () => overviewView(),
  habits: () => ({ today: localDate(), habits: habitsView() }),
  expenses: (p) => ({ ...expensesView(p.get('month'), p.get('category')), months: expenseMonths() }),
  notes: (p) => notesView(p.get('q') || '', p.get('tag') || ''),
  shopping: () => ({ ...shoppingView(), lists: listsView() }),
  goals: () => goalsView(),
  exams: () => ({ exams: examsView(), countdowns: countdownsView() }),
  tools: (p) => toolsView(p.get('q') || ''),
  audit: (p) => ({ stats: auditStats(7), rows: searchAudit({ q: p.get('q') || '', tool: p.get('tool') || '', approval: p.get('approval') || '', source: p.get('source') || '', limit: 80 }) }),
}

export const routeNames = Object.keys(ROUTES)

export async function handleDashboard(req, res, url, isSignedIn) {
  const p = url.pathname
  if (p !== '/dash' && !p.startsWith('/dash/')) return false
  try {
    if (typeof isSignedIn !== 'function' || !isSignedIn(req)) {
      reply(res, 403, { error: 'לא מחובר' })
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(res, 405, { error: 'קריאה בלבד' })
      return true
    }
    if (p === '/dash' || p === '/dash/') {
      reply(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8')
      return true
    }
    const m = /^\/dash\/api\/([a-z]+)$/.exec(p)
    const route = m && Object.hasOwn(ROUTES, m[1]) ? ROUTES[m[1]] : null
    if (!route) {
      reply(res, 404, { error: 'לא נמצא' })
      return true
    }
    reply(res, 200, await route(url.searchParams))
  } catch (e) {
    reply(res, 500, { error: text(e.message, 200) })
  }
  return true
}
