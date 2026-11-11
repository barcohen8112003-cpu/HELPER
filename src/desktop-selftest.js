// node src/desktop-selftest.js
// Offline, any OS: no model, no Windows, no screen. A scripted "model" drives the desktop body over a fake pc.js
// (fake screenshots, fake UI Automation answers), and the test checks what reached the fake mouse and keyboard.
// The PowerShell the real PC would run is parsed with pwsh when one is on PATH (or PWSH=<path>); it is never run here.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-desktop-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
fs.writeFileSync(process.env.HELPER_ENV_FILE, 'COMPUTER_MODE=ask\n')
delete process.env.PC_BRIDGE_SECRET

const { runGoal, _test } = await import('./computer-use.js')
const { desktopBody, windowKind, sameScreen } = await import('./desktop-body.js')
const pc = await import('./pc.js')
const { config } = await import('./config.js')

let failed = 0
let passed = 0
let skipped = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const skip = (name) => {
  skipped++
  console.log(`SKIP  ${name}`)
}

// A grey grid of 64x36 cells (the shape pc.captureScript returns); `cells` sets some cells to another shade.
const grid = (base = 0x80, cells = {}) => Array.from({ length: 64 * 36 }, (_, i) => (cells[i] ?? base).toString(16).padStart(2, '0')).join('')

const WIN = {
  notepad: { hwnd: '100', title: 'notes.txt - Notepad', process: 'notepad' },
  whatsapp: { hwnd: '200', title: '(3) WhatsApp', process: 'WhatsApp' },
  terminal: { hwnd: '300', title: 'Windows PowerShell', process: 'powershell' },
  keepass: { hwnd: '400', title: 'Database - KeePass', process: 'KeePass' },
  explorer: { hwnd: '500', title: 'Downloads', process: 'explorer' },
  settings: { hwnd: '600', title: 'Settings', process: 'SystemSettings' },
  chrome: { hwnd: '700', title: 'Search - Google Chrome', process: 'chrome' },
  run: { hwnd: '800', title: 'Run', process: 'explorer' },
}

// A fake pc.js. `controls` maps "x,y" (screen pixels) to { el, at }; `focus` is the focused control and window.
// The screenshot is 2x scaled down with a 1920 offset (a second monitor), to prove coordinates map back.
function fakePc({ controls = {}, focus = { fg: WIN.notepad, el: { label: 'Text editor', role: 'Document' } }, sigs = null, inspectFails = 0 } = {}) {
  const acts = []
  const shots = []
  let n = 0
  let fails = inspectFails
  const state = { focus, controls }
  const api = {
    async screenshot(opts) {
      const file = path.join(tmp, `shot-${++n}.png`)
      fs.writeFileSync(file, Buffer.from('fakepng'))
      shots.push(opts)
      const sig = typeof sigs === 'function' ? sigs(n) : grid(0x80 + (n % 2) * 0x40)
      return { file, width: 1280, height: 720, scale: 2, left: 1920, top: 0, sig, window: state.focus.fg, target: opts?.target === 'window' ? 'window' : 'active' }
    },
    async inspectAt(x, y) {
      if (fails > 0) {
        fails--
        throw new Error('פעולה לא מוכרת: inspectAt')
      }
      const c = state.controls[`${x},${y}`]
      return c ? { at: c.at, fg: state.focus.fg, el: c.el, ...(c.uia ? { uia: c.uia } : {}) } : { at: state.focus.fg, fg: state.focus.fg, el: { label: '', role: 'Pane' } }
    },
    async focusInfo() {
      if (fails > 0) {
        fails--
        throw new Error('timeout')
      }
      return { fg: state.focus.fg, el: state.focus.el }
    },
    async focusWindow(q) {
      const w = Object.values(WIN).find((x) => x.title.toLowerCase().includes(String(q).toLowerCase()))
      if (!w) return { ok: false, reason: 'none' }
      state.focus = { fg: w, el: { label: '', role: 'Window' } }
      return { ok: true, window: w }
    },
    async act(a) {
      // What pc.js does in the same script as the keystroke: refuse if the foreground window is not the checked one.
      if (a.expectHwnd !== undefined && a.expectHwnd !== state.focus.fg.hwnd) {
        refused.push(a)
        throw Object.assign(new Error('המקלדת כבר לא בחלון שנבדק, אז לא הוקלד כלום'), { code: 'refused' })
      }
      acts.push(a)
      await state.afterAct?.(a)
      return ''
    },
  }
  const refused = []
  return { api, acts, shots, state, refused }
}

// Replies with the scripted replies in order (an action, or { actions: [...] }), then "done".
const script = (...replies) => {
  let i = 0
  const seen = []
  const fn = async (messages) => {
    seen.push(messages.at(-1))
    fn.messages = messages
    const r = replies[i++] ?? { type: 'done', summary: 'בוצע' }
    return { content: JSON.stringify(r.actions ? { thought: 't', actions: r.actions } : { thought: 't', action: r }) }
  }
  fn.calls = () => i
  fn.seen = seen
  return fn
}
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(m?.content || ''))
const allText = (body, think) => (think.messages || []).map(textOf).join('\n')
const body = (fake, extra = {}) => ({ ...desktopBody(fake.api), maxSteps: 8, ...extra })

// --- window kinds ---
ok(windowKind(WIN.terminal) === 'terminal' && windowKind(WIN.keepass) === 'secret' && windowKind(WIN.run) === 'run', 'terminals, password managers and the Run box are recognised')
ok(windowKind(WIN.settings) === 'system' && windowKind(WIN.whatsapp) === 'messaging' && windowKind(WIN.notepad) === 'app', 'settings, chat and ordinary windows are recognised')
ok(windowKind({ title: 'Inbox - me@x.com - Gmail - Google Chrome', process: 'chrome' }) === 'messaging', 'a mail tab in a browser counts as messaging')

// 1. An ungated click on a control Windows names "Send" is blocked; nothing reaches the mouse.
{
  const fake = fakePc({ controls: { '2920,800': { at: WIN.notepad, el: { label: 'Send', role: 'Button' } } } })
  const think = script({ type: 'click', x: 500, y: 400 })
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 0, '1. a click on "Send" without a gate never reaches the mouse')
  ok(allText(null, think).includes('Blocked by the safety check') && out.startsWith('DONE'), '1. the model is told why and the run goes on')
}

// 2. Enter in a chat window is a send: blocked without a gate; with an approved gate it runs once.
{
  const fake = fakePc({ focus: { fg: WIN.whatsapp, el: { label: 'Type a message', role: 'Edit' } } })
  const think = script({ type: 'key', keys: 'enter' })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 0, '2. enter in WhatsApp without a gate is blocked')
  ok(allText(null, think).includes('may send a message'), '2. the model is told to gate a send')

  const fake2 = fakePc({ focus: { fg: WIN.whatsapp, el: { label: 'Type a message', role: 'Edit' } } })
  const asked = []
  const gate = { type: 'gate', kind: 'send', site: 'WhatsApp', items: 'הודעה לאמא: אני בדרך', total: '', currency: '', when: '', uncertain: '', then: { type: 'key', keys: 'enter' } }
  const out = await runGoal({ goal: 'x', body: body(fake2), ctx: { confirm: async (t, media) => (asked.push({ t, media }), true) }, think: script(gate) })
  ok(asked.length === 1 && fake2.acts.length === 1 && fake2.acts[0].keys === 'enter', '2. an approved send gate presses enter exactly once')
  ok(asked[0].t.includes('לפי Windows') && asked[0].t.includes('WhatsApp'), '2. the approval card names the window Windows reports, not only what the model wrote')
  ok(out.startsWith('DONE'), '2. the run finishes')
}

// 3. The screen changed while the user was deciding: the approved action does not run.
{
  const fake = fakePc({ controls: { '2920,800': { at: WIN.chrome, el: { label: 'Place order', role: 'Button' } } }, focus: { fg: WIN.chrome, el: { label: '', role: 'Pane' } } })
  const gate = { type: 'gate', kind: 'order', site: 'shop', items: 'x', total: '10', currency: '₪', when: '', uncertain: '', then: { type: 'click', x: 500, y: 400 } }
  const think = script(gate)
  await runGoal({
    goal: 'x',
    body: body(fake),
    ctx: {
      confirm: async () => {
        // A pop-up took that spot while he read the card.
        fake.state.controls['2920,800'] = { at: WIN.chrome, el: { label: 'Subscribe to premium', role: 'Button' } }
        return true
      },
    },
    think,
  })
  ok(fake.acts.length === 0, '3. a changed control after the yes means the approved click is not performed')
  ok(allText(null, think).includes('screen changed while the user was deciding'), '3. the model is told nothing was committed')
}

// 4. Typing into a password field ends the run; nothing is typed.
{
  const fake = fakePc({ focus: { fg: WIN.chrome, el: { label: 'password field', role: 'Edit', password: true } } })
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think: script({ type: 'type', text: 'hunter22' }) })
  ok(out.startsWith('NEED_USER') && fake.acts.length === 0, '4. a password field is never typed into')
}

// 5. Terminals and the Run box get no typing or keys; win+r is refused.
{
  const fake = fakePc({ focus: { fg: WIN.terminal, el: { label: 'Console', role: 'Document' } } })
  const think = script({ type: 'type', text: 'Remove-Item C:\\x -Recurse' }, { type: 'key', keys: 'enter' })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 0 && allText(null, think).includes('run_command'), '5. a terminal gets neither typing nor enter, and the model is pointed to run_command')
  const fake2 = fakePc()
  await runGoal({ goal: 'x', body: body(fake2), ctx: {}, think: script({ type: 'key', keys: 'win+r' }) })
  ok(fake2.acts.length === 0, '5. win+r is refused')
  const fake3 = fakePc({ focus: { fg: WIN.run, el: { label: 'Open:', role: 'Edit' } } })
  await runGoal({ goal: 'x', body: body(fake3), ctx: {}, think: script({ type: 'type', text: 'cmd' }) })
  ok(fake3.acts.length === 0, '5. the Run box gets no typing')
  const fake4 = fakePc({ focus: { fg: WIN.terminal, el: { label: 'Console', role: 'Document' } } })
  const asked = []
  const t4 = script({ type: 'gate', kind: 'send', site: 'x', items: 'x', then: { type: 'key', keys: 'enter' } })
  await runGoal({ goal: 'x', body: body(fake4), ctx: { confirm: async (t) => (asked.push(t), true) }, think: t4 })
  ok(asked.length === 0 && fake4.acts.length === 0, '5. a gate cannot open a terminal either: the user is not even asked')
}

// 6. A password manager or credential prompt stops the run.
{
  const fake = fakePc({ controls: { '2920,800': { at: WIN.keepass, el: { label: 'Copy password', role: 'Button' } } } })
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think: script({ type: 'click', x: 500, y: 400 }) })
  ok(out.startsWith('NEED_USER') && fake.acts.length === 0, '6. a click in a password manager ends the run untouched')
}

// 7. Focus moved away from the window in the picture: typing does not run.
{
  const fake = fakePc()
  const b = body(fake)
  const think = async (messages) => {
    // After the screenshot of Notepad, a pop-up takes focus.
    fake.state.focus = { fg: { hwnd: '999', title: 'Update available', process: 'updater' }, el: { label: 'Install now', role: 'Button' } }
    think.n = (think.n || 0) + 1
    return { content: JSON.stringify({ thought: 't', action: think.n === 1 ? { type: 'type', text: 'hello' } : { type: 'done', summary: 'x' } }) }
  }
  await runGoal({ goal: 'x', body: b, ctx: {}, think })
  ok(fake.acts.length === 0, '7. typing does not go to a window that took focus after the screenshot')
}

// 7b. The reviewer's case: a batch clicks into a window, a pop-up takes focus, and the typing that follows must not
// go to the pop-up. The window the click landed in is the only one typing may reach.
{
  const popup = { hwnd: '999', title: 'Update available', process: 'updater' }
  const fake = fakePc({ controls: { '2920,800': { at: WIN.chrome, el: { label: 'Search', role: 'Edit' } } }, focus: { fg: WIN.chrome, el: { label: 'Search', role: 'Edit' } } })
  fake.state.afterAct = (a) => {
    if (a.type === 'click') fake.state.focus = { fg: popup, el: { label: 'Comment', role: 'Edit' } }
  }
  const think = script({ actions: [{ type: 'click', x: 500, y: 400 }, { type: 'type', text: 'hello' }, { type: 'key', keys: 'enter' }] })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.map((a) => a.type).join(',') === 'click', '7b. after a click, typing does not adopt a pop-up that took focus: only the click ran')
  ok(allText(null, think).includes('not in the window you saw'), '7b. the model is told the keyboard moved')
}
// 7c. The pop-up appears between the check and the keystroke: the check inside the keystroke's own script refuses.
{
  const popup = { hwnd: '999', title: 'Update available', process: 'updater' }
  const fake = fakePc({ focus: { fg: WIN.notepad, el: { label: 'Text editor', role: 'Document' } } })
  const focusInfo = fake.api.focusInfo
  fake.api.focusInfo = async () => {
    const r = await focusInfo()
    fake.state.focus = { fg: popup, el: { label: 'Comment', role: 'Edit' } }
    return r
  }
  const think = script({ type: 'type', text: 'hello' })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 0 && fake.refused.length === 1 && fake.refused[0].expectHwnd === WIN.notepad.hwnd, '7c. a keystroke carries the checked window, and focus moving after the check means nothing is typed')
  ok(allText(null, think).includes('לא הוקלד כלום'), '7c. the model hears that nothing was typed')
}
// 7d. After alt+tab (focus moved, Windows did not say where), typing in the same batch waits for a new look.
{
  const fake = fakePc()
  const think = script({ actions: [{ type: 'key', keys: 'alt+tab' }, { type: 'type', text: 'x' }] })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 1 && fake.acts[0].keys === 'alt+tab' && allText(null, think).includes('not known which window'), '7d. typing after alt+tab in a batch does not run')
  // A right-click menu, the same.
  const fake2 = fakePc({ controls: { '2920,800': { at: WIN.notepad, el: { label: 'Text editor', role: 'Document' } } } })
  const t2 = script({ type: 'right_click', x: 500, y: 400 }, { type: 'type', text: 'x' })
  // Without a new screenshot in between, the latch would be unknown; with one, it is the new foreground window.
  await runGoal({ goal: 'x', body: body(fake2), ctx: {}, think: t2 })
  ok(fake2.acts.map((a) => a.type).join(',') === 'right_click,type', '7d. after a new look, typing goes to the window in that look')
}
// 7e. focus_window: typing goes to the window Windows says came forward, and only that one.
{
  const fake = fakePc()
  const think = script({ actions: [{ type: 'focus_window', title: 'chrome' }] }, { actions: [{ type: 'type', text: 'x' }] })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 1 && fake.acts[0].expectHwnd === WIN.chrome.hwnd, '7e. after focus_window, typing is bound to the window that came forward')
}

// 8. Fail closed: when Windows cannot say what is there, nothing runs, and after three misses the run stops.
{
  const fake = fakePc({ inspectFails: 10 })
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think: script({ type: 'click', x: 1, y: 1 }, { type: 'click', x: 1, y: 1 }, { type: 'click', x: 1, y: 1 }) })
  ok(fake.acts.length === 0 && out.startsWith('NEED_USER') && out.includes('לעדכן'), '8. an unanswered check never runs the click; three misses stop the run (an outdated home PC says so)')
  const fake2 = fakePc({ controls: { '2920,800': { at: WIN.notepad, uia: 'Access is denied' } } })
  const t2 = script({ type: 'click', x: 500, y: 400 })
  await runGoal({ goal: 'x', body: body(fake2), ctx: {}, think: t2 })
  ok(fake2.acts.length === 0 && allText(null, t2).includes('could not say what control'), '8. a window whose control cannot be read gets no click')
}

// 9. Batching: click a search box, type, enter: one screenshot and one model call, three actions, all checked.
{
  const fake = fakePc({ controls: { '2920,800': { at: WIN.chrome, el: { label: 'Search', role: 'Edit' } } }, focus: { fg: WIN.chrome, el: { label: 'Search', role: 'Edit' } } })
  const think = script({ actions: [{ type: 'click', x: 500, y: 400 }, { type: 'type', text: 'מזג אוויר תל אביב' }, { type: 'key', keys: 'enter' }] })
  const started = Date.now()
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.map((a) => a.type).join(',') === 'click,type,key', '9. a batch runs click, type and enter in order')
  ok(fake.acts[0].x === 2920 && fake.acts[0].y === 800, '9. the first action maps back to the second monitor (x2 scale + 1920 offset)')
  ok(think.calls() === 2 && fake.shots.length === 3 && out.startsWith('DONE'), '9. one look and one model call did the three actions (then a look for "done" and the closing picture)')
  ok(Date.now() - started < 4000, '9. batched actions wait 150 ms between them, not 900 ms each')
}

// 10. A batch takes only one aimed action, never an ending action, and stops at the first block.
{
  const { list, note } = _test.batchOf({ action: { type: 'click', x: 1, y: 1 }, actions: [{ type: 'click', x: 1, y: 1 }, { type: 'type', text: 'a' }, { type: 'click', x: 2, y: 2 }, { type: 'key', keys: 'tab' }] }, { batch: 4 })
  ok(list.length === 2 && note.includes('did not run'), '10. a second click in a batch (stale coordinates) and what follows it are dropped')
  const g = _test.batchOf({ action: { type: 'type', text: 'a' }, actions: [{ type: 'type', text: 'a' }, { type: 'gate', kind: 'send', then: { type: 'key', keys: 'enter' } }] }, { batch: 4 })
  ok(g.list.length === 1 && g.list[0].type === 'type', '10. a gate is never inside a batch')
  const d = _test.batchOf({ action: { type: 'done' }, actions: [{ type: 'done' }, { type: 'type', text: 'x' }] }, { batch: 4 })
  ok(d.list.length === 1 && d.list[0].type === 'done', '10. an ending action comes alone')
  const many = _test.batchOf({ action: { type: 'key', keys: 'tab' }, actions: Array.from({ length: 9 }, () => ({ type: 'key', keys: 'tab' })) }, { batch: 4 })
  ok(many.list.length === 4, '10. at most 4 actions per look')
  const none = _test.batchOf({ action: { type: 'key', keys: 'tab' }, actions: [{ type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }] }, {})
  ok(none.list.length === 1, '10. a body without batching (browser, phone) runs only one action')
  // In a run: the second action is blocked (win+r), so the third never runs.
  const fake = fakePc()
  const think = script({ actions: [{ type: 'type', text: 'a' }, { type: 'key', keys: 'win+r' }, { type: 'type', text: 'b' }] })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 1 && fake.acts[0].text === 'a' && allText(null, think).includes('the rest did not run'), '10. a blocked action ends the batch and the model hears which one')
  // Enter ends a batch: what came after was planned for a screen that is gone.
  const fake2 = fakePc()
  const t2 = script({ actions: [{ type: 'type', text: 'a' }, { type: 'key', keys: 'enter' }, { type: 'type', text: 'b' }] })
  await runGoal({ goal: 'x', body: body(fake2), ctx: {}, think: t2 })
  ok(fake2.acts.length === 2 && allText(null, t2).includes('stopped after "enter"'), '10. nothing in a batch runs after enter')
}

// 11. Stuck detection on the desktop, from the grey grid.
{
  const fake = fakePc({ sigs: () => grid(0x80) })
  const think = script({ type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(textOf(think.seen[3]).includes('has not changed for 3 steps'), '11. four identical desktop screens tell the model it is stuck')
  const caret = fakePc({ sigs: (n) => grid(0x80, n % 2 ? { 100: 0x10 } : {}) })
  const t2 = script({ type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' })
  await runGoal({ goal: 'x', body: body(caret), ctx: {}, think: t2 })
  ok(textOf(t2.seen[3]).includes('has not changed'), '11. a blinking caret (one cell) does not hide that nothing changed')
  const moving = fakePc({ sigs: (n) => grid(0x80, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + n * 20, 0x10]))) })
  const t3 = script({ type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' }, { type: 'key', keys: 'tab' })
  await runGoal({ goal: 'x', body: body(moving), ctx: {}, think: t3 })
  ok(!t3.seen.some((m) => textOf(m).includes('has not changed')), '11. a screen that changes is never called stuck')
  ok(!sameScreen({ sig: grid(), window: WIN.notepad }, { sig: grid(), window: WIN.chrome }), '11. another foreground window is a change')
  ok(sameScreen({ sig: grid(), window: WIN.whatsapp }, { sig: grid(), window: { ...WIN.whatsapp, title: '(4) WhatsApp' } }), '11. an unread counter in the title is not a change')
}

// 12. Drag: both points map back to the screen, and a drop on the recycle bin needs a gate.
{
  const fake = fakePc({ controls: { '3920,1000': { at: WIN.explorer, el: { label: 'Archive', role: 'ListItem' } } } })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think: script({ type: 'drag', x: 100, y: 100, x2: 1000, y2: 500 }) })
  ok(fake.acts.length === 1 && fake.acts[0].x === 2120 && fake.acts[0].x2 === 3920 && fake.acts[0].y2 === 1000, '12. a drag runs with both ends mapped to screen pixels')
  const bin = fakePc({ controls: { '3920,1000': { at: WIN.explorer, el: { label: 'Recycle Bin', role: 'ListItem' } } } })
  await runGoal({ goal: 'x', body: body(bin), ctx: {}, think: script({ type: 'drag', x: 100, y: 100, x2: 1000, y2: 500 }) })
  ok(bin.acts.length === 0, '12. dragging onto the recycle bin is blocked without a gate')
}

// 13. Delete keys: fine in a text field, a gate elsewhere.
{
  const list = fakePc({ focus: { fg: WIN.explorer, el: { label: 'report.pdf', role: 'ListItem' } } })
  await runGoal({ goal: 'x', body: body(list), ctx: {}, think: script({ type: 'key', keys: 'shift+delete' }) })
  ok(list.acts.length === 0, '13. shift+delete on a file is blocked without a gate')
  const edit = fakePc({ focus: { fg: WIN.notepad, el: { label: 'Text editor', role: 'Edit' } } })
  await runGoal({ goal: 'x', body: body(edit), ctx: {}, think: script({ type: 'key', keys: 'delete' }) })
  ok(edit.acts.length === 1, '13. delete inside a text field just edits')
}

// 13b. Opening a program file runs it: blocked; opening a document is fine.
{
  const exe = fakePc({ controls: { '2920,800': { at: WIN.explorer, el: { label: 'setup.exe', role: 'ListItem' } } } })
  await runGoal({ goal: 'x', body: body(exe), ctx: {}, think: script({ type: 'double_click', x: 500, y: 400 }) })
  ok(exe.acts.length === 0, '13b. double-clicking setup.exe is blocked')
  const doc = fakePc({ controls: { '2920,800': { at: WIN.explorer, el: { label: 'report.pdf', role: 'ListItem' } } } })
  await runGoal({ goal: 'x', body: body(doc), ctx: {}, think: script({ type: 'double_click', x: 500, y: 400 }) })
  ok(doc.acts.length === 1, '13b. double-clicking a PDF opens it')
}

// 14. System settings: moving around is fine, a switch is a gate.
{
  const fake = fakePc({
    controls: { '2920,800': { at: WIN.settings, el: { label: 'Bluetooth', role: 'Button' } }, '2000,200': { at: WIN.settings, el: { label: 'Devices', role: 'ListItem' } } },
    focus: { fg: WIN.settings, el: { label: '', role: 'Window' } },
  })
  const think = script({ type: 'click', x: 40, y: 100 }, { type: 'click', x: 500, y: 400 })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.acts.length === 1 && fake.acts[0].x === 2000, '14. a navigation item in Settings is clicked, a switch is not')
  ok(allText(null, think).includes('changes a system setting'), '14. the model is told the switch needs an "account" gate')
}

// 15. view and focus_window.
{
  const fake = fakePc()
  const think = script({ type: 'view', target: 'window' }, { type: 'focus_window', title: 'chrome' }, { type: 'focus_window', title: 'nothing-like-this' })
  await runGoal({ goal: 'x', body: body(fake), ctx: {}, think })
  ok(fake.shots[0].target === 'active' && fake.shots[1].target === 'window', '15. "view window" makes the next screenshot the foreground window only')
  ok(allText(null, think).includes('In front now: "Search - Google Chrome"') && allText(null, think).includes('No open window matches'), '15. focus_window reports what Windows says is in front')
  ok(textOf(think.seen[0]).includes('Foreground window: "notes.txt - Notepad" (notepad)'), '15. each step names the foreground window')
}

// 16. COMPUTER_MODE=auto skips the question before use_computer starts, never a gate inside it.
{
  config.computerMode = 'auto'
  const fake = fakePc({ focus: { fg: WIN.whatsapp, el: { label: 'Type a message', role: 'Edit' } } })
  let asks = 0
  const gate = { type: 'gate', kind: 'send', site: 'WhatsApp', items: 'x', then: { type: 'key', keys: 'enter' } }
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: { confirm: async () => (++asks, false) }, think: script(gate) })
  ok(asks === 1 && fake.acts.length === 0 && out.startsWith('DENIED'), '16. in auto mode a send gate still asks, and a no means nothing was sent')
  const fake2 = fakePc({ focus: { fg: WIN.whatsapp, el: { label: 'Type a message', role: 'Edit' } } })
  await runGoal({ goal: 'x', body: body(fake2), ctx: {}, think: script({ type: 'key', keys: 'enter' }) })
  ok(fake2.acts.length === 0, '16. in auto mode an ungated send key is still blocked')
  config.computerMode = 'ask'
}

// 17. A card number is never typed, batch or not.
{
  const fake = fakePc()
  const out = await runGoal({ goal: 'x', body: body(fake), ctx: {}, think: script({ actions: [{ type: 'type', text: 'name' }, { type: 'type', text: '4580 1234 5678 9012' }] }) })
  ok(out.startsWith('NEED_USER') && fake.acts.length === 1 && fake.acts[0].text === 'name', '17. a card number inside a batch stops the run before it is typed')
}

// 18. A turn-based game (tic-tac-toe in a window) fits in the step budget: one look and one move per turn.
// This proves the loop, the checks and the coordinates hold over a game; the scripted "model" knows the moves.
{
  const board = Array(9).fill('')
  const cell = (i) => ({ x: 400 + (i % 3) * 200, y: 150 + Math.floor(i / 3) * 200 })
  const controls = {}
  for (let i = 0; i < 9; i++) {
    const c = cell(i)
    controls[`${c.x * 2 + 1920},${c.y * 2}`] = { at: { hwnd: '900', title: 'Tic Tac Toe', process: 'tictactoe' }, el: { label: `Cell ${i + 1}`, role: 'Button' } }
  }
  const fake = fakePc({ controls, focus: { fg: { hwnd: '900', title: 'Tic Tac Toe', process: 'tictactoe' }, el: { label: '', role: 'Window' } }, sigs: () => grid(0x80, Object.fromEntries(board.map((v, i) => [i * 7, v === 'X' ? 0x10 : v === 'O' ? 0xf0 : 0x80]))) })
  const realAct = fake.api.act
  // The opponent answers each move in the first free cell from the end.
  fake.api.act = async (a) => {
    await realAct(a)
    const i = Object.keys(controls).indexOf(`${a.x},${a.y}`)
    if (i >= 0 && !board[i]) {
      board[i] = 'X'
      const free = board.map((v, j) => (v ? -1 : j)).filter((j) => j >= 0)
      if (free.length) board[free.at(-1)] = 'O'
    }
    return ''
  }
  const won = () => [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]].some((l) => l.every((j) => board[j] === 'X'))
  // X takes 0, 1, 2 (the opponent plays 8, 7): a win on the third move.
  const think = async () => {
    if (won()) return { content: JSON.stringify({ thought: 'won', action: { type: 'done', summary: 'ניצחתי' } }) }
    const next = [0, 1, 2, 3, 4].find((j) => !board[j])
    return { content: JSON.stringify({ thought: 'move', action: { type: 'click', ...cell(next) } }) }
  }
  const out = await runGoal({ goal: 'win at tic-tac-toe', body: body(fake, { maxSteps: 25 }), ctx: {}, think })
  ok(out.startsWith('DONE') && won() && fake.acts.length === 3, '18. a turn-based game is played and won in 4 looks, each move checked on its cell')
}

// 19. The PowerShell side: typing never borrows the clipboard for short text, and puts it back for long text.
{
  const short = pc.typeScript('שלום עולם')
  ok(!/Set-Clipboard/.test(short) && /SendInput/.test(short), '19. short text (Hebrew too) is typed as Unicode keystrokes, the clipboard untouched')
  const long = pc.typeScript('א'.repeat(pc.UNICODE_MAX + 1))
  const iGet = long.indexOf('Get-Clipboard -Format Text')
  const iSet = long.indexOf('Set-Clipboard -Value \'')
  const iBack = long.indexOf('Set-Clipboard -Value $old')
  ok(iGet > 0 && iSet > iGet && iBack > iSet, '19. long text saves the clipboard text, pastes, then restores it')
  ok(/FileDropList/.test(long) && /\[K\]::Type/.test(long), '19. a clipboard holding files or a picture is left alone; the text is typed instead')
  const src = fs.readFileSync(new URL('./pc.js', import.meta.url), 'utf8')
  ok(!/Set-Clipboard -Value \$\{lit\(str\)\}; Start-Sleep -Milliseconds 80; \[U\]::Down\(0x11\); \[U\]::Tap\(0x56\); \[U\]::Up\(0x11\)\$\{pressEnter/.test(src), '19. pc_type no longer pastes without restoring the clipboard')
  const g = pc.typeScript('שלום', '12345')
  ok(g.indexOf("-ne '12345'") > 0 && g.indexOf("-ne '12345'") < g.indexOf('[K]::Type') && g.indexOf('IsPassword') < g.indexOf('[K]::Type'), '19. the typing script checks the foreground window and the password flag before the first keystroke')
  ok(pc.clipboardPasteScript('x', false, '7').indexOf("-ne '7'") < pc.clipboardPasteScript('x', false, '7').indexOf('Set-Clipboard'), '19. the paste path checks the window before it touches the clipboard')
  ok(/HELPER_REFUSED:window'; return/.test(pc.typeScript('a', '1; Remove-Item x')) && !/Remove-Item/.test(pc.typeScript('a', '1; Remove-Item x')), '19. a window id that is not a number refuses, and never reaches the script')
  ok(!/GetForegroundWindow/.test(pc.typeScript('a')), '19. without a checked window (pc_type) the script is unchanged')
  ok(/ElemInfo/.test(pc.inspectScript(1, 2)) && !/ValuePattern|\.Value\b/.test(pc._scripts.UIA), '19. the control check reads names only, never a field value')
  let threw = false
  try {
    pc.inspectScript('1; Remove-Item x', 2)
  } catch {
    threw = true
  }
  ok(threw, '19. a point that is not a number never reaches the script')
  // Found on a real PC (PowerShell 5.1): System.Windows.Point lives in WindowsBase, which nothing else loads, so a
  // script that names a WPF type must load its assembly itself or UIA's FromPoint fails on every call.
  const ins = pc.inspectScript(10, 20)
  ok(!/System\.Windows\.Point/.test(ins) || /Add-Type -AssemblyName[^\n]*\bWindowsBase\b/.test(ins), '19. the point probe loads WindowsBase, where System.Windows.Point lives')
}

// 20. Parse every script with PowerShell, if this machine has it.
{
  const pwsh = process.env.PWSH || (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh']).stdout?.toString().trim().split(/\r?\n/)[0] ?? '')
  if (!pwsh || !fs.existsSync(pwsh)) skip('PowerShell parse: no pwsh on this machine (set PWSH=<path> to run it)')
  else {
    const dir = fs.mkdtempSync(path.join(tmp, 'ps-'))
    const scripts = {
      capture_active: pc.captureScript('C:\\t\\a.png', 1280, 'active'),
      capture_window: pc.captureScript("C:\\t\\it's.png", 0, 'window'),
      inspect: pc.inspectScript(10, 20),
      focus: pc.focusScript(),
      focus_window: pc.focusWindowScript("it's \"q\""),
      type_short: pc.typeScript('שלום "x" \'y\'\n\tz'),
      type_guarded: pc.typeScript('שלום', '123456'),
      paste_guarded: pc.clipboardPasteScript('x', true, '42'),
      type_long: pc.typeScript('ב'.repeat(pc.UNICODE_MAX + 5)),
      paste_enter: pc.clipboardPasteScript('hi', true),
      drag: pc.dragScript(1, 2, 300, 400),
    }
    // With a BOM: Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page, so Hebrew bytes turn into quote
    // marks and the parse fails. Production never writes files (it sends -EncodedCommand), so this is the test's own encoding.
    for (const [k, v] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, `${k}.ps1`), '\uFEFF' + v)
    const check = `$bad = @()
Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Filter *.ps1 | ForEach-Object { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e); if ($e.Count) { $bad += "$($_.Name): $($e[0].Message)" } }
foreach ($src in @(${['INPUT', 'WIN', 'UNICODE'].map((k) => `'${pc._scripts[k].replace(/'/g, "''")}'`).join(', ')})) { $m = [regex]::Match($src, '(?s)Add-Type @"(.*?)"@'); try { Add-Type -TypeDefinition $m.Groups[1].Value -ErrorAction Stop } catch { $bad += "compile: $_" } }
$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'K+INPUT')
if ([IntPtr]::Size -eq 8 -and $size -ne 40) { $bad += "INPUT is $size bytes, SendInput needs 40 on 64-bit" }
$bad -join [Environment]::NewLine`
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', timeout: 120000 })
    const problems = (run.stdout || '').trim()
    if (run.status !== 0 && !problems) console.log(run.stderr)
    ok(run.status === 0 && !problems, `20. every desktop script parses and its C# compiles in PowerShell${problems ? `: ${problems}` : ''}`)
  }
}

// 21. The vault latch (PR #78, src/secret-redact.js): after a saved password is filled, no picture of this machine's
// screen reaches a model or a chat until Helper restarts, whichever desktop path asks. These checks run only where
// that file exists, so they start guarding as soon as that PR lands next to this one.
{
  let latch = null
  try {
    latch = await import('./secret-redact.js')
  } catch {}
  if (!latch?.holdForRedaction) skip('vault latch: src/secret-redact.js is not here yet (PR #78); these checks start when it lands')
  else {
    const SECRET = 'Kx9-vault-Secret-771'
    latch.holdForRedaction(SECRET)
    try {
      // The real desktop body is refused before any screenshot or model call.
      let calls = 0
      const out = await runGoal({ goal: 'x', body: _test.BODIES.desktop, ctx: {}, think: async () => (++calls, { content: '{}' }) })
      ok(out.startsWith('FAIL') && calls === 0, '21. after a fill, use_computer stops before any screenshot or model call')
      // Every capture target of pc.screenshot is behind the same guard.
      for (const target of [undefined, 'active', 'window']) {
        let code = ''
        await pc.screenshot(target ? { width: 1280, target } : 1280).catch((e) => (code = e.code))
        ok(code === 'withheld', `21. pc.screenshot(${target || 'primary'}) is refused after a fill`)
      }
      // A copy of the desktop body is refused the same way, before its (fake) screen is looked at.
      const copy = fakePc()
      let copyCalls = 0
      const outCopy = await runGoal({ goal: 'x', body: body(copy), ctx: {}, think: async () => (++copyCalls, { content: '{}' }) })
      ok(outCopy.startsWith('FAIL') && copyCalls === 0 && copy.shots.length === 0, '21. a copy of the desktop body stops too, with no screenshot and no model call')
      // A desktop-shaped body under another name (a future screen body) still sends no picture and no password.
      const fake = fakePc({ focus: { fg: { hwnd: '1', title: `login ${SECRET}`, process: 'chrome' }, el: { label: 'Send', role: 'Button' } } })
      const media = []
      const sent = []
      const gate = { type: 'gate', kind: 'send', site: 'x', items: `to ${SECRET}`, then: { type: 'key', keys: 'enter' } }
      const think = async (messages) => {
        sent.push(JSON.stringify(messages))
        return { content: JSON.stringify({ thought: 't', action: sent.length === 1 ? { type: 'key', keys: 'enter' } : sent.length === 2 ? gate : { type: 'done', summary: 'x' } }) }
      }
      await runGoal({ goal: 'x', body: body(fake, { name: 'screen-under-test' }), ctx: { confirm: async (t, m) => (media.push({ t, m }), true), sendMedia: async (m) => media.push({ final: m }) }, think })
      ok(sent.length >= 2 && sent.every((j) => !/image_url|data:image/.test(j)), '21. no model request carries a picture')
      ok(sent.every((j) => !j.includes(SECRET)), '21. a password in a window title or a probe answer never reaches the model')
      ok(media.length === 1 && !media[0].m && !media[0].t.includes(SECRET) && !media.some((x) => x.final), '21. the approval card has no picture and no password, and no closing picture is sent')
    } finally {
      latch.forgetAll()
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed ? 1 : 0)
