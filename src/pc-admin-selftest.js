// node src/pc-admin-selftest.js: commands as Administrator (src/pc-admin.js) without Windows. A temporary folder stands
// for %ProgramData%\HelperAdmin and a stand-in for the elevated runner answers requests; the run_command tool is
// checked for asking in every mode. If pwsh is here (PWSH=<path>), the runner and setup scripts are parsed too.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-admin-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })
delete process.env.PC_BRIDGE_SECRET

let passed = 0
let failed = 0
let skipped = 0
const ok = (cond, name) => (cond ? passed++ : (failed++, console.log(`FAIL  ${name}`)))

const admin = await import('./pc-admin.js')
const base = path.join(dir, 'HelperAdmin')
const inbox = path.join(base, 'inbox')
const win = { base, platform: 'win32', poll: 10, waitMs: 2000 }

// 1. Not set up: nothing is written and nothing starts.
{
  let started = 0
  const r = await admin.runAdminCommand('whoami', { ...win, start: async () => (started++, true) })
  ok(r === admin.SETUP_NEEDED && started === 0 && !fs.existsSync(inbox), '1. without the setup it answers how to set it up and runs nothing')
  ok((await admin.runAdminCommand('whoami', { ...win, platform: 'linux' })).includes('Windows'), '1. off Windows it refuses')
}

fs.mkdirSync(inbox, { recursive: true })
fs.writeFileSync(path.join(base, 'runner.ps1'), '# stand-in')

// A stand-in runner: takes each request (rename, as the real one does) and answers it.
const runner = (answer) => async () => {
  setTimeout(() => {
    for (const f of fs.readdirSync(inbox).filter((n) => /^[0-9a-f]{32}\.req$/.test(n))) {
      const id = f.slice(0, 32)
      fs.renameSync(path.join(inbox, f), path.join(inbox, `${id}.work`))
      const cmd = fs.readFileSync(path.join(inbox, `${id}.work`), 'utf8')
      fs.rmSync(path.join(inbox, `${id}.work`))
      fs.writeFileSync(path.join(inbox, `${id}.out`), '﻿' + JSON.stringify(answer(cmd)))
    }
  }, 30)
  return true
}

// 2. Set up: the command reaches the runner whole (Hebrew, quotes, new lines) and the output comes back.
{
  const cmd = 'Write-Output "שלום \'x\'"\nGet-Service Spooler'
  let seen = null
  const r = await admin.runAdminCommand(cmd, { ...win, start: runner((c) => ((seen = c), { out: 'done', err: '', code: 0, timeout: false })) })
  ok(seen === cmd, '2. the runner gets the exact command')
  ok(r.startsWith('(כמנהל)') && r.includes('done'), `2. the output comes back marked as admin (${r.slice(0, 40)})`)
  ok(fs.readdirSync(inbox).length === 0, '2. nothing is left in the inbox')
  const e = await admin.runAdminCommand('x', { ...win, start: runner(() => ({ out: '', err: 'Access denied', code: 1, timeout: false })) })
  ok(e.includes('STDERR: Access denied'), '2. errors come back')
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31;1mWrite-Error: _x001B_[31;1mboom &amp; גמור_x001B_[0m_x000A_</S></Objs>'
  ok(admin.formatResult({ out: '', err: clixml, code: 1 }).includes('STDERR: Write-Error: boom & גמור'), '2. PowerShell\'s CLIXML error stream comes back as plain text')
  const t = await admin.runAdminCommand('x', { ...win, start: runner(() => ({ out: '', err: '', code: null, timeout: true })) })
  ok(t.includes('60'), '2. a command stopped at the time limit says so')
}

// 3. The task does not start: the request is withdrawn, so it can never run later.
{
  const r = await admin.runAdminCommand('whoami', { ...win, start: async () => false })
  ok(r === admin.SETUP_NEEDED && fs.readdirSync(inbox).length === 0, '3. a task that will not start leaves no request behind')
  let starts = 0
  const r2 = await admin.runAdminCommand('whoami', { ...win, waitMs: 300, start: async () => (starts++, true) })
  ok(/לא הורצה/.test(r2) && fs.readdirSync(inbox).length === 0, '3. a request nobody took is withdrawn and reported as not run')
  ok((await admin.runAdminCommand('x'.repeat(admin.MAX_COMMAND + 1), { ...win, start: async () => (starts++, true) })).includes('ארוכה'), '3. an over-long command is refused before anything is written')
  ok((await admin.runAdminCommand('   ', win)).includes('אין פקודה'), '3. an empty command is refused')
}

// 4. The tool: admin asks every time, auto mode included, and does nothing on a no.
{
  const { config } = await import('./config.js')
  const { pcTools } = await import('./pc-tools.js')
  const tool = pcTools.find((t) => t.name === 'run_command')
  ok(!!tool && tool.parameters.properties.admin?.type === 'boolean' && !tool.parameters.required.includes('admin'), '4. run_command has an optional admin switch')
  for (const mode of ['ask', 'auto']) {
    config.computerMode = mode
    const asked = []
    const r = await tool.run({ command: 'Stop-Service Spooler', admin: true }, { confirm: async (q) => (asked.push(q), false) })
    ok(asked.length === 1 && asked[0].includes('כמנהל') && asked[0].includes('Stop-Service Spooler') && /לא אישר/.test(r), `4. in ${mode} mode the admin command is shown in full and asked about; a no runs nothing`)
  }
  config.computerMode = 'auto'
  const asked = []
  await tool.run({ command: 'echo hi', admin: 'true' }, { confirm: async (q) => (asked.push(q), false) }).catch(() => {})
  ok(!asked.some((q) => q.includes('כמנהל')), '4. only a real true asks for admin; anything else is the normal path')
}

// 5. The bridge carries it to the home PC.
{
  const src = fs.readFileSync(new URL('./pc-bridge.js', import.meta.url), 'utf8')
  ok(/'runAdminCommand'/.test(src) && /handlers\.runAdminCommand/.test(src), '5. the home bridge knows runAdminCommand')
}

// 6. The PowerShell scripts parse, if pwsh is here.
{
  const pwsh = process.env.PWSH || (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh']).stdout?.toString().trim().split(/\r?\n/)[0] ?? '')
  if (!pwsh || !fs.existsSync(pwsh)) {
    skipped++
    console.log('SKIP PowerShell parse: no pwsh on this machine (set PWSH=<path> to run it)')
  } else {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'windows')
    const files = ['helper-admin-runner.ps1', 'helper-admin-setup.ps1'].map((f) => path.join(root, f).replace(/'/g, "''"))
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `$bad = @(); foreach ($f in @('${files.join("','")}')) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e); if ($e.Count) { $bad += "$($f): $($e[0].Message)" } }; $bad -join '; '`], { encoding: 'utf8' })
    ok(run.status === 0 && !run.stdout.trim(), `6. the runner and setup scripts parse${run.stdout.trim() ? `: ${run.stdout.trim()}` : ''}`)
  }
  const setup = fs.readFileSync(new URL('../scripts/windows/helper-admin-setup.ps1', import.meta.url), 'utf8')
  ok(/-Remove/.test(setup) && /IsInRole/.test(setup) && /inheritance:r/.test(setup), '6. setup checks for Administrator, locks the folder and can be undone')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed ? 1 : 0)
