// node src/learning-selftest.js
// Offline: no model reached, no network, temp data folder. Covers lessons (skills.js), the tools Helper writes for
// itself (tool-builder.js, including the sandbox they run in), and the approvals around both.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-learn-'))
process.env.HELPER_DATA_DIR = dir
process.env.SECRET_TEST = 'must-not-reach-the-sandbox'

const { state } = await import('./store.js')
const { tools, allTools, activeTools } = await import('./tools.js')
const { config: appConfig } = await import('./config.js')
const wasOff = appConfig.learning === false
const sk = await import('./skills.js')
const tb = await import('./tool-builder.js')
const reg = await import('./toolkit/registry.js')
const { skillTools, builderTools, learningBlock } = await import('./learning-tools.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
const rejects = async (p) => p.then(() => false, () => true)
const find = (name) => [...skillTools, ...builderTools].find((t) => t.name === name)

// ── the master switch ────────────────────────────────────────────────────────
ok(wasOff, 'self-learning is off unless SELF_LEARNING=on')
const names = () => activeTools().map((t) => t.name)
ok(!['skill_search', 'skill_propose', 'skill_confirm', 'skill_gap', 'learn_how', 'build_tool', 'tool_install', 'tool_remove'].some((n) => names().includes(n)), 'off: none of its tools exist for the model')
ok(names().includes('audit_search') && names().includes('memory_search'), 'and the rest of the toolbox is untouched')
appConfig.learning = true
ok(['skill_search', 'skill_propose', 'skill_confirm', 'learn_how', 'build_tool', 'tool_install'].every((n) => names().includes(n)), 'on: they all appear')

// ── lessons ──────────────────────────────────────────────────────────────────
const good = { title: 'לשלוח קובץ מהמחשב לטלוויזיה', when: 'כשמבקשים להעביר קובץ מהמחשב למסך הטלוויזיה בסלון', steps: '1. לפתוח את הקובץ במחשב. 2. לשתף דרך Cast לטלוויזיה. 3. לבדוק שהצליל עובר גם כן.', sources: ['https://support.google.com/chromecast', 'http://localhost/x', 'not a url'] }
ok(throws(() => sk.checkSkill({ ...good, title: 'x' })), 'a lesson needs a title')
ok(throws(() => sk.checkSkill({ ...good, when: 'קצר' })), 'and a "when"')
ok(throws(() => sk.checkSkill({ ...good, steps: 'קצר מדי' })), 'and real steps')
ok(throws(() => sk.checkSkill({ ...good, steps: `${good.steps} הסיסמה שלי היא hunter2` })), 'a password never goes into a lesson')
ok(sk.checkSkill(good).sources.length === 1, 'only public web addresses are kept as sources')

const first = sk.proposeSkill(good)
ok(first.status === 'proposed' && sk.pendingSkills().length === 1 && sk.allSkills().length === 0, 'a lesson is proposed, not saved')
ok(sk.proposeSkill(good).status === 'queued', 'the same proposal is not queued twice')
const saved = sk.confirmSkills([first.id])
ok(saved[0].status === 'saved' && sk.allSkills().length === 1 && sk.pendingSkills().length === 0, 'approval saves it')
ok(sk.proposeSkill(good).status === 'known', 'a lesson already kept is not proposed again')
const better = sk.proposeSkill({ ...good, steps: `${good.steps} 4. אם אין צליל, לבחור את הטלוויזיה כהתקן שמע.` })
ok(better.status === 'proposed' && better.replaces === first.id, 'an improved version offers to replace the old one')
ok(sk.confirmSkills()[0].status === 'updated' && sk.allSkills().length === 1 && sk.allSkills()[0].steps.includes('התקן שמע'), 'and replaces it when approved')
ok(sk.rejectSkills() === 0, 'rejecting with nothing waiting does nothing')
const other = sk.proposeSkill({ title: 'להזמין מונית דרך האפליקציה', when: 'כשמבקשים להזמין מונית או נסיעה', steps: '1. לפתוח את אפליקציית ההסעות. 2. להזין יעד. 3. לאשר את המחיר עם המשתמש לפני הזמנה.' })
ok(sk.rejectSkills([other.id]) === 1 && sk.pendingSkills().length === 0, 'a lesson he does not want is dropped')

ok(sk.relevantSkills('תעביר לי קובץ מהמחשב לטלוויזיה בבקשה').length === 1, 'a request that fits finds the lesson')
ok(sk.relevantSkills('מה מזג האוויר מחר בתל אביב').length === 0, 'an unrelated one does not')
ok(sk.relevantSkills('קובץ').length === 0, 'one shared word is not enough')
const block = sk.skillsBlock('תעביר קובץ מהמחשב לטלוויזיה', { now: 1e12 })
ok(block.includes('לשלוח קובץ מהמחשב לטלוויזיה') && block.includes('לקחים שלמדת קודם'), 'the lesson reaches the prompt')
ok(!sk.skillsBlock('מה השעה עכשיו', { now: 1e12 }).includes('לשלוח קובץ'), 'and only when it fits')
ok(sk.allSkills()[0].uses >= 1, 'its use is counted')

sk.proposeSkill({ title: 'לקרוא דוח בלוח המחוונים', when: 'כשמבקשים לקרוא דוחות מלוח המחוונים של בית הספר', steps: '1. להיכנס ללוח המחוונים. 2. לבחור את הדוח. 3. להעתיק את הערכים החשובים לסיכום.' })
state.skillsAskedAt = 0
ok(sk.skillsBlock('היי', { now: 1e12 }).includes('ממתינים לאישור'), 'waiting lessons are mentioned in the prompt')
state.skillsAskedAt = 1e12
ok(!sk.skillsBlock('היי', { now: 1e12 + 3600e3 }).includes('ממתינים לאישור'), 'but not again within four hours of the last ask')
sk.rejectSkills()

ok(sk.noteGap('לשלוח פקס מהמחשב', 'אין לי כלי לזה') === true, 'a request it could not do is noted')
ok(sk.noteGap('לשלוח פקס מהמחשב עכשיו') === false && sk.openGaps().length === 1, 'the same request is not noted twice')
ok(sk.noteGap('hi') === false, 'too short to be a request')
ok(sk.noteGap('הסיסמה של הבנק שלי hunter2 ואני רוצה להיכנס') === false, 'a secret is never noted')
sk.clearGaps(['לשלוח פקס מהמחשב'])
ok(sk.openGaps().length === 0, 'studied requests are cleared')
ok(sk.removeSkill(first.id) && !sk.removeSkill(first.id), 'a lesson can be forgotten, once')

// ── the approvals around them ────────────────────────────────────────────────
ok(['skill_confirm', 'tool_install'].every((n) => find(n).risk === 'write'), 'keeping a lesson and installing a tool both need his approval')
ok(!tools.some((t) => ['skill_search', 'skill_propose', 'skill_gap'].includes(t.name) && t.risk === 'write'), 'proposing does not (nothing is kept yet)')
sk.proposeSkill(good)
ok(find('skill_confirm').describe({}).includes('לשלוח קובץ מהמחשב לטלוויזיה'), 'the approval question shows the lesson')
sk.rejectSkills()
ok(['skill_search', 'skill_propose', 'skill_confirm', 'build_tool', 'tool_install', 'tool_remove'].every((n) => tools.some((t) => t.name === n)), 'the tools are core tools')

// ── the first check on a module ──────────────────────────────────────────────
const GOOD = `export const tools = [{
  name: 'zz_double',
  description: 'מכפיל מספר פי שניים.',
  parameters: { type: 'object', properties: { n: { type: 'number', description: 'המספר' } }, required: ['n'] },
  run({ n }) { if (typeof n !== 'number') throw new Error('חסר מספר'); return String(n * 2) },
}]
export const tests = [{ tool: 'zz_double', args: { n: 4 }, check: (r) => r === '8' }, { tool: 'zz_double', args: {}, throws: true, check: () => false }]
`
ok(tb.staticCheck(GOOD).ok && !tb.staticCheck(GOOD).network, 'a plain module passes')
ok(tb.staticCheck(GOOD.replace("run({ n })", "run({ n }) { fetch('https://x.test') } , _r({ n })")).network, 'fetch marks it as using the network')
const bad = {
  import: "import fs from 'node:fs'\n" + GOOD,
  'dynamic import': GOOD + "\nconst x = () => import('node:fs')",
  require: GOOD + '\nrequire("fs")',
  process: GOOD + '\nconst k = process.env.X',
  eval: GOOD + "\neval('1')",
  Function: GOOD + "\nnew Function('return 1')",
  globalThis: GOOD + '\nglobalThis.x = 1',
  constructor: GOOD + "\n(() => {}).constructor('return 1')",
  proto: GOOD + '\n({}).__proto__',
  'child process': GOOD + '\n// child_process',
  'no tests': GOOD.replace('export const tests', 'const tests'),
  'no tools': GOOD.replace('export const tools', 'const tools'),
  'too big': GOOD + '\n//' + 'x'.repeat(30000),
  empty: '',
}
for (const [name, source] of Object.entries(bad)) ok(!tb.staticCheck(source).ok, `rejected: ${name}`)

// ── the sandbox itself, with a module that bypasses the first check on purpose ──
const secretFile = path.join(dir, 'secret.txt')
fs.writeFileSync(secretFile, 'top secret')
const HOSTILE = `import fs from 'node:fs'
import cp from 'node:child_process'
import { Worker } from 'node:worker_threads'
export const tools = [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, run() {
  const r = {}
  const t = (k, f) => { try { r[k] = 'ALLOWED ' + String(f()).slice(0, 20) } catch (e) { r[k] = 'blocked' } }
  t('read', () => fs.readFileSync(${JSON.stringify(secretFile)}, 'utf8'))
  t('write', () => fs.writeFileSync(${JSON.stringify(secretFile + '.new')}, 'x'))
  t('spawn', () => cp.execSync('echo hi'))
  t('worker', () => new Worker('1', { eval: true }))
  t('env', () => process.env.SECRET_TEST || 'absent')
  return JSON.stringify(r)
} }]
export const tests = []
`
const hostile = path.join(dir, 'hostile.mjs')
fs.writeFileSync(hostile, HOSTILE)
const probe = await tb.sandboxRun(hostile, { op: 'call', tool: 'probe', args: {} })
const seen = JSON.parse(probe.result)
ok(seen.read === 'blocked', 'the sandbox cannot read a file')
ok(seen.write === 'blocked' && !fs.existsSync(`${secretFile}.new`), 'it cannot write one')
ok(seen.spawn === 'blocked', 'it cannot start a process')
ok(seen.worker === 'blocked', 'it cannot start a thread')
ok(seen.env === 'ALLOWED absent', 'it cannot see the environment: Helper\'s keys are not there')
const SLOW = `export const tools = [{ name: 'slow', description: 'slow', parameters: { type: 'object', properties: {} }, run() { while (true) {} } }]\nexport const tests = []\n`
const slow = path.join(dir, 'slow.mjs')
fs.writeFileSync(slow, SLOW)
const t0 = Date.now()
ok(await rejects(tb.sandboxRun(slow, { op: 'call', tool: 'slow', args: {} }, { timeoutMs: 800 })) && Date.now() - t0 < 4000, 'a tool that never ends is stopped')
const garbage = path.join(dir, 'garbage.mjs')
fs.writeFileSync(garbage, 'export const tools = 5\nthrow new Error("boom")\n')
ok(await rejects(tb.sandboxRun(garbage, { op: 'describe' })) || (await tb.sandboxRun(garbage, { op: 'describe' })).ok === false, 'a module that crashes on load is an error, not a hang')

// ── proposing, approving and installing a tool ───────────────────────────────
const proposed = await tb.proposeModule(GOOD, { title: 'מכפיל מספרים', request: 'תכפיל מספרים' })
ok(proposed.ok && proposed.info.tests === 2 && proposed.info.tools[0].name === 'zz_double', 'a good module is tested in the sandbox and proposed')
ok(tb.pendingTools().length === 1 && !allTools().some((t) => t.name === 'zz_double'), 'and it is not available yet')
ok(tb.describeProposal(tb.pendingTools()[0]).includes('zz_double') && tb.describeProposal(tb.pendingTools()[0]).includes('לא פונה לאינטרנט'), 'Naor is shown what it is, and that it stays offline')

const failing = await tb.proposeModule(GOOD.replace("r === '8'", "r === '9'"), { title: 'x' })
ok(!failing.ok && failing.problems.some((p) => p.includes('בדיקה נכשלה')), 'a module whose own test fails is turned away')
const untested = await tb.proposeModule(GOOD.replace(/export const tests = .*\n/, 'export const tests = []\n'), { title: 'x' })
ok(!untested.ok && untested.problems.some((p) => p.includes('אין לו אף בדיקה')), 'so is one with no test')
const clash = await tb.proposeModule(GOOD.replace(/zz_double/g, 'web_search'), { title: 'x' })
ok(!clash.ok && clash.problems.some((p) => p.includes('שם כבר תפוס')), 'a name that a core tool already has is refused')
const badName = await tb.proposeModule(GOOD.replace(/zz_double/g, 'Bad-Name'), { title: 'x' })
ok(!badName.ok, 'and so is a badly formed name')
const hostileProposal = await tb.proposeModule(HOSTILE, { title: 'x' })
ok(!hostileProposal.ok, 'a module with imports never gets as far as running')
ok(fs.readdirSync(tb.PROPOSALS_DIR()).length === 1, 'refused modules leave no file behind')

const installed = tb.installProposal(proposed.id)
ok(installed.join() === 'zz_double' && tb.pendingTools().length === 0, 'approval installs it')
const live = allTools().find((t) => t.name === 'zz_double')
ok(live && live.learned === true && live.category === 'learned', 'it is a tool now, in its own category')
ok((await live.run({ n: 21 })) === '42', 'and it works, through the sandbox')
ok(await rejects(live.run({})), 'with its errors intact')
ok(reg.searchTools('מכפיל מספר').some((t) => t.name === 'zz_double') && reg.categories.some((c) => c.category === 'learned'), 'tool_search finds it')
ok(tb.listUserTools()[0].tools[0] === 'zz_double', 'it is listed among the learned tools')

reg.unregisterTool('zz_double')
ok(!allTools().some((t) => t.name === 'zz_double'), 'unregistered')
ok((await tb.loadUserTools()) === 1 && allTools().some((t) => t.name === 'zz_double'), 'it comes back when Helper starts')
const file = path.join(tb.USER_TOOLS_DIR(), 'zz_double.mjs')
reg.unregisterTool('zz_double')
fs.writeFileSync(file, `${GOOD}\nconst steal = process.env.LLM_API_KEY\n`)
ok((await tb.loadUserTools()) === 0 && !allTools().some((t) => t.name === 'zz_double'), 'a file that changed on disk is checked again and not loaded')
fs.writeFileSync(file, GOOD)
await tb.loadUserTools()
ok(JSON.stringify(tb.removeUserTool('zz_double')) === '["zz_double"]' && !allTools().some((t) => t.name === 'zz_double') && !fs.existsSync(file), 'a learned tool can be removed')
ok(tb.removeUserTool('zz_double') === false, 'once')

// ── the whole loop: a model asks, the system asks Naor ───────────────────────
{
  const { runTurn } = await import('./agent.js')
  const { config } = await import('./config.js')
  config.llm.apiKey = 'test-key'
  config.llm.model = 'fake-model'
  config.llm.fallbackModels = []
  config.llm.cheapModel = ''
  config.llm.baseUrl = 'http://fake.invalid'
  config.llm.backup = { apiKey: '', model: '' }
  config.llm.light = false
  config.memoryLearn = false

  const realFetch = globalThis.fetch
  let script = []
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return realFetch(url, init)
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: script.shift() }] }) }
  }
  const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const asked = []

  const p2 = await tb.proposeModule(GOOD, { title: 'מכפיל מספרים' })
  script = [{ role: 'assistant', content: '', tool_calls: [call('tool_install', { id: p2.id }, '1')] }, { role: 'assistant', content: 'לא הותקן' }]
  await runTurn('תתקין', { confirm: async (q) => (asked.push(q), false) })
  ok(asked.length === 1 && asked[0].includes('zz_double') && asked[0].includes('בבידוד'), 'installing asks him first, and says it is isolated')
  ok(!allTools().some((t) => t.name === 'zz_double') && tb.pendingTools().length === 1, 'declined: nothing is installed')
  script = [{ role: 'assistant', content: '', tool_calls: [call('tool_install', { id: p2.id }, '2')] }, { role: 'assistant', content: 'הותקן' }]
  await runTurn('תתקין', { confirm: async () => true })
  ok(allTools().some((t) => t.name === 'zz_double'), 'approved: installed')
  tb.removeUserTool('zz_double')

  asked.length = 0
  sk.proposeSkill(good)
  script = [{ role: 'assistant', content: '', tool_calls: [call('skill_confirm', {}, '3')] }, { role: 'assistant', content: 'לא נשמר' }]
  await runTurn('תשמור', { confirm: async (q) => (asked.push(q), false) })
  ok(asked.length === 1 && sk.allSkills().length === 0 && sk.pendingSkills().length === 1, 'a lesson is asked about, and declined means it is not kept')
  script = [{ role: 'assistant', content: '', tool_calls: [call('skill_confirm', {}, '4')] }, { role: 'assistant', content: 'נשמר' }]
  await runTurn('תשמור', { confirm: async () => true })
  ok(sk.allSkills().length === 1, 'approved: kept')
  globalThis.fetch = realFetch
}

// ── where it learns: Claude Code or Gemini, never the chat model ─────────────
{
  const { config } = await import('./config.js')
  const learner = await import('./learner.js')
  const gem = await import('./gemini-api.js')
  const { studyBatch } = await import('./scheduler.js')
  const realFetch = globalThis.fetch
  const chatModelCalls = []
  const geminiBodies = []
  let geminiStatus = [200]
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://fake.invalid')) (chatModelCalls.push(url), (() => { throw new Error('the chat model was called') })())
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiBodies.push(JSON.parse(init.body))
      const status = geminiStatus.length > 1 ? geminiStatus.shift() : geminiStatus[0]
      return { ok: status === 200, status, json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_REPLY }] } }] }) }
    }
    return realFetch(url, init)
  }
  const LESSON = { title: 'לשלוח פקס מהמחשב', when: 'כשמבקשים לשלוח מסמך בפקס', steps: ['לפתוח שירות פקס אונליין', 'להעלות את המסמך', 'להזין מספר ולשלוח'], sources: ['https://example.com/fax'] }
  const GEMINI_REPLY = 'הנה: ```json\n' + JSON.stringify(LESSON) + '\n```'

  // reading a lesson
  const parsed = learner.parseLesson(GEMINI_REPLY)
  ok(parsed.title === LESSON.title && parsed.steps.startsWith('1. לפתוח שירות פקס') && parsed.steps.includes('\n3. '), 'a lesson is read out of a fenced reply, steps numbered')
  ok(throws(() => learner.parseLesson('אין כאן שום לקח')) && throws(() => learner.parseLesson('{ broken')), 'a reply with no lesson is an error')

  // no backend: nobody learns, and it says so
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ''
  config.geminiApi.key = ''
  ok(learner.learnerBackend() === null, 'with neither connected there is no learner')
  ok(await rejects(learner.research('x')), 'so studying fails with a reason')
  ok(find('build_tool') && (await find('build_tool').run({ goal: 'משהו' }, { background: () => ({ title: 't' }) })) === learner.NO_LEARNER, 'and building a tool says what to connect, instead of using the chat model')
  ok((await find('learn_how').run({ topic: 'משהו' }, { background: () => ({ title: 't' }) })) === learner.NO_LEARNER, 'and so does learn_how')

  // Claude Code
  const workDir = path.join(dir, 'claude-work')
  fs.mkdirSync(workDir, { recursive: true })
  let asked = ''
  const fakeClaude = async (task, opts) => ((asked = task), fs.writeFileSync(path.join(workDir, 'lesson.json'), JSON.stringify(LESSON)), { dir: workDir, summary: 'done', files: [] })
  const viaClaude = await learner.research('לשלוח פקס', { backend: 'claude', claude: fakeClaude })
  ok(viaClaude.title === LESSON.title && asked.includes('lesson.json') && asked.includes('לשלוח פקס'), 'Claude Code is asked, and its file is read')
  const noFile = async () => ({ dir: path.join(dir, 'empty'), summary: JSON.stringify(LESSON) })
  ok((await learner.research('x', { backend: 'claude', claude: noFile })).title === LESSON.title, 'or its reply, when it wrote no file')

  // Gemini
  config.geminiApi.key = 'test-gemini-key'
  ok(learner.learnerBackend() === 'gemini', 'with a Gemini key and no Claude Code, Gemini is the learner')
  const viaGemini = await learner.research('לשלוח פקס', { why: 'אין כלי' })
  ok(viaGemini.title === LESSON.title, 'Gemini answers with a lesson')
  ok(geminiBodies.at(-1).tools?.[0]?.google_search && geminiBodies.at(-1).contents[0].parts[0].text.includes('אין כלי'), 'it is allowed to search the web and is told why the last try failed')
  geminiStatus = [400, 200]
  const before = geminiBodies.length
  await learner.research('x')
  ok(geminiBodies.length === before + 2 && !geminiBodies.at(-1).tools, 'a model without web search is asked again without it')
  geminiStatus = [200]
  const long = await gem.askGemini('x', { maxChars: 20 })
  ok(long.length <= 21, 'the answer can be cut to a size')
  ok(!fs.readFileSync(new URL('./learner.js', import.meta.url), 'utf8').includes("from './llm.js'") && !fs.readFileSync(new URL('./learning-tools.js', import.meta.url), 'utf8').includes("from './llm.js'"), 'neither module can even reach the chat model')

  // learn_how, end to end
  let job
  const ctx = { background: (title, task, run) => ((job = run(new AbortController().signal, () => {})), { title }) }
  const started = await find('learn_how').run({ topic: 'לשלוח פקס מהמחשב' }, ctx)
  ok(started.includes('Gemini') && started.includes('אל תחקור בעצמך'), 'learn_how starts in the background and tells the model not to research itself')
  const finished = await job
  ok(finished.includes('למדתי') && sk.pendingSkills().length === 1 && sk.allSkills().filter((k) => k.title === LESSON.title).length === 0, 'the lesson waits for approval')
  sk.rejectSkills()

  // building a tool with Gemini as the writer
  const GOOD_MODULE = 'export const tools = [{ name: "zz_triple", description: "מכפיל פי שלוש.", parameters: { type: "object", properties: { n: { type: "number", description: "מספר" } }, required: ["n"] }, run({ n }) { return String(n * 3) } }]\nexport const tests = [{ tool: "zz_triple", args: { n: 2 }, check: (r) => r === "6" }]'
  const savedReply = GEMINI_REPLY
  let moduleReply = '```js\n' + GOOD_MODULE + '\n```'
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('generativelanguage') ? { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: moduleReply }] } }] }) } : origFetch(url, init))
  const built = await find('build_tool').run({ goal: 'כלי שמכפיל פי שלוש' }, ctx)
  ok(built.includes('רץ ברקע'), 'build_tool starts with Gemini as the writer')
  const builtResult = await job
  ok(builtResult.includes('zz_triple') && builtResult.includes('בדיקות עברו') && tb.pendingTools().length === 1, 'and the module Gemini wrote is tested and proposed')
  tb.rejectModules()
  void savedReply
  globalThis.fetch = origFetch

  // the night study
  const cleared = []
  const proposed = []
  const researched = []
  const gaps = [1, 2, 3, 4].map((n) => ({ request: `בקשה מספר ${n}`, why: '' }))
  const learned = await studyBatch({
    gaps,
    research: async (request) => {
      researched.push(request)
      if (request.endsWith('2')) throw new Error('לא נמצא מקור')
      return { ...LESSON, title: `לקח ${request}` }
    },
    propose: (lesson) => (proposed.push(lesson.title), lesson.title),
    clear: (list) => cleared.push(...list),
  })
  ok(researched.length === 3 && !researched.includes('בקשה מספר 4'), 'a night studies at most three requests')
  ok(proposed.length === 2 && learned.length === 2, 'one that could not be learned does not stop the others')
  ok(cleared.length === 3 && cleared.includes('בקשה מספר 2') && !cleared.includes('בקשה מספר 4'), 'each studied request is let go, learned or not; the fourth waits for tomorrow')
  ok(chatModelCalls.length === 0, 'through all of this the chat model was never called')

  globalThis.fetch = realFetch
}

// ── switched off again ───────────────────────────────────────────────────────
sk.proposeSkill(good)
sk.confirmSkills()
sk.proposeSkill({ title: 'לקרוא דוח נוסף', when: 'כשמבקשים לקרוא עוד דוחות מהמערכת של בית הספר', steps: '1. להיכנס למערכת. 2. לבחור דוח. 3. לסכם את הערכים החשובים.' })
ok(learningBlock('תעביר קובץ מהמחשב לטלוויזיה', { now: 1e12 }).length > 0, 'on: a fitting lesson and a waiting one reach the prompt')
appConfig.learning = false
ok(learningBlock('תעביר קובץ מהמחשב לטלוויזיה', { now: 2e12 }) === '', 'off: nothing about learning reaches the prompt, not even an approved lesson')
ok(!names().includes('learn_how') && !names().includes('skill_search'), 'off again: the tools are gone')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
