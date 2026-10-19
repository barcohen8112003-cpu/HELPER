// Free public-data lookups. No API keys, every call goes through the SSRF-safe fetchJson/fetchText.
import { str, num, obj, oneOf, lines, clip, need, toNumber, fetchJson, fetchText } from './_kit.js'

export const category = 'lookup'
export const blurb = 'חיפושי מידע ציבורי חינמי: מזג אוויר, ויקיפדיה, מטבעות, חדשות טכנולוגיה ועוד'

const enc = encodeURIComponent
const T = 10000

const WMO = {
  0: 'שמיים בהירים', 1: 'בהיר ברובו', 2: 'מעונן חלקית', 3: 'מעונן', 45: 'ערפל', 48: 'ערפל קפוא',
  51: 'טפטוף קל', 53: 'טפטוף', 55: 'טפטוף חזק', 56: 'טפטוף קפוא', 57: 'טפטוף קפוא חזק',
  61: 'גשם קל', 63: 'גשם', 65: 'גשם חזק', 66: 'גשם קפוא', 67: 'גשם קפוא חזק',
  71: 'שלג קל', 73: 'שלג', 75: 'שלג כבד', 77: 'גרגרי שלג', 80: 'ממטרים קלים', 81: 'ממטרים', 82: 'ממטרים עזים',
  85: 'ממטרי שלג', 86: 'ממטרי שלג עזים', 95: 'סופת רעמים', 96: 'סופת רעמים וברד', 99: 'סופת רעמים וברד כבד',
}
export const wmoText = (code) => WMO[code] ?? `קוד מזג אוויר ${code}`

export const stripTags = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return m ? stripTags(m[1]) : ''
}

// Items of an RSS (<item>) or Atom (<entry>) feed, minimal and defensive.
export function parseFeed(xml, max = 5) {
  const blocks = [...String(xml).matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0])
  return blocks.slice(0, max).map((b) => {
    const link = tag(b, 'link') || (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '')
    return { title: tag(b, 'title'), link, date: tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published'), summary: tag(b, 'description') || tag(b, 'summary') }
  })
}

async function geo(place) {
  const name = String(need(place, 'שם מקום')).trim()
  const d = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${enc(name)}&count=1&language=he`, { timeoutMs: T })
  const r = d?.results?.[0]
  if (!r) throw new Error(`לא נמצא מקום בשם "${name}"`)
  return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country].filter(Boolean).join(', '), tz: r.timezone, elevation: r.elevation }
}

const r1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : '?')
const dayName = (iso) => {
  try {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'UTC' })
  } catch {
    return iso
  }
}

export const tools = [
  {
    name: 'lookup_geocode',
    description: 'מוצא קואורדינטות, מדינה ואזור זמן של עיר או מקום.',
    parameters: obj({ place: str('שם המקום') }),
    network: true,
    async run({ place }) {
      const g = await geo(place)
      return lines(g.label, `קו רוחב ${g.lat}, קו אורך ${g.lon}`, g.tz && `אזור זמן: ${g.tz}`, g.elevation != null && `גובה: ${g.elevation} מ'`)
    },
  },
  {
    name: 'lookup_weather',
    description: 'מזג אוויר עכשיו ותחזית ל-3 ימים לכל עיר בעולם.',
    parameters: obj({ place: str('שם העיר') }),
    network: true,
    async run({ place }) {
      const g = await geo(place)
      const d = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto`,
        { timeoutMs: T },
      )
      const c = d.current
      if (!c) throw new Error('אין נתוני מזג אוויר')
      const days = (d.daily?.time ?? []).map((t, i) => `${dayName(t)} ${t}: ${wmoText(d.daily.weather_code?.[i])}, ${r1(d.daily.temperature_2m_min?.[i])}–${r1(d.daily.temperature_2m_max?.[i])}°, סיכוי לגשם ${d.daily.precipitation_probability_max?.[i] ?? '?'}%`)
      return clip(lines(`${g.label}`, `עכשיו: ${wmoText(c.weather_code)}, ${r1(c.temperature_2m)}° (מרגיש ${r1(c.apparent_temperature)}°), לחות ${c.relative_humidity_2m ?? '?'}%, רוח ${r1(c.wind_speed_10m)} קמ"ש`, 'תחזית:', days))
    },
  },
  {
    name: 'lookup_sun_times',
    description: 'שעות זריחה ושקיעה של מקום, להיום ולימים הקרובים.',
    parameters: obj({ place: str('שם המקום') }),
    network: true,
    async run({ place }) {
      const g = await geo(place)
      const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&daily=sunrise,sunset&forecast_days=3&timezone=auto`, { timeoutMs: T })
      const t = d?.daily?.time
      if (!t?.length) throw new Error('אין נתוני זריחה')
      const hm = (s) => String(s ?? '').split('T')[1] ?? '?'
      return lines(g.label, t.map((day, i) => `${day}: זריחה ${hm(d.daily.sunrise?.[i])}, שקיעה ${hm(d.daily.sunset?.[i])}`))
    },
  },
  {
    name: 'lookup_air_quality',
    description: 'איכות האוויר עכשיו במקום: מדד AQI אירופאי וחלקיקים.',
    parameters: obj({ place: str('שם המקום') }),
    network: true,
    async run({ place }) {
      const g = await geo(place)
      const d = await fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${g.lat}&longitude=${g.lon}&current=european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide`, { timeoutMs: T })
      const c = d?.current
      if (!c) throw new Error('אין נתוני איכות אוויר')
      const a = c.european_aqi
      const level = a == null ? '?' : a <= 20 ? 'טובה מאוד' : a <= 40 ? 'טובה' : a <= 60 ? 'בינונית' : a <= 80 ? 'גרועה' : a <= 100 ? 'גרועה מאוד' : 'קיצונית'
      return lines(g.label, `מדד AQI אירופאי: ${a ?? '?'} (${level})`, `PM2.5: ${c.pm2_5 ?? '?'}, PM10: ${c.pm10 ?? '?'}, אוזון: ${c.ozone ?? '?'}, NO2: ${c.nitrogen_dioxide ?? '?'} (µg/m³)`)
    },
  },
  {
    name: 'lookup_wikipedia',
    description: 'תקציר ערך מוויקיפדיה בעברית או באנגלית לפי נושא.',
    parameters: obj({ topic: str('הנושא'), lang: oneOf(['he', 'en'], 'שפה, ברירת מחדל he') }, ['topic']),
    network: true,
    async run({ topic, lang }) {
      const l = lang === 'en' ? 'en' : 'he'
      const q = String(need(topic, 'נושא')).trim()
      const s = await fetchJson(`https://${l}.wikipedia.org/w/api.php?action=opensearch&search=${enc(q)}&limit=1&format=json`, { timeoutMs: T })
      const title = s?.[1]?.[0]
      if (!title) throw new Error(`לא נמצא ערך על "${q}"`)
      const d = await fetchJson(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${enc(title.replace(/ /g, '_'))}`, { timeoutMs: T })
      const ex = String(d?.extract ?? '').slice(0, 600)
      if (!ex) throw new Error('לערך אין תקציר')
      return lines(d.title ?? title, ex, d.content_urls?.desktop?.page)
    },
  },
  {
    name: 'lookup_dictionary',
    description: 'הגדרה באנגלית של מילה: חלק דיבר, משמעויות ודוגמה.',
    parameters: obj({ word: str('מילה באנגלית') }),
    network: true,
    async run({ word }) {
      const w = String(need(word, 'מילה')).trim().toLowerCase()
      let d
      try {
        d = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(w)}`, { timeoutMs: T })
      } catch (e) {
        if (/404/.test(e.message)) throw new Error(`לא נמצאה הגדרה למילה "${w}"`)
        throw e
      }
      const e = Array.isArray(d) ? d[0] : null
      if (!e?.meanings?.length) throw new Error(`לא נמצאה הגדרה למילה "${w}"`)
      const out = e.meanings.slice(0, 3).map((m) => {
        const def = m.definitions?.[0]
        return `${m.partOfSpeech ?? ''}: ${def?.definition ?? ''}${def?.example ? ` (למשל: ${def.example})` : ''}`
      })
      return clip(lines(`${e.word}${e.phonetic ? ` ${e.phonetic}` : ''}`, out))
    },
  },
  {
    name: 'lookup_country',
    description: 'עובדות על מדינה (מ-Wikidata): בירה, אוכלוסייה, שטח, מטבע ושפות רשמיות.',
    parameters: obj({ name: str('שם המדינה, עברית או אנגלית') }),
    network: true,
    async run({ name }) {
      const n = String(need(name, 'שם מדינה')).trim()
      const wd = 'https://www.wikidata.org/w/api.php'
      const lang = /[֐-׿]/.test(n) ? 'he' : 'en'
      const s = await fetchJson(`${wd}?action=wbsearchentities&search=${enc(n)}&language=${lang}&uselang=he&type=item&limit=6&format=json`, { timeoutMs: T })
      const ids = (s?.search ?? []).map((x) => x.id).filter((id) => /^Q\d+$/.test(id))
      if (!ids.length) throw new Error(`לא נמצאה מדינה "${n}"`)
      const ents = (await fetchJson(`${wd}?action=wbgetentities&ids=${ids.join('|')}&props=claims|labels&languages=he|en&format=json`, { timeoutMs: 20000, maxBytes: 12_000_000 }))?.entities ?? {}
      const id = ids.find((i) => ents[i]?.claims?.P36 && ents[i]?.claims?.P1082)
      if (!id) throw new Error(`"${n}" לא נראית כמדינה`)
      const c = ents[id].claims
      const ref = (p, max = 3) => (c[p] ?? []).map((x) => x.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, max)
      const amount = (p) => {
        const v = Number((c[p] ?? []).slice(-1)[0]?.mainsnak?.datavalue?.value?.amount)
        return Number.isFinite(v) ? v : null
      }
      const refs = [...new Set([...ref('P36', 2), ...ref('P38', 2), ...ref('P37', 4), ...ref('P30', 1)])]
      const labs = refs.length ? (await fetchJson(`${wd}?action=wbgetentities&ids=${refs.join('|')}&props=labels&languages=he|en&format=json`, { timeoutMs: T }))?.entities ?? {} : {}
      const L = (i) => labs[i]?.labels?.he?.value ?? labs[i]?.labels?.en?.value ?? i
      const pop = amount('P1082')
      const area = amount('P2046')
      return lines(
        ents[id].labels?.he?.value ?? ents[id].labels?.en?.value ?? n,
        `בירה: ${ref('P36', 2).map(L).join(', ')}`,
        pop != null && `אוכלוסייה: ${pop.toLocaleString('en-US')}`,
        area != null && `שטח: ${area.toLocaleString('en-US')} קמ"ר`,
        ref('P30', 1).length && `יבשת: ${ref('P30', 1).map(L).join(', ')}`,
        ref('P37', 4).length && `שפות רשמיות: ${ref('P37', 4).map(L).join(', ')}`,
        ref('P38', 2).length && `מטבע: ${ref('P38', 2).map(L).join(', ')}`,
      )
    },
  },
  {
    name: 'lookup_exchange_rate',
    description: 'שער המרה עדכני בין מטבעות (ECB), עם המרת סכום. למשל USD ל-ILS.',
    parameters: obj({ from: str('קוד מטבע מקור, למשל USD'), to: str('קוד מטבע יעד, למשל ILS'), amount: num('סכום, ברירת מחדל 1') }, ['from', 'to']),
    network: true,
    async run({ from, to, amount }) {
      const f = String(need(from, 'מטבע מקור')).trim().toUpperCase()
      const t = String(need(to, 'מטבע יעד')).trim().toUpperCase()
      const a = amount === undefined || amount === '' ? 1 : toNumber(amount, 'סכום')
      if (f === t) return `${a} ${f} = ${a} ${t}`
      const d = await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${enc(f)}&symbols=${enc(t)}`, { timeoutMs: T }).catch((e) => {
        if (/404|422/.test(e.message)) throw new Error('קוד מטבע לא מוכר')
        throw e
      })
      const rate = d?.rates?.[t]
      if (typeof rate !== 'number') throw new Error('לא נמצא שער')
      return `${a} ${f} = ${Number((a * rate).toFixed(4))} ${t} (שער ${rate}, תאריך ${d.date})`
    },
  },
  {
    name: 'lookup_exchange_history',
    description: 'שער מטבע בתאריך היסטורי מסוים (YYYY-MM-DD).',
    parameters: obj({ from: str('מטבע מקור'), to: str('מטבע יעד'), date: str('תאריך YYYY-MM-DD') }),
    network: true,
    async run({ from, to, date }) {
      const f = String(need(from, 'מטבע מקור')).trim().toUpperCase()
      const t = String(need(to, 'מטבע יעד')).trim().toUpperCase()
      const day = String(need(date, 'תאריך')).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('תאריך חייב להיות בפורמט YYYY-MM-DD')
      const d = await fetchJson(`https://api.frankfurter.dev/v1/${day}?base=${enc(f)}&symbols=${enc(t)}`, { timeoutMs: T }).catch((e) => {
        if (/404|422/.test(e.message)) throw new Error('קוד מטבע או תאריך לא תקינים')
        throw e
      })
      const rate = d?.rates?.[t]
      if (typeof rate !== 'number') throw new Error('לא נמצא שער')
      return `ב-${d.date}: 1 ${f} = ${rate} ${t}`
    },
  },
  {
    name: 'lookup_crypto_price',
    description: 'מחיר נוכחי של מטבע קריפטו (מידע בלבד, לא ייעוץ השקעות).',
    parameters: obj({ coin: str('מזהה CoinGecko, למשל bitcoin או ethereum'), currency: str('מטבע, ברירת מחדל usd') }, ['coin']),
    network: true,
    async run({ coin, currency }) {
      const c = String(need(coin, 'מטבע קריפטו')).trim().toLowerCase()
      const cur = String(currency || 'usd').trim().toLowerCase()
      const d = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${enc(c)}&vs_currencies=${enc(cur)}&include_24hr_change=true`, { timeoutMs: T })
      const e = d?.[c]
      if (!e || typeof e[cur] !== 'number') throw new Error(`לא נמצא מחיר ל-"${c}" (יש להשתמש במזהה כמו bitcoin)`)
      const ch = e[`${cur}_24h_change`]
      return `${c}: ${e[cur]} ${cur.toUpperCase()}${typeof ch === 'number' ? ` (24 שעות: ${ch.toFixed(2)}%)` : ''}. מידע בלבד, לא ייעוץ השקעות.`
    },
  },
  {
    name: 'lookup_earthquakes',
    description: 'רעידות אדמה משמעותיות בשבוע האחרון (USGS), אפשר לסנן לאזור ישראל.',
    parameters: obj({ near_israel: { type: 'boolean', description: 'רק באזור ישראל והסביבה' }, min_magnitude: num('עוצמה מינימלית') }, []),
    network: true,
    async run({ near_israel, min_magnitude }) {
      const feed = near_israel ? 'all_week' : 'significant_week'
      const d = await fetchJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`, { timeoutMs: 15000, maxBytes: 8_000_000 })
      const min = min_magnitude == null || min_magnitude === '' ? 0 : toNumber(min_magnitude, 'עוצמה')
      let list = (d?.features ?? []).filter((f) => (f.properties?.mag ?? 0) >= min)
      if (near_israel) {
        list = list.filter((f) => {
          const [lon, lat] = f.geometry?.coordinates ?? []
          return lat >= 26 && lat <= 38 && lon >= 28 && lon <= 40
        })
      }
      list.sort((a, b) => (b.properties?.time ?? 0) - (a.properties?.time ?? 0))
      if (!list.length) throw new Error('לא נמצאו רעידות אדמה מתאימות בשבוע האחרון')
      return clip(lines(`${list.length} רעידות (מציג עד 8):`, list.slice(0, 8).map((f) => `M${f.properties?.mag ?? '?'} ${f.properties?.place ?? '?'} - ${f.properties?.time ? new Date(f.properties.time).toISOString().slice(0, 16).replace('T', ' ') : '?'} UTC`)))
    },
  },
  {
    name: 'lookup_book',
    description: 'חיפוש ספרים ב-Open Library לפי שם או מחבר.',
    parameters: obj({ query: str('שם ספר או מחבר') }),
    network: true,
    async run({ query }) {
      const q = String(need(query, 'שאילתה')).trim()
      const d = await fetchJson(`https://openlibrary.org/search.json?q=${enc(q)}&limit=5&fields=title,author_name,first_publish_year,number_of_pages_median`, { timeoutMs: T })
      const docs = d?.docs ?? []
      if (!docs.length) throw new Error(`לא נמצאו ספרים עבור "${q}"`)
      return clip(lines(docs.map((b) => `${b.title ?? '?'} - ${(b.author_name ?? []).slice(0, 2).join(', ') || 'מחבר לא ידוע'}${b.first_publish_year ? ` (${b.first_publish_year})` : ''}`)))
    },
  },
  {
    name: 'lookup_arxiv',
    description: 'חיפוש מאמרים מדעיים ב-arXiv: כותרת, מחברים ותקציר קצר.',
    parameters: obj({ query: str('נושא באנגלית') }),
    network: true,
    async run({ query }) {
      const q = String(need(query, 'שאילתה')).trim()
      const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=all:${enc(q)}&max_results=3`, { timeoutMs: 15000 })
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
      if (!entries.length) throw new Error(`לא נמצאו מאמרים עבור "${q}"`)
      return clip(
        entries
          .map((e) => {
            const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => stripTags(m[1])).slice(0, 3).join(', ')
            return `${tag(e, 'title')}\n${authors} | ${tag(e, 'published').slice(0, 10)}\n${tag(e, 'summary').slice(0, 250)}…\n${tag(e, 'id')}`
          })
          .join('\n\n'),
        2500,
      )
    },
  },
  {
    name: 'lookup_hackernews',
    description: 'הכתבות המובילות כרגע ב-Hacker News.',
    parameters: obj({ count: num('כמה כתבות, עד 10') }, []),
    network: true,
    async run({ count }) {
      const n = Math.min(10, Math.max(1, Math.round(count == null || count === '' ? 5 : toNumber(count, 'כמות'))))
      const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json', { timeoutMs: T })
      if (!Array.isArray(ids) || !ids.length) throw new Error('לא התקבלו כתבות')
      const items = await Promise.all(ids.slice(0, n).map((id) => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${Number(id)}.json`, { timeoutMs: T }).catch(() => null)))
      const ok = items.filter((i) => i?.title)
      if (!ok.length) throw new Error('לא התקבלו כתבות')
      return clip(lines(ok.map((i, k) => `${k + 1}. ${i.title} (${i.score ?? 0} נקודות) ${i.url ?? `https://news.ycombinator.com/item?id=${i.id}`}`)))
    },
  },
  {
    name: 'lookup_github_repo',
    description: 'מידע ציבורי על מאגר GitHub: תיאור, כוכבים, שפה ועדכון אחרון.',
    parameters: obj({ repo: str('בפורמט owner/name, למשל nodejs/node') }),
    network: true,
    async run({ repo }) {
      const r = String(need(repo, 'מאגר')).trim()
      if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('המאגר חייב להיות בפורמט owner/name')
      const [o, n] = r.split('/')
      const d = await fetchJson(`https://api.github.com/repos/${enc(o)}/${enc(n)}`, { timeoutMs: T, headers: { accept: 'application/vnd.github+json' } }).catch((e) => {
        if (/404/.test(e.message)) throw new Error(`המאגר ${r} לא נמצא`)
        if (/403|429/.test(e.message)) throw new Error('GitHub הגביל זמנית את הבקשות, נסה מאוחר יותר')
        throw e
      })
      return lines(d.full_name, d.description, `כוכבים: ${d.stargazers_count ?? '?'} | forks: ${d.forks_count ?? '?'} | issues פתוחים: ${d.open_issues_count ?? '?'}`, `שפה: ${d.language ?? '?'} | רישיון: ${d.license?.spdx_id ?? '?'}`, d.pushed_at && `עדכון אחרון: ${d.pushed_at.slice(0, 10)}`, d.html_url)
    },
  },
  {
    name: 'lookup_package',
    description: 'מידע על חבילה ב-npm או PyPI: גרסה אחרונה, תיאור ורישיון.',
    parameters: obj({ name: str('שם החבילה'), registry: oneOf(['npm', 'pypi'], 'ברירת מחדל npm') }, ['name']),
    network: true,
    async run({ name, registry }) {
      const n = String(need(name, 'שם חבילה')).trim()
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(n)) throw new Error('שם חבילה לא תקין')
      const notFound = (e) => {
        if (/404/.test(e.message)) throw new Error(`החבילה "${n}" לא נמצאה`)
        throw e
      }
      if (registry === 'pypi') {
        const d = await fetchJson(`https://pypi.org/pypi/${enc(n)}/json`, { timeoutMs: T }).catch(notFound)
        const i = d?.info ?? {}
        return lines(`${i.name ?? n} ${i.version ?? ''} (PyPI)`, i.summary, i.license && `רישיון: ${String(i.license).slice(0, 60)}`, i.requires_python && `Python: ${i.requires_python}`, i.package_url)
      }
      const d = await fetchJson(`https://registry.npmjs.org/${n.replace('/', '%2F')}/latest`, { timeoutMs: T }).catch(notFound)
      return lines(`${d.name ?? n} ${d.version ?? ''} (npm)`, d.description, d.license && `רישיון: ${typeof d.license === 'string' ? d.license : d.license?.type}`, d.homepage)
    },
  },
  {
    name: 'lookup_rss',
    description: 'קורא פיד RSS/Atom מכתובת ומציג את הפריטים האחרונים.',
    parameters: obj({ url: str('כתובת הפיד'), count: num('כמה פריטים, עד 10') }, ['url']),
    network: true,
    async run({ url, count }) {
      const n = Math.min(10, Math.max(1, Math.round(count == null || count === '' ? 5 : toNumber(count, 'כמות'))))
      const xml = await fetchText(String(need(url, 'כתובת')).trim(), { timeoutMs: 12000 })
      const items = parseFeed(xml, n)
      if (!items.length) throw new Error('לא נמצאו פריטים בפיד')
      return clip(lines(items.map((i, k) => `${k + 1}. ${i.title || '(ללא כותרת)'}${i.date ? ` [${i.date}]` : ''}\n   ${i.summary.slice(0, 160)}\n   ${i.link}`)), 2500)
    },
  },
  {
    name: 'lookup_holidays',
    description: 'חגים וימי חופשה רשמיים של מדינה בשנה מסוימת.',
    parameters: obj({ country: str('קוד מדינה בן 2 אותיות, למשל IL או US'), year: num('שנה, ברירת מחדל השנה הנוכחית') }, ['country']),
    network: true,
    async run({ country, year }) {
      const cc = String(need(country, 'מדינה')).trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(cc)) throw new Error('קוד מדינה חייב להיות 2 אותיות, למשל IL')
      const y = year == null || year === '' ? new Date().getFullYear() : Math.round(toNumber(year, 'שנה'))
      const raw = await fetchText(`https://date.nager.at/api/v3/PublicHolidays/${y}/${enc(cc)}`, { timeoutMs: T }).catch((e) => {
        if (/404/.test(e.message)) throw new Error('מדינה לא נתמכת')
        throw e
      })
      if (!raw.trim()) throw new Error('אין נתוני חגים למדינה הזו במקור (למשל ישראל לא נתמכת)')
      const d = JSON.parse(raw)
      if (!Array.isArray(d) || !d.length) throw new Error('לא נמצאו חגים')
      return clip(lines(`חגים ב-${cc} בשנת ${y}:`, d.map((h) => `${h.date} - ${h.localName ?? h.name}${h.name && h.localName !== h.name ? ` (${h.name})` : ''}`)))
    },
  },
]

const ok = (re) => (r) => re.test(String(r))

export const tests = [
  { tool: 'lookup_geocode', args: { place: 'Tel Aviv' }, check: ok(/קו רוחב/) },
  { tool: 'lookup_weather', args: { place: 'Tel Aviv' }, check: ok(/עכשיו/) },
  { tool: 'lookup_sun_times', args: { place: 'Jerusalem' }, check: ok(/זריחה/) },
  { tool: 'lookup_air_quality', args: { place: 'Haifa' }, check: ok(/AQI/) },
  { tool: 'lookup_wikipedia', args: { topic: 'ירושלים' }, check: (r) => String(r).length > 50 },
  { tool: 'lookup_dictionary', args: { word: 'hello' }, check: ok(/hello/i) },
  { tool: 'lookup_country', args: { name: 'Israel' }, check: ok(/בירה/) },
  { tool: 'lookup_exchange_rate', args: { from: 'USD', to: 'ILS', amount: 10 }, check: ok(/ILS/) },
  { tool: 'lookup_exchange_history', args: { from: 'USD', to: 'EUR', date: '2024-01-15' }, check: ok(/EUR/) },
  { tool: 'lookup_crypto_price', args: { coin: 'bitcoin' }, check: ok(/bitcoin/) },
  { tool: 'lookup_earthquakes', args: { min_magnitude: 0 }, check: (r) => String(r).length > 5 },
  { tool: 'lookup_book', args: { query: 'dune herbert' }, check: ok(/Dune/i) },
  { tool: 'lookup_arxiv', args: { query: 'transformer attention' }, check: (r) => String(r).length > 40 },
  { tool: 'lookup_hackernews', args: { count: 3 }, check: ok(/1\./) },
  { tool: 'lookup_github_repo', args: { repo: 'nodejs/node' }, check: ok(/nodejs\/node/) },
  { tool: 'lookup_package', args: { name: 'express' }, check: ok(/express/) },
  { tool: 'lookup_rss', args: { url: 'https://hnrss.org/frontpage', count: 2 }, check: ok(/1\./) },
  { tool: 'lookup_holidays', args: { country: 'US', year: 2025 }, check: ok(/2025-/) },
]
