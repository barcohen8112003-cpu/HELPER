import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

const FILE = path.join(DATA_DIR, 'state.json')

const defaults = {
  owner: null, // { jid, jids, self, selfChat }
  manualPair: false, // set by /unpair: wait for a pairing code instead of pairing with the self-chat
  memory: [], // { id, fact }
  reminders: [], // { id, text, at, repeat }
  tasks: [], // { id, instruction, at, repeat }: scheduled runs of the agent itself
  watchers: [], // { id, name, url, instruction, intervalMin, lastValue, lastRun }
  history: [],
  mail: { uids: {}, lastPoll: 0 }, // uids: last seen uid per mailbox
  calendar: { seen: null, lastPoll: 0 }, // seen: event uids already reported
  health: {}, // { [source]: { fails, down } } for mail and Classroom connections
  homework: { seen: null, nudged: [], open: [], lastPoll: 0 }, // seen/nudged: assignment ids; open: unsubmitted, cached for the brief
  discordOutbox: [], // { text, speak, at }: messages waiting for the Discord bot to collect and deliver
  bridgeSeenAt: 0, // when the Discord bot last called the bridge
  sentKeys: [], // event keys already announced, so nothing is announced twice
  inbox: [], // { id, text, at, answered, how, alerted }: his last chat messages and whether each got an answer (src/inbox.js)
  lessons: { fetchedAt: 0, week: [] }, // the Webtop timetable: [{ day, lesson, subject, teacher, room, cancelled }]
  webtopLoginOpen: false, // a re-login notice was already sent for the current signed-out stretch
  webtopLoginNotifiedAt: 0, // last WhatsApp notice, so a flapping session cannot send another inside the gap
  googleHomeLoginOpen: false,
  googleHomeLoginNotifiedAt: 0,
  contacts: {}, // { [jid]: name }: WhatsApp contacts, so "send Dani..." can find Dani's number
  wa: { seen: [], lastAt: 0 }, // WhatsApp message ids already handled, and the time of the newest one
  outbox: [], // { text, urgent } waiting for WhatsApp to be connected or for quiet hours to end
  voiceMode: 'match', // 'match': a voice reply only to a voice message; 'always': a voice reply to everything
  modelOverride: '', // model pinned with /model, until /model default or /new
  summary: '', // rolling summary of conversation that no longer fits in history
  brief: { lastDate: '' },
  news: { lastDate: '' },
  classroomWork: {}, // { [workId]: { status, title, course, account, courseId, dir, file, error, at } }: Classroom assignments sent to Gemini
  classroomPaused: false, // /classroom pause: new assignments are noted but not started
  fileOutbox: [], // { path, name, mime, caption, at }: files waiting for WhatsApp to be connected
  location: null, // { lat, lng, address, city, live, at }: the last location the user shared in WhatsApp
  phoneAppNotes: {}, // { [package]: [note] }: where things live in each phone app, learned by run_on_phone
  nextId: 1,
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    // The file exists but cannot be read. Starting empty would silently erase memory, reminders and tasks on the
    // next save, so the damaged file is kept aside and the newest daily backup is used instead.
    try {
      fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`)
    } catch {}
    console.error(`[store] state.json פגום (${e.message}); משחזר מגיבוי`)
    for (const name of backups().reverse()) {
      try {
        return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'))
      } catch {}
    }
    return {}
  }
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const KEEP_BACKUPS = 7
const backups = () => {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((n) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()
  } catch {
    return []
  }
}

// One copy of the previous state per day, the last week kept. Best effort: a failed backup never blocks a save.
function backupOncePerDay() {
  try {
    const name = `state-${new Date().toISOString().slice(0, 10)}.json`
    if (!fs.existsSync(FILE) || fs.existsSync(path.join(BACKUP_DIR, name))) return
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.copyFileSync(FILE, path.join(BACKUP_DIR, name))
    for (const old of backups().slice(0, -KEEP_BACKUPS)) fs.unlinkSync(path.join(BACKUP_DIR, old))
  } catch {}
}

export const state = { ...defaults, ...load() }

export function save() {
  backupOncePerDay()
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, FILE)
}

export const newId = () => state.nextId++
