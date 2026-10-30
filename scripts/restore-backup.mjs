// Unpacks a Helper backup (.hbk, downloaded from the "Helper backups" folder in Google Drive) into a folder.
//   node scripts/restore-backup.mjs <file.hbk> <target folder>
// It asks for the backup passphrase (or reads BACKUP_PASSPHRASE). The target gets data/ (point HELPER_DATA_DIR at
// it, or copy it into the data volume) and env/.env (the settings). Nothing is overwritten: the folder must be empty.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { decrypt } from '../src/backup.js'

const [file, target] = process.argv.slice(2)
if (!file || !target) {
  console.log('שימוש: node scripts/restore-backup.mjs <file.hbk> <target folder>')
  process.exit(1)
}
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.log(`התיקייה ${target} לא ריקה. בחר תיקייה חדשה, כדי שלא יידרס כלום.`)
  process.exit(1)
}
let pass = process.env.BACKUP_PASSPHRASE
if (!pass) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  pass = await rl.question('סיסמת הגיבוי: ')
  rl.close()
}
const backup = decrypt(fs.readFileSync(file), pass)
for (const [rel, data] of Object.entries(backup.files)) {
  const out = path.resolve(target, rel)
  if (!out.startsWith(path.resolve(target) + path.sep)) throw new Error(`נתיב לא תקין בגיבוי: ${rel}`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(data, 'base64'))
}
console.log(`שוחזרו ${Object.keys(backup.files).length} קבצים מגיבוי של ${backup.createdAt} אל ${target}`)
