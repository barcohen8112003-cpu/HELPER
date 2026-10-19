// Shared helpers for toolkit modules. Keep this small: a module should read almost like a table of tools.
import dns from 'node:dns/promises'
import net from 'node:net'

export const str = (description) => ({ type: 'string', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
export const oneOf = (values, description) => ({ type: 'string', enum: values, description })
export const obj = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required })

// Tool results are plain text for the model. Keep them short and structured.
export const lines = (...parts) => parts.flat().filter((p) => p !== undefined && p !== null && p !== '').join('\n')
export const clip = (text, max = 1500) => (String(text).length > max ? `${String(text).slice(0, max)}…` : String(text))

export function need(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`חסר ${name}`)
  return value
}

export function toNumber(value, name = 'מספר') {
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim())
  if (!Number.isFinite(n)) throw new Error(`${name} לא תקין`)
  return n
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const v = ip.toLowerCase()
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:')
}

// Only public http/https addresses. A tool that fetches a URL the model (or a web page it read) chose must never be
// able to reach the user's router, the Helper UI on localhost, or cloud metadata endpoints.
export async function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('כתובת לא תקינה')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('רק כתובות http/https')
  if (url.username || url.password) throw new Error('כתובת עם סיסמה לא מותרת')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('כתובת פנימית אסורה')
  return url
}

// GET with a timeout and a size cap. Redirects are followed by hand so each hop is checked too.
export async function fetchText(raw, { timeoutMs = 10000, maxBytes = 400_000, headers = {} } = {}) {
  let url = raw
  for (let hop = 0; hop < 4; hop++) {
    const checked = await assertPublicUrl(url)
    const res = await fetch(checked, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Helper/1.0', ...headers } })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), checked).href
      continue
    }
    if (!res.ok) throw new Error(`השרת החזיר ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.subarray(0, maxBytes).toString('utf8')
  }
  throw new Error('יותר מדי הפניות')
}

// Persistent data for a toolkit module, kept in Helper's own state file under state.toolkit[name]. Modules that
// store nothing never import the store at all.
//   const list = await bucket('shopping', [])      // the same array every call; mutate it, then:
//   await persist()
export async function bucket(name, fallback) {
  const { state } = await import('../store.js')
  state.toolkit ??= {}
  state.toolkit[name] ??= fallback
  return state.toolkit[name]
}

export async function persist() {
  const { save } = await import('../store.js')
  save()
}

export async function nextId() {
  const { newId } = await import('../store.js')
  return newId()
}

export async function fetchJson(raw, options) {
  return JSON.parse(await fetchText(raw, options))
}
