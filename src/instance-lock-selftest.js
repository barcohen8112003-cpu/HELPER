// Offline. A lock PID reused by tini or a browser after a reboot must not look like another HELPER.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isHelperCmdline, lockHeldByOther, processAlive } from './instance-lock.js'

let passed = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  passed++
}

ok(isHelperCmdline(Buffer.from('node\0src/index.js\0')), 'node src/index.js is HELPER')
ok(isHelperCmdline(Buffer.from('/usr/local/bin/node\0/app/src/index.js\0')), 'an absolute node path running this entry is HELPER')
ok(isHelperCmdline(Buffer.from('node\0--require\0/x.js\0src/index.js\0')), 'flags before the entry still count')
ok(isHelperCmdline('node.exe\0C:\\helper\\src\\index.js\0'), 'Windows node.exe with a backslash path counts')
ok(!isHelperCmdline(Buffer.from('/usr/bin/tini\0--\0node\0src/index.js\0')), 'tini is not HELPER even when it wraps node')
ok(!isHelperCmdline(Buffer.from('node\0/app/src/other.js\0')), 'node running a different script is not HELPER')
ok(!isHelperCmdline(Buffer.from('node\0/app/not-src/index.js\0')), 'a different index.js is not this entry')
ok(!isHelperCmdline(fs.readFileSync('/proc/self/cmdline')), 'this test process is not HELPER')

ok(!lockHeldByOther(process.pid, { cmdline: () => Buffer.from('node\0src/index.js') }), 'our own PID is not another instance')
ok(!lockHeldByOther(4242, { self: 7, alive: () => false, cmdline: () => Buffer.from('node\0src/index.js') }), 'a dead PID is a stale lock')
ok(!lockHeldByOther(4242, { self: 7, alive: () => true, cmdline: () => Buffer.from('/usr/bin/tini\0--') }), 'a live process that is not HELPER is a stale lock')
ok(lockHeldByOther(4242, { self: 7, alive: () => true, cmdline: () => Buffer.from('node\0/app/src/index.js') }), 'a live HELPER that is not us holds the lock')
ok(!lockHeldByOther(4242, { self: 7, alive: () => true, cmdline: () => null, hasProc: true }), 'an unreadable command line on Linux is not a confirmed HELPER')
ok(lockHeldByOther(4242, { self: 7, alive: () => true, cmdline: () => null, hasProc: false }), 'without /proc a live PID is the only signal')
ok(!lockHeldByOther(0) && !lockHeldByOther('nope') && !lockHeldByOther(''), 'a missing or garbage PID is not a lock')
ok(processAlive(process.pid), 'this process is alive')
ok(!processAlive(Number.MAX_SAFE_INTEGER), 'a PID that cannot exist is not alive')

const index = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const hold = index.indexOf('lockHeldByOther(lockedBy)')
const drop = index.indexOf('fs.rmSync(LOCK, { force: true })')
const write = index.indexOf('fs.writeFileSync(LOCK, String(process.pid))')
ok(hold !== -1 && drop !== -1 && hold < drop && drop < write, 'a stale lock is deleted before this process claims it')

console.log(`${passed} בדיקות עברו, 0 נכשלו`)
