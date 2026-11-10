import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR } from './config.js'
import { state, save } from './store.js'

const SENT_LOG = path.join(DATA_DIR, 'sent.log')
const MAX_OUTBOX = 100
const MAX_KEYS = 500
const MAX_FILES = 30
const MAX_LEDGER = 500

// For keyed messages only, a bounded record of what happened to each one: sent (send accepted it) or evicted (the
// queue was full and it was pushed out unsent). A caller that must know its notice really left (recovery notices,
// src/recovery-notice.js) reads these instead of guessing from a key's absence. Nothing else changes: delivery
// stays at-least-once, and the cap still pushes out the oldest message.
function ledger(name, key) {
  if (!key) return
  state[name] = [...(state[name] || []), key].slice(-MAX_LEDGER)
}

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
//
// `sendFile({ buffer, mime, name, caption })` delivers a document the same way. Queued files are kept as a path on
// disk, not as bytes in the state file, and wait out quiet hours like any other non-urgent message.
export function createOutbox(send, sendFile) {
  let flushing = false

  // Sends what may go out now. A message stays queued until `send` has accepted it.
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      while (state.owner) {
        const i = state.outbox.findIndex((m) => m.urgent || !inQuietHours())
        if (i < 0) break
        // The message itself, not its position: while send is awaited, notify can push the queue past its cap and
        // shift everything by one, so state.outbox[i] may be another message by the time send returns.
        const m = state.outbox[i]
        await send(m.text)
        // A plain record of every message the assistant sent on its own initiative, and when.
        fs.appendFileSync(SENT_LOG, `${new Date().toLocaleString('sv-SE')} ${m.urgent ? '[urgent] ' : ''}${m.text.replace(/\n/g, ' | ')}\n`)
        ledger('outboxSent', m.key)
        // Taken out only if it is still queued; if the cap pushed it out meanwhile, it already left the queue.
        const j = state.outbox.indexOf(m)
        if (j >= 0) state.outbox.splice(j, 1)
        save()
      }
      state.fileOutbox ??= []
      while (state.owner && sendFile && state.fileOutbox.length && !inQuietHours()) {
        const f = state.fileOutbox[0]
        // A file that was deleted in the meantime cannot be sent; it is dropped, not retried forever.
        if (fs.existsSync(f.path)) {
          await sendFile({ buffer: fs.readFileSync(f.path), mime: f.mime, name: f.name, caption: f.caption })
          fs.appendFileSync(SENT_LOG, `${new Date().toLocaleString('sv-SE')} [file] ${f.name}${f.caption ? ` | ${f.caption.replace(/\n/g, ' | ')}` : ''}\n`)
        }
        state.fileOutbox.shift()
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
    // The key travels with the message, so a caller can tell whether its notice is still waiting here.
    state.outbox.push({ text, urgent, ...(key && { key }) })
    if (state.outbox.length > MAX_OUTBOX) ledger('outboxEvicted', state.outbox.shift().key)
    save()
    return flush()
  }

  // Queues a file that is already on disk: { path, name, mime, caption }.
  function notifyFile(file) {
    state.fileOutbox ??= []
    state.fileOutbox.push({ ...file, at: Date.now() })
    if (state.fileOutbox.length > MAX_FILES) state.fileOutbox.shift()
    save()
    return flush()
  }

  return { notify, notifyFile, flush }
}
