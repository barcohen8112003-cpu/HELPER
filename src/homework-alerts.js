// One "new homework" alert per homework, across the two pipelines that read the same WhatsApp groups:
// src/schoolwork.js (15:00 list, fed by the groups reader's extraction round) and src/mathwork.js (18:00 math report,
// read at message time). Both still LIST the item in their own daily report; only the immediate alert is shared.
//
// A source message is identified by group + sender hash + message id (both pipelines see the same WhatsApp message),
// and, when an id is missing on one side, by group + sender hash + due day + nearly the same words. Whoever alerts
// first claims it; the other marks its item as already announced.
//
// Stored on this machine only, in data/homework-alerts.json (not in the Drive backup): group id, sender hash, message
// id, due day and at most 160 characters of the homework text, for 21 days.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'
import { similarity } from './schoolwork.js'

const FILE = () => path.join(DATA_DIR, 'homework-alerts.json')
const KEEP_MS = 21 * 86400000
const MAX = 500

let cache = null
function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (!Array.isArray(cache)) cache = []
  } catch {
    cache = []
  }
  return cache
}
function persist() {
  const tmp = FILE() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache))
  fs.renameSync(tmp, FILE())
}
export const _reload = () => void (cache = null)

// ref: { g (group jid), s (sender hash), mid (message id), day ('' if none), text }
const same = (e, ref) => {
  if (!ref?.g || !ref.s || e.g !== ref.g || e.s !== ref.s) return false
  if (e.mid && ref.mid) return e.mid === ref.mid
  return (e.day || '') === (ref.day || '') && similarity(e.text, ref.text) >= 0.5
}

// The claim another pipeline already made for this source message, or null.
export function claimedByOther(ref, by, nowMs = Date.now()) {
  return load().find((e) => e.by !== by && nowMs - e.at < KEEP_MS && same(e, ref)) || null
}

export function claim(ref, by, nowMs = Date.now()) {
  if (!ref?.g || !ref.s) return
  const list = load().filter((e) => nowMs - e.at < KEEP_MS)
  if (!list.some((e) => e.by === by && same(e, ref))) list.push({ g: ref.g, s: ref.s, mid: String(ref.mid || '').slice(0, 64), day: ref.day || '', text: String(ref.text || '').slice(0, 160), by, at: nowMs })
  cache = list.slice(-MAX)
  persist()
}
