// The acceptance test: does Helper finish real tasks end to end? npm run accept:real
//
// Each task in tasks.yml runs in its own process with its own empty data folder, through the same runTurn the
// WhatsApp handler calls, with the real model from .env. Safe by default (auto mode): synthetic recipients that
// never reach the network, fixture pages instead of the internet, approvals answered by the script, and only the
// tools in AUTO_TOOLS really run. Money cards are always declined. Device and kill tests are manual and are
// reported as skipped, never as passed. The report goes to accept-reports/ (not in git), with evidence masked.
//
//   npm run accept:real                    every auto task
//   npm run accept:real -- --only 5,6,9    some of them
//   npm run accept:real -- --live 14,16    these live tasks too, after a typed yes. Refused in CI.
//   npm run accept:real -- --list          the tasks and their modes
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { ROOT, loadTasks, mask, runChecks, guardFetch, hostOf, AUTO_TOOLS, LIVE_EXTRA_TOOLS, MONEY, FIXTURE_HOST } from './accept-lib.mjs'

const TURN_TIMEOUT = Number(process.env.ACCEPT_TURN_TIMEOUT_MS) || 3 * 60000
const RESULT = 'ACCEPT_RESULT '
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return null
  return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : ''
}
const idList = (v) => (v ? v.split(',').map((s) => Number(s.trim())).filter(Number.isInteger) : null)

// ── the parent: picks tasks, runs each in a child, writes the report ────────
async function main() {
  const tasks = loadTasks()
  if (flag('list') !== null) {
    for (const t of tasks) console.log(`${String(t.id).padStart(2)}  ${t.mode.padEnd(6)}  ${t.area.padEnd(13)} ${t.title}`)
    return
  }
  const only = idList(flag('only'))
  const live = idList(flag('live')) || []
  if (live.length && (process.env.CI || !process.stdin.isTTY)) {
    console.log('--live runs only by hand at a terminal, never in CI.')
    process.exit(2)
  }
  for (const id of live) {
    const t = tasks.find((x) => x.id === id)
    if (!t || t.mode !== 'live') {
      console.log(`--live ${id}: not a live task (npm run accept:real -- --list)`)
      process.exit(2)
    }
  }

  const envFile = process.env.HELPER_ENV_FILE || path.join(ROOT, '.env')
  const env = readEnv(envFile)
  if (!env.LLM_API_KEY || !env.LLM_MODEL) {
    console.log(`accept:real talks to the real model: LLM_API_KEY and LLM_MODEL are needed in ${envFile}.`)
    process.exit(2)
  }

  if (live.length) {
    console.log('\nLive tasks use the real internet and real sites. Messages still go only to a synthetic recipient,')
    console.log('and every approval card that looks like money is declined. Scope of this run:')
    for (const id of live) console.log(`  ${id}. ${tasks.find((t) => t.id === id).title}`)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('Type "yes" to run them: ')).trim().toLowerCase()
    rl.close()
    if (answer !== 'yes') {
      console.log('Not confirmed. Nothing ran.')
      process.exit(2)
    }
  }

  const started = new Date()
  const results = []
  for (const t of tasks) {
    if (only && !only.includes(t.id)) continue
    if (t.mode === 'manual') {
      results.push({ id: t.id, title: t.title, mode: t.mode, status: 'skipped', why: 'manual: needs a device or the test copy of the bot', pass_when: t.pass_when })
      continue
    }
    if (t.mode === 'live' && !live.includes(t.id)) {
      results.push({ id: t.id, title: t.title, mode: t.mode, status: 'skipped', why: 'live: not opted in (--live)', pass_when: t.pass_when })
      continue
    }
    process.stdout.write(`${String(t.id).padStart(2)} ${t.title} … `)
    const r = await runChild(t, envFile, t.mode === 'live')
    console.log(r.status === 'pass' ? 'pass' : `${r.status}${r.why ? `: ${r.why}` : ''}`)
    results.push({ ...r, id: t.id, title: t.title, mode: t.mode, pass_when: t.pass_when })
  }
  const file = writeReport(results, started, live)
  const count = (s) => results.filter((r) => r.status === s).length
  console.log(`\n${count('pass')} pass, ${count('fail')} fail, ${count('skipped')} skipped (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  console.log(`report: ${path.relative(process.cwd(), file)}`)
  process.exit(count('fail') ? 1 : 0)
}

function readEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.replace(/\r$/, '').trim().replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

// Auto: only the model settings reach the test, so no account, mailbox or device of his can be used.
// Live: his keys for search and prices too, but never mail passwords, and the computer stays off.
const AUTO_KEYS = /^(LLM_[A-Z_]+|TIMEZONE|BOT_NAME)$/
const NEVER_KEYS = /^(MAIL\d?_|DISCORD|WHATSAPP|BIRD_|PC_|PHONE_|TV_|WEBTOP_|GOOGLE_HOME|COMPUTER_MODE|CLAUDE_CODE)/
function childEnvFile(envFile, live, dir) {
  const env = readEnv(envFile)
  const keep = Object.entries(env).filter(([k]) => (live ? !NEVER_KEYS.test(k) : AUTO_KEYS.test(k)))
  const file = path.join(dir, 'test.env')
  fs.writeFileSync(file, [...keep.map(([k, v]) => `${k}=${v}`), 'COMPUTER_MODE=off', 'CONFIRM_ALWAYS=pc_type'].join('\n') + '\n')
  return file
}

function runChild(task, envFile, live) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-accept-'))
  const started = Date.now()
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'accept-real.mjs'), '--child', String(task.id), '--mode', live ? 'live' : 'auto'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HELPER_DATA_DIR: dir,
        HELPER_ENV_FILE: childEnvFile(envFile, live, dir),
        HELPER_ACCEPT: live ? 'live' : 'auto',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(ROOT, 'scripts', 'as-server.cjs')}`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (out += d))
    const limit = setTimeout(() => proc.kill('SIGKILL'), TURN_TIMEOUT * Math.max(1, task.steps.length) + 60000)
    proc.on('close', (code) => {
      clearTimeout(limit)
      fs.rmSync(dir, { recursive: true, force: true })
      const line = out.split('\n').findLast((l) => l.startsWith(RESULT))
      const seconds = Math.round((Date.now() - started) / 1000)
      if (line) return resolve({ ...JSON.parse(line.slice(RESULT.length)), seconds })
      resolve({ status: 'fail', why: code === null ? 'timed out' : `crashed (exit ${code}): ${mask(out.trim().split('\n').slice(-3).join(' '), 200)}`, seconds, steps: [] })
    })
  })
}

function writeReport(results, started, live) {
  const dir = process.env.ACCEPT_REPORT_DIR || path.join(ROOT, 'accept-reports')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const json = path.join(dir, `accept-${stamp}.json`)
  const summary = { started: started.toISOString(), seconds: Math.round((Date.now() - started) / 1000), live, results }
  fs.writeFileSync(json, JSON.stringify(summary, null, 2))
  const icon = { pass: '✅', fail: '❌', skipped: '⏭️' }
  const md = [
    `# accept:real ${started.toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'fail').length} fail, ${results.filter((r) => r.status === 'skipped').length} skipped, ${summary.seconds}s.${live.length ? ` Live tasks in this run: ${live.join(', ')}.` : ' No live tasks in this run.'}`,
    '',
    '| # | task | mode | result | time | evidence |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => {
      const evidence = r.status === 'skipped' ? r.why : [r.why, ...(r.steps || []).map((s) => `«${s.reply}»${s.cards?.length ? ` card: «${s.cards[0]}»` : ''}`)].filter(Boolean).join(' / ')
      return `| ${r.id} | ${r.title} | ${r.mode} | ${icon[r.status]} ${r.status} | ${r.seconds ?? '-'}s | ${String(evidence || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`
    }),
    '',
  ].join('\n')
  const mdFile = json.replace(/\.json$/, '.md')
  fs.writeFileSync(mdFile, md)
  return mdFile
}

// ── the child: one task, one fresh Helper ────────────────────────────────────
async function child(id, live) {
  const task = loadTasks().find((t) => t.id === id)
  const { config } = await import('../src/config.js')
  // The network guard goes in before any module that fetches is loaded.
  const blocked = []
  const llmHosts = [hostOf(config.llm.baseUrl), hostOf(config.llm.backup?.baseUrl)]
  globalThis.fetch = guardFetch({ allowHosts: llmHosts, live, blocked })
  config.newsFeeds = [`https://${FIXTURE_HOST}/news.xml`]
  if (!live) {
    config.tavilyKey = ''
  }
  const { state } = await import('../src/store.js')
  const { runTurn, resetHistory } = await import('../src/agent.js')
  const { tools } = await import('../src/tools.js')
  const { addCandidate } = await import('../src/memory.js')
  const { searchAudit } = await import('../src/audit.js')

  const allowed = new Set([...AUTO_TOOLS, ...(live ? LIVE_EXTRA_TOOLS : [])])
  for (const tool of tools) {
    if (!allowed.has(tool.name)) {
      tool.run = async () => 'הכלי הזה לא זמין בבדיקת הקבלה (מצב בדיקה). אמור למשתמש שלא יכולת לבצע את החלק הזה.'
    } else if (tool.name === 'fetch_page' && !live) {
      // fetch_page falls back to a real browser when the download fails; in auto mode only fixture pages are read.
      const real = tool.run
      tool.run = async (a, ctx) => (hostOf(a?.url) === FIXTURE_HOST ? real(a, ctx) : 'שגיאה: הדף לא זמין בבדיקת הקבלה (אין רשת)')
    }
  }

  // The synthetic WhatsApp side. Nothing here reaches the network or a real person.
  const world = { sent: [], said: [], reacted: [], jobs: [], cards: [], audit: [], now: new Date() }
  let confirmAnswer = false
  const ctx = {
    source: 'whatsapp',
    confirm: async (question) => {
      world.cards.push(String(question))
      if (MONEY.test(String(question))) return false
      return confirmAnswer
    },
    sendMedia: async (m) => world.said.push(`[media ${m?.mime || ''}]`),
    say: async (text) => world.said.push(String(text)),
    react: async (emoji) => world.reacted.push(emoji),
    sendAs: async (jid, text) => world.sent.push({ jid, text: String(text) }),
    findContact: async (to) => ({ name: String(to), number: '+000 SYNTHETIC', jid: 'synthetic@accept.test' }),
    background: (title, instruction) => {
      const job = { title, instruction, cancelled: false }
      world.jobs.push(job)
      return { title }
    },
  }

  for (const [kind, value] of Object.entries(task.seed || {})) {
    if (kind === 'candidate') addCandidate(value, { category: 'preference' })
    if (kind === 'reminder') {
      const at = new Date(Date.now() + 26 * 3600e3)
      state.reminders.push({ id: state.nextId++, text: value, at: at.toISOString(), repeat: 'none' })
    }
  }
  const before = JSON.parse(JSON.stringify({ reminders: state.reminders, memory: state.memory }))

  const steps = []
  const failures = []
  for (const [n, step] of task.steps.entries()) {
    if (step.new_conversation) {
      resetHistory()
      if (!step.say) continue
    }
    world.cards = []
    confirmAnswer = step.confirm === 'approve'
    const pendingBefore = (state.memoryCandidates || []).length
    let reply = ''
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT)
      reply = String((await runTurn(step.say, { ...ctx, signal: ac.signal })) || '')
      clearTimeout(timer)
    } catch (e) {
      failures.push(`step ${n + 1}: the turn failed: ${e.message}`)
    }
    if (step.wait_learning) {
      for (let waited = 0; waited < 45000 && (state.memoryCandidates || []).length === pendingBefore; waited += 500) await new Promise((r) => setTimeout(r, 500))
    }
    world.reply = reply
    world.state = state
    world.before = before
    world.audit = searchAudit({ limit: 500 })
    for (const f of runChecks(step.expect, world)) failures.push(`step ${n + 1}: ${f}`)
    steps.push({ say: mask(step.say, 120), reply: mask(reply), cards: world.cards.map((c) => mask(c, 160)) })
  }

  const result = {
    status: failures.length ? 'fail' : 'pass',
    why: failures.join('; '),
    steps,
    sent_to_synthetic: world.sent.length,
    blocked_hosts: [...new Set(blocked)],
  }
  console.log(RESULT + JSON.stringify(result))
  process.exit(0)
}

// Last, so every constant above is defined before a task runs.
if (flag('child') !== null) await child(Number(flag('child')), flag('mode') === 'live')
else await main()
