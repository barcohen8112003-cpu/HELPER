// One WhatsApp note after a deploy. The image carries build-info.json (git sha + recent subjects).
// The data volume remembers the last sha we announced, so a restart of the same build stays quiet.
import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR, ROOT } from './config.js'

export const MAX_ATTEMPTS = 2

const stateFile = () => path.join(DATA_DIR, 'last-release.json')

export function redact(text) {
  let out = String(text || '')
  out = out.replace(/(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}/g, '[סודי]')
  out = out.replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[סודי]')
  out = out.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*\S+/g, '$1=[סודי]')
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASS|COOKIE)/i.test(key)) continue
    if (!value || value.length < 8) continue
    out = out.split(value).join('[סודי]')
  }
  return out
}

export function readBuildInfo(file = path.join(ROOT, 'build-info.json')) {
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  const sha = String(data.sha || process.env.GIT_SHA || 'unknown').trim() || 'unknown'
  const commits = Array.isArray(data.commits) ? data.commits : []
  return { sha, short: String(data.short || sha.slice(0, 7)), commits }
}

// Commits newer than the sha we already announced. The baked log is newest first.
// The previous sha missing from that window means we only have the recent slice.
export function commitsSince(info, previousSha) {
  const list = Array.isArray(info?.commits) ? info.commits : []
  if (!previousSha) return list.slice(0, 1)
  const prev = String(previousSha)
  const idx = list.findIndex((c) => c?.sha && (c.sha === prev || c.sha.startsWith(prev) || prev.startsWith(c.sha)))
  if (idx === 0) return []
  if (idx > 0) return list.slice(0, idx)
  return list.slice(0, 15)
}

export function fallbackText(short, commits) {
  const lines = (commits || []).map((c) => `• ${String(c.subject || '').trim()}`).filter((l) => l !== '• ').slice(0, 6)
  return [`עודכנתי לגרסה ${short}.`, ...lines].join('\n')
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

const SYSTEM = `אתה כותב לנאור הודעת וואטסאפ קצרה בעברית על עדכון של העוזר.
פתח ב"עודכנתי לגרסה <הקוד>." ואז 3 עד 6 שורות, כל אחת מתחילה ב-•, ידידותית וקצרה.
רק מה שמופיע ברשימת הקומיטים. אל תמציא. בלי מפתחות, סיסמאות, סודות או ערכי env.`

// send(text) => Promise. ask(system, user) => Promise<string>, optional.
// Marks the sha only after a successful send. A crash between send and the mark can retry,
// but only MAX_ATTEMPTS times, so a restart loop cannot keep messaging him.
export async function announceRelease({ send, ask, info, file = stateFile(), enabled = config.updateNotes } = {}) {
  if (!enabled) return { sent: false, reason: 'off' }
  const build = info || readBuildInfo()
  const sha = String(build.sha || '')
  if (!sha || sha === 'unknown') return { sent: false, reason: 'no-sha' }
  const prev = readState(file)
  if (prev?.sha === sha && prev.announced) return { sent: false, reason: 'same' }
  const attempts = prev?.sha === sha ? Number(prev.attempts) || 0 : 0
  if (attempts >= MAX_ATTEMPTS) return { sent: false, reason: 'gave-up' }
  const nextAttempts = attempts + 1
  writeState(file, { sha, attempts: nextAttempts, announced: false })
  const first = !prev?.sha
  const commits = (first ? (build.commits || []).slice(0, 1) : commitsSince(build, prev.sha)).map((c) => ({
    sha: c.sha,
    subject: redact(c.subject || ''),
    body: redact(c.body || ''),
  }))
  const short = build.short || sha.slice(0, 7)
  let text = ''
  try {
    const askFn = ask || (await import('./llm.js')).ask
    const user = [
      `גרסה: ${short}`,
      first ? 'זו הפעם הראשונה. סכם רק את הקומיט האחרון.' : 'סכם רק את הקומיטים האלה, מהחדש לישן.',
      ...commits.map((c, i) => `${i + 1}. ${c.subject}\n${c.body}`),
    ].join('\n\n')
    text = String((await askFn(SYSTEM, user)) || '').trim()
    if (text && !text.includes('עודכנתי')) text = `עודכנתי לגרסה ${short}.\n${text}`
  } catch {
    text = ''
  }
  if (!text) text = fallbackText(short, commits)
  text = redact(text).slice(0, 3500)
  try {
    await send(text)
  } catch {
    return { sent: false, reason: 'send-failed', attempts: nextAttempts }
  }
  writeState(file, { sha, attempts: nextAttempts, announced: true })
  return { sent: true, attempts: nextAttempts, text }
}
