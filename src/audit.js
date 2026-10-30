// The activity log: one line for every tool HELPER ran, with when, from where, what it was given, whether Naor was asked
// and what he answered, and how it ended. It answers "what did you do last night?" and "who sent that?" from facts
// instead of from memory, and it is the first place to look when something happened that he does not remember asking for.
//
// What is written is deliberately short and already cleaned: keys and tokens are masked (secret-logs.js), arguments named
// like a secret are never stored, and results are cut to their opening. It never throws: a failing log must not stop a tool.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'
import { redact } from './secret-logs.js'

export const AUDIT_DIR = () => path.join(DATA_DIR, 'audit')
const KEEP_MONTHS = 12
const ARG_CHARS = 200
const RESULT_CHARS = 160
const SECRET_KEY = /pin|pass|secret|token|code|otp|cvv|card|key|auth/i

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// The arguments as they are kept: secret-looking names hidden, everything else masked and cut.
export function maskArgs(args) {
  const out = {}
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
    out[k] = SECRET_KEY.test(k) ? '••••' : clip(redact(typeof v === 'string' ? v : JSON.stringify(v)), ARG_CHARS)
  }
  return out
}

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const fileFor = (d) => path.join(AUDIT_DIR(), `${monthKey(d)}.jsonl`)

// source: whatsapp | task | job | the bridge client's name (tv, android_app, discord). approval: none | approved | declined.
export function record({ tool, args, source = 'unknown', approval = 'none', ok = true, result = '', error = '', ms = 0, now = new Date() }) {
  try {
    const file = fileFor(now)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(AUDIT_DIR(), { recursive: true })
      // A new month starts: months older than the retention window go.
      const oldest = monthKey(new Date(now.getFullYear(), now.getMonth() - (KEEP_MONTHS - 1), 1))
      for (const f of fs.readdirSync(AUDIT_DIR())) if (/^\d{4}-\d{2}\.jsonl$/.test(f) && f.slice(0, 7) < oldest) fs.rmSync(path.join(AUDIT_DIR(), f), { force: true })
    }
    const entry = {
      t: now.toISOString(),
      source: String(source).slice(0, 30),
      tool: String(tool).slice(0, 60),
      args: maskArgs(args),
      approval,
      ok: Boolean(ok),
      ms: Math.max(0, Math.round(ms)),
      ...(error ? { error: clip(redact(error), RESULT_CHARS) } : {}),
      result: clip(redact(result), RESULT_CHARS),
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch (e) {
    console.log(`[audit] ${e.message}`)
  }
}

// Newest first. Every filter is optional; `q` looks in the tool name, the arguments, the result and the error.
export function searchAudit({ q = '', tool = '', approval = '', source = '', from = '', to = '', limit = 50 } = {}) {
  const dir = AUDIT_DIR()
  if (!fs.existsSync(dir)) return []
  const want = String(q).trim().toLowerCase()
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  const out = []
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (tool && !e.tool.includes(tool)) continue
      if (approval && e.approval !== approval) continue
      if (source && e.source !== source) continue
      if (from && e.t < from) continue
      if (to && e.t > to) continue
      if (want && !`${e.tool} ${JSON.stringify(e.args)} ${e.result} ${e.error || ''}`.toLowerCase().includes(want)) continue
      out.push(e)
      if (out.length >= max) return out
    }
  }
  return out
}

// A few numbers for the dashboard: the last `days` days.
export function auditStats(days = 7, now = new Date()) {
  const from = new Date(now.getTime() - days * 86400000).toISOString()
  const rows = searchAudit({ from, to: now.toISOString(), limit: 200 })
  const byTool = {}
  for (const r of rows) byTool[r.tool] = (byTool[r.tool] || 0) + 1
  return {
    total: rows.length,
    failed: rows.filter((r) => !r.ok && r.approval !== 'declined').length,
    declined: rows.filter((r) => r.approval === 'declined').length,
    approved: rows.filter((r) => r.approval === 'approved').length,
    top: Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tool, n]) => ({ tool, n })),
    capped: rows.length >= 200,
  }
}

const when = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
const SOURCES = { whatsapp: 'וואטסאפ', task: 'משימה מתוזמנת', job: 'משימת רקע', tv: 'טלוויזיה', android_app: 'האפליקציה', discord: 'דיסקורד' }

// The model's view: "what did you do yesterday?", "did you send anything to Dani?".
export const auditTools = [
  {
    name: 'audit_search',
    description: 'יומן הפעילות שלך: מה הפעלת ומתי, מאיפה ביקשו, והאם המשתמש אישר. לשאלות כמו "מה עשית אתמול בלילה?" או "שלחת משהו לדני?".',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'מילת חיפוש בשם הכלי, בקלט או בתוצאה' },
        tool: { type: 'string', description: 'שם כלי (או חלק ממנו)' },
        days: { type: 'number', description: 'כמה ימים אחורה, ברירת מחדל 2' },
        approval: { type: 'string', enum: ['approved', 'declined'], description: 'רק פעולות שאושרו או סורבו' },
      },
      required: [],
    },
    run({ q, tool, days, approval } = {}) {
      const from = new Date(Date.now() - Math.max(0.1, Math.min(365, Number(days) || 2)) * 86400000).toISOString()
      const rows = searchAudit({ q, tool, approval, from, limit: 25 })
      if (!rows.length) return 'אין פעולות מתאימות ביומן'
      return rows
        .map((r) => `${when(r.t)} · ${SOURCES[r.source] || r.source} · ${r.tool}${Object.keys(r.args).length ? ` ${JSON.stringify(r.args).slice(0, 90)}` : ''} · ${r.approval === 'approved' ? 'אושר' : r.approval === 'declined' ? 'סורב' : 'ללא אישור'} · ${r.ok ? 'הצליח' : `נכשל${r.error ? `: ${r.error}` : ''}`}`)
        .join('\n')
    },
  },
]
