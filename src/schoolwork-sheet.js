// A Google Sheet HELPER keeps in step with the homework list (src/schoolwork.js).
// Helper creates the file itself (drive.file: only a file it made), then rewrites the table on every sync.
// Open items first, by due date; a finished item gets "V" in the status column and stays a week.
import { googleEnabled, googleAccounts, driveCreate, gcall, grantedScopes } from './google.js'

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const FILE_NAME = 'שיעורי בית — הלפר'
const TAB = 'שיעורי בית'
export const HEAD = ['מספר', 'מקצוע', 'משימה', 'מועד הגשה', 'דחיפות', 'סטטוס', 'מקור']
const KEEP_DONE_DAYS = 7
const DAY = 86400000

export function urgencyLabel(item, nowMs, { pastDue, wall, dayNum }) {
  if (!item?.due?.day) return 'בלי תאריך'
  if (pastDue(item, nowMs)) return 'עבר המועד'
  const now = wall(nowMs)
  const diff = dayNum(item.due.day) - dayNum(now.day)
  if (diff === 0) return 'היום'
  if (diff === 1) return 'מחר'
  if (diff === 2) return 'מחרתיים'
  return `בעוד ${diff} ימים`
}

export function sheetRows(items, nowMs, helpers) {
  const { isOpen, dueLabel, where, pastDue, wall, dayNum } = helpers
  const dueSort = (i) => (i.due?.day ? `${i.due.day}T${i.due.time || '23:59'}` : '9999')
  const open = items.filter(isOpen).sort((a, b) => dueSort(a).localeCompare(dueSort(b)))
  const done = items
    .filter((i) => i.status === 'done' && nowMs - (i.closedAt || 0) < KEEP_DONE_DAYS * DAY)
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  const row = (i) => [
    String(i.n ?? ''),
    i.course || '',
    i.title || '',
    i.due?.day ? dueLabel(i.due, nowMs) : 'בלי תאריך הגשה',
    urgencyLabel(i, nowMs, { pastDue, wall, dayNum }),
    isOpen(i) ? '' : 'V',
    where(i),
  ]
  return [HEAD, ...open.map(row), ...done.map(row)]
}

function canWrite(scopes) {
  if (!scopes) return true
  return scopes.some((s) => s.endsWith('/drive.file') || s.endsWith('/drive') || s.endsWith('/spreadsheets'))
}

async function writeAccount() {
  if (!googleEnabled()) return ''
  for (const email of googleAccounts()) {
    const scopes = await grantedScopes(email).catch(() => null)
    if (canWrite(scopes)) return email
  }
  return ''
}

async function tabName(email, id) {
  const meta = await gcall(email, 'GET', `${SHEETS}/${encodeURIComponent(id)}?fields=sheets(properties(title,sheetId))`)
  const tabs = meta.sheets || []
  const hit = tabs.find((s) => s.properties?.title === TAB)
  if (hit) return TAB
  if (tabs[0]?.properties?.sheetId != null) {
    await gcall(email, 'POST', `${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, {
      json: { requests: [{ updateSheetProperties: { properties: { sheetId: tabs[0].properties.sheetId, title: TAB }, fields: 'title' } }] },
    }).catch(() => {})
    return TAB
  }
  return tabs[0]?.properties?.title || TAB
}

async function writeRows(email, id, rows) {
  const sheet = await tabName(email, id)
  const q = (r) => `'${sheet.replace(/'/g, "''")}'!${r}`
  await gcall(email, 'POST', `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(q('A2:G2000'))}:clear`, { json: {} })
  await gcall(email, 'PUT', `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(q('A1'))}?valueInputOption=RAW`, {
    json: { range: q('A1'), majorDimension: 'ROWS', values: rows },
  })
}

// deps: { load, persist, helpers, notify? }. Returns { link, created, rows } or { error }.
export async function syncHomeworkSheet(deps, nowMs = Date.now()) {
  const s = deps.load()
  const email = await writeAccount()
  if (!email) return { error: 'אין חשבון Google שממנו אפשר לכתוב גיליון' }
  let info = s.sheet || {}
  let created = false
  if (!info.id) {
    const rows = sheetRows(s.items || [], nowMs, deps.helpers)
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const made = await driveCreate(email, { name: FILE_NAME, kind: 'sheet', content: csv })
    info = { id: made.id, link: made.link, announced: false }
    s.sheet = info
    deps.persist()
    created = true
    try {
      await tabName(email, info.id)
    } catch {}
    return { link: info.link, created, rows: rows.length - 1 }
  }
  const rows = sheetRows(s.items || [], nowMs, deps.helpers)
  await writeRows(email, info.id, rows)
  return { link: info.link, created, rows: rows.length - 1 }
}

export async function announceSheetOnce(notify, deps, text) {
  const s = deps.load()
  if (!notify || !s.sheet?.link || s.sheet.announced) return false
  await notify(text, true, `schoolwork-sheet:${s.sheet.id}`, 'schoolwork')
  s.sheet.announced = true
  deps.persist()
  return true
}
