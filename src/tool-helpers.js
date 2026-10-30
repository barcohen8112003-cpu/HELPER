// Shared by the tool lists (tools.js, google-tools.js, pc-tools.js): parameter schema helpers, which Google
// account a call uses, and the approval gate for the user's computer.
import { config } from './config.js'
import * as google from './google.js'
import * as pc from './pc.js'

export const str = (description) => ({ type: 'string', description })
export const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

// Read tools cover every connected Google account unless one is named; write tools default to the first (primary) one.
export const one = (account) => google.resolveAccounts(account)[0]
// For tools that change something. Read-only accounts (school) are refused here, in code, whatever the model was told.
export function writable(account) {
  const email = account ? one(account) : google.googleAccounts().find((a) => !config.google.readOnly.includes(a.toLowerCase()))
  if (!email) throw new Error('אין חשבון Google שמותר לכתוב בו')
  if (config.google.readOnly.includes(email.toLowerCase())) throw new Error(`החשבון ${email} מוגדר לקריאה בלבד. אפשר לנסח טיוטה והמשתמש ישלח בעצמו.`)
  return email
}
export const perAccount = async (account, fn) => (await Promise.all(google.resolveAccounts(account).map((a) => fn(a).catch((e) => [{ account: a, error: e.message }])))).flat()

export const ACCOUNT = str('כתובת חשבון Google מסוים; ריק = כל החשבונות בקריאה, החשבון הראשי בכתיבה')

export const computerEnabled = () => config.computerMode !== 'off' && pc.pcEnabled()

export async function approved(ctx, what) {
  if (config.computerMode === 'auto') return true
  return ctx.confirm(what)
}
