// What the model sees of HELPER's self-teaching: lessons (skills.js) and tools it writes for itself (tool-builder.js).
// Both end the same way: nothing is kept until Naor approves it, and the approval is the system's own question
// (risk: 'write'), so a web page or a mail cannot talk HELPER into teaching itself something.
import fs from 'node:fs'
import path from 'node:path'
import { state } from './store.js'
import { config } from './config.js'
import { runClaudeCode, projectSlug } from './claude-code.js'
import { askGemini } from './gemini-api.js'
import { learnerBackend, research, NO_LEARNER } from './learner.js'
import {
  proposeSkill, pendingSkills, confirmSkills, rejectSkills, removeSkill, searchSkills, noteGap, skillsBlock,
} from './skills.js'
import {
  WRITER_BRIEF, extractModule, proposeModule, pendingTools, rejectModules, describeProposal, installProposal, removeUserTool, listUserTools,
} from './tool-builder.js'

const str = (description) => ({ type: 'string', description })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const ids = (args) => (Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isFinite) : [])
const idsParam = { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' }, description: 'המזהים, ריק = כולם' } }, required: [] }
const ASK_EVERY_MS = 4 * 3600e3

// ── lessons ──────────────────────────────────────────────────────────────────

const learningOn = () => config.learning
const gated = (list) => list.map((t) => ({ enabled: learningOn, ...t }))

export const skillTools = gated([
  {
    name: 'skill_search',
    description: 'מחפש בלקחים שלמדת קודם ("איך עושים X"). ריק = הלקחים האחרונים.',
    parameters: obj({ query: str('מה מחפשים') }, []),
    run({ query }) {
      const found = searchSkills(query || '')
      return found.length ? found.map((k) => `#${k.id} ${k.title}\nמתי: ${k.when}\n${k.steps}`).join('\n\n') : 'אין לקח מתאים'
    },
  },
  {
    name: 'skill_propose',
    description: 'כותב לקח חדש אחרי שלמדת לעשות משהו: מתי הוא רלוונטי והצעדים שבאמת עבדו. נשמר רק אחרי אישור המשתמש.',
    parameters: obj({
      title: str('כותרת קצרה, למשל "לשלוח קובץ מהמחשב לטלוויזיה"'),
      when: str('מתי הלקח רלוונטי, משפט אחד'),
      steps: str('הצעדים שעבדו, מסודרים. רק מה שניסית או שקראת במקור אמין'),
      sources: { type: 'array', items: { type: 'string' }, description: 'כתובות של המקורות' },
    }, ['title', 'when', 'steps']),
    run(args) {
      const r = proposeSkill(args)
      if (r.status === 'known') return `כבר יש לקח כזה (#${r.id})`
      if (r.status === 'queued') return `כבר הצעתי לקח כזה (#${r.id}), הוא ממתין לאישור`
      return `הלקח הוצע (#${r.id})${r.replaces ? ` במקום לקח קודם (#${r.replaces})` : ''} וממתין לאישור המשתמש. אמור לו בשורה אחת מה למדת.`
    },
  },
  {
    name: 'skill_gap',
    description: 'רושם בקשה שלא הצלחת לבצע ולא ידעת איך, כדי ללמוד אותה בלילה.',
    parameters: obj({ request: str('מה ביקשו, במשפט אחד'), why: str('למה לא הצלחת') }, ['request']),
    run({ request, why }) {
      return noteGap(request, why) ? 'נרשם. אלמד את זה בלילה.' : 'כבר רשום, או שהבקשה לא מתאימה'
    },
  },
  {
    name: 'skill_confirm',
    description: "שומר לקחים ממתינים (ids, או כולם). המשתמש מאשר בצ'אט לפני השמירה.",
    parameters: idsParam,
    risk: 'write',
    onAsk() {
      state.skillsAskedAt = Date.now()
    },
    describe(args) {
      const want = ids(args)
      const list = pendingSkills().filter((c) => !want.length || want.includes(c.id))
      return list.length ? `לשמור ${list.length === 1 ? 'לקח' : 'לקחים'}?\n${list.map((c) => `• ${c.title}: ${c.steps.slice(0, 160)}${c.steps.length > 160 ? '…' : ''}`).join('\n')}` : 'אין לקחים ממתינים'
    },
    run(args) {
      const done = confirmSkills(ids(args))
      return done.length ? done.map((d) => `${d.status === 'updated' ? 'עודכן' : 'נשמר'}: ${d.title}`).join('\n') : 'אין לקחים ממתינים'
    },
  },
  {
    name: 'skill_reject',
    description: 'מוחק לקחים ממתינים שהמשתמש לא רוצה (ids, או כולם).',
    parameters: idsParam,
    run(args) {
      const n = rejectSkills(ids(args))
      return n ? `נמחקו ${n} לקחים ממתינים` : 'אין לקחים ממתינים'
    },
  },
  {
    name: 'skill_forget',
    description: 'מוחק לקח שמור לפי מזהה.',
    parameters: obj({ id: { type: 'number' } }),
    run({ id }) {
      return removeSkill(id) ? 'נמחק' : 'לא נמצא'
    },
  },
])

// ── tools it writes for itself ───────────────────────────────────────────────

// The module, written by Claude Code when it is connected, otherwise by Gemini. Never by the main chat model.
async function writeModule(goal, feedback, { signal, setStep }) {
  const task = `${WRITER_BRIEF}${goal}${feedback ? `\n\nYour previous attempt was rejected for these reasons. Fix all of them:\n${feedback}` : ''}`
  const backend = learnerBackend()
  if (!backend) throw new Error(NO_LEARNER)
  if (backend === 'claude') {
    setStep('Claude Code כותב את הכלי')
    const done = await runClaudeCode(`${task}\n\nWrite the file as tool.mjs in the current folder, and reply with one line.`, { project: `tool-${projectSlug(goal)}`, signal, setStep })
    const file = path.join(done.dir, 'tool.mjs')
    if (!fs.existsSync(file)) throw new Error('Claude Code לא יצר את הקובץ')
    return fs.readFileSync(file, 'utf8')
  }
  setStep('Gemini כותב את הכלי')
  return extractModule(await askGemini(task, { maxChars: 30000 }))
}

export const builderTools = gated([
  {
    name: 'learn_how',
    description: 'כשמבקשים ממך משהו שאתה לא יודע איך לעשות: לומד את זה ב-Claude Code או ב-Gemini (לא במודל הראשי), ברקע, וכותב לקח שממתין לאישור המשתמש.',
    parameters: obj({ topic: str('מה צריך ללמוד, במשפט או שניים, עם הקשר מהבקשה'), why: str('למה לא הצלחת קודם, אם ניסית') }, ['topic']),
    async run({ topic, why }, ctx) {
      if (!learnerBackend()) return NO_LEARNER
      if (!ctx?.background) return 'אי אפשר ללמוד מכאן. זה עובד רק בשיחה.'
      const job = ctx.background(`לומד: ${String(topic).slice(0, 40)}`, topic, async (signal, setStep) => {
        const lesson = await research(topic, { why, signal, setStep })
        const r = proposeSkill(lesson)
        return r.status === 'known' ? `כבר ידעתי את זה (לקח #${r.id}). תבקש שוב ואעשה.` : `למדתי: ${lesson.title}. הלקח ממתין לאישור שלך (#${r.id}). תבקש שוב ואעשה.`
      })
      return `"${job.title}" רץ ברקע ב-${learnerBackend() === 'claude' ? 'Claude Code' : 'Gemini'}. אמור למשתמש בשורה אחת שאתה לומד את זה ושתחזור אליו כשתדע. אל תחקור בעצמך.`
    },
  },
  {
    name: 'build_tool',
    description: 'כותב לעצמך כלי חדש בקוד כשאין כלי שמכסה את מה שביקשו (המרה, חישוב, פענוח, עיצוב). רץ ברקע. הכלי נבדק ומותקן רק באישור המשתמש.',
    parameters: obj({ goal: str('מה הכלי צריך לעשות, עם דוגמה לקלט ולפלט. כמה שיותר מדויק') }),
    async run({ goal }, ctx) {
      if (!learnerBackend()) return NO_LEARNER
      if (!ctx?.background) return 'אי אפשר לבנות כלי מכאן. זה עובד רק בשיחה.'
      const title = `כלי חדש: ${String(goal).slice(0, 40)}`
      const job = ctx.background(title, goal, async (signal, setStep) => {
        let feedback = ''
        let last = []
        for (let attempt = 1; attempt <= 2; attempt++) {
          const source = await writeModule(goal, feedback, { signal, setStep })
          setStep('בודק את הכלי בבידוד')
          const r = await proposeModule(source, { title: goal, request: goal })
          if (r.ok) {
            const names = r.info.tools.map((t) => t.name).join(', ')
            return `הכנתי ${r.info.tools.length === 1 ? 'כלי' : 'כלים'}: ${names}. ${r.info.tests} בדיקות עברו${r.info.network ? ', והוא פונה לאינטרנט' : ''}. ממתין לאישור שלך להתקנה (#${r.id}).`
          }
          last = r.problems
          feedback = r.problems.join('\n')
        }
        return `לא הצלחתי לבנות את הכלי. הבעיות: ${last.slice(0, 3).join('; ')}`
      })
      return `"${job.title}" רץ ברקע. אמור למשתמש בשורה אחת שהתחלתי לבנות לעצמי כלי, ושאבקש אישור להתקנה כשיהיה מוכן.`
    },
  },
  {
    name: 'tool_pending',
    description: 'כלים שכתבת לעצמך וממתינים לאישור התקנה.',
    parameters: obj({}, []),
    run() {
      const list = pendingTools()
      return list.length ? list.map((p) => `#${p.id} ${p.title}: ${p.info.tools.map((t) => t.name).join(', ')}`).join('\n') : 'אין כלים ממתינים'
    },
  },
  {
    name: 'tool_install',
    description: "מתקין כלי שכתבת לעצמך (id). המשתמש מאשר בצ'אט, ורואה מה הכלי עושה ואם הוא פונה לאינטרנט.",
    parameters: obj({ id: { type: 'number' } }),
    risk: 'write',
    onAsk() {
      state.toolsAskedAt = Date.now()
    },
    describe({ id }) {
      const p = pendingTools().find((x) => x.id === Number(id))
      return p ? describeProposal(p) : 'אין הצעה כזאת'
    },
    run({ id }) {
      const names = installProposal(Number(id))
      return `הותקן: ${names.join(', ')}. אפשר להשתמש בו עכשיו (tool_search מוצא אותו).`
    },
  },
  {
    name: 'tool_reject',
    description: 'מוחק כלים ממתינים שהמשתמש לא רוצה (ids, או כולם).',
    parameters: idsParam,
    run(args) {
      const n = rejectModules(ids(args))
      return n ? `נמחקו ${n} כלים ממתינים` : 'אין כלים ממתינים'
    },
  },
  {
    name: 'tool_learned',
    description: 'הכלים שהתקנת לעצמך בעבר.',
    parameters: obj({}, []),
    run() {
      const list = listUserTools()
      return list.length ? list.map((m) => `${m.tools.join(', ')}: ${m.title}${m.network ? ' (פונה לאינטרנט)' : ''}`).join('\n') : 'עוד לא התקנתי כלים לעצמי'
    },
  },
  {
    name: 'tool_remove',
    description: 'מסיר כלי שהתקנת לעצמך, לפי שמו.',
    parameters: obj({ name: str('שם הכלי') }),
    run({ name }) {
      const removed = removeUserTool(String(name))
      return removed ? `הוסר: ${removed.join(', ')}` : 'אין כלי כזה בין אלה שהתקנתי'
    },
  },
])

// The learning part of the system prompt for this message: lessons that fit it, and what is waiting for approval.
export function learningBlock(query = '', opts = {}) {
  if (!config.learning) return ''
  const lines = [skillsBlock(query, opts)]
  const waiting = pendingTools()
  if (waiting.length && (opts.now ?? Date.now()) - (state.toolsAskedAt || 0) > ASK_EVERY_MS) {
    lines.push(
      opts.english
        ? `Tools you wrote that wait for his approval: ${waiting.map((p) => `#${p.id} ${p.title}`).join('; ')}. When he says yes, or at a natural moment, call tool_install once; the system asks him.`
        : `כלים שכתבת לעצמך וממתינים לאישור שלו: ${waiting.map((p) => `#${p.id} ${p.title}`).join('; ')}. כשהוא אומר כן, או ברגע טבעי, קרא פעם אחת ל-tool_install; המערכת מבקשת ממנו אישור.`
    )
  }
  return lines.filter(Boolean).join('\n\n')
}
