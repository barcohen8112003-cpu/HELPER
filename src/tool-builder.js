// Tools HELPER writes for itself.
//
// A request nothing in the toolbox covers (a converter, a parser, a calculation) can become a new tool: Claude Code, or
// the main model when Claude Code is not connected, writes one small module; HELPER checks it, tests it, shows Naor what
// it is, and installs it only after his yes.
//
// The code is never trusted. Every call runs in its own process under Node's permission model (src/sandbox-runner.mjs):
// no file writes, no other file reads, no child processes, no threads, and an empty environment, so Helper's keys and
// memory are not there to take. What is left open is the network, so a module that uses it is marked and he is told
// before he approves. A module is plain functions in one file with no imports (the first check turns away anything else).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from './config.js'
import { newId, state, save } from './store.js'
import { registerTool, unregisterTool, hasToolNamed } from './toolkit/registry.js'

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-runner.mjs')
export const PROPOSALS_DIR = () => path.join(DATA_DIR, 'tool-proposals')
export const USER_TOOLS_DIR = () => path.join(DATA_DIR, 'user-tools')
const MAX_SOURCE = 24 * 1024
const CALL_TIMEOUT_MS = 8000
const TEST_TIMEOUT_MS = 20000
const MAX_PROPOSALS = 10
const MAX_USER_TOOLS = 40

// ── the first check: what a module may contain ───────────────────────────────

// Not the wall, only a filter that turns away the obvious. The wall is the sandbox.
const FORBIDDEN = [
  [/\bimport\b/, 'import (המודול צריך להיות קובץ אחד בלי תלויות)'],
  [/\brequire\b/, 'require'],
  [/\bprocess\b/, 'process'],
  [/\bchild_process\b|\bspawn\b|\bexecSync\b/, 'הרצת תהליכים'],
  [/\beval\b|\bFunction\s*\(|new\s+Function/, 'eval או Function'],
  [/\bglobalThis\b|\bglobal\b|\bself\b|\bwindow\b/, 'גישה לאובייקט הגלובלי'],
  [/\bWebAssembly\b|\bWorker\b|\bSharedArrayBuffer\b|\bAtomics\b/, 'WebAssembly, Worker או זיכרון משותף'],
  [/\.constructor\b|__proto__|\bReflect\b|\bProxy\b/, 'גישה לאב-טיפוס'],
  [/node:|\bfs\b|\bnet\b|\bhttp\b|\bos\b\s*\./, 'מודולים של Node'],
  [/\bsetInterval\b/, 'setInterval'],
]
const NETWORK = /\bfetch\b|XMLHttpRequest|WebSocket|EventSource/
export const NAME = /^[a-z][a-z0-9_]{2,40}$/

export function staticCheck(source) {
  const problems = []
  const text = String(source || '')
  if (!text.trim()) problems.push('הקובץ ריק')
  if (text.length > MAX_SOURCE) problems.push(`הקובץ ארוך מדי (${text.length} תווים, התקרה ${MAX_SOURCE})`)
  // Comments and strings are checked too: a word hidden there is no reason to trust the rest.
  for (const [re, label] of FORBIDDEN) if (re.test(text)) problems.push(`אסור להשתמש ב-${label}`)
  if (!/export\s+const\s+tools\b/.test(text)) problems.push('חסר export const tools')
  if (!/export\s+const\s+tests\b/.test(text)) problems.push('חסר export const tests')
  return { ok: problems.length === 0, problems, network: NETWORK.test(text) }
}

// ── running it in the sandbox ────────────────────────────────────────────────

// -> the parsed answer of the runner. Rejects on a timeout, a crash, or output that is not one JSON document.
export function sandboxRun(file, request, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const abs = path.resolve(file)
    // Windows needs its system folder variable to start a process at all; nothing else goes in.
    const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${abs}`, '--max-old-space-size=96', RUNNER, abs], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('הכלי לא סיים בזמן'))), timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > 200_000) child.kill('SIGKILL')
    })
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => (clearTimeout(timer), reject(e)))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(`הכלי קרס או החזיר תשובה לא תקינה${err ? `: ${err.split('\n').find((l) => l.trim())?.slice(0, 120)}` : ''}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

// ── proposals ────────────────────────────────────────────────────────────────

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

function allNamesTaken(names) {
  return names.filter((n) => hasToolNamed(n))
}

// Checks and tests a module. -> { ok, problems, info? }. `file` is read, never executed outside the sandbox.
export async function validateModule(file) {
  const source = fs.readFileSync(file, 'utf8')
  const first = staticCheck(source)
  if (!first.ok) return { ok: false, problems: first.problems }
  let described
  try {
    described = await sandboxRun(file, { op: 'describe' })
  } catch (e) {
    return { ok: false, problems: [`המודול לא נטען: ${e.message}`] }
  }
  if (!described.ok) return { ok: false, problems: [`המודול לא נטען: ${described.error}`] }
  const problems = []
  const tools = described.tools || []
  if (!tools.length) problems.push('המודול לא מגדיר אף כלי')
  if (tools.length > 5) problems.push('יותר מדי כלים במודול אחד (עד 5)')
  for (const t of tools) {
    if (!NAME.test(t.name || '')) problems.push(`שם כלי לא תקין: ${t.name}`)
    if (!t.description || t.description.length < 8 || t.description.length > 220) problems.push(`${t.name}: התיאור צריך להיות בין 8 ל-220 תווים`)
    if (!t.parameters || t.parameters.type !== 'object') problems.push(`${t.name}: parameters חייב להיות אובייקט`)
  }
  const taken = allNamesTaken(tools.map((t) => t.name))
  if (taken.length) problems.push(`שם כבר תפוס: ${taken.join(', ')}`)
  if (problems.length) return { ok: false, problems }
  let tested
  try {
    tested = await sandboxRun(file, { op: 'test' }, { timeoutMs: TEST_TIMEOUT_MS })
  } catch (e) {
    return { ok: false, problems: [`הבדיקות לא רצו: ${e.message}`] }
  }
  if (!tested.ok) return { ok: false, problems: [`הבדיקות לא רצו: ${tested.error}`] }
  const covered = new Set((tested.results || []).map((r) => r.tool))
  for (const t of tools) if (!covered.has(t.name)) problems.push(`${t.name}: אין לו אף בדיקה`)
  for (const r of tested.results || []) if (!r.pass) problems.push(`בדיקה נכשלה ב-${r.tool}: ${r.why}`)
  const network = first.network || tools.some((t) => t.network)
  return problems.length
    ? { ok: false, problems }
    : { ok: true, problems: [], info: { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, network: Boolean(t.network) })), network, tests: (tested.results || []).length, size: source.length } }
}

const proposals = () => (state.toolProposals ??= [])
export const pendingTools = () => proposals()

// Saves a validated module as a proposal waiting for Naor. -> { ok: true, id, info } or { ok: false, problems }.
export async function proposeModule(source, { title = '', request = '' } = {}) {
  fs.mkdirSync(PROPOSALS_DIR(), { recursive: true })
  const id = newId()
  const file = path.join(PROPOSALS_DIR(), `${id}.mjs`)
  fs.writeFileSync(file, String(source))
  const checked = await validateModule(file)
  if (!checked.ok) {
    fs.rmSync(file, { force: true })
    return { ok: false, problems: checked.problems }
  }
  if (proposals().length >= MAX_PROPOSALS) {
    const old = proposals().shift()
    fs.rmSync(path.join(PROPOSALS_DIR(), `${old.id}.mjs`), { force: true })
  }
  proposals().push({ id, title: clean(title || checked.info.tools[0].name, 80), request: clean(request, 300), info: checked.info, at: Date.now() })
  save()
  return { ok: true, id, info: checked.info }
}

export function rejectModules(ids) {
  const drop = ids?.length ? proposals().filter((p) => ids.includes(p.id)) : [...proposals()]
  for (const p of drop) fs.rmSync(path.join(PROPOSALS_DIR(), `${p.id}.mjs`), { force: true })
  state.toolProposals = proposals().filter((p) => !drop.includes(p))
  save()
  return drop.length
}

// What Naor is shown before he says yes.
export function describeProposal(p) {
  const tools = p.info.tools.map((t) => `• ${t.name}: ${t.description}`).join('\n')
  return [
    `להתקין כלי חדש שכתבתי לעצמי?`,
    tools,
    `בדקתי אותו: ${p.info.tests} בדיקות עברו.`,
    p.info.network ? '⚠️ הכלי הזה פונה לאינטרנט.' : 'הוא לא פונה לאינטרנט.',
    'הוא רץ בבידוד: בלי גישה לקבצים, למפתחות, לזיכרון או למחשב.',
  ].join('\n')
}

// ── installed tools ──────────────────────────────────────────────────────────

function toolObjects(file, info) {
  return info.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    network: t.network,
    learned: true,
    async run(args) {
      const out = await sandboxRun(file, { op: 'call', tool: t.name, args })
      if (!out.ok) throw new Error(out.error || 'הכלי נכשל')
      return out.result
    },
  }))
}

// Moves an approved proposal into the installed tools and makes it available at once.
export function installProposal(id) {
  const p = proposals().find((x) => x.id === id)
  if (!p) throw new Error('אין הצעה כזאת')
  if (fs.existsSync(USER_TOOLS_DIR()) && fs.readdirSync(USER_TOOLS_DIR()).filter((f) => f.endsWith('.mjs')).length >= MAX_USER_TOOLS) throw new Error(`יש כבר ${MAX_USER_TOOLS} כלים שנלמדו. אפשר להסיר אחד עם tool_remove`)
  fs.mkdirSync(USER_TOOLS_DIR(), { recursive: true })
  const from = path.join(PROPOSALS_DIR(), `${p.id}.mjs`)
  const first = p.info.tools[0].name
  const to = path.join(USER_TOOLS_DIR(), `${first}.mjs`)
  fs.copyFileSync(from, to)
  fs.writeFileSync(`${to}.json`, JSON.stringify({ title: p.title, request: p.request, tools: p.info.tools.map((t) => t.name), network: p.info.network, installedAt: Date.now() }, null, 2))
  fs.rmSync(from, { force: true })
  state.toolProposals = proposals().filter((x) => x !== p)
  save()
  for (const t of toolObjects(to, p.info)) registerTool(t, 'learned', 'כלים שהעוזר כתב לעצמו')
  return p.info.tools.map((t) => t.name)
}

// Installed tools are checked again each time Helper starts: a file that changed on disk is not loaded blindly.
export async function loadUserTools() {
  const dir = USER_TOOLS_DIR()
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const file = path.join(dir, f)
    try {
      const first = staticCheck(fs.readFileSync(file, 'utf8'))
      if (!first.ok) throw new Error(first.problems.join('; '))
      const d = await sandboxRun(file, { op: 'describe' })
      if (!d.ok) throw new Error(d.error)
      const info = { tools: d.tools }
      for (const t of toolObjects(file, info)) {
        if (!hasToolNamed(t.name)) (registerTool(t, 'learned', 'כלים שהעוזר כתב לעצמו'), n++)
      }
    } catch (e) {
      console.log(`[tools] ${f} לא נטען: ${e.message}`)
    }
  }
  return n
}

export function removeUserTool(name) {
  const dir = USER_TOOLS_DIR()
  if (!fs.existsSync(dir)) return false
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (!meta.tools.includes(name)) continue
    for (const t of meta.tools) unregisterTool(t)
    fs.rmSync(path.join(dir, f), { force: true })
    fs.rmSync(path.join(dir, f.replace(/\.json$/, '')), { force: true })
    return meta.tools
  }
  return false
}

export function listUserTools() {
  const dir = USER_TOOLS_DIR()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((x) => x.endsWith('.mjs.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

// ── asking a writer ──────────────────────────────────────────────────────────

// The instructions for whoever writes the module (Claude Code, or the main model).
export const WRITER_BRIEF = `Write ONE JavaScript module file that adds a small tool to a personal assistant. Output only the file.

Contract (a checker rejects anything else):
- One ES module, plain functions, NO imports and NO require. No process, eval, Function, globalThis, child processes, files.
- The tool never touches the user's files or machine. It computes, converts, parses or formats what it is given.
- Only if the request really needs live data from a public website may it use fetch(url, { signal: AbortSignal.timeout(8000) }); then set network: true on that tool. Otherwise use no network at all.
- export const tools = [{ name, description, parameters, run(args) }]
  name: lowercase snake_case, 3-40 chars. description: Hebrew, one sentence, under 150 chars, says what it does and its inputs.
  parameters: { type: 'object', properties: { x: { type: 'string', description: '...' } }, required: ['x'] }
  run(args) returns a short Hebrew string. Bad input: throw new Error('הודעה בעברית').
- export const tests = [{ tool: 'name', args: {...}, check: (result) => boolean }]  at least one real test per tool, with an expected value you worked out by hand. Tests never use the network. A test that expects an error: { tool, args, throws: true, check: () => false }.
- Up to 3 tools in the module, each doing one thing well.

Example of the shape:
export const tools = [{
  name: 'text_count_words',
  description: 'סופר מילים בטקסט.',
  parameters: { type: 'object', properties: { text: { type: 'string', description: 'הטקסט' } }, required: ['text'] },
  run({ text }) { if (!text) throw new Error('חסר טקסט'); return String(text.trim().split(/\\s+/).length) },
}]
export const tests = [{ tool: 'text_count_words', args: { text: 'a b c' }, check: (r) => r === '3' }]

The request:
`

// Pulls the module out of a model reply that may wrap it in a code fence.
export function extractModule(reply) {
  const text = String(reply || '')
  const fence = text.match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/)
  return (fence ? fence[1] : text).trim()
}
