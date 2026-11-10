// The agent layer: Helper works toward a goal instead of answering one message at a time.
// For a request that takes several stages the model first writes a plan (update_plan: the goal, the steps, and
// what "done" looks like), works through it with its tools, keeps the plan current as steps finish or get stuck,
// and before it answers it checks the result against "done". The answer is the practical outcome: what was done,
// what was found, links, and what is still open. A plan left open (out of steps, waiting for him) is kept for a
// day, so "תמשיך" picks it up where it stopped.
import { config } from './config.js'
import { state, save } from './store.js'

export const STATUSES = ['pending', 'doing', 'done', 'skipped', 'blocked']
const MARK = { pending: '○', doing: '▶', done: '✓', skipped: '–', blocked: '✗' }
const MAX_STEPS_IN_PLAN = 10
// An open plan from an earlier message is offered back for this long.
export const PLAN_TTL = 24 * 3600000

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// Hebrew and English verbs of doing. Hebrew has no \b in JS regexes, so a word starts after a space or punctuation.
const DO_VERBS = /(^|[\s,.;:!?"'(])[וש]?(תעשה|תכין|תמצא|תבדוק|תשווה|תארגן|תתכנן|תסדר|תזמין|תקבע|תבנה|תכתוב|תחקור|תאסוף|תשלח|תסכם|תעבור|תוריד|תתקין|תרשום|תפתור|תעזור|תטפל|תביא|תחפש|תכנן|לתכנן|למצוא|לבדוק|להשוות|לארגן|לסדר|plan|research|compare|organi[sz]e|find|prepare|book|build|check|collect|summari[sz]e)(?=$|[\s,.;:!?"')])/gi
const SEQUENCE = /(ואחר כך|ואז|אחרי זה|בסוף|קודם כל|שלב|צעד|step|then|after that|and finally)/i

// A cheap guess, no model call: does this message read like a goal with several stages rather than a question?
// It only sharpens the hint in the prompt; the model still decides whether a plan is worth it.
export function looksLikeGoal(text) {
  const t = String(text || '')
  if (t.length < 12) return false
  const verbs = (t.match(DO_VERBS) || []).length
  if (verbs >= 2) return true
  if (verbs >= 1 && (SEQUENCE.test(t) || t.includes(',') || t.length >= 50)) return true
  return SEQUENCE.test(t) && t.length >= 40
}

export function normalizePlan(args, previous) {
  const goal = clip(args?.goal, 200) || previous?.goal || ''
  const doneWhen = clip(args?.done_when, 240) || previous?.done_when || ''
  const raw = Array.isArray(args?.steps) ? args.steps : []
  const steps = raw
    .map((s) => (typeof s === 'string' ? { text: s } : s || {}))
    .map((s) => ({ text: clip(s.text, 160), status: STATUSES.includes(s.status) ? s.status : 'pending', ...(s.note ? { note: clip(s.note, 200) } : {}) }))
    .filter((s) => s.text)
    .slice(0, MAX_STEPS_IN_PLAN)
  return { goal, done_when: doneWhen, steps, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() }
}

export const openSteps = (plan) => (plan?.steps || []).filter((s) => s.status === 'pending' || s.status === 'doing')
export const blockedSteps = (plan) => (plan?.steps || []).filter((s) => s.status === 'blocked')
// Finished = nothing is left that could still happen: every step is done or skipped. A blocked step is waiting on
// something (a date from him, a login, an answer from someone), so its plan is kept and offered back.
export const isFinished = (plan) => !!plan?.steps?.length && plan.steps.every((s) => s.status === 'done' || s.status === 'skipped')
const doneCount = (plan) => plan.steps.filter((s) => s.status === 'done').length

export function planText(plan) {
  if (!plan?.steps?.length) return ''
  const lines = plan.steps.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}${s.note ? ` (${s.note})` : ''}`)
  return `${plan.goal ? `Goal: ${plan.goal}\n` : ''}${lines.join('\n')}${plan.done_when ? `\nDone when: ${plan.done_when}` : ''}`
}

// What the user sees when a plan is first made: the goal and the steps, nothing else.
export function planCard(plan) {
  return `📋 *${plan.goal || 'התוכנית'}*\n${plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`
}

// One line for "מה רץ": how far a background task has got.
export const progressLine = (plan) => {
  const current = plan.steps.find((s) => s.status === 'doing') || openSteps(plan)[0]
  return `${doneCount(plan)}/${plan.steps.length}${current ? ` · ${current.text}` : ''}`
}

// Shown to the user once, when a plan with this many steps is made in a live chat.
const SHOW_FROM = 3
const showsPlan = (ctx) => config.agent?.showPlan !== false && typeof ctx?.say === 'function' && !['job', 'task'].includes(ctx?.source)

export const planTool = {
  name: 'update_plan',
  description:
    'תוכנית עבודה למטרה של כמה שלבים: המטרה, השלבים (כל אחד עם status: pending, doing, done, skipped, blocked) ומתי זה נחשב גמור (done_when). קרא לזה פעם אחת לפני שאתה מתחיל לפעול, ושוב כששלב מסתיים, נתקע או משתנה, עם כל הרשימה בכל פעם. לא לשאלה פשוטה שעונים עליה בכלי אחד או שניים.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'המטרה במשפט אחד, כמו שהמשתמש היה אומר אותה' },
      done_when: { type: 'string', description: 'איך תדע שהמטרה הושגה: התוצאה המעשית שהמשתמש מקבל' },
      steps: {
        type: 'array',
        description: '2-8 שלבים קונקרטיים, כל אחד פעולה אחת',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
            note: { type: 'string', description: 'מה יצא, או למה נתקע' },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['goal', 'steps'],
  },
  run(args, ctx) {
    if (!ctx) return 'אין הקשר לתוכנית'
    // Shown once per goal: a plan picked up from an earlier message was already shown then.
    // A plan for another goal while one is still open (he said "wait, first do X"): the open one is set aside,
    // not overwritten, so "back to the first one" finds where it stopped. One slot, same lifetime as a plan.
    const other = isOtherGoal(ctx.plan, args)
    const first = !ctx.plan || other
    const plan = normalizePlan(args, other ? undefined : ctx.plan)
    if (!plan.steps.length) return 'תוכנית ריקה: צריך לפחות שלב אחד'
    if (other) {
      const { resumed, ...aside } = ctx.plan
      void resumed
      state.planAside = aside
    } else if (state.planAside && !isOtherGoal(state.planAside, args)) delete state.planAside
    ctx.plan = plan
    ctx.planTouched = true
    ctx.setStep?.(progressLine(plan))
    if (first && plan.steps.length >= SHOW_FROM && showsPlan(ctx) && !ctx.planShown) {
      ctx.planShown = true
      Promise.resolve(ctx.say(planCard(plan))).catch((e) => console.log(`[plan] ${e.message}`))
    }
    const open = openSteps(plan)
    const waiting = blockedSteps(plan)
    if (!open.length && waiting.length) return `אין שלב שאפשר לבצע עכשיו, ו-${waiting.length} חסומים: ${waiting.map((s) => `${s.text}${s.note ? ` (${s.note})` : ''}`).join('; ')}. המטרה לא הושלמה. אמור למשתמש מה כבר יש ומה בדיוק חסר כדי להמשיך, בלי להציג את זה כגמור. התוכנית נשמרת, וכשהחסר יגיע ממשיכים ממנה.`
    if (!open.length) return `כל השלבים סגורים. עכשיו בדוק את התוצאה מול "${plan.done_when || plan.goal}" וענה למשתמש עם התוצאה המעשית.`
    return `התוכנית נשמרה (${doneCount(plan)}/${plan.steps.length}). השלב הבא: ${open[0].text}. בצע אותו עם הכלים, בלי לספר למשתמש על כל שלב.`
  },
}

// Is this update_plan call about a different goal than `plan`, which still has work in it? Only when both the goal
// and every step are new: the same goal reworded keeps at least a step, and a plan that grew keeps its goal.
function isOtherGoal(plan, args) {
  if (!plan?.steps?.length || isFinished(plan)) return false
  const goal = clip(args?.goal, 200)
  if (!goal || goal === plan.goal) return false
  const had = new Set(plan.steps.map((s) => s.text))
  const steps = (Array.isArray(args?.steps) ? args.steps : []).map((s) => clip(typeof s === 'string' ? s : s?.text, 160)).filter(Boolean)
  return steps.length > 0 && !steps.some((t) => had.has(t))
}

// The plan set aside for another goal, while it is still worth offering back.
function asidePlan() {
  const p = state.planAside
  if (!p?.steps?.length) return null
  if (Date.now() - (p.updatedAt || 0) > PLAN_TTL || isFinished(p)) {
    delete state.planAside
    return null
  }
  return p
}

// The standing rules, in the prompt on every turn.
export function agentRules(english) {
  return english
    ? `Agent mode: a goal that takes several stages (find + compare + act, research then a summary, organize several things) starts with update_plan: goal, 2-8 concrete steps, done_when = the practical result he gets. Then work the steps with your tools, read real data rather than guess, and call update_plan again as steps finish (done), get stuck (blocked, with a note) or change. A plain question needs no plan. Before answering, check the result against done_when. The answer is the outcome, not the process: what you did, what you found (numbers, links), what is still open and the one next step if any.`
    : `מצב סוכן: מטרה שדורשת כמה שלבים (למצוא + להשוות + לבצע, לחקור ואז לסכם, לסדר כמה דברים) מתחילה ב-update_plan: המטרה, 2-8 שלבים קונקרטיים, ו-done_when = התוצאה המעשית שהמשתמש מקבל. אחר כך עבוד על השלבים עם הכלים, קרא נתונים אמיתיים במקום לנחש, וקרא שוב ל-update_plan כששלב מסתיים (done), נתקע (blocked, עם הערה) או משתנה. שאלה פשוטה לא צריכה תוכנית. לפני שאתה עונה, בדוק את התוצאה מול done_when. התשובה היא התוצאה ולא התהליך: מה עשית, מה מצאת (מספרים, קישורים), מה עוד פתוח, וצעד הבא אחד אם יש.`
}

// The part of the prompt that changes during a turn: the hint for this message and the plan as it stands.
export function planBlock(ctx, english, goalHint) {
  const parts = []
  if (ctx?.plan?.steps?.length) {
    const head = ctx.plan.resumed
      ? english
        ? 'An open plan from earlier (if he asks to continue, carry on from the first open step; a blocked step ✗ waits on what its note says, so if this message brings it, set the step back to doing and go on; if he is on something else, leave it; if he calls it off, mark the open and blocked steps skipped):'
        : 'תוכנית פתוחה מקודם (אם הוא מבקש להמשיך, המשך מהשלב הפתוח הראשון; שלב חסום ✗ מחכה למה שכתוב בהערה שלו, אז אם ההודעה הזאת מביאה את זה, החזר אותו ל-doing והמשך; אם הוא מדבר על משהו אחר, עזוב אותה; אם הוא מבטל אותה, סמן את השלבים הפתוחים והחסומים skipped):'
      : english
        ? 'Your plan for this goal:'
        : 'התוכנית שלך למטרה הזאת:'
    parts.push(`${head}\n${planText(ctx.plan)}`)
  }
  const aside = asidePlan()
  if (aside && aside.goal !== ctx?.plan?.goal) {
    parts.push(
      `${english ? 'Set aside earlier for another goal, not finished (if he goes back to it, call update_plan with this goal and these steps and carry on from where it stopped; never report it as done):' : 'הונחה בצד מקודם לטובת מטרה אחרת, ולא הושלמה (אם הוא חוזר אליה, קרא ל-update_plan עם המטרה והשלבים האלה והמשך מאיפה שנעצרה; אל תציג אותה כגמורה):'}\n${planText(aside)}`
    )
  }
  if (!ctx?.plan?.steps?.length && goalHint) {
    // The guess is made from verbs alone, so it is offered, not ordered: telling about a hard day uses the same verbs.
    parts.push(
      english
        ? 'This message reads like a goal with several stages: if he is asking you to do it, start with update_plan. If he is only telling you about it, no plan.'
        : 'ההודעה הזאת נראית כמו מטרה של כמה שלבים: אם הוא מבקש שתבצע אותה, התחל ב-update_plan. אם הוא רק מספר על זה, בלי תוכנית.'
    )
  }
  return parts.join('\n\n')
}

// Said to the model, once per turn, when it is about to answer with a plan in hand. Not shown to the user and
// removed from the history afterwards.
export function verifyPrompt(plan, english) {
  const open = openSteps(plan)
  const openList = open.map((s) => `- ${s.text}`).join('\n')
  const waiting = blockedSteps(plan).length
  if (english) {
    return `[Self-check before you answer. Not from the user.]\n${planText(plan)}\n\n${open.length ? `Steps still open:\n${openList}\nIf you can still do them with your tools, do them now. If not, mark them blocked or skipped with the reason.\n` : ''}Check the result against "${plan.done_when || plan.goal}". Then write the final answer to the user: the outcome (what was done, what you found, numbers and links), what is still open and why, and one next step if there is one.${waiting ? ' A blocked step is not done: say what it waits for, and do not call the goal finished.' : ''} Do not mention this check.`
  }
  return `[בדיקה עצמית לפני שאתה עונה. לא מהמשתמש.]\n${planText(plan)}\n\n${open.length ? `שלבים שעוד פתוחים:\n${openList}\nאם אתה עדיין יכול לבצע אותם עם הכלים, בצע עכשיו. אם לא, סמן אותם blocked או skipped עם הסיבה.\n` : ''}בדוק את התוצאה מול "${plan.done_when || plan.goal}". ואז כתוב למשתמש את התשובה הסופית: התוצאה (מה בוצע, מה מצאת, מספרים וקישורים), מה עוד פתוח ולמה, וצעד הבא אחד אם יש.${waiting ? ' שלב חסום הוא לא גמור: אמור למה הוא מחכה, ואל תציג את המטרה כהושלמה.' : ''} אל תזכיר את הבדיקה הזאת.`
}

// Whether the model should be stopped for that check: always when steps are open; when everything is closed,
// only in full mode (light mode is on a small per-minute budget, and a closed plan is usually a finished one).
export function needsVerify(ctx) {
  if (!ctx?.planTouched || ctx.verified || !ctx.plan?.steps?.length) return false
  if (openSteps(ctx.plan).length) return true
  return !config.llm.light && !!ctx.plan.done_when
}

// ── kept between messages ──────────────────────────────────────────────────
export function savedPlan() {
  let p = state.plan
  if (p?.steps?.length && (Date.now() - (p.updatedAt || 0) > PLAN_TTL || isFinished(p))) {
    delete state.plan
    p = null
  }
  // Nothing current: the plan that was set aside for it comes back as the open one.
  if (!p?.steps?.length) {
    p = asidePlan()
    if (!p) return null
    state.plan = p
    delete state.planAside
  }
  return { ...p, steps: p.steps.map((s) => ({ ...s })), resumed: true }
}

export function keepPlan(plan) {
  if (plan?.steps?.length && !isFinished(plan)) {
    const { resumed, ...rest } = plan
    void resumed
    state.plan = rest
  } else delete state.plan
  save()
}

export function clearPlan() {
  delete state.plan
  delete state.planAside
}
