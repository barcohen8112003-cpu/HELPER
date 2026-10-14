// Weather from Open-Meteo: free, no key, no sign-up. A place name is looked up once and its coordinates kept.
import { state, save } from './store.js'

const GEO = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  return res.json()
}

// "Tel Aviv", "חיפה" -> { name, lat, lon }. Cached in state, so the lookup happens once per place.
export async function locate(place) {
  const cache = (state.geo ??= {})
  if (cache[place]) return cache[place]
  const hit = (await getJson(`${GEO}?name=${encodeURIComponent(place)}&count=1&language=he`)).results?.[0]
  if (!hit) throw new Error(`לא מצאתי מקום בשם "${place}"`)
  cache[place] = { name: hit.name, lat: hit.latitude, lon: hit.longitude }
  save()
  return cache[place]
}

const hourKey = (d) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}

// Today and the next days, plus the hourly picture so the weather at a given event time can be read off.
export async function forecast(place, days = 2) {
  const at = await locate(place)
  const data = await getJson(
    `${FORECAST}?latitude=${at.lat}&longitude=${at.lon}&timezone=${encodeURIComponent(process.env.TZ)}&forecast_days=${Math.min(7, Math.max(1, days))}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&hourly=temperature_2m,precipitation_probability'
  )
  const daily = data.daily.time.map((date, i) => ({
    date,
    min: Math.round(data.daily.temperature_2m_min[i]),
    max: Math.round(data.daily.temperature_2m_max[i]),
    rainChance: data.daily.precipitation_probability_max[i],
    rainMm: data.daily.precipitation_sum[i],
  }))
  const hourly = new Map(data.hourly.time.map((t, i) => [t, { temp: Math.round(data.hourly.temperature_2m[i]), rainChance: data.hourly.precipitation_probability[i] }]))
  return { place: at.name, daily, at: (date) => hourly.get(hourKey(new Date(date))) || null }
}
