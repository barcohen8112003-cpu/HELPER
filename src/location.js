// Where the user is: the last location he shared in WhatsApp (📍 or live location). Kept only in state.json on this
// computer and given to the model as a line in its instructions, so errands (delivery), weather and transit can use it.
import { state, save } from './store.js'

const FRESH_HOURS = 12
const STALE_DAYS = 7

// Coordinates -> { address, city }, from OpenStreetMap's public geocoder. Only the coordinates are sent.
export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=he&zoom=18`
  const res = await fetch(url, { headers: { 'User-Agent': 'Helper personal assistant (local)' }, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`geocoder ${res.status}`)
  const j = await res.json()
  const a = j.address || {}
  const city = a.city || a.town || a.village || a.municipality || ''
  const street = [a.road, a.house_number].filter(Boolean).join(' ')
  return { address: [street, a.suburb || a.neighbourhood, city].filter(Boolean).join(', ') || j.display_name || '', city }
}

// A location from WhatsApp: { lat, lng, name?, address?, live }. The place's own name and address, when the user
// shared a place, are kept as given; the geocoder only fills in what is missing. Returns the saved record.
export async function setLocation({ lat, lng, name = '', address = '', live = false }) {
  let found = { address: '', city: '' }
  if (!address) found = await reverseGeocode(lat, lng).catch(() => found)
  state.location = { lat, lng, address: [name, address || found.address].filter(Boolean).join(', '), city: found.city, live, at: Date.now() }
  save()
  return state.location
}

// A live location sends updates for as long as it is on. Only the first one is answered; the rest just update.
export const isLiveUpdate = (loc) => loc.live && state.location?.live && Date.now() - state.location.at < FRESH_HOURS * 3600000

// The line the model sees, or '' when there is none or it is older than a week.
export function locationLine(english = false) {
  const l = state.location
  if (!l || Date.now() - l.at > STALE_DAYS * 86400000) return ''
  const hours = Math.round((Date.now() - l.at) / 3600000)
  const place = `${l.address || '?'} (${l.lat.toFixed(5)}, ${l.lng.toFixed(5)})`
  if (english) return `User's last shared location: ${place}, ${hours < 1 ? 'just now' : `${hours}h ago`}${hours >= FRESH_HOURS ? ' - may be out of date, confirm before a delivery' : ''}. Use it for delivery, weather and transit only when he does not name a place; an address in his message always wins.`
  return `המיקום האחרון שהמשתמש שיתף: ${place}, ${hours < 1 ? 'עכשיו' : `לפני ${hours} שעות`}${hours >= FRESH_HOURS ? ' - ייתכן שכבר לא מעודכן, וודא לפני משלוח' : ''}. השתמש בו למשלוחים, מזג אוויר ותחבורה רק כשהוא לא נוקב במקום; כתובת שהוא כותב בהודעה תמיד גוברת.`
}
