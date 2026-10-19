// Phone calls with the assistant. ElevenLabs runs the voice side: an agent tied to a Twilio number. This module is
// what that agent can reach on this computer: a small server that answers a handful of tool calls, a tunnel that
// makes it reachable from the internet, and the call-out when the assistant is asked to phone the owner.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { config, DATA_DIR, saveSettings } from './config.js'
import { state } from './store.js'
import { activeTools } from './tools.js'
import { sessionEnabled, readSessionPage } from './session.js'

const API = 'https://api.elevenlabs.io/v1'
const TOOLS_FILE = path.join(DATA_DIR, 'voice-tools.json')
const MAX_BODY = 20000
const MAX_PER_MINUTE = 60

const digits = (s) => String(s || '').replace(/\D/g, '')
const ownerDigits = () => digits(String(state.owner?.jid || '').split('@')[0])

export const voiceEnabled = () => Boolean(config.phone.agentId && config.elevenlabs.apiKey)

const PROMPT = `אתה Helper, העוזר האישי של נאור, ואתה מדבר איתו בטלפון. דבר בעברית מדוברת, כמו חבר חד וחביב.

איך מדברים בטלפון:
- משפטים קצרים. תשובה אחת בכל פעם, שניים-שלושה משפטים לכל היותר.
- בלי רשימות, בלי כותרות ובלי אימוג'ים. זו שיחה, לא הודעה.
- תשובה קודם, אחר כך פרטים רק אם הוא צריך.
- אפשר קצת הומור והקנטה, אבל כשהוא לחוץ או במצוקה, תהיה רגוע ועוזר.
- אל תפתח בברכה ארוכה ואל תסיים בהצעת עזרה. כשהעניין נגמר, תן לו לסגור.
- לפני שאתה קורא לכלי, אמור במשפט קצר מה אתה עושה ("שנייה, בודק"), ואחרי התשובה אל תחזור על כל הפרטים.

מה אתה יכול לעשות בשיחה (בעזרת הכלים):
- get_agenda: תזכורות פעילות ומטלות שאין אישור שהוגשו.
- webtop_today: מה שמופיע היום ב-Webtop (שינויי מערכת, שיעורי בית, חיסורים, הודעות). סכם בקול בקצרה, אל תקרא הכל.
- add_reminder, list_reminders, cancel_reminder: תזכורות. את הזמן שולחים בפורמט YYYY-MM-DDTHH:MM לפי שעון ישראל. אם הוא אמר "מחר בשמונה", חשב את התאריך.
- remember: לשמור עובדה עליו.
את שאר הדברים (מיילים, שליחת הודעות, הרצת פקודות) אי אפשר מהטלפון: תגיד לו בפשטות שאפשר לבקש בוואטסאפ.

כנות:
- אל תמציא מחירים, תאריכים או עובדות. אם אתה לא בטוח, תגיד "לא בטוח" או "אני מנחש".
- אם כלי נכשל או אומר שמשהו לא מחובר, תגיד את זה כמו שזה.
- אל תבקש ממנו סיסמאות או מספרי כרטיס אשראי.`

const SPEC = [
  { name: 'get_agenda', description: 'תזכורות פעילות ומטלות שאין אישור שהוגשו.', properties: {} },
  { name: 'webtop_today', description: 'הטקסט של דף הבית ב-Webtop: שינויי מערכת, שיעורי בית, אירועים בשיעור והודעות.', properties: {} },
  {
    name: 'add_reminder',
    description: 'קובע תזכורת שתישלח לנאור בוואטסאפ בזמן שנקבע.',
    properties: {
      text: { type: 'string', description: 'מה להזכיר' },
      when: { type: 'string', description: 'זמן מקומי (ישראל) בפורמט YYYY-MM-DDTHH:MM' },
    },
    required: ['text', 'when'],
  },
  { name: 'list_reminders', description: 'מציג את כל התזכורות הפעילות.', properties: {} },
  { name: 'cancel_reminder', description: 'מבטל תזכורת לפי מזהה.', properties: { id: { type: 'number', description: 'מזהה התזכורת' } }, required: ['id'] },
  { name: 'remember', description: 'שומר עובדה על נאור לזיכרון קבוע.', properties: { fact: { type: 'string', description: 'העובדה לשמירה' } }, required: ['fact'] },
]

const reuse = (name) => (args) => {
  const tool = activeTools().find((t) => t.name === name)
  if (!tool) throw new Error('הכלי לא זמין')
  return tool.run(args, {})
}

const handlers = {
  get_agenda() {
    const reminders = state.reminders.map((r) => `${r.text} (${new Date(r.at).toLocaleString('he-IL')})`)
    const open = state.homework.open.slice(0, 10).map((w) => `${w.title} (${w.course}), הגשה ${w.due}`)
    return `תזכורות: ${reminders.join('; ') || 'אין'}. מטלות שאין אישור שהוגשו: ${open.join('; ') || 'אין'}.`
  },
  async webtop_today() {
    if (!sessionEnabled()) throw new Error('Webtop לא מוגדר')
    return readSessionPage(config.webtop.url, 3500)
  },
  add_reminder: reuse('add_reminder'),
  list_reminders: reuse('list_reminders'),
  cancel_reminder: reuse('cancel_reminder'),
  remember: reuse('remember'),
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) return reject(new Error('too large'))
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function startServer() {
  let minute = 0
  let count = 0
  const reply = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const server = http.createServer(async (req, res) => {
    try {
      const now = Math.floor(Date.now() / 60000)
      if (now !== minute) [minute, count] = [now, 0]
      if (++count > MAX_PER_MINUTE) return reply(res, 429, { error: 'too many requests' })
      // Twilio cannot send our header, so its request carries the secret in the address instead.
      if (req.url.startsWith('/twiml/outbound')) {
        const key = new URL(req.url, 'http://x').searchParams.get('key') || ''
        if (!config.twilio.sid || !same(key, config.phone.secret) || !ownerDigits()) return reply(res, 401, { error: 'unauthorized' })
        const twiml = await outboundTwiml(ownerDigits())
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        console.log('[voice] שיחה יוצאת עונתה, מועברת לסוכן')
        return res.end(String(twiml))
      }
      const secret = String(req.headers['x-voice-secret'] || '')
      if (req.method !== 'POST' || !same(secret, config.phone.secret)) return reply(res, 401, { error: 'unauthorized' })
      const name = req.url.match(/^\/tool\/([a-z_]+)$/)?.[1]
      const handler = name && handlers[name]
      if (!handler) return reply(res, 404, { error: 'unknown tool' })
      const args = JSON.parse((await readBody(req)) || '{}')
      // The phone system fills these in itself (they are not something the caller or the model can set):
      // only a call to or from the owner's own number gets anything.
      const owner = ownerDigits()
      if (!owner || (digits(args.caller) !== owner && digits(args.called) !== owner)) return reply(res, 403, { error: 'not the owner' })
      const { caller, called, ...rest } = args
      const result = await handler(rest)
      console.log(`[voice] ${name}`)
      reply(res, 200, { result: String(result ?? '') })
    } catch (e) {
      console.log(`[voice] ${e.message}`)
      reply(res, 200, { error: e.message })
    }
  })
  server.on('error', (e) => console.log(`[voice] ${e.message}`))
  server.listen(config.phone.port, '127.0.0.1')
}

async function eleven(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { 'xi-api-key': config.elevenlabs.apiKey, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 300)}`)
  if (!text) return {}
  // Most answers are JSON; register-call answers with TwiML (XML), which is passed on as it is.
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

let tunnelUrl = ''

// Twilio asks for this when the owner picks up a call the assistant placed. It hands the call to the voice agent.
async function outboundTwiml(owner) {
  return eleven('POST', '/convai/twilio/register-call', {
    agent_id: config.phone.agentId,
    from_number: config.twilio.from,
    to_number: `+${owner}`,
    direction: 'outbound',
  })
}

// Points the agent's tools at the tunnel's current address, creating the tools the first time.
export async function syncAgent(publicUrl) {
  const known = fs.existsSync(TOOLS_FILE) ? JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')) : {}
  for (const spec of SPEC) {
    const tool_config = {
      type: 'webhook',
      name: spec.name,
      description: spec.description,
      api_schema: {
        url: `${publicUrl}/tool/${spec.name}`,
        method: 'POST',
        request_headers: { 'x-voice-secret': config.phone.secret },
        request_body_schema: {
          type: 'object',
          properties: {
            ...spec.properties,
            caller: { type: 'string', dynamic_variable: 'system__caller_id' },
            called: { type: 'string', dynamic_variable: 'system__called_number' },
          },
          required: spec.required || [],
        },
      },
    }
    if (known[spec.name]) await eleven('PATCH', `/convai/tools/${known[spec.name]}`, { tool_config })
    else known[spec.name] = (await eleven('POST', '/convai/tools', { tool_config })).id
  }
  fs.writeFileSync(TOOLS_FILE, JSON.stringify(known))
  await eleven('PATCH', `/convai/agents/${config.phone.agentId}`, { conversation_config: { agent: { prompt: { prompt: PROMPT, tool_ids: Object.values(known) } } } })
  console.log(`[voice] הסוכן מחובר דרך ${publicUrl}`)
}

const cloudflared = () =>
  [
    path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ].find((p) => fs.existsSync(p)) || 'cloudflared'

// A quick tunnel has a new address every time it starts, so the agent is re-pointed each time.
function startTunnel() {
  const run = () => {
    const child = spawn(cloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${config.phone.port}`], { windowsHide: true })
    let announced = false
    const onOutput = (data) => {
      const url = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
      if (url && !announced) {
        announced = true
        tunnelUrl = url
        syncAgent(url).catch((e) => console.log(`[voice] ${e.message}`))
      }
    }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)
    child.on('error', (e) => console.log(`[voice] המנהרה לא עלתה: ${e.code === 'ENOENT' ? 'cloudflared לא מותקן' : e.message}`))
    child.on('exit', () => setTimeout(run, 20000))
    process.on('exit', () => child.kill())
  }
  run()
}

export function startVoice() {
  if (!voiceEnabled()) return
  if (!config.phone.secret) saveSettings({ VOICE_SECRET: randomBytes(24).toString('hex') })
  startServer()
  startTunnel()
}

// Rings the owner's phone and connects the call to the voice agent.
export async function callOwner() {
  if (!voiceEnabled()) throw new Error('השיחות הקוליות לא מוגדרות')
  const owner = ownerDigits()
  if (!owner) throw new Error('אין מספר מוגדר לבעלים')
  // With Twilio credentials in .env the call is placed by Twilio, and when it is answered Twilio asks us (through the
  // tunnel) where to send it: to the voice agent.
  if (config.twilio.sid && config.twilio.token) {
    if (!tunnelUrl) throw new Error('המנהרה עוד לא עלתה, נסה שוב בעוד רגע')
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString('base64') },
      body: new URLSearchParams({ To: `+${owner}`, From: config.twilio.from, Url: `${tunnelUrl}/twiml/outbound?key=${config.phone.secret}` }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return
  }
  const list = await eleven('GET', '/convai/phone-numbers')
  const number = (Array.isArray(list) ? list : list.phone_numbers || [])[0]
  if (!number) throw new Error('עדיין לא חיברו מספר טלפון לסוכן ב-ElevenLabs')
  await eleven('POST', '/convai/twilio/outbound-call', { agent_id: config.phone.agentId, agent_phone_number_id: number.phone_number_id, to_number: `+${owner}` })
}
