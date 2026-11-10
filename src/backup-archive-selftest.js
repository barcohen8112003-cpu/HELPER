// Offline proof that the recovery archive (data/inflight-archive.jsonl, src/inflight.js) survives the encrypted
// Drive backup and a restore into a clean folder: every stranded id, the ones still in state.json and the ones that
// already moved to the archive, is recoverable from the restored folder alone. Synthetic data, fixed times, no
// network, no Drive. Also: the archive holds metadata only, the backup never touches the originals, and restore
// still refuses a folder that is not empty (an existing archive there is left as it was).
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-backup-archive-'))
const dir = path.join(root, 'live')
fs.mkdirSync(dir)
process.env.HELPER_DATA_DIR = dir
const envFile = path.join(root, 'test.env')
process.env.HELPER_ENV_FILE = envFile
fs.writeFileSync(envFile, 'LLM_API_KEY=not-a-real-key\n')
const PASS = 'synthetic passphrase'
process.env.BACKUP_PASSPHRASE = PASS

const { state, save } = await import('./store.js')
const inflight = await import('./inflight.js')
const { collect, encrypt } = await import('./backup.js')

// Synthetic traffic: one big boot incident (spills past MAX_ITEMS into the archive) and then enough small stuck
// incidents to make bound() merge the oldest open ones (more spill).
const T0 = Date.UTC(2026, 10, 10, 6, 0, 0)
const wa = (state.wa = {})
const id = (n) => `SYNTH-${String(n).padStart(4, '0')}`
let n = 0
for (let i = 0; i < 130; i++, n++) inflight.track(wa, id(n), T0 + n * 1000, T0 + n * 1000)
inflight.strand(wa, { all: true, now: T0 + 200000 })
for (let k = 0; k < inflight.MAX_INCIDENTS + 5; k++) {
  for (let i = 0; i < 3; i++, n++) inflight.track(wa, id(n), T0 + n * 1000, T0 + n * 1000)
  inflight.strand(wa, { all: true, now: T0 + 300000 + k * 1000 })
}
save()

const all = new Set(Array.from({ length: n }, (_, i) => id(i)))
const archivePath = inflight.ARCHIVE()
const archiveText = fs.readFileSync(archivePath, 'utf8')
const inArchive = new Set(archiveText.split('\n').filter(Boolean).map((l) => JSON.parse(l).id).filter(Boolean))
const inState = new Set(wa.recovery.flatMap((r) => (r.items || []).map((x) => x.id)))
ok(inArchive.size > 0 && inState.size > 0, `ids live in both places (state ${inState.size}, archive ${inArchive.size})`)
const archiveOnly = [...inArchive].filter((x) => !inState.has(x))
ok(archiveOnly.length > 0, `${archiveOnly.length} ids exist only in the archive: without it a restore would lose them`)
ok(wa.recovery.length <= inflight.MAX_INCIDENTS, 'state stays bounded')
const before = inflight.recoverableIds(wa)
ok(before.size === all.size && [...all].every((x) => before.has(x)), `all ${all.size} synthetic ids recoverable before the backup`)

const allowed = new Set(['incident', 'id', 'sentAt', 'receivedAt', 'closed', 'count', 'handedKey', 'deliveredAt'])
ok(
  archiveText.split('\n').filter(Boolean).every((l) => Object.keys(JSON.parse(l)).every((k) => allowed.has(k))),
  'the archive holds metadata only (no message text field)',
)

// A line cut short by a crash stays in the archive; it must travel as is and must not hide anything.
fs.appendFileSync(archivePath, '{"incident":"boot-x","id":"SYN')
const archiveBytes = fs.readFileSync(archivePath)
const stateBytes = fs.readFileSync(path.join(dir, 'state.json'))

const files = collect(dir, envFile)
ok(files['data/inflight-archive.jsonl'], 'the recovery archive is in the backup')
ok(Buffer.from(files['data/inflight-archive.jsonl'], 'base64').equals(archiveBytes), 'the archive is backed up byte for byte (broken tail line included)')
ok(Buffer.from(files['data/state.json'], 'base64').equals(stateBytes), 'state.json is backed up byte for byte')
const keys = Object.keys(files)
ok(keys.indexOf('data/state.json') < keys.indexOf('data/inflight-archive.jsonl'), 'state.json is read before the archive')
ok(!keys.some((k) => !/^data\/(state\.json|inflight-archive\.jsonl)$|^env\/\.env$/.test(k)), 'nothing else is collected from this data folder: ' + keys.join(', '))

const blob = encrypt(files, PASS)
ok(!blob.includes(Buffer.from(archiveOnly[0])) && !blob.includes(Buffer.from('SYNTH-')), 'no id is readable in the encrypted file')
const hbk = path.join(root, 'b.hbk')
fs.writeFileSync(hbk, blob)
ok(fs.readFileSync(archivePath).equals(archiveBytes) && fs.readFileSync(path.join(dir, 'state.json')).equals(stateBytes), 'the backup leaves the originals as they were')

const restore = (target, pass = PASS) =>
  spawnSync(process.execPath, ['scripts/restore-backup.mjs', hbk, target], { env: { ...process.env, BACKUP_PASSPHRASE: pass }, encoding: 'utf8' })

// Wrong passphrase: refused, nothing written.
const wrongTarget = path.join(root, 'wrong')
const wrong = restore(wrongTarget, 'not it')
ok(wrong.status !== 0 && !fs.existsSync(path.join(wrongTarget, 'data')), 'a wrong passphrase restores nothing')

// Clean isolated destination.
const target = path.join(root, 'restored')
const run = restore(target)
ok(run.status === 0, 'restore runs: ' + run.stdout + run.stderr)
ok(/inflight-archive\.jsonl/.test(run.stdout), 'restore says the archive came back: ' + run.stdout.trim())
const restoredArchive = path.join(target, 'data', 'inflight-archive.jsonl')
ok(fs.readFileSync(restoredArchive).equals(archiveBytes), 'restored archive is identical')
ok(fs.readFileSync(path.join(target, 'data', 'state.json')).equals(stateBytes), 'restored state.json is identical')
const restoredWa = JSON.parse(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8')).wa
const after = inflight.recoverableIds(restoredWa, restoredArchive)
ok(after.size === all.size && [...all].every((x) => after.has(x)), `all ${all.size} ids recoverable from the restored folder`)

// The way Helper itself would read it: a fresh process with HELPER_DATA_DIR pointed at the restored data folder,
// default archive path, state loaded by store.js.
const probe = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', "const { state } = await import('./src/store.js'); const i = await import('./src/inflight.js'); console.log(JSON.stringify([...i.recoverableIds(state.wa)].sort()))"],
  { env: { ...process.env, HELPER_DATA_DIR: path.join(target, 'data'), HELPER_ENV_FILE: path.join(target, 'env', '.env') }, encoding: 'utf8' },
)
ok(probe.status === 0, 'a fresh process opens the restored folder: ' + probe.stderr)
const seen = JSON.parse(probe.stdout.trim().split('\n').pop())
ok(seen.length === all.size && seen.every((x) => all.has(x)), `a fresh process over the restored folder recovers all ${all.size} ids`)

// Never overwrite: a destination that already has an archive is refused and its archive is left alone.
const busy = path.join(root, 'busy')
fs.mkdirSync(path.join(busy, 'data'), { recursive: true })
fs.writeFileSync(path.join(busy, 'data', 'inflight-archive.jsonl'), 'keep me\n')
const again = restore(busy)
ok(again.status !== 0, 'restore refuses a folder that is not empty')
ok(fs.readFileSync(path.join(busy, 'data', 'inflight-archive.jsonl'), 'utf8') === 'keep me\n', 'an existing archive there is not overwritten')
const twice = restore(target)
ok(twice.status !== 0 && fs.readFileSync(restoredArchive).equals(archiveBytes), 'restoring twice into the same folder is refused')

// An older backup without the archive still restores, and says the archive is missing.
const oldFiles = { ...files }
delete oldFiles['data/inflight-archive.jsonl']
fs.writeFileSync(hbk, encrypt(oldFiles, PASS))
const oldRun = restore(path.join(root, 'old'))
ok(oldRun.status === 0 && /אין בגיבוי ארכיון/.test(oldRun.stdout), 'a backup without the archive says so on restore')

fs.rmSync(root, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, 0 נכשלו`)
