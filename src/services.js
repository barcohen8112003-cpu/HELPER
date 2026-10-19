// External services for weather, Jewish calendar, and currency conversion.
// None of these require API keys or credentials.

const WMO_CODES = {
  0: 'בהיר',
  1: 'בהיר ברובו',
  2: 'מעונן חלקית',
  3: 'מעונן',
  45: 'ערפילי',
  48: 'ערפילי עם כפור',
  51: 'טפטוף קל',
  53: 'טפטוף בינוני',
  55: 'טפטוף כבד',
  56: 'טפטוף קופא קל',
  57: 'טפטוף קופא כבד',
  61: 'גשם קל',
  63: 'גשם בינוני',
  65: 'גשם כבד',
  66: 'גשם קופא קל',
  67: 'גשם קופא כבד',
  71: 'שלג קל',
  73: 'שלג בינוני',
  75: 'שלג כבד',
  77: 'גרגירי שלג',
  80: 'ממטרים קלים',
  81: 'ממטרים בינוניים',
  82: 'ממטרים כבדים',
  85: 'ממטרי שלג קלים',
  86: 'ממטרי שלג כבדים',
  95: 'סופת רעמים',
  96: 'סופת רעמים עם ברד קל',
  99: 'סופת רעמים עם ברד כבד',
}

const wmoText = (code) => WMO_CODES[code] || `קוד ${code}`

export async function getWeather(city = 'תל אביב') {
  const q = String(city).trim()
  if (!q) return 'נא לציין שם עיר או יישוב'

  // 1. Geocoding via Open-Meteo
  let geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=he&format=json`, { signal: AbortSignal.timeout(15000) })
  let geo = await geoRes.json().catch(() => null)
  if (!geo?.results?.length) {
    // Try English if Hebrew didn't find anything
    geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(15000) })
    geo = await geoRes.json().catch(() => null)
  }
  if (!geo?.results?.length) return `לא נמצא מקום בשם "${q}"`

  const place = geo.results[0]
  const { latitude: lat, longitude: lon, name, country } = place

  // 2. Weather forecast
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return `שגיאה בקבלת נתוני מזג אוויר (${res.status})`
  const data = await res.json()

  const cur = data.current
  const lines = [
    `*מזג האוויר ב-${name}${country ? `, ${country}` : ''}:*`,
    `• טמפרטורה: ${cur.temperature_2m}°C (מרגיש כמו ${cur.apparent_temperature}°C)`,
    `• מצב: ${wmoText(cur.weather_code)}`,
    `• לחות: ${cur.relative_humidity_2m}% | רוח: ${cur.wind_speed_10m} קמ"ש`,
  ]

  if (data.daily?.time?.length) {
    lines.push('\n*תחזית לימים הקרובים:*')
    const count = Math.min(5, data.daily.time.length)
    for (let i = 0; i < count; i++) {
      const dStr = data.daily.time[i]
      const d = new Date(dStr)
      const dayName = d.toLocaleString('he-IL', { weekday: 'short' })
      const max = data.daily.temperature_2m_max[i]
      const min = data.daily.temperature_2m_min[i]
      const code = data.daily.weather_code[i]
      const rain = data.daily.precipitation_probability_max?.[i]
      const rainNote = rain > 20 ? `, סיכוי לגשם: ${rain}%` : ''
      lines.push(`• ${dayName} (${dStr.slice(5)}): ${min}°C - ${max}°C, ${wmoText(code)}${rainNote}`)
    }
  }

  return lines.join('\n')
}

const CITIES_GEONAME = {
  'ירושלים': 281184,
  'jerusalem': 281184,
  'תל אביב': 293397,
  'תל אביב-יפו': 293397,
  'tel aviv': 293397,
  'חיפה': 294801,
  'haifa': 294801,
  'באר שבע': 295530,
  'beer sheva': 295530,
  'beersheba': 295530,
  'אילת': 295277,
  'eilat': 295277,
  'טבריה': 293322,
  'tiberias': 293322,
  'אשדוד': 295629,
  'ashdod': 295629,
  'נתניה': 294071,
  'netanya': 294071,
  'ראשון לציון': 293703,
  'rishon lezion': 293703,
  'פתח תקווה': 293932,
  'petah tikva': 293932,
}

export async function getJewishCalendar(city = 'ירושלים') {
  const normCity = String(city).trim().toLowerCase()
  const geonameid = CITIES_GEONAME[normCity] || 281184

  const now = new Date()
  const [convRes, shabbatRes] = await Promise.allSettled([
    fetch(`https://www.hebcal.com/converter?cfg=json&gy=${now.getFullYear()}&gm=${now.getMonth() + 1}&gd=${now.getDate()}&g2h=1`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`https://www.hebcal.com/shabbat?cfg=json&geonameid=${geonameid}&m=50`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
  ])

  const lines = []
  if (convRes.status === 'fulfilled' && convRes.value?.hebrew) {
    lines.push(`*תאריך עברי היום:* ${convRes.value.hebrew}`)
  }

  if (shabbatRes.status === 'fulfilled' && shabbatRes.value?.items?.length) {
    const locName = shabbatRes.value.location?.name || city
    lines.push(`\n*זמני שבת (${locName}):*`)
    for (const item of shabbatRes.value.items) {
      if (item.category === 'candles') {
        const time = item.date ? new Date(item.date).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : item.title
        lines.push(`• כניסת שבת (הדלקת נרות): ${time}`)
      } else if (item.category === 'havdalah') {
        const time = item.date ? new Date(item.date).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : item.title
        lines.push(`• צאת שבת (הבדלה): ${time}`)
      } else if (item.category === 'parashat') {
        lines.push(`• פרשת השבוע: ${item.hebrew || item.title}`)
      } else if (item.category === 'holiday') {
        lines.push(`• חג / מועד: ${item.hebrew || item.title}`)
      }
    }
  }

  return lines.length ? lines.join('\n') : 'לא הצלחתי לשלוף את נתוני לוח השנה'
}

export async function getCurrencyRate(from = 'USD', to = 'ILS', amount = 1) {
  const f = String(from).trim().toUpperCase()
  const t = String(to).trim().toUpperCase()
  const amt = Number(amount) || 1

  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return `שגיאה בקבלת שער חליפין עבור ${f}`
  const data = await res.json()

  if (data.result !== 'success' || !data.rates?.[t]) {
    return `לא נמצא שער חליפין בין ${f} ל-${t}`
  }

  const rate = data.rates[t]
  const total = (amt * rate).toFixed(2)
  const updated = data.time_last_update_utc ? new Date(data.time_last_update_utc).toLocaleDateString('he-IL') : ''

  return `${amt} ${f} = *${total} ${t}* (שער: 1 ${f} = ${rate.toFixed(4)} ${t}${updated ? `, עודכן: ${updated}` : ''})`
}

export async function getRedAlerts(city = '', days = 1) {
  const d = Number(days) || 1
  const mode = d > 1 ? 3 : 1
  const url = `https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=${mode}`

  let liveAlerts = []
  try {
    const liveRes = await fetch('https://www.oref.org.il/WarningMessages/alert/alerts.json', {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.oref.org.il/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(4000),
    })
    if (liveRes.ok) {
      const text = await liveRes.text()
      if (text && text.trim().length > 5) {
        const parsed = JSON.parse(text)
        if (parsed.data && Array.isArray(parsed.data)) liveAlerts = parsed.data
      }
    }
  } catch {}

  const res = await fetch(url, {
    headers: { Referer: 'https://www.oref.org.il/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return 'לא ניתן להתחבר לשרת התרעות פיקוד העורף כרגע'
  const history = await res.json().catch(() => [])

  const filterCity = String(city || '').trim().toLowerCase()
  const matched = filterCity
    ? history.filter((a) => (a.data || '').toLowerCase().includes(filterCity))
    : history

  const lines = []
  if (liveAlerts.length) {
    lines.push('🚨 *צבע אדום בזמן אמת! התרעות פעילות ברגעים אלו:*')
    lines.push(liveAlerts.map((a) => `• ${a}`).join('\n'))
    lines.push('')
  }

  const titleCity = city ? `באזור ${city}` : 'בישראל'
  const timeDesc = d > 1 ? `ב-${d} הימים האחרונים` : 'מהיום'

  if (!matched.length && !liveAlerts.length) {
    return `שקט: אין התרעות צבע אדום ${titleCity} ${timeDesc}.`
  }

  lines.push(`📢 *התרעות פיקוד העורף ${titleCity} (${timeDesc}) - סה"כ ${matched.length}:*`)
  const display = matched.slice(0, 15)
  for (const a of display) {
    lines.push(`• *${a.time}* (${a.date}) - ${a.data}: ${a.category_desc || 'התרעה'}`)
  }
  if (matched.length > 15) {
    lines.push(`_...ועוד ${matched.length - 15} התרעות נוספות._`)
  }

  return lines.join('\n')
}

export async function trackPackage(trackingNumber) {
  const code = String(trackingNumber).trim().toUpperCase()
  if (!code) return 'נא לציין מספר מעקב למשלוח'

  let carrier = 'חבילה בינלאומית / דואר'
  if (/^RR|^CP|^EE|^LZ|^IL|IL$/.test(code)) carrier = 'דואר ישראל (Israel Post)'
  else if (/^LP|^UG|^UZ|^CN|CN$/.test(code)) carrier = 'דואר סין / Cainiao (AliExpress)'
  else if (/^\d{10}$/.test(code)) carrier = 'DHL Express'
  else if (/^\d{12}$/.test(code)) carrier = 'FedEx'
  else if (/^1Z/.test(code)) carrier = 'UPS'

  const links = [
    `• 17Track: https://t.17track.net/en#nums=${encodeURIComponent(code)}`,
    `• ParcelsApp: https://parcelsapp.com/en/tracking/${encodeURIComponent(code)}`,
    ...(carrier.includes('דואר ישראל') ? [`• מעקב דואר ישראל: https://israelpost.co.il/itemtrace?itemCode=${encodeURIComponent(code)}`] : []),
    ...(carrier.includes('Cainiao') ? [`• מעקב Cainiao: https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(code)}`] : []),
  ]

  return [
    `📦 *פרטי מעקב משלוח (${code}):*`,
    `• חברת שילוח מזוהה: *${carrier}*`,
    '\n*קישורי מעקב ישירים לצפייה בסטטוס המלא בזמן אמת:*',
    ...links,
  ].join('\n')
}

export async function getTransitInfo(line, city = '') {
  const qLine = String(line || '').trim()
  if (!qLine) return 'נא לציין מספר קו או אזור לבדיקה'

  try {
    const res = await fetch(`https://open-bus-stride-api.hasadna.org.il/gtfs_routes/list?route_short_name=${encodeURIComponent(qLine)}&limit=10`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return `שגיאה בחיפוש קו ${qLine} במאגר התחבורה הציבורית`
    const routes = await res.json().catch(() => [])
    if (!routes?.length) return `לא נמצאו נתונים עבור קו ${qLine}`

    const filterCity = String(city || '').trim().toLowerCase()
    const filtered = filterCity
      ? routes.filter((r) => (r.route_long_name || '').toLowerCase().includes(filterCity))
      : routes

    const list = filtered.length ? filtered : routes
    const lines = [`🚌 *מסלולי קו ${qLine} (${list[0]?.agency_name || 'תחבורה ציבורית'}):*`]
    for (const r of list.slice(0, 6)) {
      lines.push(`• *מפעיל:* ${r.agency_name} | *מסלול:* ${r.route_long_name.replace(/<->/g, ' ⟷ ')}`)
    }
    return lines.join('\n')
  } catch (e) {
    return `לא הצלחתי לשלוף את נתוני הקו: ${e.message}`
  }
}

