// Direct calls into Windows (user32, kernel32, dwmapi) through koffi: windows, focus, placement, keys, typing and the
// mouse. Each call takes microseconds; HELPER's older PC tools start a PowerShell for every action.
'use strict'
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')

const HWND = koffi.pointer('HWND', koffi.opaque())
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *buf, int max)')
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(HWND hwnd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hwnd)')
const IsIconic = user32.func('bool __stdcall IsIconic(HWND hwnd)')
const IsZoomed = user32.func('bool __stdcall IsZoomed(HWND hwnd)')
const GetWindow = user32.func('HWND __stdcall GetWindow(HWND hwnd, uint32_t cmd)')
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)')
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)')
const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(HWND hwnd)')
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(HWND hwnd)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND hwnd, int cmd)')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(HWND hwnd, HWND after, int x, int y, int cx, int cy, uint32_t flags)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)')
const PostMessageW = user32.func('bool __stdcall PostMessageW(HWND hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)')
const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
const LockWorkStation = user32.func('bool __stdcall LockWorkStation()')
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)')
const DwmGetWindowAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ void *value, uint32_t size)')

// SendInput: one INPUT is 40 bytes on x64 (a type and a union of mouse, keyboard and hardware input).
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) })
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)')

const GW_OWNER = 4, GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14
const SW_RESTORE = 9, SW_MAXIMIZE = 3, SW_MINIMIZE = 6, SW_SHOW = 5
const SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020
const WM_CLOSE = 0x0010
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001
const MOUSEEVENTF = { leftdown: 0x0002, leftup: 0x0004, rightdown: 0x0008, rightup: 0x0010, wheel: 0x0800 }

function text(hwnd) {
  const n = GetWindowTextLengthW(hwnd)
  if (n <= 0) return ''
  const buf = new Uint16Array(n + 1)
  GetWindowTextW(hwnd, buf, n + 1)
  return Buffer.from(buf.buffer).toString('utf16le').replace(/\0.*$/, '')
}

function exeOf(pid) {
  const h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid)
  if (!h) return ''
  try {
    const buf = new Uint16Array(1024)
    const size = [1024]
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return ''
    return Buffer.from(buf.buffer).toString('utf16le', 0, size[0] * 2)
  } finally {
    CloseHandle(h)
  }
}

function cloaked(hwnd) {
  const v = Buffer.alloc(4)
  return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, v, 4) === 0 && v.readUInt32LE(0) !== 0
}

/** The window's outline as the user sees it (without the invisible resize borders), in screen pixels. */
function frame(hwnd) {
  const r = {}
  const b = Buffer.alloc(16)
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, b, 16) === 0) {
    return { x: b.readInt32LE(0), y: b.readInt32LE(4), width: b.readInt32LE(8) - b.readInt32LE(0), height: b.readInt32LE(12) - b.readInt32LE(4) }
  }
  GetWindowRect(hwnd, r)
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
}

/** The windows on the taskbar, front to back: {hwnd, title, exe, app, minimized, maximized, bounds}. */
function windows() {
  const out = []
  const cb = koffi.register((hwnd) => {
    try {
      if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return true
      const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
      if (ex & WS_EX_TOOLWINDOW || ex & WS_EX_NOACTIVATE) return true
      const title = text(hwnd)
      if (!title || cloaked(hwnd)) return true
      const pid = [0]
      GetWindowThreadProcessId(hwnd, pid)
      const exe = exeOf(pid[0])
      const app = exe.split('\\').pop().replace(/\.exe$/i, '')
      if (/^(TextInputHost|ApplicationFrameHost|SystemSettings|ShellExperienceHost)$/i.test(app) && !title) return true
      out.push({ hwnd, title, exe, app, pid: pid[0], minimized: IsIconic(hwnd), maximized: IsZoomed(hwnd), bounds: frame(hwnd) })
    } catch (e) { /* a window that closed meanwhile */ }
    return true
  }, koffi.pointer(EnumWindowsProc))
  try { EnumWindows(cb, 0) } finally { koffi.unregister(cb) }
  return out
}

function foreground() {
  const h = GetForegroundWindow()
  if (!h) return null
  return windows().find((w) => koffi.address(w.hwnd) === koffi.address(h)) || { hwnd: h, title: text(h), app: '' }
}

/** Brings a window to the front. Windows only lets the app in front do that, so input is attached to its thread. */
function focus(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)
  const fg = GetForegroundWindow()
  const me = GetCurrentThreadId()
  const them = fg ? GetWindowThreadProcessId(fg, [0]) : 0
  if (them && them !== me) AttachThreadInput(me, them, true)
  // A tap of Alt lifts the foreground lock for this one call.
  keys([{ vk: 0x12 }, { vk: 0x12, up: true }])
  BringWindowToTop(hwnd)
  const ok = SetForegroundWindow(hwnd)
  ShowWindow(hwnd, SW_SHOW)
  if (them && them !== me) AttachThreadInput(me, them, false)
  return ok
}

/** Places a window at {x, y, width, height} in screen pixels (restoring it first when maximized or minimized). */
function place(hwnd, rect) {
  if (IsZoomed(hwnd) || IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)
  // The frame Windows reports includes invisible borders: grow by their width so the visible edge lands on rect.
  const outer = {}
  GetWindowRect(hwnd, outer)
  const vis = frame(hwnd)
  const dl = vis.x - outer.left, dt = vis.y - outer.top
  const dr = outer.right - (vis.x + vis.width), db = outer.bottom - (vis.y + vis.height)
  return SetWindowPos(hwnd, null, rect.x - dl, rect.y - dt, rect.width + dl + dr, rect.height + dt + db, SWP_NOZORDER | SWP_FRAMECHANGED)
}

const maximize = (hwnd) => ShowWindow(hwnd, SW_MAXIMIZE)
const minimize = (hwnd) => ShowWindow(hwnd, SW_MINIMIZE)
const restore = (hwnd) => ShowWindow(hwnd, SW_RESTORE)
const close = (hwnd) => PostMessageW(hwnd, WM_CLOSE, 0, 0)

function send(inputs) {
  if (!inputs.length) return 0
  return SendInput(inputs.length, inputs, koffi.sizeof(INPUT))
}

const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0xA3, 0xA5, 0x6F])

/** Key presses: [{vk, up}] in order. */
function keys(list) {
  return send(list.map((k) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: k.vk, wScan: 0, dwFlags: (k.up ? KEYEVENTF_KEYUP : 0) | (EXTENDED.has(k.vk) ? KEYEVENTF_EXTENDEDKEY : 0), time: 0, dwExtraInfo: 0 } } })))
}

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
  space: 0x20, backspace: 0x08, delete: 0x2E, del: 0x2E, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, insert: 0x2D,
  volumeup: 0xAF, volumedown: 0xAE, mute: 0xAD, playpause: 0xB3, next: 0xB0, prev: 0xB1, previous: 0xB1, stop: 0xB2,
}
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6F + i

/** A key combination like "ctrl+shift+t" or "alt+f4", pressed and released. */
function combo(spec) {
  const parts = String(spec).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const codes = parts.map((p) => VK[p] ?? (p.length === 1 ? p.toUpperCase().charCodeAt(0) : null))
  if (codes.some((c) => c == null)) throw new Error('unknown key: ' + spec)
  const down = codes.map((vk) => ({ vk }))
  const up = codes.slice().reverse().map((vk) => ({ vk, up: true }))
  return keys(down.concat(up))
}

/** Types text into whatever has focus, any language, as Unicode key events. */
function type(str) {
  const inputs = []
  for (const ch of String(str)) {
    if (ch === '\n') {
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: VK.enter, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } })
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: VK.enter, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } })
      continue
    }
    for (const unit of Buffer.from(ch, 'utf16le').length > 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [ch.charCodeAt(0)]) {
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } })
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } })
    }
  }
  return send(inputs)
}

function cursor() {
  const p = {}
  GetCursorPos(p)
  return { x: p.x, y: p.y }
}

/** A click at screen pixels (x, y); button "left" or "right", count 1 or 2. */
function click(x, y, button = 'left', count = 1) {
  SetCursorPos(Math.round(x), Math.round(y))
  const d = MOUSEEVENTF[button + 'down'], u = MOUSEEVENTF[button + 'up']
  const list = []
  for (let i = 0; i < count; i++) {
    list.push({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: d, time: 0, dwExtraInfo: 0 } } })
    list.push({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: u, time: 0, dwExtraInfo: 0 } } })
  }
  return send(list)
}

function scroll(amount) {
  return send([{ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: Math.round(amount * 120) >>> 0, dwFlags: MOUSEEVENTF.wheel, time: 0, dwExtraInfo: 0 } } }])
}

const handleId = (hwnd) => String(koffi.address(hwnd))

module.exports = { windows, foreground, focus, place, maximize, minimize, restore, close, keys, combo, type, click, scroll, cursor, VK, lock: () => LockWorkStation(), handleId }
