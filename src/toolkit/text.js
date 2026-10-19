// Text tools: counting, case, Hebrew helpers (niqqud, gematria, keyboard layout, number words), encodings, hashes.
// Fully offline. Inputs are capped at 20000 chars and outputs are clipped.
import crypto from 'node:crypto'
import { str, num, oneOf, obj, clip, toNumber } from './_kit.js'

export const category = 'text'
export const blurb = 'עיבוד טקסט, עברית, קידודים והמרות'

const MAX = 20000

function T(value, name = 'טקסט') {
  if (value === undefined || value === null || value === '') throw new Error(`חסר ${name}`)
  const s = String(value)
  if (s.length > MAX) throw new Error(`${name} ארוך מדי (מקסימום ${MAX} תווים)`)
  return s
}

// ---------- Hebrew helpers ----------
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g
const stripNiqqud = (s) => s.replace(NIQQUD, '')

const GEMATRIA = {}
'אבגדהוזחטיכלמנסעפצקרשת'.split('').forEach((ch, i) => {
  GEMATRIA[ch] = i < 9 ? i + 1 : i < 18 ? (i - 8) * 10 : (i - 17) * 100
})
Object.assign(GEMATRIA, { ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90 })

const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,./"
const HE_KEYS = "/'קראטוןםפ][שדגכעיחלךף,זסבהנמצתץ."
const EN_TO_HE = new Map([...EN_KEYS].map((c, i) => [c, HE_KEYS[i]]))
const HE_TO_EN = new Map([...HE_KEYS].map((c, i) => [c, EN_KEYS[i]]))

const FINAL = { כ: 'ך', מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ' }
const REGULAR = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }

// ---------- number to Hebrew words ----------
const ONES_F = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר']
const ONES_M = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה']
const TEENS_F = ['', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה']
const TEENS_M = ['', 'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר', 'חמישה עשר', 'שישה עשר', 'שבעה עשר', 'שמונה עשר', 'תשעה עשר']
const TENS = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים']
const HUNDREDS = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות', 'שבע מאות', 'שמונה מאות', 'תשע מאות']
const THOUSANDS_CONSTRUCT = ['', '', '', 'שלושת אלפים', 'ארבעת אלפים', 'חמשת אלפים', 'ששת אלפים', 'שבעת אלפים', 'שמונת אלפים', 'תשעת אלפים', 'עשרת אלפים']

function groupPhrases(n, gender) {
  const ones = gender === 'm' ? ONES_M : ONES_F
  const teens = gender === 'm' ? TEENS_M : TEENS_F
  const out = []
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h) out.push(HUNDREDS[h])
  if (r) {
    if (r <= 10) out.push(ones[r])
    else if (r < 20) out.push(teens[r - 10])
    else {
      out.push(TENS[Math.floor(r / 10)])
      if (r % 10) out.push(ones[r % 10])
    }
  }
  return out
}

function withVav(phrases) {
  return phrases.length > 1 ? phrases.slice(0, -1).join(' ') + ' ו' + phrases.at(-1) : phrases.join(' ')
}

function scalePhrase(n, word, two) {
  if (n === 1) return word
  if (n === 2) return two
  return `${withVav(groupPhrases(n, 'm'))} ${word}`
}

function numberToWords(n, gender) {
  if (n === 0) return 'אפס'
  const phrases = []
  const billions = Math.floor(n / 1e9)
  const millions = Math.floor(n / 1e6) % 1000
  const thousands = Math.floor(n / 1000) % 1000
  const rest = n % 1000
  if (billions) phrases.push(scalePhrase(billions, 'מיליארד', 'שני מיליארד'))
  if (millions) phrases.push(scalePhrase(millions, 'מיליון', 'שני מיליון'))
  if (thousands) {
    if (thousands === 1) phrases.push('אלף')
    else if (thousands === 2) phrases.push('אלפיים')
    else if (thousands <= 10) phrases.push(THOUSANDS_CONSTRUCT[thousands])
    else phrases.push(`${withVav(groupPhrases(thousands, 'm'))} אלף`)
  }
  if (rest) phrases.push(...groupPhrases(rest, gender))
  return withVav(phrases)
}

// ---------- roman ----------
const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
const ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/

// ---------- morse ----------
const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..',
}
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]))

// ---------- diff ----------
function lineDiff(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(['=', a[i]])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]])
    else out.push(['+', b[j++]])
  }
  while (i < n) out.push(['-', a[i++]])
  while (j < m) out.push(['+', b[j++]])
  return out
}

// A pattern with a quantified group that itself contains a quantifier or alternation can backtrack for ages.
const DANGEROUS = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\}|\|)(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/

const words = (s) => s.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.toLowerCase())

export const tools = [
  {
    name: 'text_stats',
    description: 'סופר מילים, תווים, משפטים, שורות ופסקאות בטקסט ומעריך זמן קריאה.',
    parameters: obj({ text: str('הטקסט') }),
    run({ text }) {
      const s = T(text)
      const wordCount = s.split(/\s+/).filter(Boolean).length
      const sentences = (s.match(/[.!?…]+(?=\s|$)/g) || []).length || 1
      const minutes = wordCount / 200
      const reading = minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))} שניות` : `${Math.round(minutes * 10) / 10} דקות`
      return [
        `מילים: ${wordCount}`,
        `תווים: ${s.length}`,
        `תווים בלי רווחים: ${s.replace(/\s/g, '').length}`,
        `משפטים: ${sentences}`,
        `שורות: ${s.split(/\r?\n/).length}`,
        `פסקאות: ${s.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()).length}`,
        `זמן קריאה משוער: ${reading}`,
      ].join('\n')
    },
  },
  {
    name: 'text_change_case',
    description: 'ממיר טקסט לאותיות גדולות, קטנות, Title, camelCase, snake_case או kebab-case.',
    parameters: obj({ text: str('הטקסט'), mode: oneOf(['upper', 'lower', 'title', 'sentence', 'camel', 'snake', 'kebab'], 'סוג ההמרה') }),
    run({ text, mode }) {
      const s = T(text)
      const w = () => words(s)
      switch (mode) {
        case 'upper': return clip(s.toUpperCase())
        case 'lower': return clip(s.toLowerCase())
        case 'title': return clip(s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))
        case 'sentence': return clip(s.toLowerCase().replace(/(^|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))
        case 'camel': return clip(w().map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join(''))
        case 'snake': return clip(w().join('_'))
        case 'kebab': return clip(w().join('-'))
        default: throw new Error('סוג המרה לא מוכר')
      }
    },
  },
  {
    name: 'text_slugify',
    description: 'הופך טקסט לכתובת-סלאג: אותיות קטנות, בלי ניקוד ותווים מיוחדים, מילים מחוברות במקף.',
    parameters: obj({ text: str('הטקסט') }),
    run({ text }) {
      const slug = T(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
      if (!slug) throw new Error('לא נשארו תווים תקינים')
      return clip(slug)
    },
  },
  {
    name: 'text_strip_niqqud',
    description: 'מסיר ניקוד וטעמי מקרא מטקסט בעברית ומחזיר את האותיות בלבד.',
    parameters: obj({ text: str('הטקסט המנוקד') }),
    run({ text }) {
      return clip(stripNiqqud(T(text)))
    },
  },
  {
    name: 'text_gematria',
    description: 'מחשב גימטריה (ערך מספרי של אותיות עבריות) לכל מילה בטקסט ולסך הכול.',
    parameters: obj({ text: str('מילה או משפט בעברית') }),
    run({ text }) {
      const ws = stripNiqqud(T(text)).split(/\s+/).filter(Boolean)
      const rows = []
      let total = 0
      for (const w of ws) {
        let v = 0
        for (const ch of w) v += GEMATRIA[ch] || 0
        if (v) {
          rows.push(`${w}: ${v}`)
          total += v
        }
      }
      if (!rows.length) throw new Error('לא נמצאו אותיות עבריות')
      if (rows.length > 1) rows.push(`סה"כ: ${total}`)
      return clip(rows.join('\n'))
    },
  },
  {
    name: 'text_fix_keyboard_layout',
    description: 'מתקן טקסט שהוקלד בפריסת מקלדת שגויה (עברית כתובה באנגלית ולהפך), בזיהוי אוטומטי או לפי כיוון.',
    parameters: obj({ text: str('הטקסט השגוי'), direction: oneOf(['auto', 'to_hebrew', 'to_english'], 'כיוון, ברירת מחדל auto') }, ['text']),
    run({ text, direction = 'auto' }) {
      const s = T(text)
      let dir = direction
      if (dir === 'auto') {
        const he = (s.match(/[א-ת]/g) || []).length
        const en = (s.match(/[A-Za-z]/g) || []).length
        dir = he > en ? 'to_english' : 'to_hebrew'
      }
      if (dir === 'to_hebrew') return clip([...s].map((c) => EN_TO_HE.get(c.toLowerCase()) ?? c).join(''))
      if (dir === 'to_english') return clip([...s].map((c) => HE_TO_EN.get(c) ?? c).join(''))
      throw new Error('כיוון לא מוכר')
    },
  },
  {
    name: 'text_fix_final_letters',
    description: 'מתקן אותיות סופיות בעברית: כ מ נ פ צ בסוף מילה הופכות לך ם ן ף ץ, ולהפך באמצע מילה.',
    parameters: obj({ text: str('הטקסט בעברית') }),
    run({ text }) {
      const s = T(text)
      return clip(
        s.replace(/[א-ת]{2,}/g, (word, offset) => {
          const after = s[offset + word.length]
          const keepLast = after === "'" || after === '׳'
          return [...word]
            .map((ch, i) => {
              const last = i === word.length - 1
              if (last && !keepLast) return FINAL[ch] || ch
              return REGULAR[ch] || ch
            })
            .join('')
        }),
      )
    },
  },
  {
    name: 'text_diff',
    description: 'משווה שני טקסטים שורה אחר שורה ומציג שורות שנוספו (+) ושורות שהוסרו (-).',
    parameters: obj({ old_text: str('הטקסט הישן'), new_text: str('הטקסט החדש') }),
    run({ old_text, new_text }) {
      const a = T(old_text, 'טקסט ישן').split(/\r?\n/)
      const b = T(new_text, 'טקסט חדש').split(/\r?\n/)
      if (a.length > 800 || b.length > 800) throw new Error('יותר מדי שורות להשוואה (מקסימום 800)')
      const d = lineDiff(a, b)
      const added = d.filter((x) => x[0] === '+').length
      const removed = d.filter((x) => x[0] === '-').length
      if (!added && !removed) return 'הטקסטים זהים'
      return clip([`נוספו ${added} שורות, הוסרו ${removed}`, ...d.filter((x) => x[0] !== '=').map(([k, l]) => `${k} ${l}`)].join('\n'))
    },
  },
  {
    name: 'text_regex_replace',
    description: 'מחליף בטקסט לפי ביטוי רגולרי (pattern, replacement עם $1, flags) ומדווח כמה החלפות בוצעו.',
    parameters: obj({ text: str('הטקסט'), pattern: str('הביטוי הרגולרי'), replacement: str('טקסט ההחלפה, ברירת מחדל ריק'), flags: str('דגלים מתוך gimsu, ברירת מחדל g') }, ['text', 'pattern']),
    run({ text, pattern, replacement = '', flags = 'g' }) {
      const s = T(text)
      const p = T(pattern, 'ביטוי')
      if (p.length > 200) throw new Error('הביטוי ארוך מדי (מקסימום 200 תווים)')
      if (!/^[gimsu]*$/.test(flags)) throw new Error('דגלים מותרים: g i m s u')
      if (DANGEROUS.test(p)) throw new Error('הביטוי מסוכן (חזרות מקוננות) ועלול לתקוע את המערכת')
      let re
      try {
        re = new RegExp(p, [...new Set(flags + 'g')].join(''))
      } catch {
        throw new Error('ביטוי רגולרי לא תקין')
      }
      let count = 0
      for (const _ of s.matchAll(re)) if (++count >= 5000) break
      const rep = String(replacement)
      if (rep.length > 1000) throw new Error('טקסט ההחלפה ארוך מדי')
      const out = flags.includes('g') ? s.replace(re, rep) : s.replace(new RegExp(p, flags), rep)
      return clip(`${out}\n(${flags.includes('g') ? count : Math.min(count, 1)} החלפות)`)
    },
  },
  {
    name: 'text_extract',
    description: 'מחלץ מטקסט כל המיילים, הקישורים, המספרים או התאריכים שבו (בלי כפילויות).',
    parameters: obj({ text: str('הטקסט'), kind: oneOf(['emails', 'urls', 'numbers', 'dates'], 'מה לחלץ') }),
    run({ text, kind }) {
      const s = T(text)
      const res = {
        emails: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
        urls: /https?:\/\/[^\s<>"'()\]]+/g,
        numbers: /(?:(?<![\p{L}\p{N}])-)?\d+(?:,\d{3})*(?:\.\d+)?/gu,
        dates: /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/g,
      }
      const re = res[kind]
      if (!re) throw new Error('סוג חילוץ לא מוכר')
      let found = [...new Set(s.match(re) || [])]
      if (kind === 'urls') found = found.map((u) => u.replace(/[.,;:!?]+$/, ''))
      if (kind === 'emails') found = [...new Set(found.map((e) => e.replace(/^[-.%+_]+/, '')))]
      if (!found.length) return 'לא נמצא כלום'
      return clip(`נמצאו ${found.length}:\n${found.slice(0, 100).join('\n')}`)
    },
  },
  {
    name: 'text_lines',
    description: 'מסדר שורות בטקסט: מיון עולה/יורד, הסרת כפילויות, היפוך סדר או הסרת שורות ריקות.',
    parameters: obj({ text: str('הטקסט, שורה בכל פריט'), op: oneOf(['sort', 'sort_desc', 'dedupe', 'sort_unique', 'reverse', 'remove_empty'], 'הפעולה') }),
    run({ text, op }) {
      let l = T(text).split(/\r?\n/)
      const cmp = (x, y) => x.localeCompare(y, 'he', { numeric: true })
      const uniq = (arr) => [...new Set(arr)]
      switch (op) {
        case 'sort': l = l.sort(cmp); break
        case 'sort_desc': l = l.sort((x, y) => cmp(y, x)); break
        case 'dedupe': l = uniq(l); break
        case 'sort_unique': l = uniq(l).sort(cmp); break
        case 'reverse': l = l.reverse(); break
        case 'remove_empty': l = l.filter((x) => x.trim()); break
        default: throw new Error('פעולה לא מוכרת')
      }
      return clip(l.join('\n'))
    },
  },
  {
    name: 'text_base64',
    description: 'מקודד טקסט ל-Base64 או מפענח Base64 חזרה לטקסט (UTF-8).',
    parameters: obj({ text: str('הטקסט'), mode: oneOf(['encode', 'decode'], 'קידוד או פענוח') }),
    run({ text, mode }) {
      const s = T(text)
      if (mode === 'encode') return clip(Buffer.from(s, 'utf8').toString('base64'))
      if (mode !== 'decode') throw new Error('מצב לא מוכר')
      const clean = s.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) throw new Error('זה לא Base64 תקין')
      const out = Buffer.from(clean, 'base64').toString('utf8')
      if (out.includes('�')) throw new Error('התוכן המפוענח אינו טקסט תקין')
      return clip(out)
    },
  },
  {
    name: 'text_url_encode',
    description: 'מקודד טקסט לשימוש בכתובת URL (אחוזים) או מפענח כתובת מקודדת.',
    parameters: obj({ text: str('הטקסט'), mode: oneOf(['encode', 'decode'], 'קידוד או פענוח') }),
    run({ text, mode }) {
      const s = T(text)
      if (mode === 'encode') return clip(encodeURIComponent(s))
      if (mode !== 'decode') throw new Error('מצב לא מוכר')
      try {
        return clip(decodeURIComponent(s.replace(/\+/g, ' ')))
      } catch {
        throw new Error('קידוד URL לא תקין')
      }
    },
  },
  {
    name: 'text_hash',
    description: 'מחשב גיבוב (md5, sha1, sha256 או sha512) של טקסט ומחזיר אותו בהקסדצימל.',
    parameters: obj({ text: str('הטקסט'), algorithm: oneOf(['md5', 'sha1', 'sha256', 'sha512'], 'אלגוריתם, ברירת מחדל sha256') }, ['text']),
    run({ text, algorithm = 'sha256' }) {
      if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algorithm)) throw new Error('אלגוריתם לא נתמך')
      return crypto.createHash(algorithm).update(T(text), 'utf8').digest('hex')
    },
  },
  {
    name: 'text_uuid',
    description: 'מייצר מזהה UUID אקראי (גרסה 4), אחד או עד 10.',
    parameters: obj({ count: num('כמה מזהים, ברירת מחדל 1') }, []),
    run({ count = 1 }) {
      const n = Math.floor(toNumber(count, 'כמות'))
      if (n < 1 || n > 10) throw new Error('כמות בין 1 ל-10')
      return Array.from({ length: n }, () => crypto.randomUUID()).join('\n')
    },
  },
  {
    name: 'text_number_to_hebrew',
    description: 'כותב מספר שלם במילים בעברית (125 הופך למאה עשרים וחמש), בלשון נקבה או זכר.',
    parameters: obj({ number: num('מספר שלם עד טריליון'), gender: oneOf(['f', 'm'], 'f נקבה (ברירת מחדל), m זכר') }, ['number']),
    run({ number, gender = 'f' }) {
      const n = toNumber(number, 'מספר')
      if (!Number.isInteger(n)) throw new Error('רק מספרים שלמים')
      if (Math.abs(n) >= 1e12) throw new Error('המספר גדול מדי')
      if (gender !== 'f' && gender !== 'm') throw new Error('מין לא מוכר')
      return (n < 0 ? 'מינוס ' : '') + numberToWords(Math.abs(n), gender)
    },
  },
  {
    name: 'text_roman',
    description: 'ממיר מספר (1-3999) לספרות רומיות או ספרות רומיות למספר.',
    parameters: obj({ value: str('מספר או ספרות רומיות, למשל 1994 או MCMXCIV') }),
    run({ value }) {
      const v = String(value).trim().toUpperCase()
      if (/^\d+$/.test(v)) {
        let n = Number(v)
        if (n < 1 || n > 3999) throw new Error('מספר בין 1 ל-3999 בלבד')
        let out = ''
        for (const [val, sym] of ROMAN) while (n >= val) { out += sym; n -= val }
        return out
      }
      if (!v || !ROMAN_RE.test(v)) throw new Error('ספרות רומיות לא תקינות')
      let total = 0
      let rest = v
      for (const [val, sym] of ROMAN) while (rest.startsWith(sym)) { total += val; rest = rest.slice(sym.length) }
      return String(total)
    },
  },
  {
    name: 'text_morse',
    description: 'ממיר טקסט באנגלית ומספרים לקוד מורס, או קוד מורס (נקודות ומקפים) חזרה לטקסט.',
    parameters: obj({ text: str('טקסט באנגלית או קוד מורס; מילים מופרדות ב-/') }),
    run({ text }) {
      const s = T(text).trim()
      if (/^[.\-/\s]+$/.test(s)) {
        return clip(
          s.split(/\s*\/\s*|\s{3,}/).map((w) => w.split(/\s+/).filter(Boolean).map((c) => MORSE_REV[c] ?? '?').join('')).join(' '),
        )
      }
      return clip(
        s.toUpperCase().split(/\s+/).map((w) => [...w].map((c) => {
          if (!MORSE[c]) throw new Error(`התו "${c}" לא נתמך במורס`)
          return MORSE[c]
        }).join(' ')).join(' / '),
      )
    },
  },
]

export const tests = [
  { tool: 'text_stats', args: { text: 'שלום עולם. מה שלומך?' }, check: (r) => r.includes('מילים: 4') && r.includes('משפטים: 2') && r.includes('תווים: 20') },
  { tool: 'text_stats', args: { text: '' }, throws: true, check: () => false },
  { tool: 'text_change_case', args: { text: 'hello big world', mode: 'camel' }, check: (r) => r === 'helloBigWorld' },
  { tool: 'text_change_case', args: { text: 'Hello Big World', mode: 'snake' }, check: (r) => r === 'hello_big_world' },
  { tool: 'text_change_case', args: { text: 'hello big world', mode: 'title' }, check: (r) => r === 'Hello Big World' },
  { tool: 'text_change_case', args: { text: 'abc', mode: 'nope' }, throws: true, check: () => false },
  { tool: 'text_slugify', args: { text: 'Hello, World! Café' }, check: (r) => r === 'hello-world-cafe' },
  { tool: 'text_slugify', args: { text: '!!!' }, throws: true, check: () => false },
  { tool: 'text_strip_niqqud', args: { text: 'שָׁלוֹם' }, check: (r) => r === 'שלום' },
  { tool: 'text_gematria', args: { text: 'שלום' }, check: (r) => r === 'שלום: 376' },
  { tool: 'text_gematria', args: { text: 'יהוה אבג' }, check: (r) => r.includes('יהוה: 26') && r.includes('סה"כ: 32') },
  { tool: 'text_gematria', args: { text: 'hello' }, throws: true, check: () => false },
  { tool: 'text_fix_keyboard_layout', args: { text: 'akuo' }, check: (r) => r === 'שלום' },
  { tool: 'text_fix_keyboard_layout', args: { text: 'שלום' }, check: (r) => r === 'akuo' },
  { tool: 'text_fix_final_letters', args: { text: 'שלומ עמ' }, check: (r) => r === 'שלום עם' },
  { tool: 'text_fix_final_letters', args: { text: 'ךלמ' }, check: (r) => r === 'כלם' },
  { tool: 'text_diff', args: { old_text: 'a\nb\nc', new_text: 'a\nc\nd' }, check: (r) => r.includes('- b') && r.includes('+ d') && !r.includes('- a') },
  { tool: 'text_diff', args: { old_text: 'x', new_text: 'x' }, check: (r) => r === 'הטקסטים זהים' },
  { tool: 'text_regex_replace', args: { text: 'a1b22', pattern: '\\d+', replacement: '#' }, check: (r) => r === 'a#b#\n(2 החלפות)' },
  { tool: 'text_regex_replace', args: { text: 'aaaa', pattern: '(a+)+$' }, throws: true, check: () => false },
  { tool: 'text_regex_replace', args: { text: 'x', pattern: '(' }, throws: true, check: () => false },
  { tool: 'text_extract', args: { text: 'יש 3 תפוחים ו-1,250.5 שקלים', kind: 'numbers' }, check: (r) => r === 'נמצאו 2:\n3\n1,250.5' },
  { tool: 'text_extract', args: { text: 'כתבו ל-a.b@example.com או ל-a.b@example.com וראו https://x.org/p?q=1.', kind: 'emails' }, check: (r) => r === 'נמצאו 1:\na.b@example.com' },
  { tool: 'text_extract', args: { text: 'ראו https://x.org/p?q=1.', kind: 'urls' }, check: (r) => r === 'נמצאו 1:\nhttps://x.org/p?q=1' },
  { tool: 'text_extract', args: { text: 'ב-12/03/2024 וגם 5.6.24', kind: 'dates' }, check: (r) => r === 'נמצאו 2:\n12/03/2024\n5.6.24' },
  { tool: 'text_lines', args: { text: 'b\na\nb', op: 'dedupe' }, check: (r) => r === 'b\na' },
  { tool: 'text_lines', args: { text: 'b\na\nb', op: 'sort' }, check: (r) => r === 'a\nb\nb' },
  { tool: 'text_lines', args: { text: 'a\n\nb', op: 'remove_empty' }, check: (r) => r === 'a\nb' },
  { tool: 'text_base64', args: { text: 'hello', mode: 'encode' }, check: (r) => r === 'aGVsbG8=' },
  { tool: 'text_base64', args: { text: 'aGVsbG8=', mode: 'decode' }, check: (r) => r === 'hello' },
  { tool: 'text_base64', args: { text: 'שלום', mode: 'encode' }, check: (r) => Buffer.from(r, 'base64').toString('utf8') === 'שלום' },
  { tool: 'text_base64', args: { text: '###', mode: 'decode' }, throws: true, check: () => false },
  { tool: 'text_url_encode', args: { text: 'a b&ש', mode: 'encode' }, check: (r) => r === 'a%20b%26%D7%A9' },
  { tool: 'text_url_encode', args: { text: 'a%20b%26%D7%A9', mode: 'decode' }, check: (r) => r === 'a b&ש' },
  { tool: 'text_url_encode', args: { text: '%E0%A4%A', mode: 'decode' }, throws: true, check: () => false },
  { tool: 'text_hash', args: { text: 'abc' }, check: (r) => r === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  { tool: 'text_hash', args: { text: 'abc', algorithm: 'md5' }, check: (r) => r === '900150983cd24fb0d6963f7d28e17f72' },
  { tool: 'text_hash', args: { text: 'abc', algorithm: 'sha1' }, check: (r) => r === 'a9993e364706816aba3e25717850c26c9cd0d89d' },
  { tool: 'text_uuid', args: { count: 2 }, check: (r) => r.split('\n').length === 2 && r.split('\n').every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)) },
  { tool: 'text_uuid', args: { count: 11 }, throws: true, check: () => false },
  { tool: 'text_number_to_hebrew', args: { number: 125 }, check: (r) => r === 'מאה עשרים וחמש' },
  { tool: 'text_number_to_hebrew', args: { number: 21 }, check: (r) => r === 'עשרים ואחת' },
  { tool: 'text_number_to_hebrew', args: { number: 15 }, check: (r) => r === 'חמש עשרה' },
  { tool: 'text_number_to_hebrew', args: { number: 2000 }, check: (r) => r === 'אלפיים' },
  { tool: 'text_number_to_hebrew', args: { number: 1250 }, check: (r) => r === 'אלף מאתיים וחמישים' },
  { tool: 'text_number_to_hebrew', args: { number: 3000000 }, check: (r) => r === 'שלושה מיליון' },
  { tool: 'text_number_to_hebrew', args: { number: 22, gender: 'm' }, check: (r) => r === 'עשרים ושניים' },
  { tool: 'text_number_to_hebrew', args: { number: 0 }, check: (r) => r === 'אפס' },
  { tool: 'text_number_to_hebrew', args: { number: 1.5 }, throws: true, check: () => false },
  { tool: 'text_roman', args: { value: '1994' }, check: (r) => r === 'MCMXCIV' },
  { tool: 'text_roman', args: { value: 'MCMXCIV' }, check: (r) => r === '1994' },
  { tool: 'text_roman', args: { value: '4000' }, throws: true, check: () => false },
  { tool: 'text_roman', args: { value: 'IIII' }, throws: true, check: () => false },
  { tool: 'text_morse', args: { text: 'SOS' }, check: (r) => r === '... --- ...' },
  { tool: 'text_morse', args: { text: '... --- ... / .-' }, check: (r) => r === 'SOS A' },
  { tool: 'text_morse', args: { text: 'שלום' }, throws: true, check: () => false },
]
