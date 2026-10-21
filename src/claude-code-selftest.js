// node src/claude-code-selftest.js: offline checks of the Claude Code hand-off, with a fake `claude` that behaves
// like the real one (stream-json on stdout, files written in its folder).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-cc-'))
const fake = path.join(tmp, 'fake-claude.mjs')
fs.writeFileSync(
  fake,
  `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.writeFileSync('args.json', JSON.stringify({ args, env: Object.keys(process.env) }))
const prompt = args[args.indexOf('-p') + 1]
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (prompt.includes('FAIL-AUTH')) { say({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }); process.exit(1) }
if (prompt.includes('HANG')) setTimeout(() => {}, 60000)
else {
  say({ type: 'system', subtype: 'init' })
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: process.cwd() + '/index.html' } }] } })
  fs.writeFileSync('index.html', '<!doctype html><html dir="rtl"><title>פרחים</title></html>')
  fs.mkdirSync('css', { recursive: true })
  fs.writeFileSync('css/style.css', 'body{margin:0}')
  say({ type: 'result', is_error: false, result: 'בניתי אתר לחנות פרחים: index.html ו-css/style.css.', total_cost_usd: 0 })
}
`
)
fs.chmodSync(fake, 0o755)
Object.assign(process.env, {
  HELPER_DATA_DIR: path.join(tmp, 'data'),
  HELPER_OFFLINE: '1',
  CLAUDE_CODE_BIN: fake,
  CLAUDE_CODE_WORKDIR: path.join(tmp, 'work'),
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
  LLM_API_KEY: 'must-not-leak',
})
fs.mkdirSync(process.env.HELPER_DATA_DIR, { recursive: true })
const cc = await import('./claude-code.js')

let passed = 0
const t = async (name, fn) => {
  try {
    await fn()
    passed++
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

await t('enabled with a token and a binary', () => assert.ok(cc.claudeCodeEnabled()))
await t('off without a token', () => {
  const was = process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  assert.ok(!cc.claudeCodeEnabled())
  process.env.CLAUDE_CODE_OAUTH_TOKEN = was
})
await t('slug cannot leave the work folder', () => {
  assert.equal(cc.projectSlug('../../etc/passwd'), 'etc-passwd')
  assert.equal(cc.projectSlug('אתר לחנות פרחים!'), 'אתר-לחנות-פרחים')
  assert.equal(cc.projectSlug(''), 'project')
})
await t('no shell, and Helper data and code are denied', () => {
  const args = cc.claudeArgs('x')
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',')
  const denied = args[args.indexOf('--disallowedTools') + 1]
  assert.ok(!allowed.includes('Bash'))
  assert.ok(denied.split(',').includes('Bash'))
  assert.ok(denied.includes(`Read(/${process.env.HELPER_DATA_DIR}/**)`))
  assert.ok(denied.includes(`Edit(/${path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')}/**)`))
})

const steps = []
let done
await t('a job runs and returns its summary and files', async () => {
  done = await cc.runClaudeCode('אתר לחנות פרחים', { project: 'פרחים', setStep: (s) => steps.push(s) })
  assert.match(done.summary, /בניתי אתר/)
  assert.ok(done.files.includes('index.html') && done.files.includes(path.join('css', 'style.css')))
  assert.ok(!done.files.some((f) => f.startsWith('.home')))
})
await t('progress is shown in Hebrew', () => assert.deepEqual(steps, ['כותב index.html']))
await t('Helper keys stay out of its environment', () => {
  const { env } = JSON.parse(fs.readFileSync(path.join(done.dir, 'args.json'), 'utf8'))
  assert.ok(!env.includes('LLM_API_KEY') && env.includes('CLAUDE_CODE_OAUTH_TOKEN'))
})
await t('the zip opens and holds the files', () => {
  const zip = path.join(tmp, 'out.zip')
  fs.writeFileSync(zip, cc.zipFiles(done.dir, done.files.filter((f) => f !== 'args.json')))
  const listed = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("\\n".join(sorted(z.namelist())));print(z.read("index.html").decode())', zip]).toString()
  assert.match(listed, /^css\/style\.css\nindex\.html\n<!doctype html>/)
})
await t('a sign-in problem says what to do', async () => {
  await assert.rejects(cc.runClaudeCode('FAIL-AUTH'), /setup-token/)
})
await t('stop ends the job', async () => {
  const ac = new AbortController()
  const p = cc.runClaudeCode('HANG', { project: 'hang', signal: ac.signal })
  setTimeout(() => ac.abort(new Error('stopped')), 200)
  await assert.rejects(p, /stopped/)
})

console.log(process.exitCode ? `\nנכשלו בדיקות, ${passed} עברו` : `\nכל ${passed} הבדיקות של Claude Code עברו`)
