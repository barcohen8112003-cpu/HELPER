// Conversation evaluation: does a short follow-up still have what it depends on? npm run eval:converse
//
// Runs the synthetic conversations in accept/converse/cases.json through the real runTurn and the real compaction,
// each in its own process with its own empty data folder, and reports for the last message of each conversation
// where the facts it needs sit in the model's request: in the recent messages (word for word), only in the running
// summary, in the memory section, or nowhere.
//
//   npm run eval:converse                              offline: a local stand-in model, no network, no key
//   npm run eval:converse -- --root ../HELPER-base     compare two checkouts (baseline first, then this one)
//   npm run eval:converse -- --real                    the model route in .env, for both checkouts alike
//   npm run eval:converse -- --only chosen-option --modes light --conditions compacted
//
// Offline proves only what reaches the model (plumbing and contract), never how a real model judges. The assistant
// lines it uses are scripted stand-ins from the cases file, and the summary is a placeholder, so anything that
// survives only in the summary is marked as depending on the summarizer model.
// --real talks to the model in .env (LLM_* keys only reach the child). No tool really runs: each answers from the
// case's synthetic fixture or says it is not available, every approval card is declined, and the only network the
// child can reach is the model's host. Reports go to accept-reports/ (not in git) and hold synthetic text only.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CASES = path.join(HERE, 'accept', 'converse', 'cases.json')
const RESULT = 'CONVERSE_RESULT '
const OFFLINE_HOST = 'offline.invalid'
const args = process.argv.slice(2)
const all = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : a.startsWith(`--${name}=`) ? [a.split('=')[1]] : []))
const flag = (name) => all(name)[0] ?? (args.includes(`--${name}`) ? '' : null)
const list = (name, fallback) => (flag(name) ? flag(name).split(',').map((s) => s.trim()).filter(Boolean) : fallback)

export function loadCases(file = CASES) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── the parent ───────────────────────────────────────────────────────────────
async function main() {
  const data = loadCases()
  const real = flag('real') !== null
  // Baseline checkouts first (--root, in the order given), this checkout last.
  const roots = [...all('root').map((r) => path.resolve(r)), HERE]
  const only = list('only', null)
  const modes = list('modes', real ? ['configured'] : ['full', 'light'])
  const conditions = list('conditions', ['fresh', 'compacted'])
  const envFile = process.env.HELPER_ENV_FILE || path.join(HERE, '.env')
  if (real) {
    const env = readEnv(envFile)
    if (!env.LLM_API_KEY || !env.LLM_MODEL) {
      console.log(`--real talks to the model route in ${envFile}: LLM_API_KEY and LLM_MODEL are needed there. Nothing ran.`)
      process.exit(2)
    }
    console.log(`real model route: ${env.LLM_MODEL} at ${hostOf(env.LLM_BASE_URL || '')} (light ${env.LLM_LIGHT || 'off'}), the same for every checkout`)
  }
  const runs = []
  for (const root of roots) {
    for (const c of data.cases) {
      if (only && !only.includes(c.id)) continue
      for (const [v, variant] of c.variants.entries()) {
        for (const mode of modes) {
          for (const condition of conditions) {
            const r = await runChild({ root, id: c.id, v, mode, condition, real, envFile })
            runs.push({ root: label(root, roots), case: c.id, variant: variant.name, heldout: Boolean(variant.heldout), mode, condition, ...r })
            process.stdout.write(r.error ? 'x' : '.')
          }
        }
      }
    }
  }
  console.log('')
  const file = writeReport(runs, { real, roots: roots.map((r) => label(r, roots)), data })
  console.log(summaryLine(runs, roots.map((r) => label(r, roots))))
  console.log(`report: ${path.relative(process.cwd(), file)}`)
  return runs
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

// Only the model settings reach a real run, so no account, mailbox or device of his can be used.
function childEnv(dir, { real, envFile, mode }) {
  const lines = real ? Object.entries(readEnv(envFile)).filter(([k]) => /^(LLM_[A-Z_]+|TIMEZONE|BOT_NAME)$/.test(k)).map(([k, v]) => `${k}=${v}`) : []
  if (mode === 'light') lines.push('LLM_LIGHT=true')
  if (mode === 'full') lines.push('LLM_LIGHT=false')
  lines.push('COMPUTER_MODE=off', 'MEMORY_LEARN=off', 'TEAM_MODE=off')
  const file = path.join(dir, 'eval.env')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function runChild({ root, id, v, mode, condition, real, envFile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-converse-'))
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', id, '--variant', String(v), '--condition', condition, '--src', root, ...(real ? ['--real'] : [])], {
      cwd: root,
      env: {
        ...process.env,
        HELPER_DATA_DIR: dir,
        HELPER_ENV_FILE: childEnv(dir, { real, envFile, mode }),
        HELPER_OFFLINE: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(HERE, 'scripts', 'as-server.cjs')}`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (out += d))
    const limit = setTimeout(() => proc.kill('SIGKILL'), real ? 10 * 60000 : 60000)
    proc.on('close', (code) => {
      clearTimeout(limit)
      fs.rmSync(dir, { recursive: true, force: true })
      const line = out.split('\n').findLast((l) => l.startsWith(RESULT))
      if (line) return resolve(JSON.parse(line.slice(RESULT.length)))
      resolve({ error: code === null ? 'timed out' : `crashed (exit ${code}): ${out.trim().split('\n').slice(-4).join(' ').slice(0, 300)}` })
    })
  })
}

// Where a need was found, best first. "messages" = word for word in the recent conversation.
const PLACES = ['messages', 'summary', 'memory', 'absent']
export function verdict(need, where) {
  if (need.where === 'memory') return where === 'memory' ? 'ok' : 'missing'
  if (where === 'messages') return 'ok'
  if (where === 'summary') return 'summary-only'
  return 'missing'
}

export function summaryLine(runs, roots) {
  return roots
    .map((root) => {
      const mine = runs.filter((r) => r.root === root && !r.error)
      const needs = mine.flatMap((r) => r.needs || [])
      const count = (s) => needs.filter((n) => n.verdict === s).length
      const chars = mine.map((r) => r.requestChars || 0)
      const avg = chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0
      return `${root}: ${count('ok')}/${needs.length} needs in reach, ${count('summary-only')} only in the summary, ${count('missing')} missing, last request ${avg} chars on average (max ${Math.max(0, ...chars)})${runs.some((r) => r.root === root && r.error) ? `, ${runs.filter((r) => r.root === root && r.error).length} runs failed` : ''}`
    })
    .join('\n')
}

function writeReport(runs, { real, roots, data }) {
  const dir = process.env.CONVERSE_REPORT_DIR || path.join(HERE, 'accept-reports')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const json = path.join(dir, `converse-${real ? 'real' : 'offline'}-${stamp}.json`)
  fs.writeFileSync(json, JSON.stringify({ real, roots, runs }, null, 2))
  const cell = (r) => (r ? (r.error ? `error: ${r.error}` : r.needs.map((n) => `${n.verdict === 'ok' ? '✓' : n.verdict === 'summary-only' ? '~' : '✗'} ${n.label} (${n.where})`).join('<br>')) : '-')
  const md = [`# Conversation evaluation, ${real ? 'real model' : 'offline (context only, no model judgment)'}, ${stamp}`, '', summaryLine(runs, roots).replace(/\n/g, '  \n'), '']
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
    if (real) {
      for (const r of mine.filter((x) => !x.error)) {
        md.push(`**${r.root} · ${r.variant} · ${r.mode} · ${r.condition}** (${r.route})`, '')
        for (const t of r.turns) md.push(`> נאור: ${t.say.replace(/\n/g, ' ')}`, `> Helper: ${String(t.reply).replace(/\n/g, ' ')}${t.tools.length ? `  \n> tools: ${t.tools.join(', ')}` : ''}${t.cards.length ? `  \n> approval asked (declined): ${t.cards.join(' / ').replace(/\n/g, ' ')}` : ''}`, '')
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
  const src = path.resolve(flag('src') || HERE)
  const real = flag('real') !== null
  const data = loadCases()
  const c = data.cases.find((x) => x.id === flag('child'))
  const variant = c.variants[Number(flag('variant'))]
  const condition = flag('condition')
  const mod = (p) => import(pathToFileURL(path.join(src, 'src', p)).href)
  const { config } = await mod('config.js')
  const { state } = await mod('store.js')
  const { runTurn, compact } = await mod('agent.js')
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
  const llmHosts = new Set([hostOf(config.llm.baseUrl), hostOf(config.llm.backup?.baseUrl)].filter(Boolean))
  let script = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    const host = hostOf(url)
    const isModel = llmHosts.has(host) && /\/chat\/completions$/.test(url)
    const body = isModel ? JSON.parse(init.body) : null
    const summarizing = body && !body.tools && /^סיכום קודם:/.test(String(body.messages?.[1]?.content || ''))
    if (summarizing) compactions.push({ instruction: body.messages[0].content, input: body.messages[1].content })
    else if (body) requests.push(body)
    if (real && isModel) return realFetch(input, init)
    if (!real && host === OFFLINE_HOST) {
      const message = summarizing ? { role: 'assistant', content: '(סיכום offline: placeholder, no model wrote it)' } : script.shift() || { role: 'assistant', content: '(offline: no model)' }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message }] }), text: async () => '' }
    }
    blocked.push(host)
    throw new TypeError(`fetch failed: ${host} is not reachable in the conversation evaluation`)
  }

  // Every tool is offered, as on a fully connected Helper, and none of them runs.
  const fixtures = { ...(c.fixtures || {}), ...(variant.fixtures || {}) }
  const called = []
  for (const tool of tools) {
    tool.enabled = () => true
    tool.run = async (a) => {
      called.push({ name: tool.name, args: a })
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
    background: (title) => ({ title }),
  }
  let callId = 0
  const turns = []
  let last = null
  for (const [i, turn] of variant.turns.entries()) {
    const isLast = i === variant.turns.length - 1
    if (!real) {
      const off = turn.offline || {}
      script = [...(off.tools?.length ? [{ role: 'assistant', content: '', tool_calls: off.tools.map((name) => ({ id: `t${++callId}`, type: 'function', function: { name, arguments: '{}' } })) }] : []), { role: 'assistant', content: off.reply || '(offline: no model)' }]
    }
    const before = requests.length
    const calledBefore = called.length
    ctxBase.cards = []
    const ctx = { ...ctxBase }
    ctx.confirm = async (q) => (ctx.cards.push(String(q)), false)
    let reply = ''
    try {
      reply = await runTurn(turn.say, ctx)
    } catch (e) {
      reply = `(turn failed: ${e.message})`
    }
    if (isLast) last = { request: requests[before], summary: state.summary || '', domains: [...(ctx.domains || [])] }
    turns.push({ say: turn.say, reply: real ? reply : '(offline)', tools: called.slice(calledBefore).map((t) => t.name), cards: ctx.cards })
    // As index.js does after every turn.
    await compact().catch(() => false)
  }

  const textOf = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '')
  const system = textOf(last?.request?.messages?.[0] || {})
  const convo = (last?.request?.messages || []).slice(1).map(textOf).join('\n')
  const memoryLines = system.split('\n').filter((l) => /^#\d+ /.test(l)).join('\n')
  const needs = (variant.need || []).map((need) => {
    const re = new RegExp(need.re)
    const folded = compactions.some((x) => re.test(x.input))
    // Offline the summary is a placeholder, so "summary" means the summarizer was shown it; real runs check the text.
    const inSummary = Boolean(last?.summary) && system.includes(last.summary) && (real ? re.test(last.summary) : folded)
    const where = need.where === 'memory' ? (re.test(memoryLines) ? 'memory' : 'absent') : re.test(convo) ? 'messages' : inSummary ? 'summary' : 'absent'
    return { label: need.label, want: need.where || 'conversation', where, verdict: verdict(need, where), summarizerSaw: folded }
  })
  const effects = called.filter((t) => (c.effects || []).includes(t.name)).map((t) => t.name)
  const result = {
    route: real ? `${config.llm.model} @ ${hostOf(config.llm.baseUrl)}${config.llm.light ? ' (light)' : ''}` : `offline stand-in${config.llm.light ? ' (light)' : ' (full)'}`,
    needs,
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
