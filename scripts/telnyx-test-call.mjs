// One test call through Telnyx Call Control: dials a number, and when it is answered says one sentence and hangs up.
// Reads TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_FROM and TELNYX_TO from .env (the same file the settings page
// writes). Run:  npm run call:telnyx            (calls TELNYX_TO)
//               npm run call:telnyx -- +9725...  (calls the number given)
// Nothing here needs a webhook: the script keeps trying to speak until the call is answered, and gives up after 60s.
import '../src/config.js' // loads .env into process.env

const key = (process.env.TELNYX_API_KEY || '').trim()
const connectionId = (process.env.TELNYX_CONNECTION_ID || '').trim()
const from = (process.env.TELNYX_FROM || '').trim()
const to = (process.argv[2] || process.env.TELNYX_TO || '').trim()
const text = (process.env.TELNYX_TEST_TEXT || 'שלום, זאת שיחת ניסיון מ-Helper. הכול עובד.').trim()

const missing = [['TELNYX_API_KEY', key], ['TELNYX_CONNECTION_ID', connectionId], ['TELNYX_FROM', from], ['TELNYX_TO', to]]
  .filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  console.error(`חסר ב-.env: ${missing.join(', ')}`)
  process.exit(1)
}
const e164 = (n) => /^\+\d{8,15}$/.test(n)
if (!e164(from) || !e164(to)) {
  console.error('המספרים צריכים להיות בפורמט +972501234567 (עם + וקידומת מדינה)')
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
const why = (r) => (r.data?.errors || []).map((e) => e.detail || e.title).join('; ') || `HTTP ${r.status}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dial = await api('POST', '/calls', { connection_id: connectionId, to, from, timeout_secs: 45 })
if (!dial.ok) {
  console.error(`Telnyx סירב לחייג: ${why(dial)}`)
  if (dial.status === 401) console.error('המפתח לא תקין. צור מפתח חדש ב-portal.telnyx.com > API Keys.')
  process.exit(1)
}
const id = dial.data.data.call_control_id
console.log(`מחייג אל ${to} מ-${from}...`)

// Speak only works once the call is answered, so keep asking until it is.
const lang = (process.env.TELNYX_LANGUAGE || 'he-IL').trim()
for (let t = 0; t < 30; t++) {
  await sleep(2000)
  const state = await api('GET', `/calls/${id}`)
  if (state.ok && state.data?.data?.is_alive === false) {
    console.error('השיחה הסתיימה בלי מענה.')
    process.exit(1)
  }
  const speak = await api('POST', `/calls/${id}/actions/speak`, { payload: text, voice: 'female', language: lang })
  if (speak.ok) {
    console.log('נענתה. מקריא את ההודעה...')
    await sleep(8000)
    await api('POST', `/calls/${id}/actions/hangup`, {})
    console.log('שיחת הניסיון עברה.')
    process.exit(0)
  }
}
await api('POST', `/calls/${id}/actions/hangup`, {})
console.error('אף אחד לא ענה תוך דקה. ניתקתי.')
process.exit(1)
