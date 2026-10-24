// Runs every self-test that needs no network, WhatsApp or model, each with its own empty data folder, and exits
// non-zero if any fails. This is what CI runs on every pull request: npm run check:all
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TESTS = [
  'src/selftest.js',
  'src/toolkit/_selftest.js',
  'src/memory-selftest.js',
  'src/learning-selftest.js',
  'src/audit-selftest.js',
  'src/fast-commands-selftest.js',
  'src/morning-selftest.js',
  'src/errand-selftest.js',
  'src/monitoring/selftest.js',
  'src/pc-bridge-selftest.js',
  'src/webtop-selftest.js',
  'src/google-home-selftest.js',
  'src/phone-selftest.js',
  'src/cloud-desktop-selftest.js',
  'src/phone-app-selftest.js',
  'src/dashboard/_selftest.js',
  'src/backup-selftest.js',
  'src/style-selftest.js',
  'src/metrics-selftest.js',
  'src/jobs-selftest.js',
  'src/study-selftest.js',
  'src/approval-selftest.js',
  'src/logs-selftest.js',
  'src/claude-code-selftest.js',
]

const failed = []
for (const test of TESTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-check-'))
  const started = Date.now()
  const run = spawnSync(process.execPath, [test], {
    cwd: ROOT,
    env: { ...process.env, HELPER_DATA_DIR: dir, HELPER_OFFLINE: '1' },
    encoding: 'utf8',
    timeout: 5 * 60000,
  })
  fs.rmSync(dir, { recursive: true, force: true })
  const ok = run.status === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${test} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (!ok) {
    failed.push(test)
    console.log(((run.stdout || '') + (run.stderr || '')).trim().split('\n').slice(-30).join('\n'))
  }
}
console.log(failed.length ? `\n${failed.length} נכשלו: ${failed.join(', ')}` : `\nכל ${TESTS.length} הבדיקות עברו`)
process.exit(failed.length ? 1 : 0)
