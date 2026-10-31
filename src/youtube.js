// YouTube search. With YOUTUBE_API_KEY it asks the official YouTube Data API (free, 10,000 units a day, a search is
// 100 of them, so about 100 searches a day). Without a key, or when the API fails (quota, bad key), it reads
// YouTube's own results page as before.
import { config } from './config.js'

let http = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(opts?.timeout || 15000) })
export const _setForTest = (opts = {}) => {
  if (opts.fetch) http = opts.fetch
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const unescape = (s) => String(s || '').replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m])

// [{ id, title, channel, published }] from the Data API, or null when there is no key or the API refused.
async function searchApi(query, max) {
  const key = config.youtubeKey
  if (!key) return null
  const p = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(max), q: query, key, regionCode: 'IL', relevanceLanguage: /[א-ת]/.test(query) ? 'he' : 'en' })
  try {
    const res = await http(`https://www.googleapis.com/youtube/v3/search?${p}`)
    if (!res.ok) {
      console.log(`[youtube] Data API ${res.status}, falling back to the results page`)
      return null
    }
    const body = await res.json()
    return (body.items || [])
      .filter((i) => i.id?.videoId)
      .map((i) => ({ id: i.id.videoId, title: unescape(i.snippet?.title), channel: unescape(i.snippet?.channelTitle), published: String(i.snippet?.publishedAt || '').slice(0, 10) }))
  } catch (e) {
    console.log(`[youtube] Data API failed (${e.message}), falling back to the results page`)
    return null
  }
}

// The results page: only "videoRenderer" entries count, which leaves out ads, Shorts shelves, channels and playlists.
async function searchPage(query, max) {
  const res = await http(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=he`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'he,en;q=0.8' },
  })
  if (!res.ok) return []
  const html = await res.text()
  const out = []
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(html)) && out.length < max) {
    if (out.some((v) => v.id === m[1])) continue
    let title = ''
    try {
      title = JSON.parse(`"${m[2]}"`)
    } catch {}
    out.push({ id: m[1], title, channel: '', published: '' })
  }
  if (!out.length) {
    const id = html.match(/"videoId":"([\w-]{11})"/)
    if (id) out.push({ id: id[1], title: '', channel: '', published: '' })
  }
  return out
}

export async function searchYouTube(query, max = 5) {
  const n = Math.max(1, Math.min(10, max))
  return (await searchApi(query, n)) || (await searchPage(query, n))
}

// The first ordinary video for a search: { id, title } or null.
export async function firstYouTubeVideo(query) {
  return (await searchYouTube(query, 1))[0] || null
}

export const youtubeTools = [
  {
    name: 'youtube_search',
    network: true,
    description: 'מחפש סרטונים ביוטיוב ומחזיר רשימה: כותרת, ערוץ, תאריך וקישור. ל"תמצא לי סרטון על X", "יש הדרכה ביוטיוב ל-X", "מה הקליפ החדש של X". להפעלה על המסך במחשב יש play_youtube.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'מה לחפש' }, count: { type: 'number', description: 'כמה תוצאות, ברירת מחדל 5' } }, required: ['query'] },
    async run({ query, count = 5 }) {
      const list = await searchYouTube(query, count)
      if (!list.length) return `לא מצאתי סרטונים. חיפוש מוכן: https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
      return list.map((v, i) => `${i + 1}. ${v.title || '(בלי כותרת)'}${v.channel ? ` · ${v.channel}` : ''}${v.published ? ` · ${v.published}` : ''}\nhttps://youtu.be/${v.id}`).join('\n')
    },
  },
]
