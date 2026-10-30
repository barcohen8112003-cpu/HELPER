// Offline checks for the Drive backup: what goes in, encryption round trip, wrong passphrase, restore, and that the
// account choice respects read-only accounts. No network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let passed = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  passed++
}

const dir = process.env.HELPER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'helper-backup-'))
process.env.HELPER_DATA_DIR = dir
const envFile = path.join(dir, 'test.env')
process.env.HELPER_ENV_FILE = envFile
fs.writeFileSync(envFile, 'LLM_API_KEY=secret-key\n')
process.env.BACKUP_PASSPHRASE = 'correct horse'
process.env.GOOGLE_CLIENT_ID = 'id'
process.env.GOOGLE_CLIENT_SECRET = 'secret'
process.env.GOOGLE_READONLY_ACCOUNTS = 'school@x.com'
fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ 'school@x.com': { refresh_token: 'r0' }, 'a@x.com': { refresh_token: 'r' } }))
fs.mkdirSync(path.join(dir, 'auth'), { recursive: true })
fs.writeFileSync(path.join(dir, 'auth', 'creds.json'), '{"me":1}')
fs.mkdirSync(path.join(dir, 'webtop-profile'), { recursive: true })
fs.writeFileSync(path.join(dir, 'webtop-profile', 'big.bin'), 'x'.repeat(1000))

const { collect, encrypt, decrypt, runBackup, backupAccount } = await import('./backup.js')
const files = collect(dir, envFile)
ok(files['data/google.json'], 'google.json is backed up')
ok(files['data/auth/creds.json'], 'the WhatsApp session is backed up')
ok(files['env/.env'], 'settings are backed up')
ok(!Object.keys(files).some((k) => k.includes('webtop-profile')), 'browser profiles are left out')

const blob = encrypt(files, 'correct horse')
ok(!blob.includes(Buffer.from('secret-key')) && !blob.includes(Buffer.from('refresh_token')), 'nothing readable in the encrypted file')
const back = decrypt(blob, 'correct horse')
ok(Buffer.from(back.files['env/.env'], 'base64').toString() === 'LLM_API_KEY=secret-key\n', 'round trip keeps the content')
assert.throws(() => decrypt(blob, 'wrong'), /הסיסמה שגויה/)
passed++
assert.throws(() => decrypt(Buffer.from('nope'), 'x'), /לא קובץ גיבוי/)
passed++

const hbk = path.join(dir, 'b.hbk')
fs.writeFileSync(hbk, blob)
const target = path.join(dir, 'restored')
const run = spawnSync(process.execPath, ['scripts/restore-backup.mjs', hbk, target], { env: { ...process.env, BACKUP_PASSPHRASE: 'correct horse' }, encoding: 'utf8' })
ok(run.status === 0, 'restore script runs: ' + run.stdout + run.stderr)
ok(fs.readFileSync(path.join(target, 'data', 'auth', 'creds.json'), 'utf8') === '{"me":1}', 'restore writes the files back')
const again = spawnSync(process.execPath, ['scripts/restore-backup.mjs', hbk, target], { env: { ...process.env, BACKUP_PASSPHRASE: 'correct horse' }, encoding: 'utf8' })
ok(again.status !== 0, 'restore never overwrites a folder that is not empty')

ok(backupAccount() === 'a@x.com', 'the read-only school account is never the backup target')

// Drive, faked: the folder is created once, the file is uploaded encrypted, and only the newest 14 are kept.
const calls = []
const existing = Array.from({ length: 16 }, (_, i) => ({ id: 'old' + i, name: 'helper-old-' + i + '.hbk' }))
globalThis.fetch = async (url, init = {}) => {
  url = String(url)
  calls.push({ url, method: init.method || 'GET', body: init.body })
  const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data), clone() { return this } })
  if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 't', expires_in: 3600 })
  if (url.includes('/upload/drive/v3/files')) return json({ id: 'new', name: 'x', size: '1' })
  if (url.includes("mimeType%3D'application%2Fvnd.google-apps.folder'") || url.includes('mimeType=%27application')) return json({ files: [] })
  if (url.endsWith('/drive/v3/files?fields=id')) return json({ id: 'folder1' })
  if (url.includes('in%20parents') || url.includes('%20in%20parents')) return json({ files: [{ id: 'new' }, ...existing] })
  if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => null, text: async () => '', clone() { return this } }
  return json({ files: [] })
}
const line = await runBackup()
ok(/a@x\.com/.test(line), 'backup reports the account: ' + line)
const up = calls.find((c) => c.url.includes('/upload/'))
ok(up && !up.body.includes(Buffer.from('secret-key')), 'the uploaded body is encrypted')
ok(calls.filter((c) => c.method === 'DELETE').length === 3, 'old backups beyond 14 are deleted')

console.log(`${passed} בדיקות עברו, 0 נכשלו`)
