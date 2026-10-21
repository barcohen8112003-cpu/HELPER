// Background tasks: long work (controlling the computer or phone, a shopping errand, research across many sites,
// code in Helper's own machine) runs here, outside the chat queue, so Naor can keep talking while it works.
// Each task has its own conversation and its own stop button; only its final result joins the chat history.
import { state, save } from './store.js'

export const MAX_RUNNING = 2
export const MAX_MINUTES = 20

const running = new Map() // id -> { id, title, startedAt, ac, step }
let nextId = 1

const persist = () => {
  state.jobs = [...running.values()].map(({ id, title, startedAt }) => ({ id, title, startedAt }))
  save()
}

export const listJobs = () => [...running.values()].map(({ id, title, startedAt, step }) => ({ id, title, startedAt, step }))

// Tasks that were running when the process stopped. Read once at startup, then cleared.
export function interruptedJobs() {
  const was = state.jobs || []
  state.jobs = []
  save()
  return was
}

// run(signal, setStep) => Promise<string>: the task's work. onDone(title, result | null, error | null) is called once.
// Returns { id, title } or throws when too many are already running.
export function startJob(title, run, onDone) {
  if (running.size >= MAX_RUNNING) {
    const names = [...running.values()].map((j) => `"${j.title}"`).join(' ו-')
    throw new Error(`כבר רצות ${running.size} משימות ברקע (${names}). אפשר לחכות שאחת תסתיים, או לעצור אחת.`)
  }
  const id = nextId++
  const ac = new AbortController()
  const job = { id, title: String(title).slice(0, 60), startedAt: Date.now(), ac, step: '' }
  running.set(id, job)
  persist()
  const limit = setTimeout(() => ac.abort(new Error('timeout')), MAX_MINUTES * 60000)
  limit.unref?.()
  // The task leaves the list before its result is sent, so "מה רץ" right after the result is already accurate.
  const finish = () => {
    clearTimeout(limit)
    running.delete(id)
    persist()
  }
  Promise.resolve()
    .then(() => run(ac.signal, (step) => (job.step = String(step).slice(0, 80))))
    .then(
      (result) => (finish(), onDone(job.title, result, null)),
      (error) => (finish(), onDone(job.title, null, ac.signal.aborted ? (ac.signal.reason?.message === 'timeout' ? new Error(`עברו ${MAX_MINUTES} דקות`) : null) : error))
    )
    .catch((e) => console.log(`[jobs] ${e.message}`))
  return { id, title: job.title }
}

// Stops the tasks whose title contains `match` (all of them when empty). Returns the titles stopped.
export function stopJobs(match = '') {
  const want = String(match).trim()
  const hit = [...running.values()].filter((j) => !want || j.title.includes(want) || String(j.id) === want)
  for (const j of hit) j.ac.abort(new Error('stopped'))
  return hit.map((j) => j.title)
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000))

export function jobsText(now = Date.now()) {
  const list = listJobs()
  if (!list.length) return 'לא רצה כרגע אף משימה ברקע.'
  return ['*ברקע עכשיו*', ...list.map((j) => `• ${j.title}, ${minutes(now - j.startedAt)} דק'${j.step ? ` (${j.step})` : ''}`)].join('\n')
}
