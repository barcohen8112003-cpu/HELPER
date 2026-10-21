import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR } from './config.js'
import { htmlToText } from './web.js'

const FILE = path.join(DATA_DIR, 'google.json')
// Moving to a server: the accounts connected on the home computer are handed over once as a file
// (GOOGLE_ACCOUNTS_SEED, e.g. a Render "secret file"), and copied in only if the server has none of its own yet.
const SEED = process.env.GOOGLE_ACCOUNTS_SEED
if (SEED && !fs.existsSync(FILE) && fs.existsSync(SEED)) fs.copyFileSync(SEED, FILE)
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const CLASSROOM = 'https://classroom.googleapis.com/v1/courses'

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  // For the live IMAP connection that reports new mail the second it lands. The mailbox is opened read-only.
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
]

// { [email]: { refresh_token } }. Read on every use so a newly connected account works without a restart.
function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveAccount(email, refreshToken) {
  fs.writeFileSync(FILE, JSON.stringify({ ...load(), [email]: { refresh_token: refreshToken } }, null, 2))
}

// Forgets the account locally and asks Google to revoke the grant, so the stored key stops working anywhere.
export async function removeAccount(email) {
  const accounts = load()
  const token = accounts[email]?.refresh_token
  delete accounts[email]
  fs.writeFileSync(FILE, JSON.stringify(accounts, null, 2))
  tokens.delete(email)
  status.delete(email)
  if (token) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15000) }).catch(() => {})
}

// The consent page to send the user to. `redirectUri` must be a loopback address this process is listening on.
export function authUrl(redirectUri, state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state })
  return url.toString()
}

// Second half of the consent flow: trades the code for a long-lived key, stores it, returns the account's address.
export async function connectWithCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(30000),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description || data.error)
  if (!data.refresh_token) throw new Error('גוגל לא החזיר מפתח קבוע. נסה שוב ואשר את כל ההרשאות.')
  const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(30000) })).json()
  if (!info.email) throw new Error('לא התקבלה כתובת מייל')
  saveAccount(info.email, data.refresh_token)
  tokens.delete(info.email)
  status.set(info.email, { ok: true, at: Date.now() })
  return info.email
}

export const googleAccounts = () => (config.google.clientId ? Object.keys(load()) : [])
export const googleEnabled = () => googleAccounts().length > 0

// Empty = every connected account; otherwise the one named.
export function resolveAccounts(account) {
  const all = googleAccounts()
  if (!account) return all
  if (!all.includes(account)) throw new Error(`החשבון ${account} לא מחובר. מחוברים: ${all.join(', ')}`)
  return [account]
}

const tokens = new Map()
// { [email]: { ok, error, at } }: the result of the last real token exchange with Google, per account.
// A stored key is not proof the account works: Google can expire or revoke it at any time.
const status = new Map()

export const googleAccountStatus = (email) => status.get(email) || null

// `fresh` skips the cached access token, so the stored key itself is tested against Google.
export async function accessToken(email, { fresh = false } = {}) {
  const cached = tokens.get(email)
  if (!fresh && cached && cached.expires > Date.now() + 60000) return cached.token
  const refresh = load()[email]?.refresh_token
  if (!refresh) throw new Error(`החשבון ${email} לא מחובר`)
  let res, data
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(30000),
    })
    data = await res.json()
  } catch (e) {
    // No answer from Google (offline, timeout) says nothing about the key, so the last known state is kept.
    throw new Error(`אין תשובה מגוגל עבור ${email}: ${e.message}`)
  }
  if (!res.ok) {
    tokens.delete(email)
    status.set(email, { ok: false, error: data.error || `HTTP ${res.status}`, at: Date.now() })
    const why = data.error === 'invalid_grant' ? 'המפתח פג או בוטל' : data.error
    throw Object.assign(new Error(`החיבור לגוגל של ${email} נכשל (${why}). צריך לחבר מחדש עם npm run google`), {
      hint: `צריך לחבר מחדש את ${email}: באתר ההגדרות, Google Workspace, "הוסף חשבון".`,
    })
  }
  status.set(email, { ok: true, at: Date.now() })
  tokens.set(email, { token: data.access_token, expires: Date.now() + data.expires_in * 1000 })
  return data.access_token
}

// Tests every connected account against Google, at most once per `maxAgeMs` each. Never throws.
export async function checkGoogleAccounts({ maxAgeMs = 10 * 60000 } = {}) {
  await Promise.all(googleAccounts().map(async (email) => {
    const last = status.get(email)
    if (last && Date.now() - last.at < maxAgeMs) return
    await accessToken(email, { fresh: true }).catch(() => {})
  }))
  return Object.fromEntries(googleAccounts().map((email) => [email, status.get(email) || null]))
}

async function api(email, url, { body, text } = {}) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await accessToken(email)}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Google HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return text ? res.text() : res.json()
}

const b64url = (s) => Buffer.from(s, 'base64url').toString('utf8')
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || ''

// ---- Gmail ----

async function summaries(email, ids) {
  const msgs = await Promise.all(ids.map((id) => api(email, `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)))
  return msgs.map((m) => ({
    account: email,
    id: m.id,
    from: header(m, 'from'),
    subject: header(m, 'subject'),
    date: new Date(Number(m.internalDate)).toLocaleString('he-IL'),
    text: m.snippet || '',
    ms: Number(m.internalDate),
  }))
}

export async function gmailSearch(email, query = '', limit = 5) {
  const data = await api(email, `${GMAIL}/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`)
  return summaries(email, (data.messages || []).map((m) => m.id))
}

// Inbox mail that arrived after `sinceMs`.
export async function gmailSince(email, sinceMs) {
  const data = await api(email, `${GMAIL}/messages?maxResults=15&labelIds=INBOX&q=after:${Math.floor(sinceMs / 1000)}`)
  return (await summaries(email, (data.messages || []).map((m) => m.id))).filter((m) => m.ms > sinceMs)
}

function findPart(part, mime) {
  if (part.mimeType === mime && part.body?.data) return b64url(part.body.data)
  for (const child of part.parts || []) {
    const text = findPart(child, mime)
    if (text) return text
  }
  return ''
}

// Prefers the plain-text version of a message, wherever it sits in the MIME tree.
const bodyText = (payload) => findPart(payload, 'text/plain') || htmlToText(findPart(payload, 'text/html'))

export async function gmailRead(email, id) {
  const m = await api(email, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`)
  return { from: header(m, 'from'), to: header(m, 'to'), subject: header(m, 'subject'), date: header(m, 'date'), text: bodyText(m.payload || {}).slice(0, 12000) }
}

export function buildRawMail({ to, subject, body }) {
  const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ')
  return Buffer.from(
    [
      `To: ${oneLine(to)}`,
      `Subject: =?UTF-8?B?${Buffer.from(oneLine(subject)).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64'),
    ].join('\r\n')
  ).toString('base64url')
}

export async function gmailSend(email, mail) {
  await api(email, `${GMAIL}/messages/send`, { body: { raw: buildRawMail(mail) } })
}

// ---- Calendar ----

export async function googleEvents(email, days) {
  const from = new Date()
  const to = new Date(from.getTime() + days * 86400000)
  const data = await api(email, `${EVENTS}?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`)
  return (data.items || []).map((e) => ({
    uid: e.recurringEventId || e.id,
    // All-day events carry a bare date; anchor it to local midnight rather than UTC.
    start: new Date(e.start?.dateTime || `${e.start?.date}T00:00`),
    title: e.summary || '',
    location: e.location || '',
    account: email,
  }))
}

// Events created or changed since `sinceIso`: one small request, cheap enough to make every minute.
// Google can push calendar changes only to a public web address, which a home computer does not have.
export async function calendarChanges(email, sinceIso) {
  const data = await api(email, `${EVENTS}?updatedMin=${encodeURIComponent(sinceIso)}&showDeleted=false&singleEvents=false&maxResults=50`)
  return (data.items || [])
    .filter((e) => e.status !== 'cancelled' && (e.start?.dateTime || e.start?.date))
    .map((e) => ({ uid: e.id, updated: e.updated, start: new Date(e.start.dateTime || `${e.start.date}T00:00`), title: e.summary || '', location: e.location || '', account: email }))
}

export async function calendarAdd(email, { title, start, end, description }) {
  const from = new Date(start)
  if (isNaN(from)) throw new Error('זמן התחלה לא תקין, נדרש YYYY-MM-DDTHH:MM')
  const to = end ? new Date(end) : new Date(from.getTime() + 3600000)
  const ev = await api(email, EVENTS, { body: { summary: title, description, start: { dateTime: from.toISOString() }, end: { dateTime: to.toISOString() } } })
  return ev.htmlLink
}

// ---- Tasks ----

export async function tasksList(email) {
  const data = await api(email, `${TASKS}?showCompleted=false&maxResults=50`)
  return (data.items || []).map((t) => ({ account: email, title: t.title, due: t.due ? t.due.slice(0, 10) : '', notes: t.notes || '' }))
}

export async function tasksAdd(email, { title, due, notes }) {
  await api(email, TASKS, { body: { title, notes, ...(due && { due: new Date(due).toISOString() }) } })
}

// ---- Classroom ----

// The student's assignments: those due within `days`, plus undated ones touched in the last two weeks.
export async function classroomWork(email, days) {
  const now = Date.now()
  const { courses = [] } = await api(email, `${CLASSROOM}?studentId=me&courseStates=ACTIVE&pageSize=50`)
  const perCourse = await Promise.all(
    courses.map(async (course) => {
      const [{ courseWork = [] }, { studentSubmissions = [] }] = await Promise.all([
        api(email, `${CLASSROOM}/${course.id}/courseWork?orderBy=${encodeURIComponent('updateTime desc')}&pageSize=40`),
        api(email, `${CLASSROOM}/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=200`),
      ])
      const done = new Set(studentSubmissions.filter((s) => s.state === 'TURNED_IN' || s.state === 'RETURNED').map((s) => s.courseWorkId))
      return courseWork.map((w) => {
        const d = w.dueDate
        // Due date and time arrive in UTC; a date without a time means end of that day.
        const due = d ? new Date(Date.UTC(d.year, d.month - 1, d.day, w.dueTime ? w.dueTime.hours || 0 : 23, w.dueTime ? w.dueTime.minutes || 0 : 59)) : null
        return { id: w.id, courseId: course.id, account: email, course: course.name, title: w.title, due, submitted: done.has(w.id), link: w.alternateLink, updated: Date.parse(w.updateTime) }
      })
    })
  )
  return perCourse
    .flat()
    .filter((w) => (w.due ? w.due > now && w.due - now < days * 86400000 : now - w.updated < 14 * 86400000))
    .sort((a, b) => (a.due || Infinity) - (b.due || Infinity))
}

// One assignment in full: the instructions and what is attached to it. Read only.
// materials: [{ kind: 'drive', id, title, link } | { kind: 'link' | 'youtube' | 'form', title, link }]
export async function classroomAssignment(email, courseId, workId) {
  const base = `${CLASSROOM}/${encodeURIComponent(courseId)}`
  const [course, w] = await Promise.all([api(email, base), api(email, `${base}/courseWork/${encodeURIComponent(workId)}`)])
  const d = w.dueDate
  const due = d ? new Date(Date.UTC(d.year, d.month - 1, d.day, w.dueTime ? w.dueTime.hours || 0 : 23, w.dueTime ? w.dueTime.minutes || 0 : 59)) : null
  const materials = (w.materials || []).map((m) => {
    if (m.driveFile) return { kind: 'drive', id: m.driveFile.driveFile.id, title: m.driveFile.driveFile.title || '', link: m.driveFile.driveFile.alternateLink || '' }
    if (m.youtubeVideo) return { kind: 'youtube', title: m.youtubeVideo.title || '', link: m.youtubeVideo.alternateLink || '' }
    if (m.form) return { kind: 'form', title: m.form.title || '', link: m.form.formUrl || '' }
    if (m.link) return { kind: 'link', title: m.link.title || '', link: m.link.url || '' }
    return { kind: 'other', title: '', link: '' }
  })
  return {
    id: w.id,
    courseId,
    account: email,
    course: course.name || '',
    title: w.title || '',
    description: w.description || '',
    due,
    maxPoints: w.maxPoints ?? null,
    link: w.alternateLink || '',
    materials,
  }
}

// ---- Drive ----

// Google's own formats are exported to their Office equivalent; everything else is downloaded as it is.
export const OFFICE_EXPORT = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
}
// Drive refuses to export a file bigger than this.
export const EXPORT_LIMIT = 10 * 1024 * 1024

// A Drive file as bytes, for the assignment folder. Refuses (with a reason, never a partial file) when the file is
// larger than maxBytes, when Drive cannot export it, or when it is a Google type with no download (Forms, sites).
// Returns { name, mime, buffer }.
export async function driveDownload(email, id, { maxBytes = Infinity } = {}) {
  const file = `${DRIVE}/${encodeURIComponent(id)}`
  const meta = await api(email, `${file}?fields=name,mimeType,size&supportsAllDrives=true`)
  const office = OFFICE_EXPORT[meta.mimeType]
  if (!office && meta.mimeType.startsWith('application/vnd.google-apps.')) throw Object.assign(new Error(`סוג קובץ של Google שאי אפשר להוריד (${meta.mimeType.replace('application/vnd.google-apps.', '')})`), { code: 'unsupported' })
  const size = Number(meta.size || 0)
  if (size && size > maxBytes) throw Object.assign(new Error('הקובץ גדול מהתקרה'), { code: 'too-big', size })
  const url = office ? `${file}/export?mimeType=${encodeURIComponent(office.mime)}` : `${file}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(email)}` }, signal: AbortSignal.timeout(120000) })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    if (office && /exportSizeLimitExceeded|too large/i.test(body)) throw Object.assign(new Error('Drive לא מייצא קבצים מעל 10MB'), { code: 'export-limit' })
    throw new Error(`Google HTTP ${res.status}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > maxBytes) throw Object.assign(new Error('הקובץ גדול מהתקרה'), { code: 'too-big', size: buffer.length })
  const name = office && !meta.name.toLowerCase().endsWith(office.ext) ? meta.name + office.ext : meta.name
  return { name, mime: office ? office.mime : meta.mimeType, buffer }
}

export async function driveSearch(email, query) {
  const q = `fullText contains '${String(query).replace(/['\\]/g, ' ')}' and trashed = false`
  const data = await api(email, `${DRIVE}?pageSize=10&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink)')}`)
  return (data.files || []).map((f) => ({ account: email, ...f }))
}

const EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
}

export async function driveRead(email, id) {
  const file = `${DRIVE}/${encodeURIComponent(id)}`
  const meta = await api(email, `${file}?fields=name,mimeType`)
  let url
  if (EXPORT[meta.mimeType]) url = `${file}/export?mimeType=${encodeURIComponent(EXPORT[meta.mimeType])}`
  else if (meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json') url = `${file}?alt=media`
  else throw new Error(`אי אפשר לקרוא קובץ מסוג ${meta.mimeType}`)
  return `${meta.name}\n\n${(await api(email, url, { text: true })).slice(0, 12000)}`
}
