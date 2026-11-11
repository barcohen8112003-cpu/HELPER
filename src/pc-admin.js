// Commands as Administrator on the user's own Windows PC, with no UAC window each time and a yes for every command.
// The owner opts in once, by running scripts/windows/helper-admin-setup.ps1 as Administrator. That registers a task
// ("Helper Admin Runner", highest privileges) whose script sits in an admin-only folder; Helper drops one request
// file per approved command into its inbox and starts the task, which runs the command elevated and writes the
// output back. Without the setup there is no admin path at all: the call answers how to set it up and runs nothing.
// The yes is asked by the tool (pc-tools.js run_command) in every mode, auto included, before anything is written.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { remoteActive, remoteCall } from './pc-bridge.js'

export const TASK = 'Helper Admin Runner'
export const MAX_COMMAND = 8000
export const SETUP_NEEDED = 'הרצה כמנהל עוד לא מוגדרת במחשב. כדי להפעיל: לפתוח PowerShell כמנהל (Run as administrator) בתיקיית HELPER ולהריץ פעם אחת: powershell -ExecutionPolicy Bypass -File scripts\\windows\\helper-admin-setup.ps1 . לביטול: אותה פקודה עם -Remove. לא הורץ כלום.'

export const adminBase = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'HelperAdmin')

const startTask = () =>
  new Promise((resolve) => execFile('schtasks.exe', ['/Run', '/TN', TASK], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// PowerShell started with -EncodedCommand writes its error stream as CLIXML; this turns it back into the error text.
export function plainErrors(text) {
  const t = String(text || '')
  if (!t.startsWith('#< CLIXML')) return t
  const parts = [...t.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1])
  return parts
    .join('')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
}

export function formatResult(r) {
  r = { ...r, err: plainErrors(r.err) }
  const out = [r.out, r.err && `STDERR: ${r.err}`, r.timeout && 'ERROR: הפקודה נעצרה אחרי 60 שניות', r.code && !r.err && !r.timeout && `ERROR: exit code ${r.code}`].filter(Boolean).join('\n')
  return `(כמנהל) ${out || '(אין פלט)'}`.slice(0, 4000)
}

// opts are for the self-test: another folder, a stand-in for schtasks, shorter waits.
export async function runAdminCommand(command, { base = adminBase(), start = startTask, waitMs = 75000, poll = 250, platform = process.platform } = {}) {
  if (remoteActive()) return remoteCall('runAdminCommand', [command])
  if (platform !== 'win32') return 'הרצה כמנהל קיימת רק במחשב Windows.'
  const cmd = String(command ?? '')
  if (!cmd.trim()) return 'אין פקודה להריץ.'
  if (cmd.length > MAX_COMMAND) return `הפקודה ארוכה מדי להרצה כמנהל (מעל ${MAX_COMMAND} תווים). לא הורץ כלום.`
  const inbox = path.join(base, 'inbox')
  if (!fs.existsSync(path.join(base, 'runner.ps1')) || !fs.existsSync(inbox)) return SETUP_NEEDED
  const id = crypto.randomBytes(16).toString('hex')
  const req = path.join(inbox, `${id}.req`)
  const out = path.join(inbox, `${id}.out`)
  // Written whole under another name, then renamed, so the runner never reads half a command.
  fs.writeFileSync(path.join(inbox, `${id}.part`), cmd, 'utf8')
  fs.renameSync(path.join(inbox, `${id}.part`), req)
  if (!(await start())) {
    fs.rmSync(req, { force: true })
    return SETUP_NEEDED
  }
  const until = Date.now() + waitMs
  let nudged = 0
  for (let waited = 0; Date.now() < until; waited += poll) {
    if (fs.existsSync(out)) {
      let r
      try {
        r = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        await sleep(poll)
        continue
      }
      fs.rmSync(out, { force: true })
      return formatResult(r)
    }
    // The runner may have been finishing its last round when this request landed: start it again while the request
    // is still untaken. A taken request is renamed away, so it can never run twice.
    if (fs.existsSync(req) && waited >= (nudged + 1) * 4000 && nudged < 3) {
      nudged++
      await start()
    }
    await sleep(poll)
  }
  const untaken = fs.existsSync(req)
  fs.rmSync(req, { force: true })
  return untaken ? 'משימת המנהל לא התחילה לרוץ, אז הפקודה בוטלה ולא הורצה.' : 'הפקודה התחילה לרוץ כמנהל ולא סיימה בזמן. לא ידוע אם הצליחה.'
}
