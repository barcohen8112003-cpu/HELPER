// Conversation evaluation: does a short follow-up still have what it depends on? npm run eval:converse
//
// Runs the synthetic conversations in accept/converse/cases.json through the real runTurn and the real compaction,
// each in its own process with its own empty data folder, and reports for the last message of each conversation
// where the facts it needs sit in the model's request: in the recent messages (word for word), only in the running
// summary, in the memory section, or nowhere.
//
//   npm run eval:converse                              offline: a local stand-in model, no network, no key
//   npm run eval:converse -- --root ../HELPER-base     compare two checkouts (baseline first, then this one)
//   npm run eval:converse -- --only chosen-option --modes light --conditions compacted --max-runs 2
//   npm run eval:converse -- --dry-run [...]            preflight only: the planned runs and request counts. Reads no
//                                                       .env, starts no process, sends nothing
//   npm run eval:converse -- --real --max-requests 30 --confirm-route "<LLM_MODEL>@<LLM_BASE_URL>" --only chosen-option
//                                                       the model route in .env, for both checkouts alike
//
// Offline proves only what reaches the model (plumbing and contract), never how a real model judges. The assistant
// lines it uses are scripted stand-ins from the cases file, and the summary is a placeholder, so anything that
// survives only in the summary is marked as depending on the summarizer model.
// --real talks to the model in .env. No tool really runs: each answers from the case's synthetic fixture or says it
// is not available, and every approval card is declined. Reports go to accept-reports/ (not in git).
//
// The network guard is narrow: it replaces globalThis.fetch in the child, which is how Helper's model client and
// its HTTP tools reach the network. Through it, only the one confirmed endpoint (scheme, host, port and path, exact)
// is reachable, a redirect is never followed (the run fails at once), and every other address is refused. Modules
// that open sockets without fetch (node:http, node:net, WebSocket, child processes) are not covered by it: this is
// not a network sandbox, and the stubbed tools are what keep those paths from running.
//
// A real run is closed until all of this holds, and a key being present opens nothing:
//   --max-requests N       a hard cap for the whole batch, at most REAL_REQUEST_CEILING. Every request to the model
//                          is counted (tool rounds, retries, summaries), and the batch stops before request N+1.
//   the plan fits the cap  its minimum (one request per message) is within N, so a small subset is chosen first.
//   --confirm-route M@U    the owner types the model and base URL he verified as already paid for, on the command
//                          line (no environment variable or file can stand in). It must equal the route in .env
//                          exactly: scheme, host, port and path. Plain http only for a loopback address.
// Only that one route is used: fallback models, the cheap and strong models and the backup provider are left out.
//
// What reaches the child: a short list of system variables (PATH, HOME, temp…), the evaluation's own settings and,
// in a real run, the model route. Nothing else of the parent's environment, and no NODE_OPTIONS of the parent.
//
// A run counts only when it finished whole: every message answered, no model error (a summary's included), no
// crash. Anything else is reported as FAILED with its transcript and errors, is left out of every count of needs,
// and makes the batch exit non-zero. With --root, only pairs that finished on every checkout are compared.
// Exit codes: 0 every planned run finished, 1 a run failed, 2 refused before anything ran, 3 stopped at the cap,
// 4 the model endpoint redirected (the batch stops there).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CASES = path.join(HERE, 'accept', 'converse', 'cases.json')
const RESULT = 'CONVERSE_RESULT '
const OFFLINE_HOST = 'offline.invalid'
// No real batch is larger than this, whatever --max-requests says. Raising it is a decision made here, in review.
export const REAL_REQUEST_CEILING = 100
const COUNT_FILE = 'eval-requests.count'
const PRELOAD = path.join(HERE, 'scripts', 'as-server.cjs')
const args = process.argv.slice(2)
const all = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : a.startsWith(`--${name}=`) ? [a.split('=')[1]] : []))
const flag = (name) => all(name)[0] ?? (args.includes(`--${name}`) ? '' : null)
const list = (name, fallback) => (flag(name) ? flag(name).split(',').map((s) => s.trim()).filter(Boolean) : fallback)
const has = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
// A whole number from 1 up, or NaN for anything else (a missing value, "all", "1e9", "-5"). null = flag not given.
export const wholeNumber = (text) => (text === null || text === undefined ? null : /^[1-9]\d{0,8}$/.test(String(text)) ? Number(text) : NaN)

export function loadCases(file = CASES) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── the parent ───────────────────────────────────────────────────────────────
// Every run of the batch, in order: baseline checkouts first, this checkout last. maxRuns is per checkout, so a
// subset stays the same pairs on both sides. min = the least the run asks of the model: one request per message.
export function planRuns(data, { roots, only = null, modes, conditions, maxRuns = null }) {
  return roots.flatMap((root) => {
    const mine = []
    for (const c of data.cases) {
      if (only && !only.includes(c.id)) continue
      for (const [v, variant] of c.variants.entries()) {
        for (const mode of modes) {
          for (const condition of conditions) mine.push({ root, id: c.id, v, variant: variant.name, heldout: Boolean(variant.heldout), mode, condition, min: variant.turns.filter((t) => !t.event).length })
        }
      }
    }
    return maxRuns ? mine.slice(0, maxRuns) : mine
  })
}

export const planMin = (plan) => plan.reduce((n, p) => n + p.min, 0)

// The preflight: what would run and how many requests it means at the least. Built from the cases file and the
// command line only, so it holds no setting, key or route.
export function preflightText(plan, { real, cap, labels }) {
  const tally = (key) => [...new Set(plan.map((p) => p[key]))].map((k) => `${k} ${plan.filter((p) => p[key] === k).length}`).join(', ')
  const perRoot = labels.map((l, i) => `${l} ${plan.filter((p) => p.root === i).length}`).join(', ')
  const variants = new Set(plan.map((p) => `${p.id}\u0000${p.v}`)).size
  return [
    `preflight, ${real ? 'real model' : 'offline stand-in'}: ${new Set(plan.map((p) => p.id)).size} cases, ${variants} variants, ${plan.length} runs (${perRoot})`,
    `  by mode: ${tally('mode') || '-'}; by condition: ${tally('condition') || '-'}`,
    `  model requests: at least ${planMin(plan)} (one per message; tool rounds, retries and summaries come on top)`,
    `  request cap: ${Number.isInteger(cap) ? `${cap}, the batch stops before request ${cap + 1}` : real ? 'none given' : 'none (offline: the stand-in answers, nothing is sent)'}`,
  ].join('\n')
}

// Why this batch may not start, or '' when it may. Before any .env is read.
export function refusal({ real, cap, confirm, plan, missing = [] }) {
  if (missing.length) return `not a Helper checkout (no ${CHECKOUT_FILES.join(', ')} under src/): ${missing.join(', ')}.`
  if (!plan.length) return 'no run matches the selection (--only, --modes, --conditions).'
  if (Number.isNaN(cap)) return '--max-requests takes a whole number from 1 up.'
  if (real && cap === null) return `--real needs --max-requests N (at most ${REAL_REQUEST_CEILING}): there is no unbounded real batch.`
  if (real && cap > REAL_REQUEST_CEILING) return `--max-requests ${cap} is over the ceiling for a real batch (${REAL_REQUEST_CEILING}). A larger run has not been approved.`
  if (cap !== null && planMin(plan) > cap) return `the selection needs at least ${planMin(plan)} requests and the cap is ${cap}. Choose a smaller subset with --only, --modes, --conditions or --max-runs.`
  if (real && !confirm) return '--real needs --confirm-route "<LLM_MODEL>@<LLM_BASE_URL>": the route the owner verified as already paid for, typed by him. A key in .env is not a go-ahead.'
  return ''
}

// What the child imports from a checkout. A folder without them is refused before any run starts.
const CHECKOUT_FILES = ['config.js', 'store.js', 'agent.js', 'jobs.js', 'tools.js']
export const missingCheckout = (root) => CHECKOUT_FILES.some((f) => !fs.existsSync(path.join(root, 'src', f)))

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
// The one address a real run may send to: scheme, host, port and path, exact, as one string. null when the base URL
// cannot be one: not http(s), user or password in it, a query or fragment, or plain http to anything but loopback.
export function endpointOf(baseUrl) {
  let u
  try {
    u = new URL(`${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return null
  return u.origin + u.pathname
}
// The same for a URL a request is really sent to; null for anything with user, password, query or fragment.
export function targetOf(url) {
  try {
    const u = new URL(url)
    return u.username || u.password || u.search || u.hash ? null : u.origin + u.pathname
  } catch {
    return null
  }
}
// "model@base URL", the string the owner types. The base URL as the endpoint sees it (no trailing slash).
export function routeOf(env) {
  const at = endpointOf(env.LLM_BASE_URL || 'https://api.openai.com/v1')
  return at ? `${env.LLM_MODEL || ''}@${at.replace(/\/chat\/completions$/, '')}` : ''
}

async function main() {
  const data = loadCases()
  const real = has('real')
  // Baseline checkouts first (--root, in the order given), this checkout last.
  const roots = [...all('root').map((r) => path.resolve(r)), HERE]
  const labels = roots.map((r) => label(r, roots))
  // voice = the full prompt with the spoken-answer note the app bridge puts in front of a voice message.
  const modes = list('modes', real ? ['configured'] : ['full', 'light', 'voice'])
  const conditions = list('conditions', ['fresh', 'compacted'])
  const cap = wholeNumber(has('max-requests') ? flag('max-requests') : null)
  const maxRuns = wholeNumber(has('max-runs') ? flag('max-runs') : null)
  const stop = (why) => {
    console.log(`${why}\nNothing ran.`)
    process.exit(2)
  }
  if (Number.isNaN(maxRuns)) stop('--max-runs takes a whole number from 1 up.')
  const plan = planRuns(data, { roots: roots.map((_, i) => i), only: list('only', null), modes, conditions, maxRuns })
  console.log(preflightText(plan, { real, cap, labels }))
  const missing = roots.filter(missingCheckout).map((r) => `${labels[roots.indexOf(r)]} (${r})`)
  if (missing.length) console.log(`  not a Helper checkout: ${missing.join(', ')}`)
  if (has('dry-run')) {
    console.log('dry run: no .env read, no process started, nothing sent.')
    return []
  }
  const confirm = has('confirm-route') ? flag('confirm-route') : ''
  const why = refusal({ real, cap, confirm, plan, missing })
  if (why) stop(why)
  const envFile = process.env.HELPER_ENV_FILE || path.join(HERE, '.env')
  if (real) {
    const env = readEnv(envFile)
    if (!env.LLM_API_KEY || !env.LLM_MODEL) stop(`--real talks to the model route in ${envFile}: LLM_API_KEY and LLM_MODEL are needed there.`)
    if (!routeOf(env)) stop(`LLM_BASE_URL in ${envFile} is not an endpoint a real run may use (https, or http on a loopback address; no user, password, query or fragment).`)
    if (confirm !== routeOf(env)) stop(`--confirm-route does not match the route in ${envFile}, which is ${routeOf(env)}.`)
    console.log(`real model route: ${routeOf(env)} (light ${env.LLM_LIGHT || 'off'}), the same for every checkout, no other model or provider`)
  }
  const runs = []
  let used = 0
  let stopped = ''
  for (const p of plan) {
    const left = cap === null ? null : cap - used
    if (left !== null && left < p.min) {
      stopped = `stopped at the request cap: ${used} of ${cap} used, the next run needs at least ${p.min}`
      break
    }
    const r = await runChild({ root: roots[p.root], id: p.id, v: p.v, mode: p.mode, condition: p.condition, real, envFile, allowance: left, route: real ? confirm : '' })
    used += r.modelRequests
    runs.push({ root: labels[p.root], case: p.id, variant: p.variant, heldout: p.heldout, mode: p.mode, condition: p.condition, ...r })
    process.stdout.write(r.status === 'complete' ? '.' : 'x')
    if (r.capHit) {
      stopped = `stopped at the request cap: ${used} of ${cap} used, request ${cap + 1} was not sent`
      break
    }
    if (r.routeViolation) {
      stopped = `stopped: ${r.routeViolation}`
      break
    }
    // A real batch does not go on sending after a failed run (a refused key, a broken checkout).
    if (real && r.status !== 'complete') {
      stopped = `stopped after a failed run (${p.id}, ${labels[p.root]}): ${String(r.error || '').slice(0, 200)}`
      break
    }
  }
  console.log('')
  const status = batchStatus(runs, { planned: plan.length, roots: labels, stopped })
  const file = writeReport(runs, { real, roots: labels, data, cap, used, stopped, planned: plan.length, status })
  console.log(statusLine(status))
  console.log(summaryLine(runs, labels))
  console.log(`model requests: ${used}${cap === null ? '' : ` of ${cap} allowed`}, runs: ${runs.length} of ${plan.length} planned`)
  if (stopped) console.log(stopped)
  console.log(`report: ${path.relative(process.cwd(), file)}`)
  process.exitCode = status.code
  return runs
}

// The batch as a whole. code: 0 only when every planned run ran and finished.
export function batchStatus(runs, { planned, roots, stopped = '' }) {
  const failed = runs.filter((r) => r.status !== 'complete' && !r.capHit)
  const comparable = comparableKeys(runs, roots).size
  const pairs = new Set(runs.map(keyOf)).size
  const violation = runs.some((r) => r.routeViolation)
  const word = violation ? 'FAILED (route)' : failed.length ? 'FAILED' : stopped ? 'STOPPED AT CAP' : runs.length < planned ? 'INCOMPLETE' : 'COMPLETE'
  return { word, failed: failed.length, ran: runs.length, planned, comparable, pairs, compare: roots.length > 1, code: violation ? 4 : failed.length ? 1 : stopped ? 3 : runs.length < planned ? 1 : 0 }
}

export const statusLine = (s) =>
  `status: ${s.word}. ${s.ran} of ${s.planned} planned runs ran, ${s.failed} failed${s.compare ? `; ${s.comparable} of ${s.pairs} pairs finished on every checkout and only those are compared${s.comparable < s.pairs ? ' (the comparison is incomplete)' : ''}` : ''}.${s.code ? ' Not valid evidence of a finished evaluation.' : ''}`

const keyOf = (r) => `${r.case}\u0000${r.variant}\u0000${r.mode}\u0000${r.condition}`
// Runs that count: finished whole, and with --root the same run finished on every checkout.
export function comparableKeys(runs, roots) {
  const keys = new Set(runs.map(keyOf))
  return new Set([...keys].filter((k) => roots.every((root) => runs.some((r) => r.root === root && keyOf(r) === k && r.status === 'complete'))))
}

const label = (root, roots) => (root === HERE ? (roots.length > 1 ? 'candidate' : 'this') : roots.length > 2 ? `baseline-${roots.indexOf(root) + 1}` : 'baseline')

function readEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.replace(/\r$/, '').trim().replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// The evaluation's own settings file. In a real run: the one confirmed route and nothing else from .env, so no
// account, mailbox or device of his can be used and no other model or provider can take over.
const ROUTE_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_LIGHT', 'TIMEZONE', 'BOT_NAME']
export function writeEvalEnv(dir, { real, envFile, mode }) {
  const lines = real ? Object.entries(readEnv(envFile)).filter(([k]) => ROUTE_KEYS.includes(k)).map(([k, v]) => `${k}=${v}`) : []
  if (mode === 'light') lines.push('LLM_LIGHT=true')
  if (mode === 'full' || mode === 'voice') lines.push('LLM_LIGHT=false')
  lines.push('COMPUTER_MODE=off', 'MEMORY_LEARN=off', 'TEAM_MODE=off')
  const file = path.join(dir, 'eval.env')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

// What a process needs from the system to start and find its files, by name. Everything else the parent holds
// (keys, tokens, service settings, proxies, NODE_OPTIONS) stays behind.
export const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
export function childProcessEnv(parent, own, platform = process.platform) {
  // Windows names are not case sensitive ("Path").
  const norm = (k) => (platform === 'win32' ? k.toUpperCase() : k)
  const allowed = new Set(INHERITED.map(norm))
  const env = {}
  for (const [k, v] of Object.entries(parent)) if (allowed.has(norm(k)) && typeof v === 'string') env[k] = v
  return { ...env, ...own }
}

// allowance: how many requests to the model this run may still send (null = offline with no cap).
function runChild({ root, id, v, mode, condition, real, envFile, allowance, route = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-converse-'))
  return new Promise((resolve) => {
    // The server stand-in is preloaded by argument, so no NODE_OPTIONS is passed on at all.
    const proc = spawn(process.execPath, ['--require', PRELOAD, fileURLToPath(import.meta.url), '--child', id, '--variant', String(v), '--condition', condition, '--mode', mode, '--src', root, ...(allowance === null ? [] : ['--allowance', String(allowance)]), ...(real ? ['--real', '--route', route] : [])], {
      cwd: root,
      env: childProcessEnv(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: writeEvalEnv(dir, { real, envFile, mode }), HELPER_OFFLINE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (out += d))
    const limit = setTimeout(() => proc.kill('SIGKILL'), real ? 10 * 60000 : 60000)
    proc.on('close', (code) => {
      clearTimeout(limit)
      // The child writes its count to disk before every request, so it is known even after a crash or a kill.
      // When it cannot be read, the whole allowance counts as spent.
      const count = fs.existsSync(path.join(dir, COUNT_FILE)) ? fs.readFileSync(path.join(dir, COUNT_FILE), 'utf8') : ''
      fs.rmSync(dir, { recursive: true, force: true })
      const line = out.split('\n').findLast((l) => l.startsWith(RESULT))
      // A crash keeps its first error line and its last lines, so the report says why.
      const lines = out.trim().split('\n')
      const first = lines.find((l) => /\b\w*Error\b/.test(l)) || ''
      const result = line ? JSON.parse(line.slice(RESULT.length)) : { error: code === null ? 'timed out' : `crashed (exit ${code}): ${[first, ...lines.slice(-3).filter((l) => l !== first)].join(' ').slice(0, 500)}` }
      const counted = /^\d+/.test(count) ? parseInt(count, 10) : Number.isInteger(result.modelRequests) ? result.modelRequests : line && !result.error ? 0 : (allowance ?? 0)
      const capHit = Boolean(result.capHit) || / cap$/.test(count)
      // Only a child that says so finished; a crash, a timeout or the cap is not a finished run.
      const status = capHit ? 'stopped' : !result.error && result.status === 'complete' ? 'complete' : 'failed'
      if (!line && !result.error) result.error = 'no result'
      resolve({ ...result, status, modelRequests: counted, capHit })
    })
  })
}

// Where a need was found, best first. "messages" = word for word in the recent conversation.
const PLACES = ['messages', 'summary', 'memory', 'absent']
export function verdict(need, where) {
  if (need.where === 'system') return (where === 'system') !== Boolean(need.not) ? 'ok' : 'missing'
  if (need.where === 'memory') return where === 'memory' ? 'ok' : 'missing'
  if (where === 'messages') return 'ok'
  if (where === 'summary') return 'summary-only'
  return 'missing'
}

export function summaryLine(runs, roots) {
  const counted = comparableKeys(runs, roots)
  return roots
    .map((root) => {
      const mine = runs.filter((r) => r.root === root && r.status === 'complete' && counted.has(keyOf(r)))
      const needs = mine.flatMap((r) => r.needs || [])
      const count = (s) => needs.filter((n) => n.verdict === s).length
      const chars = mine.map((r) => r.requestChars || 0)
      const avg = chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0
      const invalid = mine.reduce((n, r) => n + (r.invalidRequests || 0), 0)
      return `${root}: ${invalid ? `${invalid} requests the API would refuse (a tool result away from its call), ` : ''}${count('ok')}/${needs.length} needs in reach, ${count('summary-only')} only in the summary, ${count('missing')} missing, last request ${avg} chars on average (max ${Math.max(0, ...chars)})${runs.some((r) => r.root === root && r.status !== 'complete') ? `, ${runs.filter((r) => r.root === root && r.status !== 'complete').length} runs failed or stopped and are not counted` : ''}`
    })
    .join('\n')
}

function writeReport(runs, { real, roots, data, cap = null, used = 0, stopped = '', planned = runs.length, status = batchStatus(runs, { planned, roots, stopped }) }) {
  const dir = process.env.CONVERSE_REPORT_DIR || path.join(HERE, 'accept-reports')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const json = path.join(dir, `converse-${real ? 'real' : 'offline'}-${stamp}.json`)
  fs.writeFileSync(json, JSON.stringify({ status: status.word, exitCode: status.code, real, roots, cap, requestsUsed: used, planned, ran: runs.length, failed: status.failed, comparablePairs: status.comparable, stopped, runs }, null, 2))
  const cell = (r) => (r ? (r.status !== 'complete' ? `**${r.status === 'stopped' ? 'STOPPED' : 'FAILED'}**: ${String(r.error || '').replace(/\|/g, '/')}` : [...(r.invalidRequests ? [`✗ ${r.invalidRequests} request(s) the API would refuse`] : []), ...r.needs.map((n) => `${n.verdict === 'ok' ? '✓' : n.verdict === 'summary-only' ? '~' : '✗'} ${n.label} (${n.where})`)].join('<br>')) : '-')
  const md = [`# Conversation evaluation, ${real ? 'real model' : 'offline (context only, no model judgment)'}, ${stamp}`, '', `**${statusLine(status)}**`, '', summaryLine(runs, roots).replace(/\n/g, '  \n'), '']
  md.push(`Model requests: ${used}${cap === null ? '' : ` of ${cap} allowed`}. Runs: ${runs.length} of ${planned} planned.${stopped ? ` Batch ${stopped}.` : ''}`, '')
  md.push('✓ in reach for the model, ~ only in the running summary (depends on the summarizer model), ✗ missing.', '')
  for (const c of data.cases) {
    const mine = runs.filter((r) => r.case === c.id)
    if (!mine.length) continue
    md.push(`## ${c.id}`, '', `Expected: ${c.expected}. Hard fail: ${c.hard_fail}.`, '')
    md.push(`| variant | mode | condition | ${roots.join(' | ')} |`, `|---|---|---|${roots.map(() => '---').join('|')}|`)
    const keys = [...new Set(mine.map((r) => `${r.variant}\u0000${r.mode}\u0000${r.condition}`))]
    for (const k of keys) {
      const [variant, mode, condition] = k.split('\u0000')
      const row = roots.map((root) => cell(mine.find((r) => r.root === root && r.variant === variant && r.mode === mode && r.condition === condition)))
      const held = mine.find((r) => r.variant === variant)?.heldout ? ' (held out)' : ''
      md.push(`| ${variant}${held} | ${mode} | ${condition} | ${row.join(' | ')} |`)
    }
    md.push('')
    // A failed run keeps its transcript and errors here, marked: it is a diagnostic, not conversational output.
    for (const r of mine.filter((x) => x.status !== 'complete')) {
      md.push(`**${r.status === 'stopped' ? 'STOPPED' : 'FAILED'}, not counted, not conversational output: ${r.root} · ${r.variant} · ${r.mode} · ${r.condition}**`, '', `> ${String(r.error || '').replace(/\n/g, ' ')}`)
      for (const f of r.failures || []) md.push(`> message ${f.turn + 1}: ${f.error.replace(/\n/g, ' ')}`)
      for (const e of r.modelErrors || []) md.push(`> model endpoint: ${e}`)
      for (const t of r.turns || []) md.push(`> ${t.event ? '[fixture]' : 'נאור:'} ${t.say.replace(/\n/g, ' ')}${t.event ? '' : `  \n> Helper: ${String(t.reply).replace(/\n/g, ' ')}`}`)
      md.push('')
    }
    if (real) {
      for (const r of mine.filter((x) => x.status === 'complete')) {
        md.push(`**${r.root} · ${r.variant} · ${r.mode} · ${r.condition}** (${r.route})`, '')
        for (const t of r.turns) md.push(t.event ? `> [fixture, not model output] ${t.say.replace(/\n/g, ' ')}` : `> נאור: ${t.say.replace(/\n/g, ' ')}`, `> Helper: ${String(t.reply).replace(/\n/g, ' ')}${t.tools.length ? `  \n> tools: ${t.tools.join(', ')}` : ''}${t.cards.length ? `  \n> approval asked (declined): ${t.cards.join(' / ').replace(/\n/g, ' ')}` : ''}`, '')
        if (r.effects.length) md.push(`Effect tools called (review against the hard fail): ${r.effects.join(', ')}`, '')
        md.push('Review: intent _ · continuity _ · tact/timing _ · usefulness _ · naturalness _ · facts/authority/completion _ · hard fail _', '')
      }
    }
  }
  const mdFile = json.replace(/\.json$/, '.md')
  fs.writeFileSync(mdFile, md.join('\n'))
  return mdFile
}

// ── the child: one conversation, one fresh Helper from --src ─────────────────
async function child() {
  // Names only, before the settings file is loaded on top: what this process was really started with.
  const inheritedEnv = Object.keys(process.env).sort()
  const src = path.resolve(flag('src') || HERE)
  const real = has('real')
  // How many requests to the model this run may send. A real run without one, or with one over the ceiling, ends here.
  const allowance = wholeNumber(has('allowance') ? flag('allowance') : null)
  const countFile = path.join(process.env.HELPER_DATA_DIR || os.tmpdir(), COUNT_FILE)
  let sent = 0
  const end = (result, code) => {
    console.log(RESULT + JSON.stringify(result))
    process.exit(code)
  }
  if (Number.isNaN(allowance) || (real && (allowance === null || allowance > REAL_REQUEST_CEILING))) end({ error: `refused: a real run needs a request allowance from 1 to ${REAL_REQUEST_CEILING}`, modelRequests: 0 }, 2)
  // From the first moment, so a run that fails before it asks anything is known to have sent nothing.
  fs.writeFileSync(countFile, '0')
  // Called before a request leaves. At the cap the run ends on the spot and the request is not sent.
  const spend = () => {
    if (allowance !== null && sent >= allowance) {
      fs.writeFileSync(countFile, `${sent} cap`)
      end({ error: `stopped at the request cap (${sent} sent, the next one was not)`, capHit: true, modelRequests: sent }, 3)
    }
    fs.writeFileSync(countFile, String(++sent))
  }
  const data = loadCases()
  const c = data.cases.find((x) => x.id === flag('child'))
  const variant = c.variants[Number(flag('variant'))]
  const condition = flag('condition')
  const mode = flag('mode') || 'full'
  const mod = (p) => import(pathToFileURL(path.join(src, 'src', p)).href)
  const { config } = await mod('config.js')
  const { state } = await mod('store.js')
  const agent = await mod('agent.js')
  const { runTurn, compact } = agent
  const jobs = await mod('jobs.js')
  const { tools } = await mod('tools.js')

  // What the model is asked, per request.
  const requests = []
  const compactions = []
  const blocked = []
  const realFetch = globalThis.fetch
  if (!real) {
    config.llm.apiKey = 'offline'
    config.llm.model = 'offline-model'
    config.llm.baseUrl = `http://${OFFLINE_HOST}`
    config.llm.fallbackModels = []
    config.llm.cheapModel = ''
    config.llm.backup = { apiKey: '', model: '' }
  }
  // A real run stays on the one confirmed route, whatever the checkout's own settings code would add.
  if (real) Object.assign(config.llm, { fallbackModels: [], cheapModel: '', strongModel: '', backup: { baseUrl: '', apiKey: '', model: '' } })
  // The checkout's own settings code must land on the route the owner confirmed, or nothing is sent.
  if (real && (!routeOf({ LLM_MODEL: config.llm.model, LLM_BASE_URL: config.llm.baseUrl }) || routeOf({ LLM_MODEL: config.llm.model, LLM_BASE_URL: config.llm.baseUrl }) !== flag('route'))) end({ error: `refused: this checkout's model route is not the confirmed one (${flag('route') || 'none given'})`, modelRequests: 0 }, 2)
  const endpoint = real ? endpointOf(config.llm.baseUrl) : `http://${OFFLINE_HOST}/chat/completions`
  // Every model answer that was not a success, summaries included (compaction swallows its own failures).
  const modelErrors = []
  let script = []
  // Replies a fixture dictates even in a real run (the text of a background result), used before anything else.
  const forced = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    const host = hostOf(url)
    const isModel = targetOf(url) === endpoint
    const body = isModel ? JSON.parse(init.body) : null
    const summarizing = body && !body.tools && /^סיכום קודם:/.test(String(body.messages?.[1]?.content || ''))
    if (summarizing) compactions.push({ instruction: body.messages[0].content, input: body.messages[1].content })
    else if (body) requests.push(body)
    const stand = (message) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message }] }), text: async () => '' })
    if (isModel && !summarizing && forced.length) return stand({ role: 'assistant', content: forced.shift() })
    if (real && isModel && body.model === config.llm.model) {
      spend()
      // Never followed: a redirect would carry the conversation to an address nobody confirmed.
      const res = await realFetch(url, { ...init, redirect: 'manual' })
      if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
        let next = ''
        try {
          next = new URL(res.headers.get('location') || '', url).href
        } catch {}
        const to = targetOf(next) || 'an address that cannot be shown (query, credentials or unreadable)'
        blocked.push(hostOf(next) || '(redirect)')
        const why = `the model endpoint answered HTTP ${res.status} with a redirect to ${to}; it was not followed and the run ends here`
        fs.writeFileSync(countFile, String(sent))
        end({ error: `route violation: ${why}`, routeViolation: why, modelRequests: sent, blocked: [...new Set(blocked)], status: 'failed' }, 4)
      }
      if (!res.ok) modelErrors.push(`HTTP ${res.status}${summarizing ? ' (summary)' : ''}`)
      return res
    }
    if (!real && host === OFFLINE_HOST) {
      // The stand-in counts like a real request, so the cap is checked offline on the same path.
      spend()
      const message = summarizing ? { role: 'assistant', content: '(סיכום offline: placeholder, no model wrote it)' } : script.shift() || { role: 'assistant', content: '(offline: no model)' }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message }] }), text: async () => '' }
    }
    blocked.push(host)
    // Something shaped like a model request that is not the confirmed endpoint and model (another port, path, host,
    // scheme or model): nothing was sent, and the run ends here rather than let the client try it again and again.
    let shaped = false
    try {
      shaped = /\/chat\/completions$/.test(new URL(url).pathname)
    } catch {}
    if (real && (shaped || isModel)) {
      const why = `a model request went to ${targetOf(url) || 'an address that cannot be shown'}${isModel ? ` for model ${body?.model}` : ''}, not the confirmed route; it was not sent and the run ends here`
      fs.writeFileSync(countFile, String(sent))
      end({ error: `route violation: ${why}`, routeViolation: why, modelRequests: sent, blocked: [...new Set(blocked)], status: 'failed' }, 4)
    }
    throw new TypeError(`fetch failed: ${host} is not reachable in the conversation evaluation`)
  }

  // Every tool is offered, as on a fully connected Helper, and none of them runs.
  const fixtures = { ...(c.fixtures || {}), ...(variant.fixtures || {}) }
  const called = []
  // What a turn's fixture says happens while a tool of that turn is running (a background result landing).
  let during = null
  for (const tool of tools) {
    tool.enabled = () => true
    // These two only change Helper's own notes (the plan, a registered background task), so they really run.
    if (tool.name === 'update_plan' || tool.name === 'start_background_task') {
      const own = tool.run
      tool.run = async (a, ctx) => (called.push({ name: tool.name, args: a }), own(a, ctx))
      continue
    }
    tool.run = async (a) => {
      called.push({ name: tool.name, args: a })
      if (during) await happen(during.splice(0)[0])
      return fixtures[tool.name] || 'הכלי הזה לא זמין בהערכת השיחה (סינתטי). לא בוצעה שום פעולה.'
    }
  }
  config.memoryLearn = false

  // The synthetic memory: more facts than fit in a prompt, so selection matters.
  const now = Date.now()
  state.memory = data.memory.map((m, i) => ({ id: i + 1, fact: m.fact, category: 'other', importance: m.importance, created: now - m.days * 864e5, lastUsed: now - m.days * 864e5, uses: m.uses, source: 'user' }))
  state.summary = ''
  state.history = []
  // "compacted": an earlier stretch of the same day sits in front, sized so that compaction's threshold is reached
  // right after the next-to-last message: the last message is the first one answered from the folded history,
  // the moment a short follow-up is most likely to lose what it refers to. It starts with a turn that used a tool.
  if (condition === 'compacted') {
    const at = config.llm.light ? 12 : 40
    const produced = variant.turns.slice(0, -1).reduce((n, t) => n + 2 + (t.offline?.tools?.length ? 1 + t.offline.tools.length : 0), 0)
    const filler = [{ role: 'user', content: 'מה מזג האוויר מחר בחיפה?' }, { role: 'assistant', content: '', tool_calls: [{ id: 'f0', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'f0', content: 'חיפה מחר: 22°, בהיר' }, { role: 'assistant', content: 'מחר 22° ובהיר ☀️' }]
    const chat = [['היי', 'היי 👋 מה קורה?'], ['ראית את המשחק אתמול?', 'לא ראיתי, אבל שמעתי שהיה צמוד. ניצחו?'], ['כן בהארכה', 'יפה 🔥'], ['תזכיר לי לקנות חלב', 'סגור, מחר בבוקר ⏰'], ['תודה', '👍']]
    for (let n = 0; filler.length + produced < at; n++) filler.push({ role: 'user', content: chat[n % chat.length][0] }, { role: 'assistant', content: chat[n % chat.length][1] })
    state.history = filler
  }

  const ctxBase = {
    source: 'whatsapp',
    cards: [],
    confirm: async (q) => (ctxBase.cards.push(String(q)), false),
    say: async () => {},
    sendMedia: async () => {},
    react: async () => {},
    // A registered background task that never ends by itself: "still running" is real for the rest of the run.
    background: (title) => jobs.startJob(title, () => new Promise(() => {}), () => {}),
  }
  // Something Helper wrote on its own, from the fixture, through the checkout's own code path.
  async function happen(e) {
    if (!e) return
    if (e.event === 'background_result') {
      forced.push(e.result)
      await agent.runBackground(e.title, e.title, { source: 'job', confirm: async () => false })
    } else if (e.event === 'scheduled_result') {
      forced.push(e.result)
      await agent.runTask(e.instruction, { source: 'task', confirm: async () => false })
    } else if (e.event === 'background_external') {
      // Claude Code, the TV, a lesson: index.js sends the result to him; whether it also joins the history is the
      // checkout's own doing (noteBackground), so an older checkout keeps nothing, as in production.
      agent.noteBackground?.(e.title, e.result)
    } else if (e.event === 'background_failed') {
      agent.noteBackground?.(e.title, e.text, true)
    }
  }
  const failures = []
  const VOICE_NOTE = '[שיחה קולית דרך android_app. התשובה שלך תוקרא בקול: משפט או שניים, בלי עיצוב, בלי אימוג\'י, בלי קישורים ובלי רשימות.]'
  let callId = 0
  const turns = []
  let last = null
  for (const [i, turn] of variant.turns.entries()) {
    const isLast = i === variant.turns.length - 1
    if (turn.event) {
      await happen(turn)
      turns.push({ event: turn.event, say: `${turn.event}: ${turn.title || turn.instruction} → ${turn.result || turn.text}`, reply: '', tools: [], cards: [] })
      continue
    }
    if (!real) {
      const off = turn.offline || {}
      const callOf = (t) => ({ id: `t${++callId}`, type: 'function', function: { name: t.name || t, arguments: JSON.stringify(t.args || (t === 'start_background_task' ? { title: 'הכנת קובץ', instruction: turn.say } : {})) } })
      script = [...(off.tools?.length ? [{ role: 'assistant', content: '', tool_calls: off.tools.map(callOf) }] : []), { role: 'assistant', content: off.reply || '(offline: no model)' }]
    }
    during = turn.during ? [turn.during] : null
    const before = requests.length
    const calledBefore = called.length
    ctxBase.cards = []
    const ctx = { ...ctxBase }
    ctx.confirm = async (q) => (ctx.cards.push(String(q)), false)
    let reply = ''
    let failedTurn = false
    try {
      reply = await runTurn(mode === 'voice' ? `${VOICE_NOTE}\n${turn.say}` : turn.say, mode === 'voice' ? Object.assign(ctx, { source: 'android_app' }) : ctx)
    } catch (e) {
      failedTurn = true
      failures.push({ turn: i, error: String(e.message).slice(0, 300) })
      reply = `(turn failed: ${e.message})`
    }
    if (isLast) last = { request: requests[before], summary: state.summary || '', domains: [...(ctx.domains || [])] }
    turns.push({ say: turn.say, reply: real || failedTurn ? reply : '(offline)', failed: failedTurn, tools: called.slice(calledBefore).map((t) => t.name), cards: ctx.cards })
    // As index.js does after every turn.
    await compact().catch(() => false)
  }

  const textOf = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '')
  const system = textOf(last?.request?.messages?.[0] || {})
  const convo = (last?.request?.messages || []).slice(1).map(textOf).join('\n')
  const memoryLines = system.split('\n').filter((l) => /^#\d+ /.test(l)).join('\n')
  // A run with a failed message or a model error is a diagnostic, not a sample: nothing of it is scored.
  const complete = !failures.length && !modelErrors.length
  const needs = (complete ? variant.need || [] : []).map((need) => {
    const re = new RegExp(need.re)
    const folded = compactions.some((x) => re.test(x.input))
    // Offline the summary is a placeholder, so "summary" means the summarizer was shown it; real runs check the text.
    const inSummary = Boolean(last?.summary) && system.includes(last.summary) && (real ? re.test(last.summary) : folded)
    const where = need.where === 'system' ? (re.test(system) ? 'system' : 'absent') : need.where === 'memory' ? (re.test(memoryLines) ? 'memory' : 'absent') : re.test(convo) ? 'messages' : inSummary ? 'summary' : 'absent'
    return { label: need.label, want: need.where || 'conversation', where, verdict: verdict(need, where), summarizerSaw: folded }
  })
  // A tool result must follow the call that asked for it, or the provider refuses the whole request.
  const invalidRequests = requests.filter((body) => {
    const m = body.messages
    return m.some((x, i) => {
      if (x.role !== 'tool') return false
      let j = i - 1
      while (j >= 0 && m[j].role === 'tool') j--
      return !(m[j]?.role === 'assistant' && m[j].tool_calls?.some((c) => c.id === x.tool_call_id))
    })
  }).length
  const effects = called.filter((t) => (c.effects || []).includes(t.name)).map((t) => t.name)
  const result = {
    status: complete ? 'complete' : 'failed',
    ...(complete ? {} : { error: `${failures.length} of ${variant.turns.filter((t) => !t.event).length} messages failed${modelErrors.length ? `, model endpoint: ${[...new Set(modelErrors)].join(', ')}` : ''}`, failures, modelErrors }),
    scored: complete,
    modelRequests: sent,
    inheritedEnv,
    route: real ? `${routeOf({ LLM_MODEL: config.llm.model, LLM_BASE_URL: config.llm.baseUrl })}${config.llm.light ? ' (light)' : ''}` : `offline stand-in${config.llm.light ? ' (light)' : ' (full)'}`,
    needs,
    invalidRequests,
    compactions: compactions.length,
    summaryInstruction: compactions[0]?.instruction || '',
    historyAtLastTurn: (last?.request?.messages || []).length - 1,
    // The size of the last message's first request (system prompt and messages, tool definitions not counted).
    requestChars: system.length + convo.length,
    domains: last?.domains || [],
    effects,
    blocked: [...new Set(blocked)],
    turns,
    summary: real ? last?.summary || '' : '',
  }
  console.log(RESULT + JSON.stringify(result))
  process.exit(0)
}

if (flag('child') !== null) await child()
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
