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

export const formatNews = (items) =>
  items.map((n) => `${new Date(n.at).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} [${n.source}] ${n.title}`).join('\n')
