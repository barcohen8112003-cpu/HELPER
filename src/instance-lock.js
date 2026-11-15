// One HELPER per data folder. The lock file sits on the persistent disk, so it survives a VPS reboot.
// After a reboot the old PID can belong to a different process in the new container. That is not another
// HELPER: only a live node process running this app's entry (src/index.js), other than us, holds the lock.
import fs from 'node:fs'

export const HELPER_ENTRY = 'src/index.js'

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function readCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`)
  } catch {
    return null
  }
}

// cmdline is NUL-separated. True when argv[0] is node and a later argument is this app's entry.
export function isHelperCmdline(cmdline, entry = HELPER_ENTRY) {
  const raw = Buffer.isBuffer(cmdline) ? cmdline.toString('utf8') : String(cmdline ?? '')
  const parts = raw.split('\0').filter(Boolean)
  if (!parts.length) return false
  const exe = parts[0].replace(/\\/g, '/').split('/').pop().toLowerCase()
  if (exe !== 'node' && exe !== 'node.exe' && exe !== 'nodejs') return false
  const needle = String(entry).replace(/\\/g, '/')
  return parts.slice(1).some((arg) => {
    const norm = arg.replace(/\\/g, '/')
    return norm === needle || norm.endsWith('/' + needle)
  })
}

// True only when another live HELPER holds the lock. A dead PID, our own PID, or a reused PID that is
// not this app is stale: the caller deletes the lock and continues.
export function lockHeldByOther(lockPid, { self = process.pid, alive = processAlive, cmdline = readCmdline, entry = HELPER_ENTRY, hasProc = fs.existsSync('/proc') } = {}) {
  const pid = Number(lockPid)
  if (!Number.isInteger(pid) || pid <= 0 || pid === self) return false
  if (!alive(pid)) return false
  const cmd = cmdline(pid)
  const bytes = cmd == null ? 0 : Buffer.isBuffer(cmd) ? cmd.length : String(cmd).length
  if (bytes > 0) return isHelperCmdline(cmd, entry)
  // No command line. On Linux that is not a confirmed HELPER, so the lock is stale.
  // Without /proc (Windows) a live PID is the only signal there is.
  return !hasProc
}
