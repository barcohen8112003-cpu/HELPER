// The reference module: copy its shape. Small tools, short Hebrew descriptions, errors thrown as plain messages,
// and at least one offline test per tool.
import { str, num, obj, toNumber, need } from './_kit.js'

export const category = 'math'
export const blurb = 'חישובים, אחוזים והמרות'

// A tiny recursive-descent parser: numbers, + - * / % ^, parentheses, unary minus. No eval.
function calc(input) {
  const src = String(input).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '')
  let i = 0
  const peek = () => src[i]
  function number() {
    const m = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (!m) throw new Error(`ביטוי לא תקין ליד "${src.slice(i, i + 5)}"`)
    i += m[0].length
    return Number(m[0])
  }
  function atom() {
    if (peek() === '(') {
      i++
      const v = sum()
      if (peek() !== ')') throw new Error('חסר סוגר')
      i++
      return v
    }
    if (peek() === '-') {
      i++
      return -atom()
    }
    return number()
  }
  function power() {
    const base = atom()
    if (peek() === '^') {
      i++
      return base ** power()
    }
    return base
  }
  function product() {
    let v = power()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++]
      const r = power()
      if ((op === '/' || op === '%') && r === 0) throw new Error('חילוק באפס')
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }
  function sum() {
    let v = product()
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + product() : v - product()
    return v
  }
  const result = sum()
  if (i < src.length) throw new Error(`תו לא צפוי "${src[i]}"`)
  return result
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12))))

export const tools = [
  {
    name: 'calculate',
    description: 'מחשב ביטוי חשבוני: + - * / % ^ וסוגריים. למשל "(120*1.17)-45".',
    parameters: obj({ expression: str('הביטוי') }),
    run({ expression }) {
      return fmt(calc(need(expression, 'ביטוי')))
    },
  },
  {
    name: 'percent_of',
    description: 'אחוז ממספר, אחוז שינוי בין שני מספרים, או כמה אחוז מספר אחד הוא מהשני.',
    parameters: obj({ mode: { type: 'string', enum: ['of', 'change', 'ratio'], description: 'of: X% מ-Y. change: שינוי מ-X ל-Y. ratio: X הוא כמה % מ-Y' }, x: num('X'), y: num('Y') }),
    run({ mode, x, y }) {
      const a = toNumber(x, 'x')
      const b = toNumber(y, 'y')
      if (mode === 'of') return fmt((a / 100) * b)
      if (b === 0 || (mode === 'change' && a === 0)) throw new Error('חילוק באפס')
      if (mode === 'change') return `${fmt(((b - a) / Math.abs(a)) * 100)}%`
      if (mode === 'ratio') return `${fmt((a / b) * 100)}%`
      throw new Error('מצב לא מוכר')
    },
  },
  {
    name: 'split_bill',
    description: 'מחלק חשבון בין כמה אנשים, עם טיפ אופציונלי.',
    parameters: obj({ total: num('סכום החשבון'), people: num('כמה אנשים'), tip_percent: num('אחוז טיפ, ברירת מחדל 0') }, ['total', 'people']),
    run({ total, people, tip_percent = 0 }) {
      const t = toNumber(total, 'סכום')
      const p = Math.floor(toNumber(people, 'אנשים'))
      if (p < 1) throw new Error('צריך לפחות אדם אחד')
      const withTip = t * (1 + toNumber(tip_percent, 'טיפ') / 100)
      return `סה"כ ${fmt(Math.round(withTip * 100) / 100)}, לכל אחד ${fmt(Math.round((withTip / p) * 100) / 100)}`
    },
  },
]

export const tests = [
  { tool: 'calculate', args: { expression: '(120*1.17)-45' }, check: (r) => r === '95.4' },
  { tool: 'calculate', args: { expression: '2^3^2' }, check: (r) => r === '512' },
  { tool: 'calculate', args: { expression: '1/0' }, throws: true, check: () => false },
  { tool: 'calculate', args: { expression: 'process.exit()' }, throws: true, check: () => false },
  { tool: 'percent_of', args: { mode: 'of', x: 18, y: 200 }, check: (r) => r === '36' },
  { tool: 'percent_of', args: { mode: 'change', x: 50, y: 75 }, check: (r) => r === '50%' },
  { tool: 'split_bill', args: { total: 300, people: 4, tip_percent: 10 }, check: (r) => r.includes('82.5') },
]
