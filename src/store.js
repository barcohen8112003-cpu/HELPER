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
  sessions: {}, // { [id]: { history, summary } }: side conversations, such as the voice app, kept apart from the WhatsApp chat
  mail: { uids: {}, lastPoll: 0 }, // uids: last seen uid per mailbox
  calendar: { seen: null, lastPoll: 0 }, // seen: event uids already reported
  health: {}, // { [source]: { fails, down } } for mail and Classroom connections
  homework: { seen: null, nudged: [], open: [], lastPoll: 0 }, // seen/nudged: assignment ids; open: unsubmitted, cached for the brief
  sentKeys: [], // event keys already announced, so nothing is announced twice
  wa: { seen: [], lastAt: 0 }, // WhatsApp message ids already handled, and the time of the newest one
  outbox: [], // { text, urgent } waiting for WhatsApp to be connected or for quiet hours to end
  voiceMode: 'match', // 'match': a voice reply only to a voice message; 'always': a voice reply to everything
  modelOverride: '', // model pinned with /model, until /model default or /new
  summary: '', // rolling summary of conversation that no longer fits in history
  brief: { lastDate: '' },
  news: { lastDate: '' },
  nextId: 1,
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

export const state = { ...defaults, ...load() }

export function save() {
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, FILE)
}

export const newId = () => state.nextId++
