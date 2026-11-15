// The parts of the acceptance test (npm run accept:real) that need no model: reading tasks.yml, the checks,
// masking evidence, and the network guard with its fixture pages. scripts/accept-selftest.mjs tests all of it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES = path.join(ROOT, 'accept', 'fixtures')
export const FIXTURE_HOST = 'accept.fixtures.test'
export const MODES = ['auto', 'live', 'manual']

// ── tasks.yml: a small YAML subset ───────────────────────────────────────────
// Maps, lists (block style, or [a, b] inline), "double" and 'single' quoted strings, plain strings, numbers,
// true/false/null. Whole-line comments only. Enough for tasks.yml, and an error with a line number otherwise.
export function parseYaml(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((raw, n) => ({ n: n + 1, indent: raw.search(/\S/), body: raw.trim() }))
    .filter((l) => l.body && !l.body.startsWith('#'))
  for (const l of lines) if (/^\t/.test(l.body) || l.indent < 0) throw new Error(`tasks.yml line ${l.n}: tabs are not allowed`)
  let i = 0
  const isItem = (l) => l.body === '-' || l.body.startsWith('- ')
  const fail = (l, why) => {
    throw new Error(`tasks.yml line ${l.n}: ${why}`)
  }

  function block(indent) {
    return isItem(lines[i]) ? list(indent) : map(indent)
  }
  function list(indent) {
    const out = []
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const l = lines[i]
      const rest = l.body.slice(1).trim()
      if (!rest) {
        i++
        if (i >= lines.length || lines[i].indent <= indent) fail(l, 'empty list item')
        out.push(block(lines[i].indent))
      } else if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
        // "- key: value" starts a map whose other keys sit two columns in.
        lines[i] = { ...l, indent: indent + 2, body: rest }
        out.push(map(indent + 2))
      } else {
        out.push(scalar(rest, l))
        i++
      }
    }
    return out
  }
  function map(indent) {
    const out = {}
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const l = lines[i]
      const m = l.body.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/)
      if (!m) fail(l, 'expected "key: value"')
      if (Object.hasOwn(out, m[1])) fail(l, `"${m[1]}" appears twice`)
      i++
      if (m[2] !== undefined && m[2] !== '') out[m[1]] = scalar(m[2], l)
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i])))) out[m[1]] = block(lines[i].indent)
      else out[m[1]] = null
    }
    if (i < lines.length && lines[i].indent > indent) fail(lines[i], 'unexpected indentation')
    return out
  }
  function scalar(s, l) {
    if (s.startsWith('"')) {
      if (!s.endsWith('"') || s.length < 2) fail(l, 'unclosed "')
      try {
        return JSON.parse(s)
      } catch {
        fail(l, 'bad escape in "..."')
      }
    }
    if (s.startsWith("'")) {
      if (!s.endsWith("'") || s.length < 2) fail(l, "unclosed '")
      return s.slice(1, -1).replace(/''/g, "'")
    }
    if (s.startsWith('[')) {
      if (!s.endsWith(']')) fail(l, 'unclosed [')
      const inner = s.slice(1, -1).trim()
      return inner ? inner.split(',').map((x) => scalar(x.trim(), l)) : []
    }
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null' || s === '~') return null
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
    return s
  }

  if (!lines.length) return {}
  const doc = block(lines[0].indent)
  if (i < lines.length) fail(lines[i], 'unexpected indentation')
  return doc
}

// Reads and checks tasks.yml. Every check named in it must exist, so a typo fails here and not as a quiet pass.
export function loadTasks(file = path.join(ROOT, 'tasks.yml')) {
  const doc = parseYaml(fs.readFileSync(file, 'utf8'))
  const tasks = doc.tasks
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks.yml: no tasks')
  const ids = new Set()
  for (const t of tasks) {
    const where = `tasks.yml task ${t.id ?? '?'}`
    if (!Number.isInteger(t.id)) throw new Error(`${where}: id must be a whole number`)
    if (ids.has(t.id)) throw new Error(`${where}: id appears twice`)
    ids.add(t.id)
    if (!MODES.includes(t.mode)) throw new Error(`${where}: mode must be one of ${MODES.join(', ')}`)
    if (!t.title || !t.pass_when) throw new Error(`${where}: needs title and pass_when`)
    t.steps ??= []
    if (t.mode !== 'manual' && !t.steps.length) throw new Error(`${where}: an ${t.mode} task needs steps`)
    for (const s of t.steps) {
      if (!s || typeof s !== 'object') throw new Error(`${where}: a step must be a map`)
      if (!s.say && !s.new_conversation) throw new Error(`${where}: a step needs "say" or "new_conversation"`)
      if (s.confirm && !['approve', 'deny'].includes(s.confirm)) throw new Error(`${where}: confirm is approve or deny`)
      for (const name of Object.keys(s.expect || {})) if (!CHECKS[checkName(name)]) throw new Error(`${where}: unknown check "${name}"`)
    }
    for (const k of Object.keys(t.seed || {})) if (!SEEDS.includes(k)) throw new Error(`${where}: unknown seed "${k}"`)
  }
  return tasks
}

// ── evidence ─────────────────────────────────────────────────────────────────
// Reports never hold a phone number, an email address, a long number (card, ID, code) or a whole private message.
export function mask(text, max = 280) {
  let s = String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '•••@•••')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '•••')
    .replace(/\b(sk|pk|ghp|xox[bp])[-_][\w-]{8,}/gi, '•••')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}

// ── checks ───────────────────────────────────────────────────────────────────
// Each takes (expected, world) and returns true, or a short reason it failed. The world is what the step left:
// world.reply (last answer), world.cards (approval questions in this step), world.sent (messages to synthetic
// recipients so far), world.reacted, world.jobs (background tasks started), world.state (Helper's store),
// world.audit (audit records), world.before (the store as it was when the task started).
const re = (v) => new RegExp(v, 'iu')
const lineCount = (s) => String(s || '').trim().split('\n').filter((x) => x.trim()).length
export const checkName = (key) => key.replace(/_\d+$/, '')

function localParts(d) {
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }
}
// "tomorrow 08:00" or "today 18:30" or "2026-11-02 08:00", in the process time zone (config sets TIMEZONE).
export function wantedTime(spec, now = new Date()) {
  const m = String(spec).match(/^(today|tomorrow|\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`bad time "${spec}"`)
  const day = m[1] === 'today' || m[1] === 'tomorrow' ? new Date(now) : new Date(`${m[1]}T00:00`)
  if (m[1] === 'tomorrow') day.setDate(day.getDate() + 1)
  return { ...localParts(day), h: Number(m[2]), mi: Number(m[3]) }
}

const watchingCount = (w) => (w.state.tasks?.length || 0) + (w.state.watchers?.length || 0) + w.jobs.filter((j) => !j.cancelled).length

export const CHECKS = {
  reply_matches: (v, w) => re(v).test(w.reply) || `the answer does not match /${v}/`,
  reply_not_matches: (v, w) => !re(v).test(w.reply) || `the answer matches /${v}/, which it should not`,
  reply_max_lines: (v, w) => lineCount(w.reply) <= v || `the answer has ${lineCount(w.reply)} lines, more than ${v}`,
  memory_has: (v, w) => w.state.memory.some((m) => re(v).test(m.fact)) || `no saved memory matches /${v}/`,
  memory_lacks: (v, w) => !w.state.memory.some((m) => re(v).test(m.fact)) || `a saved memory matches /${v}/`,
  pending_has: (v, w) => (w.state.memoryCandidates || []).some((m) => re(v).test(m.fact)) || `no memory waiting for approval matches /${v}/`,
  pending_lacks: (v, w) => !(w.state.memoryCandidates || []).some((m) => re(v).test(m.fact)) || `a memory waiting for approval still matches /${v}/`,
  reminder_matches: (v, w) => w.state.reminders.some((r) => re(v).test(r.text)) || `no reminder matches /${v}/`,
  reminders_lack: (v, w) => !w.state.reminders.some((r) => re(v).test(r.text)) || `a reminder matching /${v}/ is still set`,
  reminder_at: (v, w) => {
    const want = wantedTime(v, w.now)
    const hit = w.state.reminders.some((r) => {
      const got = localParts(new Date(r.at))
      return Object.keys(want).every((k) => got[k] === want[k])
    })
    return hit || `no reminder at ${v} (set: ${w.state.reminders.map((r) => new Date(r.at).toLocaleString('he-IL')).join(', ') || 'none'})`
  },
  reminders_untouched: (v, w) => {
    const same = JSON.stringify(w.state.reminders) === JSON.stringify(w.before.reminders) && JSON.stringify(w.state.memory) === JSON.stringify(w.before.memory)
    return same === Boolean(v) || (v ? 'reminders or memory were changed' : 'reminders and memory were not changed')
  },
  card_matches: (v, w) => w.cards.some((c) => re(v).test(c)) || (w.cards.length ? `no approval card matches /${v}/` : 'no approval card was shown'),
  no_card: (v, w) => (w.cards.length === 0) === Boolean(v) || (v ? `an approval card was shown: ${mask(w.cards[0], 120)}` : 'no approval card was shown'),
  sent_count: (v, w) => w.sent.length === v || `${w.sent.length} message(s) sent in his name, expected ${v}`,
  reacted: (v, w) => w.reacted.length > 0 === Boolean(v) || (v ? 'no reaction was put on the message' : 'a reaction was put on the message'),
  watching: (v, w) => (watchingCount(w) > 0) === Boolean(v) || (v ? 'no scheduled task, watch or background task was created' : `${watchingCount(w)} scheduled task(s) or watch(es) are still active`),
  audit_has: (v, w) => {
    const [tool, outcome] = String(v).split(':')
    const hit = w.audit.some((a) => a.tool === tool && (!outcome || (outcome === 'ok' ? a.ok : outcome === 'failed' ? !a.ok : a.approval === outcome)))
    return hit || `the audit log has no ${v}`
  },
}

export function runChecks(expect, world) {
  const failures = []
  for (const [key, value] of Object.entries(expect || {})) {
    let r
    try {
      r = CHECKS[checkName(key)](value, world)
    } catch (e) {
      r = `${key}: ${e.message}`
    }
    if (r !== true) failures.push(r)
  }
  return failures
}

export const SEEDS = ['candidate', 'reminder']

// ── network guard ────────────────────────────────────────────────────────────
// In the default (auto) run the only real network is the model provider. Pages on accept.fixtures.test come from
// accept/fixtures. Everything else fails like a dead connection, so no test can reach a real site or person.
export function fixtureResponse(url, now = Date.now()) {
  const u = new URL(url)
  if (u.hostname !== FIXTURE_HOST) return null
  const name = path.basename(u.pathname === '/' ? '/index.html' : u.pathname)
  const map = { 'news.xml': 'application/rss+xml', 'login.html': 'text/html; charset=utf-8', 'injection.html': 'text/html; charset=utf-8' }
  const file = path.join(FIXTURES, name)
  if (!map[name] || !fs.existsSync(file)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  let body = fs.readFileSync(file, 'utf8')
  body = body.replace(/\{\{NOW-(\d+)\}\}/g, (_, min) => new Date(now - Number(min) * 60000).toUTCString())
  return new Response(body, { status: 200, headers: { 'content-type': map[name] } })
}

export function guardFetch({ allowHosts = [], live = false, realFetch = globalThis.fetch, blocked = [] } = {}) {
  const allow = new Set(allowHosts.filter(Boolean))
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      throw new TypeError(`bad url ${url}`)
    }
    const fixture = fixtureResponse(url)
    if (fixture) return fixture
    if (live || allow.has(host)) return realFetch(input, init)
    blocked.push(host)
    throw new TypeError(`fetch failed: ${host} is not reachable in the acceptance test (auto mode)`)
  }
}

export const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ── tools in the automatic run ───────────────────────────────────────────────
// The model still sees every tool, so its choices are real. In auto mode only these run for real; the rest answer
// that they are not available in the test. None of these touch a device, a browser, a process or a real account:
// sending goes to the synthetic adapter, and the network is guarded above.
export const AUTO_TOOLS = new Set([
  'remember', 'forget', 'add_reminder', 'list_reminders', 'cancel_reminder', 'schedule_task', 'list_tasks', 'cancel_task',
  'start_background_task', 'send_whatsapp', 'send_whatsapp_to', 'react', 'voice_mode', 'get_news', 'web_search', 'fetch_page',
  'add_watcher', 'list_watchers', 'remove_watcher', 'get_weather', 'get_jewish_calendar', 'get_currency_rate',
  'memory_search', 'memory_pending', 'memory_confirm', 'memory_reject', 'skill_search', 'audit_search', 'update_plan',
  'open_loop', 'tool_search',
])
// Live runs may also browse and compare, still stopping at every approval card.
export const LIVE_EXTRA_TOOLS = new Set(['run_errand', 'compare_prices', 'find_flights', 'flight_details', 'israel_transit', 'track_package'])
// An approval card that looks like money is always declined in a test run, whatever the step says.
export const MONEY = /₪|\$|€|ש"ח|שקל|לשלם|תשלום|להזמין|הזמנה|לקנות|רכישה|כרטיס אשראי|\bpay\b|\border\b|\bbook\b|checkout/i
