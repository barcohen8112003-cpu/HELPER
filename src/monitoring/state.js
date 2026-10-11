// Everything quiet monitoring knows, in one JSON file that survives a restart.
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

const empty = () => ({
  watches: [], // see newWatch() in registry.js
  pending: [], // sends in flight: { id, event_id, watch_id, text, status: 'sending' | 'failed', created_at }
  delivered: [], // event ids already sent as an interrupt, so the brief does not repeat them
  suspicious: [], // { at, source, title, why } - reported once, in the next brief
  overrides: [], // set from WhatsApp: { kind: 'watch' | 'source' | 'topic', name, mode, until }
  dropped: 0, // events dropped since the last brief
  notes: [], // quiet-hours notices from the rest of the assistant, folded into the brief
  brief: { lastDate: '' },
})

let cache = null

export function load() {
  if (cache) return cache
  const file = config.watch.statePath
  let saved = {}
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      // A damaged file is set aside, not overwritten: it is the only record of what was already seen and sent.
      const aside = `${file}.corrupt-${Date.now()}`
      fs.renameSync(file, aside)
      console.log(`[watch] קובץ המצב היה פגום והועבר ל-${aside}. מתחיל ממצב ריק.`)
    }
  }
  cache = { ...empty(), ...saved }
  return cache
}

// Written to a temporary file and renamed over the real one, so a crash mid-write cannot leave half a file.
export function persist() {
  const file = config.watch.statePath
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(load(), null, 2))
  fs.renameSync(file + '.tmp', file)
}

// Forgets the in-memory copy, so the next load() reads the disk again. A restart, for tests.
export function forget() {
  cache = null
}

// Local time with its UTC offset, e.g. 2026-10-12T09:14:00+03:00. The process runs in Asia/Jerusalem (config.js).
export function iso(date = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`
}
