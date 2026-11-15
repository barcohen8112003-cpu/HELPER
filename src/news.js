import { config } from './config.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const PER_FEED = 12
const MAX_TITLE = 130

const clean = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (item, name) => clean(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1])

async function readFeed(url, since) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  const source = new URL(url).hostname.replace(/^(www|rss|feeds)\./, '')
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)]
    .map(([item]) => ({ source, title: tag(item, 'title').slice(0, MAX_TITLE), link: tag(item, 'link'), at: Date.parse(tag(item, 'pubDate')) }))
    .filter((n) => n.title && n.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, PER_FEED)
}

// Headlines published in the last `hours`, newest first, from every configured feed. A feed that fails is skipped.
export async function getNews(hours = 12) {
  const since = Date.now() - hours * 3600000
  const results = await Promise.allSettled(config.newsFeeds.map((url) => readFeed(url, since)))
  for (const [i, r] of results.entries()) if (r.status === 'rejected') console.log(`[news ${config.newsFeeds[i]}] ${r.reason.message}`)
  const seen = new Set()
  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((n) => !seen.has(n.title) && seen.add(n.title))
    .sort((a, b) => b.at - a.at)
}

const when = (at) => new Date(at).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

// For get_news: each headline with its time, source and link, so an answer can point at where it was published.
export const formatNews = (items) => items.map((n) => `${when(n.at)} [${n.source}] ${n.title}${n.link ? ` ${n.link}` : ''}`).join('\n')

// For the morning digest: the same headlines numbered, so every line the model writes names the one it came from.
export const numberedNews = (items) => items.map((n, i) => `[${i + 1}] ${when(n.at)} [${n.source}] ${n.title}`).join('\n')

// The model's digest lines ("• text [3]" or "• text [3,5]") turned into what he reads: the line, its source and the
// real link of the headline it cites. A line that cites no fetched headline is dropped, so nothing in the digest
// can come from the model's memory.
export function attachSources(text, items) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const refs = [...line.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim())))
    const cited = refs.map((n) => items[n - 1]).filter(Boolean)
    if (!cited.length) continue
    const body = line.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/^[•\-*]\s*/, '').trim()
    if (!body) continue
    const first = cited.find((n) => n.link) || cited[0]
    out.push(`• ${body} (${first.source})${first.link ? `\n${first.link}` : ''}`)
  }
  return out.join('\n')
}
