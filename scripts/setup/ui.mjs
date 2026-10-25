// Questions and lines for the setup wizard, in any console: numbered choices, Enter for the default, keys typed
// hidden. With --yes (or no keyboard) every question takes its default, so the wizard also runs unattended.
import readline from 'node:readline'

const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
// Tests answer the questions through a pipe: HELPER_SETUP_INTERACTIVE=1 asks them anyway.
const tty = terminal || process.env.HELPER_SETUP_INTERACTIVE === '1'
const color = (n) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s))
export const c = { bold: color(1), dim: color(2), red: color(31), green: color(32), yellow: color(33), cyan: color(36) }

let auto = !tty
let rl = null
/** --yes: no questions, every default taken. */
export const setAuto = (v) => { auto = Boolean(v) || !tty }
export const isAuto = () => auto

// Lines are queued as they come, so answers that arrive before their question (pasted, or piped) are not lost.
const queue = []
let waiter = null
let muted = false
let ended = false
function face() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal })
    // While a key is typed, the console shows dots: the key never reaches the screen or its scroll-back.
    const write = rl._writeToOutput
    rl._writeToOutput = (s) => {
      if (!muted || /^[\r\n]+$/.test(s)) return write.call(rl, s)
      const p = rl.getPrompt()
      const head = p && s.startsWith(p) ? p : ''
      write.call(rl, head + s.slice(head.length).replace(/[^\r\n]/g, '•'))
    }
    rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l) } else queue.push(l) })
    rl.on('close', () => { ended = true; if (waiter) { const w = waiter; waiter = null; w('') } })
    rl.on('SIGINT', () => { console.log('\n' + c.yellow('בוטל. אפשר להריץ שוב מתי שרוצים: helper onboard')); process.exit(130) })
  }
  return rl
}
export const close = () => { if (rl) { rl.close(); rl = null } }

function line(prompt, { hidden = false } = {}) {
  const r = face()
  muted = hidden && terminal
  // In a console the question is readline's prompt, so it is drawn again when the line is edited.
  if (terminal) { r.setPrompt(prompt); r.prompt() } else process.stdout.write(prompt)
  const done = (a) => { muted = false; if (!terminal) process.stdout.write(hidden ? '•••\n' : a + '\n'); return a }
  if (queue.length) return Promise.resolve(done(queue.shift()))
  if (ended) return Promise.resolve(done(''))
  return new Promise((resolve) => { waiter = (a) => resolve(done(a)) })
}

// ---- lines --------------------------------------------------------------------------------------

export const say = (s = '') => console.log(s)
export const ok = (s) => console.log(c.green('  ✓ ') + s)
export const warn = (s) => console.log(c.yellow('  ! ') + s)
export const bad = (s) => console.log(c.red('  ✗ ') + s)
export const info = (s) => console.log(c.dim('    ' + s))
export function step(n, total, title) {
  console.log('')
  console.log(c.cyan(c.bold(`[${n}/${total}] ${title}`)))
}
export function banner(lines) {
  const w = Math.max(...lines.map((l) => l.length)) + 4
  console.log(c.cyan('╭' + '─'.repeat(w) + '╮'))
  for (const l of lines) console.log(c.cyan('│') + '  ' + l + ' '.repeat(w - l.length - 2) + c.cyan('│'))
  console.log(c.cyan('╰' + '─'.repeat(w) + '╯'))
}

// ---- questions ----------------------------------------------------------------------------------

/** A line of text; Enter keeps the default. */
export async function ask(q, def = '') {
  if (auto) return def
  const a = (await line(`  ${q}${def ? c.dim(` [${def}]`) : ''}: `)).trim()
  return a || def
}

/** A key or password, typed hidden. Enter skips (returns the default, usually ''). */
export async function secret(q, def = '') {
  if (auto) return def
  return (await line(`  ${q}: `, { hidden: true })).trim() || def
}

/** Yes or no. */
export async function confirm(q, def = true) {
  if (auto) return def
  for (;;) {
    const a = (await line(`  ${q} ${c.dim(def ? '[כ/ל, Enter = כן]' : '[כ/ל, Enter = לא]')}: `)).trim().toLowerCase()
    if (!a) return def
    if (/^(כ|כן|y|yes|1)$/.test(a)) return true
    if (/^(ל|לא|n|no|0)$/.test(a)) return false
  }
}

/** One of a list, by its number. Returns the index. */
export async function choose(q, options, def = 0) {
  say('  ' + q)
  options.forEach((o, i) => say(`    ${c.bold(String(i + 1))}. ${o}${i === def ? c.dim('  (ברירת מחדל)') : ''}`))
  if (auto) return def
  for (;;) {
    const a = (await line(`  מספר ${c.dim(`[${def + 1}]`)}: `)).trim()
    if (!a) return def
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
  }
}

/** Several of a list: numbers flip a choice, Enter is done. items: [{label, on}]. Returns the on flags. */
export async function pick(q, items) {
  const on = items.map((x) => Boolean(x.on))
  const show = () => items.forEach((x, i) => say(`    ${on[i] ? c.green('[x]') : '[ ]'} ${c.bold(String(i + 1))}. ${x.label}`))
  say('  ' + q)
  show()
  if (auto) return on
  for (;;) {
    const a = (await line(`  ${c.dim('מספרים להחלפה (למשל 2 3), Enter לסיום')}: `)).trim()
    if (!a) return on
    for (const t of a.split(/[\s,]+/)) { const n = Number(t); if (n >= 1 && n <= items.length) on[n - 1] = !on[n - 1] }
    show()
  }
}
