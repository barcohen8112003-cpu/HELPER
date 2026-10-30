// Daily encrypted backup of what Helper cannot rebuild by itself (memory, reminders, connected accounts, the WhatsApp
// session, settings), uploaded to the owner's Google Drive. Without it, losing the server loses all of that.
//
// The file is encrypted here with BACKUP_PASSPHRASE before it leaves the server (scrypt + AES-256-GCM), so Google
// only ever holds ciphertext. Drive access uses the drive.file scope: Helper sees only the files it created.
// Restore: node scripts/restore-backup.mjs <file.hbk> <target folder>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { config, DATA_DIR, ENV_FILE } from './config.js'
import { state, save } from './store.js'
import { accessToken, googleAccounts } from './google.js'

const MAGIC = Buffer.from('HELPERBK1')
const FOLDER = 'Helper backups'
const KEEP = 14
const EVERY_MS = 24 * 3600 * 1000

// Small files only: browser profiles, the VM and old local backups are large and can be rebuilt.
const FILES = ['state.json', 'google.json', 'watch-state.json', 'voice-tools.json']
const DIRS = ['auth', 'audit']

export const backupEnabled = () => Boolean(config.backup.passphrase && backupAccount())

// The account the backup goes to: BACKUP_GOOGLE_ACCOUNT, else the first connected account that is not read-only.
export function backupAccount() {
  const all = googleAccounts()
  if (config.backup.account) return all.includes(config.backup.account) ? config.backup.account : ''
  return all.find((a) => !config.google.readOnly.includes(a.toLowerCase())) || ''
}

function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64')
  }
}

// { 'data/state.json': base64, ..., 'env/.env': base64 }
export function collect(dataDir = DATA_DIR, envFile = ENV_FILE) {
  const files = {}
  for (const name of FILES) {
    const full = path.join(dataDir, name)
    if (fs.existsSync(full)) files[`data/${name}`] = fs.readFileSync(full).toString('base64')
  }
  for (const name of DIRS) {
    const inner = {}
    walk(path.join(dataDir, name), dataDir, inner)
    for (const [rel, data] of Object.entries(inner)) files[`data/${rel}`] = data
  }
  if (fs.existsSync(envFile)) files['env/.env'] = fs.readFileSync(envFile).toString('base64')
  return files
}

export function encrypt(files, passphrase, meta = {}) {
  const plain = zlib.gzipSync(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), ...meta, files }))
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export function decrypt(buf, passphrase) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('זה לא קובץ גיבוי של Helper')
  let at = MAGIC.length
  const salt = buf.subarray(at, (at += 16))
  const iv = buf.subarray(at, (at += 12))
  const tag = buf.subarray(at, (at += 16))
  const key = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plain
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()])
  } catch {
    throw new Error('הסיסמה שגויה, או שהקובץ נפגם')
  }
  return JSON.parse(zlib.gunzipSync(plain))
}

async function drive(email, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await accessToken(email)}`, ...init.headers }, signal: AbortSignal.timeout(60000) })
  if (res.status === 403 && /insufficient/i.test(await res.clone().text())) {
    throw Object.assign(new Error(`לחשבון ${email} אין עדיין הרשאה לשמור קבצים ב-Drive`), { hint: `צריך לחבר מחדש את ${email} באתר ההגדרות (Google Workspace, "הוסף חשבון") ולאשר את כל ההרשאות.` })
  }
  if (!res.ok) throw new Error(`Drive HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? null : res.json()
}

const q = (s) => encodeURIComponent(s)

async function folderId(email) {
  const found = await drive(email, `https://www.googleapis.com/drive/v3/files?q=${q(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`)
  if (found.files?.[0]) return found.files[0].id
  const made = await drive(email, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  })
  return made.id
}

async function upload(email, parent, name, data) {
  const boundary = 'helper' + randomBytes(8).toString('hex')
  const meta = JSON.stringify({ name, parents: [parent], mimeType: 'application/octet-stream' })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return drive(email, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
}

// Keeps the newest KEEP backups in the folder and deletes the rest.
async function prune(email, parent) {
  const list = await drive(email, `https://www.googleapis.com/drive/v3/files?q=${q(`'${parent}' in parents and trashed=false`)}&orderBy=createdTime desc&fields=files(id,name)&pageSize=100`)
  for (const f of (list.files || []).slice(KEEP)) await drive(email, `https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' })
}

// Runs one backup now. Returns a short Hebrew line; throws with a Hebrew message (and a `hint`) on failure.
export async function runBackup() {
  if (!config.backup.passphrase) throw new Error('אין סיסמת גיבוי. צריך למלא אותה באתר ההגדרות, בכרטיס "גיבוי".')
  const email = backupAccount()
  if (!email) throw new Error('אין חשבון Google לגיבוי. צריך לחבר חשבון שלא מסומן "קריאה בלבד".')
  const files = collect()
  const data = encrypt(files, config.backup.passphrase, { bot: config.botName })
  const parent = await folderId(email)
  const name = `helper-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.hbk`
  await upload(email, parent, name, data)
  await prune(email, parent).catch((e) => console.log(`[backup] ניקוי גיבויים ישנים: ${e.message}`))
  state.backup = { lastOk: Date.now(), lastError: '', fails: 0, size: data.length, account: email }
  save()
  return `גיבוי נשמר ב-Drive של ${email} (${Math.round(data.length / 1024)}KB, ${Object.keys(files).length} קבצים)`
}

// Called every hour; backs up once a day. Tells the owner once after two failures in a row, and once when it recovers.
export async function backupTick(notify) {
  if (!backupEnabled()) return
  const b = (state.backup ??= { lastOk: 0, lastError: '', fails: 0 })
  const lastTry = b.lastTry || 0
  if (Date.now() - Math.max(b.lastOk || 0, lastTry) < (b.fails ? 3600 * 1000 : EVERY_MS)) return
  b.lastTry = Date.now()
  try {
    await runBackup()
    if (b.fails >= 2) await notify('✅ הגיבוי היומי ל-Drive חזר לעבוד.')
  } catch (e) {
    b.fails = (b.fails || 0) + 1
    b.lastError = e.message
    state.backup = { ...b, lastTry: b.lastTry }
    save()
    console.log(`[backup] ${e.message}`)
    if (b.fails === 2) await notify(`⚠️ הגיבוי היומי ל-Drive לא עובד: ${e.message} ${e.hint || ''}`.trim())
  }
}
