// Offline checks for background tasks: they run beside each other, report once, stop one by name, respect the
// limit, and the commands that list and stop them are recognised. No model.
import assert from 'node:assert/strict'
import { startJob, stopJobs, listJobs, jobsText, interruptedJobs, MAX_RUNNING } from './jobs.js'
import { parseCommand } from './commands.js'
let passed = 0
const ok = (c, n) => (assert.ok(c, n), passed++)

const done = []
const wait = (signal, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))))
})
const finished = new Promise((r) => {
  let n = 0
  const onDone = (title, result, error) => (done.push({ title, result, error }), ++n === 2 && r())
  startJob('השוואת מחירים', async (signal, step) => (step('בודק זאפ'), await wait(signal, 50), 'נמצא ב-389 ₪'), onDone)
  startJob('כתיבת סקריפט', async (signal) => (await wait(signal, 5000), 'לא אמור להגיע'), onDone)
})
await new Promise((r) => setTimeout(r, 5))
ok(listJobs().length === 2, 'two tasks run side by side')
ok(/בודק זאפ/.test(jobsText()), 'the list shows the current step')
assert.throws(() => startJob('שלישית', async () => 'x', () => {}), /כבר רצות 2/)
passed++
ok(MAX_RUNNING === 2, 'limit is two')
ok(interruptedJobs().length === 2 && interruptedJobs().length === 0, 'running tasks are saved for a restart, read once')
ok(stopJobs('סקריפט').length === 1, 'stop one task by part of its name')
await finished
ok(done.find((d) => d.title === 'השוואת מחירים').result === 'נמצא ב-389 ₪', 'the finished task reports its result')
const stopped = done.find((d) => d.title === 'כתיבת סקריפט')
ok(stopped.result === null && stopped.error === null, 'a stopped task reports nothing (the stop was already confirmed)')
ok(listJobs().length === 0 && /לא רצה/.test(jobsText()), 'nothing left running')

for (const t of ['מה רץ', 'מה רץ עכשיו?', '/jobs']) ok(parseCommand(t) === 'jobs', t)
ok(parseCommand('מה רץ לך בראש') === null, 'only the whole message counts')
ok(parseCommand('עצור') === 'stop', 'stop still works')
console.log(`${passed} בדיקות עברו, 0 נכשלו`)
process.exit(0)
