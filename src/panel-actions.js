// The remote panel's action catalog: every device action the panel can ever offer, as data. One source of truth:
// DEVICE_ACTIONS and the device:<id> scopes in src/panel-scopes.js are derived from it.
//
// Each action has a closed parameter schema. A field that is not in the schema is refused, a value outside its enum
// is refused, and no field is ever passed on as a command or as free text. Adding an action means an entry here,
// its scope, and its tests, nothing less.
//
// There are no handlers yet: nothing in this file can switch a device. They come with execute (stage 3), and will
// call the existing functions (controlHomeDevice, tvPowerOff) with checked values only.
//
// risk 'high' (money, sending as the owner, deleting, buying, changing settings) is never offered by the panel.
// Approvals stay on WhatsApp.

// The rooms the lights can be asked for. 'all' is a choice of its own: a request without a room is refused, it is
// never read as "all the lights".
export const LIGHT_ROOMS = Object.freeze(['all', 'סלון', 'מטבח', 'חדר שינה', 'חדר ילדים', 'החדר שלי', 'מרפסת', 'כניסה', 'מסדרון', 'שירותים', 'אמבטיה', 'לאונג'])

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v)
  return Object.freeze(o)
}

const roomParams = { room: { type: 'string', enum: LIGHT_ROOMS, required: true, label: 'חדר' } }

export const ACTION_CATALOG = deepFreeze([
  { id: 'lights:on', label: 'אורות: הדלקה', device: 'lights', kind: 'write', risk: 'low', params: roomParams },
  { id: 'lights:off', label: 'אורות: כיבוי', device: 'lights', kind: 'write', risk: 'low', params: roomParams },
  { id: 'tv:off', label: 'טלוויזיה: כיבוי', device: 'tv', kind: 'write', risk: 'low', params: {} },
])

// Only what the panel may show: never a high-risk action.
export const PANEL_ACTIONS = Object.freeze(ACTION_CATALOG.filter((a) => a.risk !== 'high'))

export const findAction = (id) => PANEL_ACTIONS.find((a) => a.id === String(id)) || null

const MAX_STRING = 80

// -> { ok: true, params } with only the schema's fields, or { ok: false, error }. Nothing here runs anything.
export function checkParams(actionId, params) {
  const action = findAction(actionId)
  if (!action) return { ok: false, error: 'פעולה לא בקטלוג' }
  if (params === undefined || params === null) params = {}
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params חייב להיות אובייקט' }
  const schema = action.params
  for (const k of Object.keys(params)) if (!Object.hasOwn(schema, k)) return { ok: false, error: `שדה לא מוכר: ${String(k).slice(0, 40)}` }
  const out = {}
  for (const [k, rule] of Object.entries(schema)) {
    const v = params[k]
    if (v === undefined) {
      if (rule.required) return { ok: false, error: `חסר שדה: ${k}` }
      continue
    }
    if (rule.type === 'string') {
      if (typeof v !== 'string' || v.length > (rule.maxLength || MAX_STRING)) return { ok: false, error: `ערך לא תקין: ${k}` }
      if (rule.enum && !rule.enum.includes(v)) return { ok: false, error: `ערך לא ברשימה: ${k}` }
    } else {
      return { ok: false, error: `ערך לא תקין: ${k}` }
    }
    out[k] = v
  }
  return { ok: true, params: out }
}

// The schema as a client sees it in GET /panel/api/catalog.
export const publicSchema = (action) =>
  Object.fromEntries(Object.entries(action.params).map(([k, r]) => [k, { type: r.type, required: Boolean(r.required), ...(r.enum ? { enum: [...r.enum] } : {}), ...(r.label ? { label: r.label } : {}) }]))
