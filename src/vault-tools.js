// The tools for Helper's credential vault (src/vault.js). None of them takes or returns a secret: a password goes in
// only on the secure page, and comes out only into the login form of the site it was saved for.
import * as vault from './vault.js'
import { fillLogin, locateLogin, pageOrigin } from './vault-fill.js'
import { boundMutation, outcome } from './bound-actions.js'
import { str, obj } from './tool-helpers.js'

const OFF = 'הכספת כבויה. כדי להפעיל, הבעלים צריך לבחור בזה בעצמו (CREDENTIAL_VAULT=on בקובץ ההגדרות). עד אז אין שמירה של סיסמאות, וסיסמה אף פעם לא נכתבת בצ\'אט.'
const NO_FILL = 'מילוי אוטומטי כבוי. הוא דורש בחירה נפרדת של הבעלים (CREDENTIAL_AUTOFILL=on). עד אז הוא מתחבר בעצמו.'

function linkFor(id) {
  const listed = (process.env.VAULT_INPUT_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)[0]
  const base = listed ? `https://${listed}` : vault.vaultInputBase()
  if (!base) throw Object.assign(new Error('אתר ההגדרות לא פועל, אז אין דף להזנה.'), { code: 'setup_needed' })
  return `${base}/vault/r/${id}`
}

// The link goes straight to the owner's chat, not to the model.
async function sendLink(ctx, kind, opts) {
  if (!ctx?.say) return outcome('refused', 'אין לאן לשלוח קישור מאובטח מהשיחה הזאת.')
  const r = vault.createRequest(kind, opts)
  const what = { setup: 'ליצירת הכספת', unlock: 'לפתיחת הכספת', store: `לשמירת פרטי התחברות ל-${r.origin}` }[kind]
  await ctx.say(`🔐 קישור ${what} (תקף ${r.expiresInMin} דקות, פעם אחת): ${linkFor(r.id)}\nהוא נפתח רק במחשב שעליו אני רץ, אחרי כניסה לאתר ההגדרות. לא לשלוח סיסמאות כאן בצ'אט.`)
  return outcome('done', `נשלח לבעלים קישור מאובטח ${what}. הסוד לא עובר דרכך; אל תבקש שישלח אותו בצ'אט.`)
}

export const vaultTools = [
  {
    name: 'credential_status',
    description: 'מצב הכספת של Helper: פעילה, נעולה, ואילו אתרים שמורים (מזהה, אתר, שם). אף פעם לא סיסמאות.',
    parameters: obj({}, []),
    run() {
      if (!vault.vaultEnabled()) return outcome('setup_needed', OFF)
      const s = vault.status()
      return outcome('done', JSON.stringify({ created: s.created, unlocked: s.unlocked, autofill: s.autofill, entries: s.entries }))
    },
  },
  {
    name: 'credential_add',
    description: 'כשהמשתמש רוצה ש-Helper יזכור התחברות לאתר: שולח לו קישור מאובטח להזנה בדף מקומי. אל תבקש סיסמה בצ\'אט ואל תקבל אותה משם.',
    parameters: obj({ site: str('כתובת האתר המלאה, https://...'), label: str('שם קצר, למשל "חשבון החשמל"') }, ['site']),
    async run({ site, label }, ctx) {
      if (!vault.vaultEnabled()) return outcome('setup_needed', OFF)
      try {
        const origin = vault.originOf(site)
        if (!vault.status().created) return sendLink(ctx, 'setup', {})
        return sendLink(ctx, 'store', { origin, label })
      } catch (e) {
        return outcome(e.code === 'setup_needed' ? 'setup_needed' : 'refused', e.message)
      }
    },
  },
  {
    name: 'credential_unlock',
    enabled: vault.vaultEnabled,
    description: 'שולח לבעלים קישור מאובטח לפתיחת הכספת (הסיסמה שלה מוזנת בדף מקומי, לא בצ\'אט).',
    parameters: obj({}, []),
    async run(_, ctx) {
      if (!vault.vaultEnabled()) return outcome('setup_needed', OFF)
      if (!vault.status().created) return outcome('setup_needed', 'אין עדיין כספת. credential_add שולח קישור ליצירה.')
      try {
        return await sendLink(ctx, 'unlock', {})
      } catch (e) {
        return outcome('setup_needed', e.message)
      }
    },
  },
  {
    name: 'credential_lock',
    enabled: vault.vaultEnabled,
    description: 'נועל את הכספת מיד.',
    parameters: obj({}, []),
    run() {
      vault.lock()
      return outcome('done', 'הכספת נעולה.')
    },
  },
  {
    name: 'credential_fill',
    enabled: vault.vaultEnabled,
    description: 'ממלא התחברות שמורה (entry_id מ-credential_status) בדף ההתחברות הפתוח בדפדפן הסידורים, רק אם הדף הוא בדיוק האתר שהיא נשמרה לו. המשתמש מאשר. הסיסמה לא חוזרת אליך.',
    parameters: obj({ entry_id: str('מזהה הרשומה') }),
    async run({ entry_id }, ctx) {
      if (!vault.vaultEnabled()) return outcome('setup_needed', OFF)
      if (!vault.autofillEnabled()) return outcome('setup_needed', NO_FILL)
      const tab = ctx?.browserTab || (await import('./errand-browser.js')).withLocalErrandTab
      return boundMutation(ctx, {
        tool: 'credential_fill',
        account: 'local',
        repeatable: true,
        async prepare() {
          const s = vault.status()
          const entry = s.entries.find((e) => e.id === entry_id)
          if (!entry) throw new Error(`אין רשומה ${entry_id}.`)
          if (!s.unlocked) throw Object.assign(new Error('הכספת נעולה. credential_unlock שולח קישור לפתיחה.'), { code: 'setup_needed' })
          const at = await tab((call) => pageOrigin(call))
          if (at !== entry.origin) throw new Error(`הדף הפתוח הוא ${at}, והרשומה שמורה ל-${entry.origin}. לא ממלא באתר אחר.`)
          // The form is located before asking, so a page that will be refused is not asked about.
          await tab((call) => locateLogin(call, entry.origin))
          return { op: { id: entry.id, origin: entry.origin }, fingerprint: { at }, question: `למלא את פרטי ההתחברות "${entry.label}" באתר ${entry.origin} שפתוח עכשיו בדפדפן?` }
        },
        recheck: async () => ({ at: await tab((call) => pageOrigin(call)) }),
        async execute(op) {
          let done
          try {
            done = await vault.withSecret(op.id, op.origin, (secret) => tab((call) => fillLogin(call, secret)))
          } catch (e) {
            // A refusal from the page check is a definite "not filled", so it is not left as unknown.
            throw Object.assign(new Error(e.message), { status: 409 })
          }
          return { confirmed: done.filled === true, ref: op.origin, text: `מולא ב-${op.origin}${done.user ? ' (שם משתמש וסיסמה)' : ' (סיסמה בלבד; לא נמצא שדה שם משתמש)'}. עוד לא נלחץ "התחבר". מעכשיו ועד הפעלה מחדש של העוזר לא נשלחות תמונות של הדפדפן או של המסך במחשב הזה, כי דף יכול להציג את הסיסמה גם מחוץ לשדה.` }
        },
      })
    },
  },
  {
    name: 'credential_delete',
    enabled: vault.vaultEnabled,
    description: 'מוחק התחברות שמורה מהכספת (entry_id). המשתמש מאשר.',
    parameters: obj({ entry_id: str('מזהה הרשומה') }),
    async run({ entry_id }, ctx) {
      if (!vault.vaultEnabled()) return outcome('setup_needed', OFF)
      return boundMutation(ctx, {
        tool: 'credential_delete',
        account: 'local',
        async prepare() {
          const entry = vault.status().entries.find((e) => e.id === entry_id)
          if (!entry) throw new Error(`אין רשומה ${entry_id}.`)
          return { op: { id: entry.id }, question: `למחוק מהכספת את "${entry.label}" (${entry.origin})?` }
        },
        async execute(op) {
          vault.deleteEntry(op.id)
          return { confirmed: !vault.status().entries.some((e) => e.id === op.id), ref: op.id, text: 'נמחק מהכספת.' }
        },
      })
    },
  },
]
