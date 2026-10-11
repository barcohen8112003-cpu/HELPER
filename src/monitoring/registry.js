// WatchRegistry: the list of watches and the overrides on top of them.
import { config } from '../config.js'
import { load, persist, iso } from './state.js'

export const MODES = ['interrupt-all', 'batch-all', 'drop-all']

// source: 'mail', 'mail/<account>', 'calendar' or 'calendar/<account>'. An event belongs to a watch when the
//         event's source starts with the watch's.
// trigger: the condition in the user's words. match: the same condition as rules a program can check:
//   { always: true } | { from: [...], keywords: [...], judge: '<what still needs understanding>' }
export function newWatch({ id, source, trigger, match, now = new Date() }) {
  return {
    id,
    source,
    trigger,
    match,
    state: 'active', // 'active' | 'paused' | 'error'
    created_at: iso(now),
    last_event_at: null,
    last_sent_message_id: null,
    pending_batch: [], // { event_id, source, title, at, deadline, topic }
    seen_event_ids: [],
    recent: [], // { at, topic, decision } of the last day, for the "someone is trying to reach me" escalation
    errors: 0,
    stats: { events_seen: 0, interrupts: 0, batched: 0, dropped: 0 },
  }
}

export const watches = () => load().watches
export const findWatch = (id) => watches().find((w) => w.id === id)

export function addWatch(watch) {
  const list = watches()
  let id = watch.id
  for (let n = 2; list.some((w) => w.id === id); n++) id = `${watch.id}-${n}`
  list.push({ ...watch, id })
  persist()
  return id
}

export function setState(id, state) {
  const w = findWatch(id)
  if (!w) return false
  w.state = state
  if (state === 'active') w.errors = 0
  persist()
  return true
}

export function removeWatch(id) {
  const s = load()
  const before = s.watches.length
  s.watches = s.watches.filter((w) => w.id !== id)
  persist()
  return s.watches.length < before
}

// The first run starts with two broad watches, so mail and calendar are covered before any is defined by hand.
// `always` is a deliberate choice here: every event goes on to the urgency decision, which is where they get quiet.
export function seedDefaults(now = new Date()) {
  const s = load()
  if (s.seeded) return
  s.seeded = true
  addWatch(newWatch({ id: 'watch-mail', source: 'mail', trigger: 'כל מייל חדש (always) - מדריך הדחיפות מחליט', match: { always: true }, now }))
  addWatch(newWatch({ id: 'watch-calendar-changes', source: 'calendar', trigger: 'כל אירוע חדש או שינוי ביומן (always)', match: { always: true }, now }))
}

// "gmail:school=interrupt-all@2026-12-01, other=drop-all" -> [{ name, mode, until }]
function parseEnv(value, kind) {
  return value
    .split(',')
    .map((part) => part.trim().match(/^(.+)=(interrupt-all|batch-all|drop-all)(?:@(\S+))?$/))
    .filter(Boolean)
    .map(([, name, mode, until]) => ({ kind, name: name.trim(), mode, until: until || null, from: 'env' }))
}

// Every override in force right now. The ones from .env come first, so they win a tie.
export function activeOverrides(now = new Date()) {
  const live = (o) => !o.until || new Date(o.until) > now
  return [...parseEnv(config.watch.overrideSource, 'source'), ...parseEnv(config.watch.overrideTopic, 'topic'), ...load().overrides.map((o) => ({ ...o, from: 'whatsapp' }))].filter(live)
}

export function setOverride(override) {
  const s = load()
  s.overrides = s.overrides.filter((o) => !(o.kind === override.kind && o.name === override.name))
  if (override.mode !== 'off') s.overrides.push(override)
  persist()
}

// The override that decides this event, if any: one on the watch itself, on its source, or on a topic the text mentions.
export function overrideFor(watch, event, now = new Date()) {
  const text = `${event.title}\n${event.body}`.toLowerCase()
  return activeOverrides(now).find(
    (o) => (o.kind === 'watch' && o.name === watch.id) || (o.kind === 'source' && event.source.replace('/', ':').includes(o.name.replace('/', ':'))) || (o.kind === 'topic' && text.includes(o.name.toLowerCase()))
  )
}
