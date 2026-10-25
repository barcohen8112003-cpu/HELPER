#!/usr/bin/env node
// The helper command: everything about setting HELPER up and keeping it running, from any folder.
//   helper onboard      the setup wizard (also: helper setup)
//   helper doctor       what is set up, what is missing, and what to do about it
//   helper start        starts the bot and HELPER for Windows (helper start bot | helper start desktop)
//   helper update       the latest version from GitHub, its packages, and a check
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import * as L from './setup/lib.mjs'
import * as U from './setup/ui.mjs'

const { ROOT, DESKTOP, IS_WIN } = L
const [cmd = 'help', ...rest] = process.argv.slice(2)

function setup(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.mjs'), ...args], { stdio: 'inherit', cwd: ROOT })
  process.exit(r.status ?? 1)
}

async function doctor() {
  const online = rest.includes('--online')
  const s = L.state()
  const r = L.running()
  let problems = 0
  const row = (good, text, fix) => { if (good === null) U.info(text); else if (good) U.ok(text); else { problems++; U.bad(text); if (fix) U.info('→ ' + fix) } }
  U.banner(['HELPER doctor'])
  U.say(U.c.bold('  המחשב'))
  row(s.nodeOk, `Node.js ${s.node}`, 'צריך 24 ומעלה: winget install OpenJS.NodeJS.LTS')
  row(s.git ? true : null, s.git ? 'Git' : 'Git לא מותקן (רק helper update צריך אותו)')
  row(s.claude ? true : null, s.claude ? 'Claude Code מותקן' : 'Claude Code לא מותקן (לא חובה)')
  U.say(U.c.bold('  הבוט'))
  row(s.envFile, '.env', 'helper onboard')
  const prov = L.providerOf(s.model.base)
  row(s.model.key && Boolean(s.model.model), s.model.key ? `מודל: ${s.model.model} אצל ${prov.id === 'custom' ? s.model.base : prov.name.split(' (')[0]}` : 'אין מפתח מודל', 'helper onboard')
  if (online && s.model.key) {
    const res = await L.checkModel({ base: s.model.base, key: s.env.LLM_API_KEY, model: s.model.model })
    row(res.ok, res.ok ? 'המפתח עובד מול הספק' : res.reason, 'helper onboard')
  }
  row(s.botDeps, 'החבילות של הבוט', 'npm install (או helper onboard)')
  row(s.whatsapp ? true : null, s.whatsapp ? 'וואטסאפ מקושר' : 'וואטסאפ עוד לא מקושר: helper start bot וסורקים את ה-QR')
  row(r.bot ? true : null, r.bot ? 'הבוט רץ על המחשב הזה' : 'הבוט לא רץ על המחשב הזה (אולי בענן)')
  if (IS_WIN) row(s.autostart ? true : null, s.autostart ? 'הבוט עולה עם Windows' : 'הבוט לא עולה לבד עם Windows')
  if (IS_WIN) {
    U.say(U.c.bold('  HELPER למחשב'))
    row(s.desktopDeps, 'מותקן', 'helper onboard --parts=desktop')
    row(s.speech.server && s.speech.model, s.speech.server && s.speech.model ? 'מנוע הדיבור בעברית' : 'אין מנוע דיבור: אפשר להקליד, לא לדבר', 'helper onboard --parts=desktop,speech')
    row(s.cloud.token ? true : null, s.cloud.token ? `מחובר לענן: ${s.cloud.url}` : 'לא מחובר ל-HELPER בענן (לא חובה)')
    row(r.desktop ? true : null, r.desktop ? 'רץ עכשיו: לוחצים PD ומדברים' : 'לא רץ עכשיו: helper start desktop')
  }
  U.say('')
  U.say(problems ? U.c.yellow(`  ${problems} דברים לתקן (הפקודה ליד כל אחד)`) : U.c.green('  הכל תקין'))
  process.exit(problems ? 1 : 0)
}

function start() {
  const which = rest[0] || 'all'
  const s = L.state()
  const r = L.running()
  if ((which === 'all' || which === 'desktop') && IS_WIN) {
    if (!s.desktopDeps) U.bad('HELPER למחשב לא מותקן: helper onboard')
    else if (r.desktop) U.ok('HELPER למחשב כבר רץ')
    else { spawn(path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'), [DESKTOP], { cwd: DESKTOP, detached: true, stdio: 'ignore' }).unref(); U.ok('HELPER למחשב עלה') }
  }
  if (which === 'all' || which === 'bot') {
    if (!s.model.key) U.bad('אין מפתח מודל: helper onboard')
    else if (r.bot) U.ok('הבוט כבר רץ')
    else if (IS_WIN) { spawn('cmd.exe', ['/c', 'start', '"HELPER"', path.join(ROOT, 'start.bat')], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref(); U.ok('הבוט עלה בחלון משלו') }
    else { const p = spawnSync(process.execPath, ['src/index.js'], { cwd: ROOT, stdio: 'inherit' }); process.exit(p.status ?? 0) }
  }
}

function update() {
  const step = (args, cwd = ROOT) => { U.info('$ ' + args.join(' ')); return spawnSync(args[0], args.slice(1), { cwd, stdio: 'inherit', shell: IS_WIN }).status === 0 }
  if (!fs.existsSync(path.join(ROOT, '.git'))) { U.bad('זו לא תיקיית git: מורידים מחדש עם install.ps1'); process.exit(1) }
  if (!step(['git', 'pull', '--ff-only'])) { U.bad('git pull נכשל (שינויים מקומיים?). לא נגעתי בכלום אחר.'); process.exit(1) }
  step(['npm', 'install', '--no-audit', '--no-fund'])
  if (fs.existsSync(path.join(DESKTOP, 'node_modules'))) step(['npm', 'install', '--no-audit', '--no-fund'], DESKTOP)
  U.ok('עודכן. אם משהו רץ, מפעילים אותו מחדש כדי שיקבל את הגרסה החדשה.')
}

function help() {
  U.say(`
  ${U.c.bold('helper')} — HELPER, העוזר האישי

    helper onboard     אשף ההתקנה: מפתחות, התקנה, דיבור, הפעלה עם Windows   (גם: helper setup)
    helper doctor      מה מותקן, מה חסר ואיך מתקנים   (--online בודק גם את המפתח מול הספק)
    helper start       מפעיל את הבוט ואת HELPER למחשב   (helper start bot / helper start desktop)
    helper update      הגרסה האחרונה מ-GitHub והחבילות שלה

  לאשף בלי שאלות: helper onboard --yes --api-key=... (שאר הדגלים: node scripts/setup.mjs --help)
`)
}

switch (cmd) {
  case 'onboard': case 'setup': case 'install': setup(rest); break
  case 'doctor': case 'status': await doctor(); break
  case 'start': start(); break
  case 'update': update(); break
  case '--help': case '-h': case 'help': help(); break
  default: U.bad('פקודה לא מוכרת: ' + cmd); help(); process.exit(2)
}
