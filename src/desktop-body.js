// The user's own Windows desktop as a body for the goal agent (use_computer, src/computer-use.js).
//
// The model still decides every step from the picture. This file adds what the picture cannot be trusted for:
// - Before a click, key or drag, Windows itself is asked what is there (UI Automation: the control's name and kind,
//   the window and its program). A control that pays, sends, deletes, installs or signs out is blocked unless the
//   model raised a gate for it, a send key in a chat or mail window is treated the same way, and a password field
//   is never typed into. Terminals, the Run box, credential prompts and password managers are off limits.
//   When Windows cannot answer, the action is not run (fail closed), and after a few such misses the run stops.
// - Typing and keys go to the window the model saw. If focus moved (a pop-up, another program), the action is not run.
// - Before an approved commit runs, the same control in the same window must still be there (fingerprint).
// - A coarse grey grid of each screenshot lets the loop notice that nothing changed for three steps.
// - The picture is of the monitor that holds the foreground window, or only that window ("view").
//
// Nothing here reads a field's value: only names of controls and windows, which UI Automation gives to any program.
import fs from 'node:fs'
import * as pcApi from './pc.js'

const IMAGE_WIDTH = 1280

// Programs whose window must not get typing or keys from the agent: a command typed there runs with no approval.
// run_command exists for that and asks first.
const TERMINAL = /^(cmd|powershell|powershell_ise|pwsh|windowsterminal|wt|openconsole|conhost|wsl|wslhost|bash|mintty|ubuntu.*|debian|kali)$/i
// Windows where a secret is asked for or kept. The agent does nothing there; the user does it himself.
const SECRET_PROGRAM = /^(credentialuibroker|consent|logonui|lockapp|1password|keepass|keepassxc|bitwarden|lastpass|dashlane|keeper.*|enpass|nordpass|protonpass|roboform|sechealthui)$/i
// Windows that change the system. Moving around in them is fine; pressing a button, a switch or a box is a setting
// change and needs a gate of kind "account".
const SYSTEM_PROGRAM = /^(systemsettings|mmc|regedit|taskmgr|msconfig|control|rundll32|sysdm|netplwiz|useraccountcontrolsettings|windowsdefender|msiexec|setup|installer)$/i
const SYSTEM_TITLE = /^(settings|הגדרות|control panel|לוח הבקרה|windows security|אבטחת windows|system properties|מאפייני מערכת|task manager|מנהל המשימות)\b/i
const SETTING_ROLES = /^(button|checkbox|radiobutton|combobox|slider|splitbutton|menuitem)$/i
// Chat and mail, as programs or as a browser tab title. Enter (and the other usual send keys) sends there.
const MESSAGING_PROGRAM = /^(whatsapp.*|telegram|discord|outlook|olk|hxoutlook|ms-teams|teams|slack|signal|messenger|thunderbird|skype|zoom|viber|line)$/i
const MESSAGING_TITLE = /whatsapp|telegram|discord|messenger|gmail|outlook|\bteams\b|slack|signal|instagram|facebook|linkedin|viber/i
const SEND_KEYS = /^(enter|return|ctrl\+enter|ctrl\+return|alt\+s|ctrl\+shift\+enter)$/i
// Keys that open a command box or a system menu; run_command and the settings tools cover what they lead to.
const BLOCKED_KEYS = /^(win\+r|windows\+r|win\+x|windows\+x)$/i
// A Run box: "Run" in English or Hebrew, owned by Explorer.
const RUN_TITLE = /^(run|הפעלה)$/i
// Deleting from a list, a folder or a desktop. In a text field these keys only edit text.
const DELETE_KEYS = /^(delete|del|shift\+delete|shift\+del)$/i
const TEXT_ROLES = /^(edit|document|combobox|text)$/i
// File names that run something when opened.
const RUNNABLE = /\.(exe|msi|msix|appx|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|com|cpl|reg|jar)$/i

// Controls on a desktop that commit, on top of the shared list in computer-use.js (pay, order, send, delete...).
export const DESKTOP_COMMIT = /\b(uninstall|format|reset this pc|sign out|log ?off|shut ?down|restart|empty (the )?recycle bin|empty trash|permanently delete|end task|install|publish|post|share|transfer|withdraw)\b|recycle bin|הסר(?:ת)? התקנה|פרמוט|איפוס|התנתק|יציאה מהחשבון|כיבוי|הפעלה מחדש|סל המחזור|מחק לצמיתות|סיום משימה|התקנ|פרסם|פרסום|שתף|שיתוף|העבר(?:ת)? כסף|משיכה/i

// How many times Windows may fail to answer about a control before the run stops.
const MAX_UNVERIFIED = 3

const norm = (title) => String(title || '').replace(/^\(\d+\)\s*/, '').trim()
const proc = (w) => String(w?.process || '')
const describe = (w) => `"${String(w?.title || '').slice(0, 60)}"${proc(w) ? ` (${proc(w)})` : ''}`

// What kind of window this is, by its program and title.
export function windowKind(w) {
  if (!w) return 'unknown'
  const p = proc(w)
  const t = norm(w.title)
  if (SECRET_PROGRAM.test(p)) return 'secret'
  if (TERMINAL.test(p)) return 'terminal'
  if (/^explorer$/i.test(p) && RUN_TITLE.test(t)) return 'run'
  if (SYSTEM_PROGRAM.test(p) || SYSTEM_TITLE.test(t) || (/^applicationframehost$/i.test(p) && /^(settings|הגדרות)$/i.test(t))) return 'system'
  if (MESSAGING_PROGRAM.test(p) || MESSAGING_TITLE.test(t)) return 'messaging'
  return 'app'
}

// Two screenshots look the same: the same foreground window and at most two cells of the 64x36 grey grid moved by
// more than a little (a blinking caret or a ticking clock is one or two cells).
export function sameScreen(a, b) {
  if (!a?.sig || !b?.sig || a.sig.length !== b.sig.length) return false
  if ((a.window?.hwnd || '') !== (b.window?.hwnd || '') || norm(a.window?.title) !== norm(b.window?.title)) return false
  let moved = 0
  for (let i = 0; i < a.sig.length; i += 2) {
    if (Math.abs(parseInt(a.sig.slice(i, i + 2), 16) - parseInt(b.sig.slice(i, i + 2), 16)) > 10 && ++moved > 2) return false
  }
  return true
}

// Keys that move the keyboard to another window without saying which.
const FOCUS_KEYS = /alt\+tab|alt\+esc|^win$|^windows$|win\+|windows\+|ctrl\+esc/

// `api` is pc.js; the self-test passes a fake one.
export function desktopBody(api = pcApi) {
  let view = 'active'
  let lastShot = null
  // The window that typing and keys may reach. It is always a window Windows named: the foreground window of the
  // last screenshot, the window a checked click landed in, or the window focus_window brought forward. It is never
  // taken from whatever has focus when typing starts, so a pop-up that appears mid-batch cannot become the target.
  // After anything that moves focus without saying where (alt+tab, a right-click menu, a drag), it is unknown, and
  // typing waits for a new look.
  let expected = null
  // The window under the last checked click, which becomes `expected` once that click runs.
  let clicked = null
  let unverified = 0

  const unverifiedVerdict = (why) => {
    if (++unverified >= MAX_UNVERIFIED) {
      return { needUser: `לא הצלחתי לבדוק מה יש על המסך לפני הלחיצה (${why}), ולכן עצרתי בלי להמשיך. אם העוזר במחשב הביתי ישן, צריך לעדכן אותו.` }
    }
    return { block: `Not performed: Windows could not say what control is there (${why}), so the action was not run. Look again and try once more, or reply "need_user".` }
  }

  // The answer for one action: { label, secret } for the shared checks in computer-use.js, or { block } to skip
  // the action with a message to the model, or { needUser } to stop the run.
  async function probe(a) {
    const pointer = Number.isFinite(a.x) && Number.isFinite(a.y)
    let info
    try {
      info = a.type === 'drag' ? await api.inspectAt(a.x2, a.y2) : pointer ? await api.inspectAt(a.x, a.y) : await api.focusInfo()
    } catch (e) {
      return unverifiedVerdict(String(e?.message || e).slice(0, 80))
    }
    if (!info || typeof info !== 'object' || (!info.at && !info.fg)) return unverifiedVerdict('no answer')
    const el = info.el || null
    // A pointer lands in the window under it; keys and typing go to the foreground window.
    const win = pointer || a.type === 'drag' ? info.at || info.fg : info.fg
    const kind = windowKind(win)
    const keys = String(a.keys || '').toLowerCase().replace(/\s+/g, '')
    const role = String(el?.role || '')
    if (a.type === 'click' || a.type === 'double_click') clicked = win?.hwnd || null

    if (kind === 'secret') return { needUser: `החלון ${describe(win)} מבקש או שומר סיסמה. את זה תעשה בעצמך, ואז תגיד לי להמשיך.` }
    if (a.type === 'type' || a.type === 'key') {
      if (!expected || !win?.hwnd) {
        return { block: 'Not performed: after that step it is not known which window has the keyboard. Look at the new screen first.' }
      }
      if (expected !== win.hwnd) {
        return { block: `Not performed: the keyboard is now in ${describe(win)}, not in the window you saw. Look at the new screen first.` }
      }
      if (kind === 'terminal' || kind === 'run') return { block: `Blocked: ${describe(win)} runs commands. Do not type or press keys there. If a command is needed, reply "fail" and say which, so it goes through run_command, which asks the user.` }
      if (a.type === 'key' && BLOCKED_KEYS.test(keys)) return { block: `Blocked: "${a.keys}" opens a command box or a system menu. Take another way.` }
      if (a.type === 'key' && kind === 'messaging' && SEND_KEYS.test(keys)) {
        return { block: `Blocked by the safety check: in ${describe(win)} "${a.keys}" may send a message as the user. If it sends, reply with a "gate" of kind "send" with the recipient and the text as shown, and this key as "then".` }
      }
      if (a.type === 'key' && DELETE_KEYS.test(keys) && !TEXT_ROLES.test(role)) {
        return { block: `Blocked by the safety check: "${a.keys}" outside a text field deletes what is selected. Reply with a "gate" of kind "delete" saying exactly what, and this key as "then".` }
      }
    }
    // Windows named the window but could not read the control (some elevated windows): not run, since nothing says
    // it is not a send button or a password field.
    if (info.uia && !el) return unverifiedVerdict(String(info.uia).slice(0, 80))
    // Opening a program or script file runs it, with no approval: pc_launch_app and run_command are the ways that ask.
    if ((a.type === 'double_click' || (a.type === 'key' && /^(enter|return|ctrl\+shift\+enter)$/.test(keys))) && RUNNABLE.test(String(el?.label || '').trim())) {
      return { block: `Blocked: "${String(el.label).slice(0, 80)}" is a program or script, and opening it runs it. Do not open it; reply "fail" and say what it is, so the user can decide.` }
    }
    if (kind === 'system' && a.type !== 'type' && SETTING_ROLES.test(role) && (a.type !== 'key' || /^(enter|space)$/.test(keys))) {
      return { block: `Blocked: "${String(el?.label || role).slice(0, 80)}" in ${describe(win)} changes a system setting. Reply with a "gate" of kind "account" and this action as "then".` }
    }
    unverified = 0
    return { label: String(el?.label || ''), role, secret: Boolean(el?.password), window: win }
  }

  // What the approved action will land on: the window and the control. Taken when the gate is asked and again just
  // before the approved action runs; if they differ, the screen changed while the user was deciding. `where` is
  // what Windows says (not what the model says), for the approval card. Throws for a window no gate may open.
  async function fingerprint(a) {
    const pointer = Number.isFinite(a.x) && Number.isFinite(a.y)
    const info = pointer ? await api.inspectAt(a.x, a.y) : await api.focusInfo()
    const win = pointer ? info?.at || info?.fg : info?.fg
    if (!win?.hwnd) throw new Error('Windows did not say which window that is')
    const kind = windowKind(win)
    if (kind === 'secret' || kind === 'terminal' || kind === 'run') throw new Error(`${describe(win)} is a window no gate may act in`)
    const label = String(info?.el?.label || '')
    return {
      id: JSON.stringify([win.hwnd, proc(win).toLowerCase(), norm(win.title), String(info?.el?.role || ''), label]),
      where: `${describe(win)}${label ? `, "${label.slice(0, 60)}"` : ''}`,
    }
  }

  return {
    name: 'desktop',
    intro: `You operate the user's Windows PC with mouse and keyboard to reach a goal he gave you. Each turn you get a
screenshot of the monitor that holds the foreground window (or of that window only, after "view") and choose the
next action, or a short batch of actions.`,
    extra: `- {"type": "drag", "x": <int>, "y": <int>, "x2": <int>, "y2": <int>}   press at (x, y), move to (x2, y2), release
- {"type": "focus_window", "title": "<part of a window title or a program name>"}   bring that window to the front
- {"type": "view", "target": "window|screen"}   next screenshots: only the foreground window (sharper), or its whole monitor`,
    tips: `Prefer keyboard shortcuts when they are surer than clicking ("ctrl+l", "alt+tab", "win"). After typing into a search or address box, press enter.
You may send "actions": [ ... ] (up to 4) instead of "action" when the next steps need no new look, for example
click a search box, type, press enter. Only the first may use coordinates; the rest are "type", "key" or "wait".
A batch stops at the first action that is blocked or fails, and after "enter". "gate", "done", "need_user" and "fail"
always come alone. Each action is checked on the real screen before it runs.`,
    maxSteps: 25,
    finalShot: true,
    batch: 4,
    async screenshot() {
      const shot = await api.screenshot({ width: IMAGE_WIDTH, target: view === 'window' ? 'window' : 'active' })
      const buffer = fs.readFileSync(shot.file)
      fs.rmSync(shot.file, { force: true })
      lastShot = shot
      expected = shot.window?.hwnd || null
      const where = shot.window ? `\nForeground window: ${describe(shot.window)}${shot.target === 'window' ? ' (the picture is this window only)' : ''}.` : ''
      return { ...shot, buffer, mime: 'image/png', image: `data:image/png;base64,${buffer.toString('base64')}`, note: where }
    },
    async act(a) {
      if (a.type === 'view') {
        view = a.target === 'window' ? 'window' : 'active'
        return `Next screenshot: ${view === 'window' ? 'the foreground window only' : 'the whole monitor'}.`
      }
      if (a.type === 'focus_window') {
        expected = null
        const r = await api.focusWindow(String(a.title || ''))
        if (r?.ok && r.window?.hwnd) expected = r.window.hwnd
        if (!r?.ok) return r?.reason === 'none' ? `No open window matches "${String(a.title || '').slice(0, 60)}".` : `Could not bring it to the front; the foreground window is ${describe(r?.window)}.`
        return `In front now: ${describe(r.window)}.`
      }
      // Typing and keys carry the window they were checked against; pc.js checks it again in the same script, right
      // before the first keystroke, and refuses if the foreground window or a password field changed in between.
      if (a.type === 'type' || a.type === 'key') {
        const r = await api.act({ ...a, expectHwnd: expected })
        if (a.type === 'key' && FOCUS_KEYS.test(String(a.keys || '').toLowerCase())) expected = null
        return r
      }
      if (a.type === 'click' || a.type === 'double_click') {
        const into = clicked
        clicked = null
        const r = await api.act(a)
        expected = into
        return r
      }
      if (a.type === 'right_click' || a.type === 'drag') expected = null
      return api.act(a)
    },
    probe,
    fingerprint,
    sameScreen,
    commit: DESKTOP_COMMIT,
    get lastShot() {
      return lastShot
    },
  }
}
