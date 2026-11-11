// Runs every self-test that needs no network, WhatsApp or model, each with its own empty data folder, and exits
// non-zero if any fails. This is what CI runs on every pull request: npm run check:all
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The server runs Node 24 (Dockerfile) and CI checks on the version in .nvmrc. On an older Node some checks fail
// for reasons that have nothing to do with the change, so the run stops here with the reason instead.
const NEED = 24
if (Number(process.versions.node.split('.')[0]) < NEED) {
  console.log(`check:all needs Node.js ${NEED} or newer (this is ${process.versions.node}), the version the server runs. nvm use (reads .nvmrc), or https://nodejs.org`)
  process.exit(1)
}

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TESTS = [
  'src/selftest.js',
  'scripts/accept-selftest.mjs',
  'src/instance-lock-selftest.js',
  'src/toolkit/_selftest.js',
  'src/memory-selftest.js',
  'src/learning-selftest.js',
  'src/audit-selftest.js',
  'src/fast-commands-selftest.js',
  'src/morning-selftest.js',
  'src/errand-selftest.js',
  'src/monitoring/selftest.js',
  'src/pc-bridge-selftest.js',
  'src/face-selftest.js',
  'src/webtop-selftest.js',
  'src/google-home-selftest.js',
  'src/phone-selftest.js',
  'src/cloud-desktop-selftest.js',
  'src/phone-app-selftest.js',
  'src/dashboard/_selftest.js',
  'src/backup-selftest.js',
  'src/backup-archive-selftest.js',
  'src/style-selftest.js',
  'src/answers-selftest.js',
  'src/metrics-selftest.js',
  'src/notice-learning-selftest.js',
  'src/jobs-selftest.js',
  'src/study-selftest.js',
  'src/approval-selftest.js',
  'src/agent-selftest.js',
  'src/continuity-selftest.js',
  'scripts/converse-eval-selftest.mjs',
  'src/routing-selftest.js',
  'src/flights-selftest.js',
  'src/stays-selftest.js',
  'src/proactive-selftest.js',
  'src/logs-selftest.js',
  'src/instinct-selftest.js',
  'src/instinct-continuity-selftest.js',
  'src/inflight-selftest.js',
  'src/boot-recovery-selftest.js',
  'src/continuity-preserve-selftest.js',
  'src/claude-code-selftest.js',
  'src/gemini-spark-selftest.js',
  'src/tv-agent-selftest.js',
  'src/google-docs-selftest.js',
  'src/webtop-file-selftest.js',
  'src/webtop-watch-selftest.js',
  'src/scrapling-selftest.js',
  'src/groups-selftest.js',
  'src/schoolwork-selftest.js',
  'src/wa-link-selftest.js',
  'src/release-notes-selftest.js',
  'src/bird-selftest.js',
  'src/opendata-selftest.js',
  'src/shopping-selftest.js',
  'src/obscura-selftest.js',
  'src/team-selftest.js',
  'src/live-voice-selftest.js',
  'src/whatsapp-speech-selftest.js',
  'src/panel-selftest.js',
  'src/bound-actions-selftest.js',
  'src/office-edit-selftest.js',
  'src/gmail-plus-selftest.js',
  'src/calendar-plus-selftest.js',
  'src/github-write-selftest.js',
  'src/vault-selftest.js',
  'src/vault-leak-selftest.js',
  'scripts/setup-selftest.mjs',
]

// A test that passes with parts skipped (no python, no venv…) is not a full pass. Each child's skips are counted
// from its own output: "SKIP <why>" lines, or a summary like "3 skipped" / "3 דולגו".
function skipsOf(output) {
  const lines = output.split('\n')
  const reasons = lines.filter((l) => /^\s*SKIP\b/.test(l)).map((l) => l.replace(/^\s*SKIP\s*/, '').trim())
  const counted = lines.map((l) => l.match(/(\d+)\s+(?:skipped|דולגו)\b/i)).filter(Boolean).reduce((n, m) => Math.max(n, Number(m[1])), 0)
  return { count: Math.max(reasons.length, counted), reasons }
}

const failed = []
const skipped = []
for (const test of TESTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-check-'))
  const started = Date.now()
  const run = spawnSync(process.execPath, [test], {
    cwd: ROOT,
    // A throwaway, empty .env: the owner's real one (DAILY_BRIEF_TIME, COMPUTER_MODE, WEBTOP_URL…) must not change a test.
    env: { ...process.env, HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, 'empty.env'), HELPER_OFFLINE: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(ROOT, 'scripts', 'as-server.cjs')}`.trim() },
    encoding: 'utf8',
    timeout: 5 * 60000,
  })
  fs.rmSync(dir, { recursive: true, force: true })
  const ok = run.status === 0
  const skips = skipsOf((run.stdout || '') + (run.stderr || ''))
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${test} (${((Date.now() - started) / 1000).toFixed(1)}s${skips.count ? `, ${skips.count} skipped` : ''})`)
  for (const why of skips.reasons) console.log(`     SKIP ${why}`)
  if (skips.count) skipped.push(`${test} (${skips.count})`)
  if (!ok) {
    failed.push(test)
    console.log(((run.stdout || '') + (run.stderr || '')).trim().split('\n').slice(-30).join('\n'))
  }
}
console.log(failed.length ? `\n${failed.length} נכשלו: ${failed.join(', ')}` : `\nכל ${TESTS.length} הבדיקות עברו`)
// Skips do not fail the run, but they are always shown: a run with skips is not reported as a full pass.
console.log(skipped.length ? `בדיקות עם חלקים שדולגו (${skipped.length}): ${skipped.join(', ')}` : 'אף חלק לא דולג')
process.exit(failed.length ? 1 : 0)
