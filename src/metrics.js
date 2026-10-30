// How fast Helper answers and how often it writes first, so both can be seen and improved. Kept in state, small:
// the last 300 turns and today's count of messages Helper sent on its own.
import { state, save } from './store.js'

const KEEP = 300
const DAY = 24 * 3600 * 1000

// How many non-urgent messages Helper may send on its own in one day. The rest wait for the next brief.
export const messageBudget = () => Math.max(1, Number(process.env.MESSAGE_BUDGET) || 6)

// process.env.TZ is set from TIMEZONE in config.js, so the local date is the user's date.
const today = () => new Date().toLocaleDateString('en-CA')

// { ms, tools, model }: one finished turn.
export function recordTurn(turn) {
  state.metrics ??= { turns: [], proactive: { day: '', count: 0 } }
  state.metrics.turns = [...state.metrics.turns, { at: Date.now(), ...turn }].slice(-KEEP)
  save()
}

// True when a non-urgent proactive message may still go out today; counts it when it does.
export function takeProactiveSlot() {
  state.metrics ??= { turns: [], proactive: { day: '', count: 0 } }
  const p = state.metrics.proactive
  if (p.day !== today()) Object.assign(p, { day: today(), count: 0 })
  if (p.count >= messageBudget()) return false
  p.count++
  save()
  return true
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)

export function metricsSummary(now = Date.now()) {
  const m = state.metrics || { turns: [], proactive: { day: '', count: 0 } }
  const recent = m.turns.filter((t) => now - t.at < DAY)
  const times = recent.map((t) => t.ms).sort((a, b) => a - b)
  return {
    turns24h: recent.length,
    p50: Math.round(pct(times, 0.5) / 100) / 10,
    p90: Math.round(pct(times, 0.9) / 100) / 10,
    avgTools: recent.length ? Math.round((recent.reduce((s, t) => s + (t.tools || 0), 0) / recent.length) * 10) / 10 : 0,
    proactiveToday: m.proactive?.day === today() ? m.proactive.count : 0,
    budget: messageBudget(),
    cost: costText(costSummary(), 'החודש'),
    costLimit: Number(process.env.MONTHLY_COST_LIMIT) || 0,
  }
}

// ---- model usage and cost ----

const month = (d = new Date()) => d.toLocaleDateString('en-CA').slice(0, 7)

// LLM_PRICES: "model=input/output" in dollars per million tokens, comma separated, e.g.
// "gpt-4.1-mini=0.4/1.6,gpt-4.1=2/8". A model not listed counts as free (free tiers, local models).
export function prices(setting = process.env.LLM_PRICES || '') {
  const out = {}
  for (const part of setting.split(',')) {
    const m = part.trim().match(/^(.+?)=\s*([\d.]+)\s*\/\s*([\d.]+)$/)
    if (m) out[m[1].trim()] = { input: Number(m[2]), output: Number(m[3]) }
  }
  return out
}

// One model call. usage is the provider's { prompt_tokens, completion_tokens }.
export function recordUsage(model, usage) {
  if (!model) return
  state.metrics ??= { turns: [], proactive: { day: '', count: 0 } }
  const all = (state.metrics.usage ??= {})
  const m = (all[month()] ??= {})
  const u = (m[model] ??= { calls: 0, input: 0, output: 0 })
  u.calls++
  u.input += Number(usage?.prompt_tokens) || 0
  u.output += Number(usage?.completion_tokens) || 0
  // Three months are enough for "this month" and "last month".
  for (const k of Object.keys(all).sort().slice(0, -3)) delete all[k]
  save()
}

// { calls, input, output, usd, priced } for a month ('YYYY-MM'). usd counts only models with a price.
export function costSummary(which = month(), table = prices()) {
  const m = state.metrics?.usage?.[which] || {}
  const sum = { calls: 0, input: 0, output: 0, usd: 0, priced: false }
  for (const [model, u] of Object.entries(m)) {
    sum.calls += u.calls
    sum.input += u.input
    sum.output += u.output
    const p = table[model]
    if (p) {
      sum.priced = true
      sum.usd += (u.input * p.input + u.output * p.output) / 1e6
    }
  }
  sum.usd = Math.round(sum.usd * 100) / 100
  return sum
}

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} מיליון` : n >= 1000 ? `${Math.round(n / 1000)} אלף` : String(n))

export function costText(s, label) {
  if (!s.calls) return ''
  return `${label}: ${s.calls} קריאות למודל, ${tokens(s.input + s.output)} טוקנים${s.priced ? `, בערך $${s.usd.toFixed(2)}` : ''}.`
}

// Once a month (from the 1st, 09:00) a line on last month; and once each when this month passes 80% and 100%
// of MONTHLY_COST_LIMIT (dollars). Both stay silent when nothing was used.
export async function costTick(notify, now = new Date()) {
  // A non-Date here is the scheduler bug (runTask was passed as `now`). Ignore it and use the clock.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) now = new Date()
  state.metrics ??= { turns: [], proactive: { day: '', count: 0 } }
  const c = (state.metrics.cost ??= { reported: '', alerts: {} })
  const prev = month(new Date(now.getFullYear(), now.getMonth() - 1, 15))
  if (c.reported !== prev && now.getHours() >= 9) {
    c.reported = prev
    save()
    const text = costText(costSummary(prev), 'בחודש שעבר')
    if (text) await notify(`💸 ${text}`, false, `cost-month:${prev}`)
  }
  const limit = Number(process.env.MONTHLY_COST_LIMIT) || 0
  if (!limit) return
  const now_ = month(now)
  const s = costSummary(now_)
  for (const step of [0.8, 1]) {
    const key = `${now_}:${step}`
    if (s.usd < limit * step || c.alerts[key]) continue
    c.alerts[key] = true
    for (const k of Object.keys(c.alerts)) if (!k.startsWith(now_)) delete c.alerts[k]
    save()
    await notify(step === 1 ? `💸 עברתי את תקרת העלות החודשית: $${s.usd.toFixed(2)} מתוך $${limit}. כדאי לעבור למודל זול יותר באתר ההגדרות, או להעלות את התקרה.` : `💸 הגעתי ל-80% מתקרת העלות החודשית ($${s.usd.toFixed(2)} מתוך $${limit}).`, step === 1, `cost-alert:${key}`)
  }
}
