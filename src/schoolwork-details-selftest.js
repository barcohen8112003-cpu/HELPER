// node src/schoolwork-details-selftest.js
// The homework-details refresh (schoolwork.js refreshHomeworkDetails) when WhatsApp's on-demand group history never
// comes back: it asks at most DETAILS_MAX_TRIES times, then finishes with what was stored live, instead of asking
// every 15 minutes forever. Offline: stand-in fetch, temp data dir, no WhatsApp, no Sheets.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-sw-details-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
process.env.HELPER_OFFLINE = '1'
process.env.SCHOOLWORK_GROUPS = 'מתמטיקה כיתה י'

let ok = true
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info && !cond ? '  ' + String(info).slice(0, 400) : ''}`)
  if (!cond) ok = false
}

const JID = '120363000000000000@g.us'
const T0 = Date.parse('2026-11-15T10:00:00Z')
const writeGroups = () => fs.writeFileSync(path.join(tmp, 'groups.json'), JSON.stringify({
  groups: { [JID]: { name: 'מתמטיקה כיתה י 4', lastAt: T0 / 1000 } },
  buffer: [{ g: JID, id: 'ABCDEF0123456789ABCDEF0123456789', at: Math.floor(T0 / 1000) - 3600, text: 'שיעורי בית', s: 'aaaaaaaaaaaa' }],
  items: [{ id: 'h1', g: JID, type: 'homework', title: 'שיעורי בית במתמטיקה', at: T0 - 3600000, date: '2026-11-18' }],
}))
writeGroups()
const FILE = path.join(tmp, 'schoolwork.json')
const SW = await import('./schoolwork.js')
// Through the module's own store, as the running process sees it (it caches the file).
const setLookback = (lookback) => {
  SW.load().lookback = lookback
  SW.persist()
}
setLookback({ done: true, at: T0 - 86400000, found: 1, pulled: false })
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).lookback

check('the cap is a small number', SW.DETAILS_MAX_TRIES >= 3 && SW.DETAILS_MAX_TRIES <= 10, SW.DETAILS_MAX_TRIES)

// 1. The phone never answers.
let asked = 0
SW.setLookbackFetch(async () => {
  asked++
  return { n: 0, timedOut: true, pulled: false, replies: 0, reason: 'no-reply-from-phone' }
})
let last
for (let round = 0; round < 20; round++) last = await SW.refreshHomeworkDetails(null, T0 + round * 20 * 60000)
check('the phone is asked at most DETAILS_MAX_TRIES times', asked === SW.DETAILS_MAX_TRIES, asked)
check('then the refresh is finished, not retried', last?.details === true && read().details === true, JSON.stringify(read()))
check('it says it gave up and why', read().detailsStatus === 'gave-up' && read().detailsGaveUp === 'no-reply-from-phone', JSON.stringify(read()))
const after = asked
await SW.refreshHomeworkDetails(null, T0 + 30 * 3600000)
check('a finished refresh never asks again', asked === after, asked)
const open = JSON.parse(fs.readFileSync(FILE, 'utf8')).items.filter((i) => i.status === 'open')
check('the homework stored live is still on the list', open.some((i) => i.source === 'groups' && i.title.includes('מתמטיקה')), JSON.stringify(open))

// 2. A state already past the cap (the VPS had detailsTries: 75): finishes at once, no new request.
setLookback({ done: true, details: false, detailsStatus: 'retry', detailsTries: 75, detailsAt: T0 })
asked = 0
await SW.refreshHomeworkDetails(null, T0 + 3600000)
check('a stored state past the cap finishes without asking', asked === 0 && read().details === true && read().detailsGaveUp === 'max-tries', JSON.stringify(read()))

// 3. WhatsApp not connected yet: nothing was asked, so no try is used up.
setLookback({ done: true, details: false, detailsTries: 2, detailsAt: T0 - 3600000 })
SW.setLookbackFetch(null)
await SW.refreshHomeworkDetails(null, T0)
check('a round with WhatsApp not ready does not use up a try', read().detailsTries === 2 && read().details !== true, JSON.stringify(read()))

// 4. History does come back on the next try: finished normally, no give-up.
let calls = 0
SW.setLookbackFetch(async () => (++calls, { n: 4, timedOut: false, pulled: true, replies: 1 }))
await SW.refreshHomeworkDetails(null, T0 + 3600000)
check('a pull that works finishes normally', calls === 1 && read().details === true && read().pulled === true && !read().detailsGaveUp, JSON.stringify(read()))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(ok ? '\nschoolwork-details: all passed' : '\nschoolwork-details: FAILED')
process.exit(ok ? 0 : 1)
