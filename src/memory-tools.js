// The model's view of the memory. remember/forget stay in tools.js and call into memory.js.
import { addFact, search, pending, confirmCandidates, rejectCandidates, CATEGORIES } from './memory.js'
import { state } from './store.js'

const str = (description) => ({ type: 'string', description })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

const idsOf = (args) => (Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isFinite) : [])

export const memoryTools = [
  {
    name: 'memory_search',
    description: 'מחפש בזיכרון הקבוע על המשתמש. לשימוש כשצריך עובדה שלא מופיעה בזיכרון שבהנחיות.',
    parameters: obj({ query: str('מילות חיפוש') }),
    run({ query }) {
      const found = search(query)
      return found.length ? found.map((m) => `#${m.id} ${m.fact}`).join('\n') : 'לא נמצא בזיכרון'
    },
  },
  {
    name: 'memory_pending',
    description: 'מציג עובדות על המשתמש שנלמדו מההודעות שלו וממתינות לאישור.',
    parameters: obj({}),
    run() {
      const list = pending()
      return list.length ? list.map((c) => `#${c.id} ${c.fact}`).join('\n') : 'אין עובדות ממתינות'
    },
  },
  {
    name: 'memory_confirm',
    description: 'שומר בזיכרון עובדות ממתינות (ids, או כולן אם לא צוין). המשתמש מאשר בצ\'אט לפני השמירה.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' }, description: 'מזהי העובדות, ריק = כולן' } }, required: [] },
    // The system asks the user, whatever a page or mail told the model: this is what keeps the memory unpoisonable.
    risk: 'write',
    onAsk() {
      state.memoryAskedAt = Date.now()
    },
    describe(args) {
      const ids = idsOf(args)
      const list = pending().filter((c) => !ids.length || ids.includes(c.id))
      return list.length ? `לשמור בזיכרון?\n${list.map((c) => `• ${c.fact}`).join('\n')}` : 'אין עובדות ממתינות לשמירה'
    },
    run(args) {
      const done = confirmCandidates(idsOf(args))
      if (!done.length) return 'אין עובדות ממתינות'
      return done.map((d) => `${d.status === 'added' ? 'נשמר' : d.status === 'updated' ? 'עודכן' : 'כבר היה ידוע'}: ${d.fact}`).join('\n')
    },
  },
  {
    name: 'memory_reject',
    description: 'מוחק עובדות ממתינות שהמשתמש לא רוצה שייזכרו (ids, או כולן אם לא צוין).',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' }, description: 'מזהי העובדות, ריק = כולן' } }, required: [] },
    run(args) {
      const n = rejectCandidates(idsOf(args))
      return n ? `נמחקו ${n} עובדות ממתינות` : 'אין עובדות ממתינות'
    },
  },
]

export { addFact, CATEGORIES }
