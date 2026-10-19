// Study and exam tools: statistics, algebra, small matrices, bagrut grades, exams countdown, flashcards, pomodoro.
import { str, num, bool, oneOf, obj, clip, lines, need, toNumber, bucket, persist, nextId } from './_kit.js'

export const category = 'study'
export const blurb = 'לימודים ומבחנים: סטטיסטיקה, אלגברה, ציונים, כרטיסיות ופומודורו'

// ---------- helpers ----------
const fmt = (n, p = 10) => {
  if (!Number.isFinite(n)) return String(n)
  const v = Number(n.toPrecision(p))
  return String(Object.is(v, -0) ? 0 : v)
}
const out = (text) => clip(text, 1500)

function parseList(value, name, max = 500) {
  const arr = Array.isArray(value) ? value : String(need(value, name)).split(/[,;\s]+/).filter(Boolean)
  if (!arr.length) throw new Error(`${name} ריק`)
  if (arr.length > max) throw new Error(`${name}: יותר מדי ערכים (מקסימום ${max})`)
  return arr.map((x) => toNumber(x, name))
}

function parseMatrix(value, name, maxDim = 6) {
  const rows = Array.isArray(value)
    ? value.map((r) => (Array.isArray(r) ? r : String(r).split(/[,\s]+/).filter(Boolean)))
    : String(need(value, name)).split(/[;|\n]+/).map((r) => r.split(/[,\s]+/).filter(Boolean)).filter((r) => r.length)
  if (!rows.length) throw new Error(`${name} ריקה`)
  if (rows.length > maxDim || rows.some((r) => r.length > maxDim)) throw new Error(`${name}: המטריצה גדולה מדי (עד ${maxDim}x${maxDim})`)
  if (rows.some((r) => r.length !== rows[0].length)) throw new Error(`${name}: השורות באורכים שונים`)
  return rows.map((r) => r.map((x) => toNumber(x, name)))
}

const showMatrix = (m) => m.map((r) => '[' + r.map((x) => fmt(x, 8)).join(', ') + ']').join('\n')
const hasPositive = (n) => Number.isFinite(n) && n > 0

function isoOk(s, name = 'תאריך') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) throw new Error(`${name} חייב להיות בפורמט YYYY-MM-DD`)
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCMonth() !== +m[2] - 1) throw new Error(`${name} לא קיים`)
  return d
}
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
const dayNum = (iso, name) => Math.round(isoOk(iso, name).getTime() / 86400000)
const addDays = (iso, n) => new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10)

// ---------- math cores ----------
function erf(x) {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2))

function median(sorted) {
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

function gaussSolve(A, b) {
  const n = A.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('למערכת אין פתרון יחיד (דטרמיננטה אפס)')
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((r, i) => r[n] / r[i])
}

function determinant(A) {
  const n = A.length
  const M = A.map((r) => [...r])
  let det = 1
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-14) return 0
    if (p !== c) {
      ;[M[c], M[p]] = [M[p], M[c]]
      det = -det
    }
    det *= M[c][c]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return det
}

function inverse(A) {
  const n = A.length
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('למטריצה אין הפכית (דטרמיננטה אפס)')
    ;[M[c], M[p]] = [M[p], M[c]]
    const d = M[c][c]
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c]
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((r) => r.slice(n))
}

const bgcd = (a, b) => {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) [a, b] = [b, a % b]
  return a
}

function parseFraction(s, name) {
  const m = /^\s*(-?\d+)\s*(?:\/\s*(-?\d+))?\s*$/.exec(String(need(s, name)))
  if (!m) throw new Error(`${name} חייב להיות שבר כמו 3/4 או מספר שלם`)
  let n = BigInt(m[1])
  let d = BigInt(m[2] ?? 1)
  if (d === 0n) throw new Error('מכנה אפס')
  if (d < 0n) [n, d] = [-n, -d]
  const g = bgcd(n, d) || 1n
  return [n / g, d / g]
}

function polyString(c) {
  // c highest degree first
  const deg = c.length - 1
  const parts = []
  c.forEach((k, i) => {
    if (k === 0) return
    const p = deg - i
    const abs = Math.abs(k)
    const coef = abs === 1 && p > 0 ? '' : fmt(abs, 8)
    const term = p === 0 ? coef : p === 1 ? `${coef}x` : `${coef}x^${p}`
    parts.push(parts.length ? (k < 0 ? ' - ' : ' + ') + term : (k < 0 ? '-' : '') + term)
  })
  return parts.length ? parts.join('') : '0'
}
const polyEval = (c, x) => c.reduce((acc, k) => acc * x + k, 0)

// ---------- periodic table ----------
const ELEMENTS = [
  ['H', 'מימן', 'Hydrogen', 1.008], ['He', 'הליום', 'Helium', 4.0026], ['Li', 'ליתיום', 'Lithium', 6.94], ['Be', 'בריליום', 'Beryllium', 9.0122],
  ['B', 'בור', 'Boron', 10.81], ['C', 'פחמן', 'Carbon', 12.011], ['N', 'חנקן', 'Nitrogen', 14.007], ['O', 'חמצן', 'Oxygen', 15.999],
  ['F', 'פלואור', 'Fluorine', 18.998], ['Ne', 'ניאון', 'Neon', 20.18], ['Na', 'נתרן', 'Sodium', 22.99], ['Mg', 'מגנזיום', 'Magnesium', 24.305],
  ['Al', 'אלומיניום', 'Aluminium', 26.982], ['Si', 'צורן (סיליקון)', 'Silicon', 28.085], ['P', 'זרחן', 'Phosphorus', 30.974], ['S', 'גופרית', 'Sulfur', 32.06],
  ['Cl', 'כלור', 'Chlorine', 35.45], ['Ar', 'ארגון', 'Argon', 39.948], ['K', 'אשלגן', 'Potassium', 39.098], ['Ca', 'סידן', 'Calcium', 40.078],
  ['Sc', 'סקנדיום', 'Scandium', 44.956], ['Ti', 'טיטניום', 'Titanium', 47.867], ['V', 'ונדיום', 'Vanadium', 50.942], ['Cr', 'כרום', 'Chromium', 51.996],
  ['Mn', 'מנגן', 'Manganese', 54.938], ['Fe', 'ברזל', 'Iron', 55.845], ['Co', 'קובלט', 'Cobalt', 58.933], ['Ni', 'ניקל', 'Nickel', 58.693],
  ['Cu', 'נחושת', 'Copper', 63.546], ['Zn', 'אבץ', 'Zinc', 65.38], ['Ga', 'גליום', 'Gallium', 69.723], ['Ge', 'גרמניום', 'Germanium', 72.63],
  ['As', 'ארסן', 'Arsenic', 74.922], ['Se', 'סלניום', 'Selenium', 78.971], ['Br', 'ברום', 'Bromine', 79.904], ['Kr', 'קריפטון', 'Krypton', 83.798],
].map(([symbol, he, en, mass], i) => ({ number: i + 1, symbol, he, en, mass }))

// ---------- kinematics ----------
function kinematics(given) {
  const k = { ...given }
  const has = (...ks) => ks.every((x) => k[x] !== undefined)
  const no = (x) => k[x] === undefined
  for (let pass = 0; pass < 6; pass++) {
    if (no('v') && has('u', 'a', 't')) k.v = k.u + k.a * k.t
    if (no('u') && has('v', 'a', 't')) k.u = k.v - k.a * k.t
    if (no('a') && has('u', 'v', 't') && k.t !== 0) k.a = (k.v - k.u) / k.t
    if (no('t') && has('u', 'v', 'a') && k.a !== 0) k.t = (k.v - k.u) / k.a
    if (no('s') && has('u', 't', 'a')) k.s = k.u * k.t + 0.5 * k.a * k.t * k.t
    if (no('s') && has('u', 'v', 't')) k.s = ((k.u + k.v) / 2) * k.t
    if (no('s') && has('u', 'v', 'a') && k.a !== 0) k.s = (k.v * k.v - k.u * k.u) / (2 * k.a)
    if (no('u') && has('v', 't', 's') && k.t !== 0) k.u = (2 * k.s) / k.t - k.v
    if (no('u') && has('a', 't', 's') && k.t !== 0) k.u = k.s / k.t - 0.5 * k.a * k.t
    if (no('a') && has('u', 't', 's') && k.t !== 0) k.a = (2 * (k.s - k.u * k.t)) / (k.t * k.t)
    if (no('v') && has('u', 'a', 's')) {
      const q = k.u * k.u + 2 * k.a * k.s
      if (q < 0) throw new Error('אין פתרון ממשי עם הנתונים האלה')
      k.v = Math.sqrt(q) * (k.u < 0 || (k.u === 0 && k.a * k.s < 0) ? -1 : 1)
    }
    if (no('u') && has('v', 'a', 's')) {
      const q = k.v * k.v - 2 * k.a * k.s
      if (q < 0) throw new Error('אין פתרון ממשי עם הנתונים האלה')
      k.u = Math.sqrt(q)
    }
    if (no('t') && has('u', 'v', 's') && k.u + k.v !== 0) k.t = (2 * k.s) / (k.u + k.v)
    if (no('a') && has('u', 'v', 's') && k.s !== 0) k.a = (k.v * k.v - k.u * k.u) / (2 * k.s)
  }
  return k
}

// ---------- tools ----------
export const tools = [
  {
    name: 'study_quadratic',
    description: 'פותר משוואה ריבועית ax²+bx+c=0 ומחזיר שורשים ממשיים או מרוכבים, דיסקרימיננטה וקודקוד.',
    parameters: obj({ a: num('המקדם a'), b: num('המקדם b'), c: num('המקדם c') }),
    run({ a, b, c }) {
      a = toNumber(a, 'a')
      b = toNumber(b, 'b')
      c = toNumber(c, 'c')
      if (a === 0) {
        if (b === 0) throw new Error('אין כאן משוואה (a ו-b שניהם אפס)')
        return `משוואה ליניארית: x = ${fmt(-c / b)}`
      }
      const d = b * b - 4 * a * c
      const head = `דיסקרימיננטה Δ = ${fmt(d)}; קודקוד (${fmt(-b / (2 * a))}, ${fmt(c - (b * b) / (4 * a))})`
      if (d > 0) return `${head}\nשני שורשים ממשיים: x₁ = ${fmt((-b + Math.sqrt(d)) / (2 * a))}, x₂ = ${fmt((-b - Math.sqrt(d)) / (2 * a))}`
      if (d === 0) return `${head}\nשורש כפול: x = ${fmt(-b / (2 * a))}`
      const re = -b / (2 * a)
      const im = Math.sqrt(-d) / (2 * Math.abs(a))
      return `${head}\nשני שורשים מרוכבים: x = ${fmt(re)} ± ${fmt(im)}i`
    },
  },
  {
    name: 'study_linear_system',
    description: 'פותר מערכת משוואות ליניאריות 2x2 עד 4x4. matrix: שורות מופרדות ב-; ומקדמים ב-פסיק. constants: האגפים הימניים.',
    parameters: obj({ matrix: str('מטריצת המקדמים, למשל "2,1;1,3"'), constants: str('האגפים הימניים, למשל "5,10"') }),
    run({ matrix, constants }) {
      const A = parseMatrix(matrix, 'מטריצה', 4)
      const b = parseList(constants, 'קבועים', 4)
      if (A.length < 2 || A.some((r) => r.length !== A.length)) throw new Error('המטריצה חייבת להיות ריבועית, לפחות 2x2')
      if (b.length !== A.length) throw new Error('מספר הקבועים חייב להיות כמספר המשוואות')
      const x = gaussSolve(A, b)
      const names = ['x', 'y', 'z', 'w']
      return x.map((v, i) => `${names[i]} = ${fmt(v)}`).join(', ')
    },
  },
  {
    name: 'stats_describe',
    description: 'סטטיסטיקה לרשימת מספרים: ממוצע, חציון, שכיח, שונות, סטיית תקן, רבעונים; עם y גם מתאם פירסון.',
    parameters: obj({ values: str('מספרים מופרדים בפסיק'), y: str('רשימה שנייה באותו אורך, לחישוב מתאם (אופציונלי)') }, ['values']),
    run({ values, y }) {
      const x = parseList(values, 'ערכים')
      const n = x.length
      const mean = x.reduce((s, v) => s + v, 0) / n
      const ss = x.reduce((s, v) => s + (v - mean) ** 2, 0)
      const sorted = [...x].sort((p, q) => p - q)
      const counts = new Map()
      for (const v of x) counts.set(v, (counts.get(v) ?? 0) + 1)
      const top = Math.max(...counts.values())
      const mode = top === 1 ? 'אין שכיח' : [...counts].filter(([, c]) => c === top).map(([v]) => fmt(v)).join(', ')
      const half = Math.floor(n / 2)
      const q1 = n > 1 ? median(sorted.slice(0, half)) : sorted[0]
      const q3 = n > 1 ? median(sorted.slice(n - half)) : sorted[0]
      const res = [
        `n = ${n}, סכום = ${fmt(x.reduce((s, v) => s + v, 0))}`,
        `ממוצע = ${fmt(mean)}, חציון = ${fmt(median(sorted))}, שכיח = ${mode}`,
        `מינימום = ${fmt(sorted[0])}, מקסימום = ${fmt(sorted[n - 1])}, טווח = ${fmt(sorted[n - 1] - sorted[0])}`,
        `שונות (אוכלוסייה) = ${fmt(ss / n)}, סטיית תקן (אוכלוסייה) = ${fmt(Math.sqrt(ss / n))}`,
        n > 1 ? `שונות (מדגם) = ${fmt(ss / (n - 1))}, סטיית תקן (מדגם) = ${fmt(Math.sqrt(ss / (n - 1)))}` : '',
        `רבעונים: Q1 = ${fmt(q1)}, Q3 = ${fmt(q3)}, IQR = ${fmt(q3 - q1)}`,
      ]
      if (y !== undefined && y !== null && y !== '') {
        const w = parseList(y, 'y')
        if (w.length !== n) throw new Error('שתי הרשימות חייבות להיות באותו אורך')
        const my = w.reduce((s, v) => s + v, 0) / n
        const sy = w.reduce((s, v) => s + (v - my) ** 2, 0)
        if (ss === 0 || sy === 0) throw new Error('אי אפשר לחשב מתאם כשכל הערכים זהים')
        const cov = x.reduce((s, v, i) => s + (v - mean) * (w[i] - my), 0)
        const r = cov / Math.sqrt(ss * sy)
        const slope = cov / ss
        res.push(`מתאם פירסון r = ${fmt(r, 8)}, R² = ${fmt(r * r, 8)}; ישר רגרסיה y = ${fmt(slope, 8)}x + ${fmt(my - slope * mean, 8)}`)
      }
      return out(lines(res))
    },
  },
  {
    name: 'stats_distribution',
    description: 'התפלגות נורמלית (mean, sd, מ-from עד-to) או בינומית (n, p, k): מחשב הסתברויות.',
    parameters: obj(
      {
        kind: oneOf(['normal', 'binomial'], 'סוג ההתפלגות'),
        mean: num('תוחלת (נורמלית, ברירת מחדל 0)'),
        sd: num('סטיית תקן (נורמלית, ברירת מחדל 1)'),
        from: num('גבול תחתון (נורמלית, אופציונלי)'),
        to: num('גבול עליון (נורמלית, אופציונלי)'),
        n: num('מספר ניסויים (בינומית, עד 1000)'),
        p: num('הסתברות להצלחה (בינומית)'),
        k: num('מספר הצלחות (בינומית)'),
      },
      ['kind'],
    ),
    run({ kind, mean = 0, sd = 1, from, to, n, p, k }) {
      if (kind === 'normal') {
        const m = toNumber(mean, 'mean')
        const s = toNumber(sd, 'sd')
        if (s <= 0) throw new Error('סטיית התקן חייבת להיות חיובית')
        const hasFrom = from !== undefined && from !== null && from !== ''
        const hasTo = to !== undefined && to !== null && to !== ''
        if (!hasFrom && !hasTo) throw new Error('צריך לפחות גבול אחד (from או to)')
        const lo = hasFrom ? toNumber(from, 'from') : -Infinity
        const hi = hasTo ? toNumber(to, 'to') : Infinity
        if (lo > hi) throw new Error('from גדול מ-to')
        const cdf = (v) => (v === -Infinity ? 0 : v === Infinity ? 1 : normCdf((v - m) / s))
        const z = (v) => (Number.isFinite(v) ? `z=${fmt((v - m) / s, 6)}` : '')
        return `P(${hasFrom ? fmt(lo) : '-∞'} < X < ${hasTo ? fmt(hi) : '∞'}) = ${cdf(hi) - cdf(lo) < 0 ? 0 : (cdf(hi) - cdf(lo)).toFixed(6)} ${z(lo)} ${z(hi)}`.trim()
      }
      if (kind === 'binomial') {
        const N = Math.floor(toNumber(need(n, 'n'), 'n'))
        const P = toNumber(need(p, 'p'), 'p')
        const K = Math.floor(toNumber(need(k, 'k'), 'k'))
        if (N < 1 || N > 1000) throw new Error('n חייב להיות בין 1 ל-1000')
        if (P < 0 || P > 1) throw new Error('p חייב להיות בין 0 ל-1')
        if (K < 0 || K > N) throw new Error('k חייב להיות בין 0 ל-n')
        const lf = [0]
        for (let i = 1; i <= N; i++) lf[i] = lf[i - 1] + Math.log(i)
        const pmf = (j) => {
          if (P === 0) return j === 0 ? 1 : 0
          if (P === 1) return j === N ? 1 : 0
          return Math.exp(lf[N] - lf[j] - lf[N - j] + j * Math.log(P) + (N - j) * Math.log(1 - P))
        }
        let le = 0
        for (let j = 0; j <= K; j++) le += pmf(j)
        le = Math.min(1, le)
        const eq = pmf(K)
        return `P(X=${K}) = ${eq.toFixed(6)}, P(X≤${K}) = ${le.toFixed(6)}, P(X≥${K}) = ${Math.min(1, 1 - le + eq).toFixed(6)}; תוחלת ${fmt(N * P)}, סטיית תקן ${fmt(Math.sqrt(N * P * (1 - P)), 6)}`
      }
      throw new Error('kind חייב להיות normal או binomial')
    },
  },
  {
    name: 'study_combinatorics',
    description: 'קומבינטוריקה מדויקת: n!, צירופים C(n,k) וסידורים P(n,k) (עד n=2000).',
    parameters: obj({ n: num('n'), k: num('k (אופציונלי)') }, ['n']),
    run({ n, k }) {
      const N = toNumber(n, 'n')
      if (!Number.isInteger(N) || N < 0 || N > 2000) throw new Error('n חייב להיות שלם בין 0 ל-2000')
      const fact = (m) => {
        let r = 1n
        for (let i = 2n; i <= BigInt(m); i++) r *= i
        return r
      }
      const nf = fact(N)
      const res = [`${N}! = ${nf.toString().length > 400 ? `${nf.toString().slice(0, 30)}… (${nf.toString().length} ספרות)` : nf}`]
      if (k !== undefined && k !== null && k !== '') {
        const K = toNumber(k, 'k')
        if (!Number.isInteger(K) || K < 0 || K > N) throw new Error('k חייב להיות שלם בין 0 ל-n')
        const perm = nf / fact(N - K)
        const comb = perm / fact(K)
        const show = (v) => (v.toString().length > 300 ? `${v.toString().slice(0, 30)}… (${v.toString().length} ספרות)` : v.toString())
        res.push(`C(${N},${K}) = ${show(comb)}`, `P(${N},${K}) = ${show(perm)}`)
      }
      return out(res.join('\n'))
    },
  },
  {
    name: 'study_primes',
    description: 'בודק אם מספר (עד 10^12) ראשוני, מפרק לגורמים ראשוניים ומונה מחלקים.',
    parameters: obj({ n: num('מספר שלם חיובי') }),
    run({ n }) {
      let m = toNumber(n, 'n')
      if (!Number.isInteger(m) || m < 2 || m > 1e12) throw new Error('n חייב להיות שלם בין 2 ל-10^12')
      const orig = m
      const f = new Map()
      for (let p = 2; p * p <= m; p += p === 2 ? 1 : 2) {
        while (m % p === 0) {
          f.set(p, (f.get(p) ?? 0) + 1)
          m /= p
        }
      }
      if (m > 1) f.set(m, (f.get(m) ?? 0) + 1)
      if (f.size === 1 && [...f.values()][0] === 1) return `${orig} הוא מספר ראשוני`
      const text = [...f].map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' × ')
      const divisors = [...f.values()].reduce((a, e) => a * (e + 1), 1)
      return `${orig} אינו ראשוני: ${orig} = ${text}; מספר מחלקים: ${divisors}`
    },
  },
  {
    name: 'study_gcd_lcm',
    description: 'מחשב מחלק משותף מקסימלי (gcd) וכפולה משותפת מינימלית (lcm) של רשימת מספרים שלמים.',
    parameters: obj({ numbers: str('מספרים שלמים מופרדים בפסיק') }),
    run({ numbers }) {
      const xs = parseList(numbers, 'מספרים', 30)
      if (xs.length < 2) throw new Error('צריך לפחות שני מספרים')
      if (xs.some((v) => !Number.isInteger(v) || v === 0 || Math.abs(v) > 1e15)) throw new Error('המספרים חייבים להיות שלמים שאינם אפס')
      let g = 0n
      let l = 1n
      for (const v of xs) {
        const b = BigInt(Math.abs(v))
        g = bgcd(g, b)
        l = (l / bgcd(l, b)) * b
      }
      return `gcd = ${g}, lcm = ${l}`
    },
  },
  {
    name: 'study_fractions',
    description: 'חשבון שברים מדויק: add/sub/mul/div בין a ל-b, או simplify לצמצום שבר a. שבר נכתב כ-3/4.',
    parameters: obj({ op: oneOf(['add', 'sub', 'mul', 'div', 'simplify'], 'הפעולה'), a: str('שבר ראשון, למשל 3/4'), b: str('שבר שני (לא נדרש בצמצום)') }, ['op', 'a']),
    run({ op, a, b }) {
      const [an, ad] = parseFraction(a, 'a')
      let r
      if (op === 'simplify') r = [an, ad]
      else {
        const [bn, bd] = parseFraction(need(b, 'b'), 'b')
        if (op === 'add') r = [an * bd + bn * ad, ad * bd]
        else if (op === 'sub') r = [an * bd - bn * ad, ad * bd]
        else if (op === 'mul') r = [an * bn, ad * bd]
        else if (op === 'div') {
          if (bn === 0n) throw new Error('חילוק באפס')
          r = [an * bd, ad * bn]
        } else throw new Error('פעולה לא מוכרת')
      }
      let [n, d] = r
      if (d < 0n) [n, d] = [-n, -d]
      const g = bgcd(n, d) || 1n
      n /= g
      d /= g
      const dec = Number(n) / Number(d)
      const whole = n / d
      const mixed = d !== 1n && (n < 0n ? -n : n) > d ? ` = ${whole} ${(n < 0n ? -n : n) % d}/${d}` : ''
      return `${d === 1n ? n : `${n}/${d}`}${mixed} (עשרוני ${fmt(dec, 8)})`
    },
  },
  {
    name: 'study_matrix',
    description: 'פעולות על מטריצות קטנות (עד 6x6): det דטרמיננטה, inverse הפוכה, transpose, multiply כפל a·b. שורות ב-; ותאים ב-פסיק.',
    parameters: obj({ op: oneOf(['det', 'inverse', 'transpose', 'multiply'], 'הפעולה'), a: str('מטריצה, למשל "1,2;3,4"'), b: str('מטריצה שנייה (לכפל)') }, ['op', 'a']),
    run({ op, a, b }) {
      const A = parseMatrix(a, 'a')
      if (op === 'transpose') return showMatrix(A[0].map((_, j) => A.map((r) => r[j])))
      if (op === 'multiply') {
        const B = parseMatrix(need(b, 'b'), 'b')
        if (A[0].length !== B.length) throw new Error('מספר העמודות של a חייב להיות כמספר השורות של b')
        return showMatrix(A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0))))
      }
      if (A.length !== A[0].length) throw new Error('צריך מטריצה ריבועית')
      if (op === 'det') return `det = ${fmt(Math.round(determinant(A) * 1e9) / 1e9, 10)}`
      if (op === 'inverse') return showMatrix(inverse(A).map((r) => r.map((v) => Math.round(v * 1e10) / 1e10 + 0)))
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'study_polynomial',
    description: 'נגזרת, אינטגרל, ערך בנקודה או אינטגרל מסוים של פולינום. coeffs: מקדמים מהחזקה הגבוהה, "3,2,1" = 3x²+2x+1.',
    parameters: obj(
      { coeffs: str('מקדמים מהחזקה הגבוהה לנמוכה'), op: oneOf(['derivative', 'integral', 'evaluate', 'definite'], 'הפעולה'), x: num('הנקודה, או הגבול התחתון באינטגרל מסוים'), to: num('הגבול העליון באינטגרל מסוים') },
      ['coeffs', 'op'],
    ),
    run({ coeffs, op, x, to }) {
      const c = parseList(coeffs, 'מקדמים', 30)
      const deg = c.length - 1
      const integral = () => [...c.map((k, i) => k / (deg - i + 1)), 0]
      if (op === 'derivative') {
        if (deg === 0) return "f'(x) = 0"
        return `f'(x) = ${polyString(c.slice(0, -1).map((k, i) => k * (deg - i)))}`
      }
      if (op === 'integral') return `∫f(x)dx = ${polyString(integral())} + C`
      if (op === 'evaluate') return `f(${fmt(toNumber(need(x, 'x'), 'x'))}) = ${fmt(polyEval(c, toNumber(x, 'x')))}`
      if (op === 'definite') {
        const lo = toNumber(need(x, 'x'), 'x')
        const hi = toNumber(need(to, 'to'), 'to')
        const F = integral()
        return `∫ מ-${fmt(lo)} עד ${fmt(hi)} = ${fmt(polyEval(F, hi) - polyEval(F, lo), 10)}`
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'study_bagrut_average',
    description: 'ממוצע בגרות משוקלל ביחידות לימוד. subjects: "מקצוע:יחידות:ציון" מופרדים ב-; ; עם bonus מוסיף 25 ל-5 יח"ל ו-12.5 ל-4 יח"ל.',
    parameters: obj({ subjects: str('למשל "מתמטיקה:5:90; אנגלית:4:85; היסטוריה:2:78"'), bonus: bool('להוסיף בונוס יחידות (משוער)') }, ['subjects']),
    run({ subjects, bonus = false }) {
      const items = String(need(subjects, 'מקצועות')).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
      if (!items.length || items.length > 40) throw new Error('צריך בין 1 ל-40 מקצועות')
      let units = 0
      let total = 0
      let plain = 0
      const rows = items.map((it) => {
        const parts = it.split(':').map((p) => p.trim())
        if (parts.length !== 3) throw new Error(`פורמט שגוי ב-"${it}" (מצופה שם:יחידות:ציון)`)
        const u = toNumber(parts[1], 'יחידות')
        const g = toNumber(parts[2], 'ציון')
        if (u <= 0 || u > 10) throw new Error(`מספר יחידות לא הגיוני ב-"${parts[0]}"`)
        if (g < 0 || g > 100) throw new Error(`ציון חייב להיות בין 0 ל-100 ב-"${parts[0]}"`)
        const b = bonus ? (u >= 5 ? 25 : u >= 4 ? 12.5 : 0) : 0
        units += u
        total += u * (g + b)
        plain += u * g
        return `${parts[0]}: ${fmt(u)} יח"ל, ציון ${fmt(g)}${b ? ` (+${b})` : ''}`
      })
      const res = [...rows, `סה"כ ${fmt(units)} יחידות`, `ממוצע משוקלל: ${(plain / units).toFixed(2)}`]
      if (bonus) res.push(`ממוצע עם בונוס: ${(total / units).toFixed(2)}`)
      return out(res.join('\n'))
    },
  },
  {
    name: 'study_needed_grade',
    description: 'כמה צריך בציון הסופי (מבחן) כדי להגיע לציון יעד: ממוצע נוכחי, כמה אחוז מהציון כבר נצבר, ויעד.',
    parameters: obj({ current_average: num('הממוצע בחלק שכבר נצבר (0-100)'), done_percent: num('כמה אחוז מהציון הסופי כבר נצבר (0-99)'), target: num('ציון היעד') }),
    run({ current_average, done_percent, target }) {
      const avg = toNumber(current_average, 'ממוצע')
      const w = toNumber(done_percent, 'אחוז')
      const t = toNumber(target, 'יעד')
      if (w < 0 || w >= 100) throw new Error('האחוז שנצבר חייב להיות בין 0 ל-99.99')
      if (avg < 0 || avg > 100 || t < 0 || t > 100) throw new Error('ציונים חייבים להיות בין 0 ל-100')
      const need_ = (t - (avg * w) / 100) / ((100 - w) / 100)
      const r = Number(need_.toFixed(2))
      if (r > 100) return `צריך ${r} במבחן, אי אפשר להגיע ליעד ${fmt(t)} (המקסימום האפשרי: ${((avg * w) / 100 + (100 - w)).toFixed(2)})`
      if (r <= 0) return `כבר הבטחת את היעד ${fmt(t)} גם עם 0 במבחן`
      return `כדי להגיע ל-${fmt(t)} צריך ${r} במבחן הסופי`
    },
  },
  {
    name: 'study_exams',
    description: 'מבחנים שמורים: add (name, date), list (ימים שנותרו), remove (name). תאריך בפורמט YYYY-MM-DD.',
    parameters: obj({ action: oneOf(['add', 'list', 'remove'], 'הפעולה'), name: str('שם המבחן'), date: str('תאריך YYYY-MM-DD'), today: str('תאריך של היום (לבדיקות, אופציונלי)') }, ['action']),
    async run({ action, name, date, today }) {
      const exams = await bucket('study_exams', [])
      const now = today ? isoOk(today, 'today') && today : todayIso()
      if (action === 'add') {
        const nm = String(need(name, 'שם')).trim().slice(0, 80)
        isoOk(need(date, 'תאריך'))
        if (exams.length >= 100) throw new Error('יותר מדי מבחנים שמורים')
        exams.push({ id: await nextId(), name: nm, date: String(date).trim() })
        await persist()
        return `נשמר: ${nm} ב-${date} (עוד ${dayNum(date) - dayNum(now)} ימים)`
      }
      if (action === 'remove') {
        const nm = String(need(name, 'שם')).trim()
        const i = exams.findIndex((e) => e.name === nm || String(e.id) === nm)
        if (i < 0) throw new Error(`לא נמצא מבחן בשם "${nm}"`)
        exams.splice(i, 1)
        await persist()
        return `נמחק המבחן "${nm}"`
      }
      if (action === 'list') {
        if (!exams.length) return 'אין מבחנים שמורים'
        const rows = [...exams].sort((a, b) => a.date.localeCompare(b.date)).map((e) => {
          const d = dayNum(e.date) - dayNum(now)
          return `${e.name}: ${e.date} (${d > 0 ? `עוד ${d} ימים` : d === 0 ? 'היום!' : `עבר לפני ${-d} ימים`})`
        })
        return out(rows.join('\n'))
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'study_flashcards',
    description: 'כרטיסיות חזרה בשיטת לייטנר: add (deck, front, back), next, answer (card, correct), stats. תאריך today אופציונלי.',
    parameters: obj(
      {
        action: oneOf(['add', 'next', 'answer', 'stats'], 'הפעולה'),
        deck: str('שם החבילה (ברירת מחדל "כללי")'),
        front: str('צד קדמי / שאלה (להוספה)'),
        back: str('צד אחורי / תשובה (להוספה)'),
        card: str('מזהה או טקסט צד קדמי של הכרטיסיה (למענה)'),
        correct: bool('האם ענית נכון'),
        today: str('תאריך YYYY-MM-DD (לבדיקות, אופציונלי)'),
      },
      ['action'],
    ),
    async run({ action, deck = 'כללי', front, back, card, correct, today }) {
      const cards = await bucket('study_flashcards', [])
      const now = today ? (isoOk(today, 'today'), String(today)) : todayIso()
      const dk = String(deck).trim().slice(0, 40) || 'כללי'
      const interval = [0, 1, 2, 4, 8, 16]
      if (action === 'add') {
        if (cards.length >= 2000) throw new Error('יותר מדי כרטיסיות')
        const f = String(need(front, 'צד קדמי')).trim().slice(0, 300)
        const b = String(need(back, 'צד אחורי')).trim().slice(0, 600)
        cards.push({ id: await nextId(), deck: dk, front: f, back: b, box: 1, due: now })
        await persist()
        return `נוספה כרטיסיה לחבילה "${dk}": ${f}`
      }
      if (action === 'next') {
        const due = cards.filter((c) => c.deck === dk && c.due <= now).sort((a, b) => a.box - b.box || a.due.localeCompare(b.due))
        if (!due.length) return `אין כרטיסיות לחזרה היום בחבילה "${dk}"`
        return `שאלה: ${due[0].front}\n(מזהה: ${due[0].id}, קופסה ${due[0].box}, ${due.length} ממתינות)`
      }
      if (action === 'answer') {
        const key = String(need(card, 'כרטיסיה')).trim()
        const c = cards.find((x) => String(x.id) === key) ?? cards.find((x) => x.deck === dk && x.front === key)
        if (!c) throw new Error('לא נמצאה כרטיסיה כזאת')
        if (correct === undefined) throw new Error('חסר correct (נכון או לא)')
        c.box = correct ? Math.min(5, c.box + 1) : 1
        c.due = addDays(now, interval[c.box])
        await persist()
        return `${correct ? 'נכון' : 'לא נכון'}. תשובה: ${c.back}. קופסה ${c.box}, חזרה הבאה ב-${c.due}`
      }
      if (action === 'stats') {
        const mine = cards.filter((c) => c.deck === dk)
        if (!mine.length) return `אין כרטיסיות בחבילה "${dk}"`
        const byBox = [1, 2, 3, 4, 5].map((b) => `קופסה ${b}: ${mine.filter((c) => c.box === b).length}`).join(', ')
        return `חבילה "${dk}": ${mine.length} כרטיסיות, ${mine.filter((c) => c.due <= now).length} לחזרה היום. ${byBox}`
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'study_pomodoro',
    description: 'בונה לוח פומודורו לפי הדקות הפנויות: בלוקי עבודה והפסקות (ברירת מחדל 25/5, הפסקה ארוכה אחרי 4).',
    parameters: obj({ minutes: num('סך הדקות הפנויות (עד 720)'), work: num('דקות עבודה לבלוק, ברירת מחדל 25'), short_break: num('הפסקה קצרה, ברירת מחדל 5'), long_break: num('הפסקה ארוכה, ברירת מחדל 15'), start: str('שעת התחלה HH:MM (אופציונלי)') }, ['minutes']),
    run({ minutes, work = 25, short_break = 5, long_break = 15, start }) {
      const total = Math.floor(toNumber(minutes, 'דקות'))
      const w = Math.floor(toNumber(work, 'עבודה'))
      const sb = Math.floor(toNumber(short_break, 'הפסקה'))
      const lb = Math.floor(toNumber(long_break, 'הפסקה ארוכה'))
      if (total < 5 || total > 720) throw new Error('הדקות חייבות להיות בין 5 ל-720')
      if (w < 5 || w > 120 || sb < 0 || lb < 0) throw new Error('ערכי בלוקים לא הגיוניים')
      let t0 = 0
      if (start) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(start).trim())
        if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('שעת התחלה חייבת להיות HH:MM')
        t0 = +m[1] * 60 + +m[2]
      }
      const clock = (m) => (start ? `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : `דקה ${m}`)
      let used = 0
      let rounds = 0
      let studied = 0
      const rows = []
      while (used < total) {
        const len = Math.min(w, total - used)
        rows.push(`${clock(t0 + used)} עבודה ${len} דק'`)
        used += len
        studied += len
        rounds++
        if (used >= total) break
        const br = Math.min(rounds % 4 === 0 ? lb : sb, total - used)
        if (br > 0) {
          rows.push(`${clock(t0 + used)} הפסקה ${br} דק'`)
          used += br
        }
      }
      return out(`${rounds} סבבי עבודה, ${studied} דקות לימוד מתוך ${total}\n${rows.join('\n')}`)
    },
  },
  {
    name: 'study_periodic_table',
    description: 'שולף יסוד מהטבלה המחזורית (36 הראשונים) לפי סמל, שם בעברית/אנגלית או מספר אטומי: מסה אטומית ושם.',
    parameters: obj({ query: str('סמל (Fe), שם (ברזל / Iron) או מספר אטומי (26)') }),
    run({ query }) {
      const q = String(need(query, 'יסוד')).trim().toLowerCase()
      const e = ELEMENTS.find((x) => String(x.number) === q || x.symbol.toLowerCase() === q || x.en.toLowerCase() === q || x.he === q || x.he.startsWith(q))
      if (!e) throw new Error('היסוד לא נמצא (יש רק 36 היסודות הראשונים)')
      return `${e.he} (${e.en}), סמל ${e.symbol}, מספר אטומי ${e.number}, מסה אטומית ${e.mass}`
    },
  },
  {
    name: 'study_kinematics',
    description: 'קינמטיקה בתאוצה קבועה: נתנו שלושה מתוך u,v,a,t,s והכלי מחשב את השניים החסרים.',
    parameters: obj(
      { u: num('מהירות התחלתית'), v: num('מהירות סופית'), a: num('תאוצה'), t: num('זמן'), s: num('העתק') },
      [],
    ),
    run(args) {
      const given = {}
      for (const key of ['u', 'v', 'a', 't', 's']) if (args[key] !== undefined && args[key] !== null && args[key] !== '') given[key] = toNumber(args[key], key)
      if (Object.keys(given).length !== 3) throw new Error('צריך לתת בדיוק שלושה משתנים מתוך u, v, a, t, s')
      if (given.t !== undefined && given.t < 0) throw new Error('הזמן לא יכול להיות שלילי')
      const r = kinematics(given)
      const missing = ['u', 'v', 'a', 't', 's'].filter((k) => r[k] === undefined || !Number.isFinite(r[k]))
      if (missing.length) throw new Error('אי אפשר לפתור עם הנתונים האלה')
      return `u = ${fmt(r.u)}, v = ${fmt(r.v)}, a = ${fmt(r.a)}, t = ${fmt(r.t)}, s = ${fmt(r.s)}`
    },
  },
  {
    name: 'study_time_split',
    description: 'מחלק שעות למידה בין מקצועות לפי קושי ודחיפות. subjects: "שם:קושי 1-5:ימים עד המבחן" מופרדים ב-;.',
    parameters: obj({ subjects: str('למשל "פיזיקה:4:10; תנ"ך:2:5"'), total_hours: num('סך שעות הלמידה לחלוקה') }),
    run({ subjects, total_hours }) {
      const hours = toNumber(total_hours, 'שעות')
      if (hours <= 0 || hours > 1000) throw new Error('סך השעות חייב להיות בין 0 ל-1000')
      const items = String(need(subjects, 'מקצועות')).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
      if (!items.length || items.length > 20) throw new Error('צריך בין 1 ל-20 מקצועות')
      const rows = items.map((it) => {
        const p = it.split(':').map((x) => x.trim())
        if (p.length !== 3) throw new Error(`פורמט שגוי ב-"${it}" (מצופה שם:קושי:ימים)`)
        const diff = toNumber(p[1], 'קושי')
        const days = toNumber(p[2], 'ימים')
        if (diff < 1 || diff > 5) throw new Error('קושי חייב להיות בין 1 ל-5')
        if (!hasPositive(days)) throw new Error('מספר הימים חייב להיות חיובי')
        return { name: p[0], weight: diff / Math.sqrt(days) }
      })
      const sum = rows.reduce((s, r) => s + r.weight, 0)
      const res = rows.map((r) => {
        const h = (r.weight / sum) * hours
        return `${r.name}: ${h.toFixed(1)} שעות (${Math.round((r.weight / sum) * 100)}%)`
      })
      return out(res.join('\n'))
    },
  },
]

// ---------- tests ----------
const near = (s, re, v, eps = 1e-4) => {
  const m = re.exec(s)
  return !!m && Math.abs(parseFloat(m[1]) - v) < eps
}

export const tests = [
  { tool: 'study_quadratic', args: { a: 1, b: -5, c: 6 }, check: (r) => r.includes('x₁ = 3') && r.includes('x₂ = 2') },
  { tool: 'study_quadratic', args: { a: 1, b: 0, c: 1 }, check: (r) => r.includes('0 ± 1i') },
  { tool: 'study_quadratic', args: { a: 1, b: -2, c: 1 }, check: (r) => r.includes('שורש כפול: x = 1') },
  { tool: 'study_quadratic', args: { a: 0, b: 0, c: 1 }, throws: true, check: () => false },
  { tool: 'study_linear_system', args: { matrix: '2,1;1,3', constants: '5,10' }, check: (r) => r === 'x = 1, y = 3' },
  { tool: 'study_linear_system', args: { matrix: '1,1,1;0,2,5;2,5,-1', constants: '6,-4,27' }, check: (r) => r === 'x = 5, y = 3, z = -2' },
  { tool: 'study_linear_system', args: { matrix: '1,2;2,4', constants: '1,2' }, throws: true, check: () => false },
  {
    tool: 'stats_describe',
    args: { values: '2,4,4,4,5,5,7,9' },
    check: (r) => r.includes('ממוצע = 5') && r.includes('חציון = 4.5') && r.includes('שכיח = 4') && r.includes('סטיית תקן (אוכלוסייה) = 2') && r.includes('שונות (מדגם) = 4.571428571') && r.includes('Q1 = 4, Q3 = 6'),
  },
  { tool: 'stats_describe', args: { values: '1,2,3,4,5', y: '2,4,6,8,10' }, check: (r) => r.includes('r = 1,') && r.includes('y = 2x + 0') },
  { tool: 'stats_describe', args: { values: '1,2,3', y: '1,2' }, throws: true, check: () => false },
  { tool: 'stats_distribution', args: { kind: 'normal', from: -1.96, to: 1.96 }, check: (r) => near(r, /= (\d\.\d+)/, 0.95, 1e-5) },
  { tool: 'stats_distribution', args: { kind: 'normal', mean: 100, sd: 15, to: 100 }, check: (r) => r.includes('= 0.500000') },
  { tool: 'stats_distribution', args: { kind: 'binomial', n: 10, p: 0.5, k: 5 }, check: (r) => r.includes('P(X=5) = 0.246094') && r.includes('P(X≤5) = 0.623047') && r.includes('P(X≥5) = 0.623047') },
  { tool: 'stats_distribution', args: { kind: 'binomial', n: 10, p: 1.5, k: 5 }, throws: true, check: () => false },
  { tool: 'study_combinatorics', args: { n: 5, k: 2 }, check: (r) => r.includes('5! = 120') && r.includes('C(5,2) = 10') && r.includes('P(5,2) = 20') },
  { tool: 'study_combinatorics', args: { n: 20 }, check: (r) => r.includes('2432902008176640000') },
  { tool: 'study_combinatorics', args: { n: 5, k: 9 }, throws: true, check: () => false },
  { tool: 'study_primes', args: { n: 360 }, check: (r) => r.includes('2^3 × 3^2 × 5') && r.includes('מחלקים: 24') },
  { tool: 'study_primes', args: { n: 97 }, check: (r) => r.includes('ראשוני') && !r.includes('אינו') },
  { tool: 'study_primes', args: { n: 1 }, throws: true, check: () => false },
  { tool: 'study_gcd_lcm', args: { numbers: '12,18' }, check: (r) => r === 'gcd = 6, lcm = 36' },
  { tool: 'study_gcd_lcm', args: { numbers: '4,6,10' }, check: (r) => r === 'gcd = 2, lcm = 60' },
  { tool: 'study_fractions', args: { op: 'add', a: '3/4', b: '5/6' }, check: (r) => r.startsWith('19/12 = 1 7/12') },
  { tool: 'study_fractions', args: { op: 'simplify', a: '6/8' }, check: (r) => r.startsWith('3/4') },
  { tool: 'study_fractions', args: { op: 'div', a: '1/2', b: '0' }, throws: true, check: () => false },
  { tool: 'study_matrix', args: { op: 'det', a: '1,2;3,4' }, check: (r) => r === 'det = -2' },
  { tool: 'study_matrix', args: { op: 'inverse', a: '4,7;2,6' }, check: (r) => r === '[0.6, -0.7]\n[-0.2, 0.4]' },
  { tool: 'study_matrix', args: { op: 'multiply', a: '1,2;3,4', b: '5,6;7,8' }, check: (r) => r === '[19, 22]\n[43, 50]' },
  { tool: 'study_matrix', args: { op: 'transpose', a: '1,2,3;4,5,6' }, check: (r) => r === '[1, 4]\n[2, 5]\n[3, 6]' },
  { tool: 'study_matrix', args: { op: 'inverse', a: '1,2;2,4' }, throws: true, check: () => false },
  { tool: 'study_polynomial', args: { coeffs: '3,2,1', op: 'derivative' }, check: (r) => r === "f'(x) = 6x + 2" },
  { tool: 'study_polynomial', args: { coeffs: '3,2,1', op: 'integral' }, check: (r) => r === '∫f(x)dx = x^3 + x^2 + x + C' },
  { tool: 'study_polynomial', args: { coeffs: '3,2,1', op: 'evaluate', x: 2 }, check: (r) => r === 'f(2) = 17' },
  { tool: 'study_polynomial', args: { coeffs: '3,2,1', op: 'definite', x: 0, to: 2 }, check: (r) => r.endsWith('= 14') },
  {
    tool: 'study_bagrut_average',
    args: { subjects: 'מתמטיקה:5:90; אנגלית:4:80; עברית:2:100' },
    check: (r) => r.includes('סה"כ 11 יחידות') && r.includes('ממוצע משוקלל: 88.18'),
  },
  { tool: 'study_bagrut_average', args: { subjects: 'מתמטיקה:5:90; עברית:5:80', bonus: true }, check: (r) => r.includes('ממוצע משוקלל: 85.00') && r.includes('ממוצע עם בונוס: 110.00') },
  { tool: 'study_bagrut_average', args: { subjects: 'מתמטיקה:5:130' }, throws: true, check: () => false },
  { tool: 'study_needed_grade', args: { current_average: 80, done_percent: 60, target: 85 }, check: (r) => r.includes('92.5') },
  { tool: 'study_needed_grade', args: { current_average: 50, done_percent: 80, target: 95 }, check: (r) => r.includes('אי אפשר') },
  { tool: 'study_needed_grade', args: { current_average: 80, done_percent: 100, target: 85 }, throws: true, check: () => false },
  { tool: 'study_exams', args: { action: 'add', name: 'מתמטיקה-טסט', date: '2030-06-10', today: '2030-06-01' }, check: (r) => r.includes('עוד 9 ימים') },
  { tool: 'study_exams', args: { action: 'list', today: '2030-06-01' }, check: (r) => r.includes('מתמטיקה-טסט: 2030-06-10 (עוד 9 ימים)') },
  { tool: 'study_exams', args: { action: 'remove', name: 'מתמטיקה-טסט' }, check: (r) => r.includes('נמחק') },
  { tool: 'study_exams', args: { action: 'add', name: 'x', date: '2030-13-45' }, throws: true, check: () => false },
  { tool: 'study_flashcards', args: { action: 'add', deck: 'בדיקה', front: 'בירת צרפת?', back: 'פריז', today: '2030-01-01' }, check: (r) => r.includes('נוספה') },
  { tool: 'study_flashcards', args: { action: 'next', deck: 'בדיקה', today: '2030-01-01' }, check: (r) => r.includes('בירת צרפת?') && r.includes('קופסה 1') },
  { tool: 'study_flashcards', args: { action: 'answer', deck: 'בדיקה', card: 'בירת צרפת?', correct: true, today: '2030-01-01' }, check: (r) => r.includes('קופסה 2') && r.includes('2030-01-03') },
  { tool: 'study_flashcards', args: { action: 'next', deck: 'בדיקה', today: '2030-01-01' }, check: (r) => r.includes('אין כרטיסיות לחזרה') },
  { tool: 'study_flashcards', args: { action: 'stats', deck: 'בדיקה', today: '2030-01-03' }, check: (r) => r.includes('1 כרטיסיות, 1 לחזרה') && r.includes('קופסה 2: 1') },
  { tool: 'study_flashcards', args: { action: 'answer', card: 'לא קיים', correct: true }, throws: true, check: () => false },
  { tool: 'study_pomodoro', args: { minutes: 120, start: '10:00' }, check: (r) => r.startsWith('4 סבבי עבודה, 100 דקות לימוד מתוך 120') && r.includes('10:25 הפסקה 5') },
  { tool: 'study_pomodoro', args: { minutes: 2 }, throws: true, check: () => false },
  { tool: 'study_periodic_table', args: { query: 'Fe' }, check: (r) => r.includes('ברזל') && r.includes('מספר אטומי 26') && r.includes('55.845') },
  { tool: 'study_periodic_table', args: { query: 'חמצן' }, check: (r) => r.includes('סמל O') },
  { tool: 'study_periodic_table', args: { query: '36' }, check: (r) => r.includes('קריפטון') },
  { tool: 'study_periodic_table', args: { query: 'Uuo' }, throws: true, check: () => false },
  { tool: 'study_kinematics', args: { u: 0, a: 2, t: 5 }, check: (r) => r === 'u = 0, v = 10, a = 2, t = 5, s = 25' },
  { tool: 'study_kinematics', args: { u: 0, a: 2, s: 25 }, check: (r) => r === 'u = 0, v = 10, a = 2, t = 5, s = 25' },
  { tool: 'study_kinematics', args: { u: 4, v: 10, s: 14 }, check: (r) => r === 'u = 4, v = 10, a = 3, t = 2, s = 14' },
  { tool: 'study_kinematics', args: { u: 1, v: 2 }, throws: true, check: () => false },
  { tool: 'study_time_split', args: { subjects: 'פיזיקה:3:4; תנ"ך:1:4', total_hours: 8 }, check: (r) => r.includes('פיזיקה: 6.0 שעות') && r.includes('תנ"ך: 2.0 שעות') },
  { tool: 'study_time_split', args: { subjects: 'פיזיקה:9:4', total_hours: 8 }, throws: true, check: () => false },
]
