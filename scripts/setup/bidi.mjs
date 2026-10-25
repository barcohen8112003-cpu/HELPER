// Hebrew that reads right in a Windows console. Windows Terminal and the old console draw characters left to right
// in the order they are stored, so "שלום" shows as "םולש". A line with Hebrew is turned into the order it should be
// seen in: right to left, with English words and numbers kept left to right inside it, brackets mirrored, and the
// line's indent and status mark ("  ✓ ") kept on the left where the console starts it.
// Only for a Windows console: terminals that do right-to-left themselves (macOS, most Linux) and anything written
// to a file or a pipe get the text as it is. HELPER_RTL=on / off overrides.

const HEB = /[֐-׿יִ-ﭏ]/
const LTR = /[A-Za-z0-9À-ɏ]/
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' }

export function rtlConsole(stream = process.stdout) {
  const v = String(process.env.HELPER_RTL || '').toLowerCase()
  if (v === 'on' || v === '1') return true
  if (v === 'off' || v === '0') return false
  return process.platform === 'win32' && Boolean(stream && stream.isTTY)
}

/**
 * One line in seen order. Runs of English and numbers (with the dots, slashes and dashes inside them, as in
 * "2.3GB", "ynet.co.il", "Ctrl+Alt+Q") stay as they are; everything else is reversed, and the runs swap places.
 */
export function visual(line) {
  const s = String(line)
  if (!HEB.test(s)) return s
  const lead = s.match(/^[\s✓✗!•→»\-*]*\s*/)[0]
  const trail = s.slice(lead.length).match(/\s*$/)[0]
  const body = s.slice(lead.length, s.length - trail.length)
  const runs = []
  let i = 0
  let rtl = ''
  while (i < body.length) {
    const m = WORD.exec(body.slice(i))
    if (m && (!m[1] || !LTR.test(body[i - 1] || ''))) {
      // An English or number run, with the words after it that are English too ("Claude Code", "Ctrl+Alt+Q").
      let text = m[0]
      for (;;) {
        const more = body.slice(i + text.length).match(/^ +(?=(?:--|[.\/])?[A-Za-z0-9\u00C0-\u024F])/)
        if (!more) break
        const next = WORD.exec(body.slice(i + text.length + more[0].length))
        if (!next) break
        text += more[0] + next[0]
      }
      if (rtl) { runs.push({ ltr: false, text: rtl }); rtl = '' }
      runs.push({ ltr: true, text })
      i += text.length
    } else { rtl += body[i]; i++ }
  }
  if (rtl) runs.push({ ltr: false, text: rtl })
  const out = runs.reverse().map((r) => (r.ltr ? r.text : [...r.text].reverse().map((ch) => MIRROR[ch] || ch).join(''))).join('')
  return lead + out + trail
}
// An English word, number, file name, flag or address: it may start with ".", "/" or "--" (".env", "--yes"), carries the marks found
// inside such things (http://a.b/c?d=1, 2.3GB, Ctrl+Alt+Q, sk-or-…) and ends on a letter, a digit or a slash.
const WORD = /^(--|[.\/])?[A-Za-z0-9\u00C0-\u024F](?:[A-Za-z0-9\u00C0-\u024F.\/:_+%@'’=?&#~…\\-]*[A-Za-z0-9\u00C0-\u024F\/])?/

/** The same for a line wrapped in colour codes: the codes stay at its ends, the words inside are turned. */
export function visualColored(line) {
  const m = String(line).match(/^((?:\x1b\[[0-9;]*m)*)([\s\S]*?)((?:\x1b\[[0-9;]*m)*)$/)
  if (!m || /\x1b/.test(m[2])) return String(line)   // colours in the middle: left as it is
  return m[1] + visual(m[2]) + m[3]
}

/** Every line of a text, in seen order when the console needs it. */
export const forConsole = (text, on = rtlConsole()) => (on ? String(text).split('\n').map(visual).join('\n') : String(text))
