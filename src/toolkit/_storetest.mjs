// node src/toolkit/_storetest.mjs corrupt|fresh   (temp data dir only; never touches the live data folder)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] || 'fresh'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-store-'))
process.env.HELPER_DATA_DIR = dir
if (mode === 'corrupt') {
  fs.mkdirSync(path.join(dir, 'backups'))
  fs.writeFileSync(path.join(dir, 'backups', 'state-2026-01-01.json'), JSON.stringify({ memory: [{ id: 1, fact: 'from-backup' }] }))
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken')
}
const store = await import('../store.js')
console.log(mode, 'memory:', JSON.stringify(store.state.memory))
store.save()
store.save()
const backupDir = path.join(dir, 'backups')
console.log('files:', fs.readdirSync(dir).join(' '), '| backups:', fs.existsSync(backupDir) ? fs.readdirSync(backupDir).join(' ') : '-')
