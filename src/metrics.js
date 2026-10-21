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
  }
}
