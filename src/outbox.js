import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR } from './config.js'
import { state, save } from './store.js'

const SENT_LOG = path.join(DATA_DIR, 'sent.log')
const MAX_OUTBOX = 100
const MAX_KEYS = 500

export function inQuietHours(date = new Date()) {
  if (!config.quiet) return false
  const { from, to } = config.quiet
  const now = date.getHours() * 60 + date.getMinutes()
  return from > to ? now >= from || now < to : now >= from && now < to
}

// Proactive messages go through here so none is lost while WhatsApp is offline,
// and non-urgent ones wait out quiet hours. `send(text)` must throw if delivery fails.
//
// Delivery is at-least-once: a message leaves the queue only after `send` accepted it, so a crash in the
// instant between sending and saving can repeat that one message after restart. It is never dropped.
export function createOutbox(send) {
  let flushing = false

  // Sends what may go out now. A message stays queued until `send` has accepted it.
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      while (state.owner) {
        const i = state.outbox.findIndex((m) => m.urgent || !inQuietHours())
        if (i < 0) break
        await send(state.outbox[i].text)
        // A plain record of every message the assistant sent on its own initiative, and when.
        fs.appendFileSync(SENT_LOG, `${new Date().toLocaleString('sv-SE')} ${state.outbox[i].urgent ? '[urgent] ' : ''}${state.outbox[i].text.replace(/\n/g, ' | ')}\n`)
        state.outbox.splice(i, 1)
        save()
      }
    } catch {
      // Not connected right now; the next flush picks it up.
    } finally {
      flushing = false
    }
  }

  // `key` names the event behind the message (a reminder firing, an assignment appearing). An event that was
  // already queued or sent is ignored, so a repeated check or a restart cannot announce the same thing twice.
  function notify(text, urgent = false, key) {
    if (key) {
      if (state.sentKeys.includes(key)) return Promise.resolve()
      state.sentKeys = [...state.sentKeys, key].slice(-MAX_KEYS)
    }
    state.outbox.push({ text, urgent })
    if (state.outbox.length > MAX_OUTBOX) state.outbox.shift()
    save()
    return flush()
  }

  return { notify, flush }
}
