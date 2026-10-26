// node src/google-docs-selftest.js
// Offline: docs_create and drive_send_file against a stand-in Google. A Docs file is uploaded as right-to-left HTML
// made from the Markdown, a Sheet as CSV, the link comes back, and a Drive file reaches the chat.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-docs-'))
process.env.GOOGLE_CLIENT_ID = 'test-client'
process.env.GOOGLE_CLIENT_SECRET = 'test-secret'

const { config } = await import('./config.js')
// The .env file may already name a read-only school account; the test uses that one, or its own.
if (!config.google.readOnly.length) config.google.readOnly.push('school@example.com')
const SCHOOL = config.google.readOnly[0]
const google = await import('./google.js')
const { googleTools } = await import('./google-tools.js')
google.saveAccount('naor@example.com', 'refresh-1')
google.saveAccount(SCHOOL, 'refresh-2')

let passed = 0
let failed = 0
const ok = (cond, name) => (cond ? passed++ : (failed++, console.log('FAIL', name)))
const tool = (name) => googleTools.find((t) => t.name === name)

const sent = []
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  sent.push({ url, opts })
  const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v), arrayBuffer: async () => new ArrayBuffer(0) })
  if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token-1', expires_in: 3600 })
  if (url.includes('/upload/drive/v3/files')) return json({ id: 'f1', name: 'סיכום מבוא מדעי', webViewLink: 'https://docs.google.com/document/d/f1/edit' })
  if (url.includes('/drive/v3/files/f2?fields')) return json({ name: 'עבודה.pdf', mimeType: 'application/pdf', size: '4' })
  if (url.includes('/drive/v3/files/f2?alt=media')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }
  return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }
}

const made = await tool('docs_create').run({ title: 'סיכום מבוא מדעי', content: '# פרק 1\n- **תא** הוא יחידת החיים\nשורה רגילה' })
ok(made.includes('https://docs.google.com/document/d/f1/edit'), 'the new document comes back as a link')
const up = sent.find((s) => s.url.includes('/upload/drive/v3/files'))
const body = up.opts.body.toString('utf8')
ok(up.opts.headers.Authorization === 'Bearer token-1', 'the upload is signed with the account token')
ok(body.includes('"mimeType":"application/vnd.google-apps.document"'), 'it becomes a Google Docs file')
ok(body.includes('<h1 dir="rtl">פרק 1</h1>') && body.includes('<b>תא</b>') && body.includes('<body dir="rtl">'), 'the Markdown becomes right-to-left headings and bold')

sent.length = 0
await tool('docs_create').run({ title: 'ציונים', content: 'מקצוע,ציון\nמתמטיקה,95', kind: 'sheet' })
const sheet = sent.find((s) => s.url.includes('/upload/drive/v3/files')).opts.body.toString('utf8')
ok(sheet.includes('application/vnd.google-apps.spreadsheet') && sheet.includes('text/csv') && sheet.includes('מתמטיקה,95'), 'a table becomes a Google Sheet from CSV')

let refused = ''
try { await tool('docs_create').run({ title: 'x', content: 'y', account: SCHOOL }) } catch (e) { refused = e.message }
ok(refused.includes('לקריאה בלבד'), 'a read-only school account is never written to')

const media = []
const out = await tool('drive_send_file').run({ account: 'naor@example.com', id: 'f2' }, { sendMedia: async (m) => media.push(m) })
ok(out.includes('עבודה.pdf') && media[0]?.name === 'עבודה.pdf' && media[0].buffer.length === 4, 'a Drive file is sent into the chat')

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
