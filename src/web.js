import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config, DATA_DIR } from './config.js'
import { isSessionUrl, readSessionPage } from './session.js'
import { pageBlocked, readPublicPage, searchPublic } from './obscura.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

// One retry: the first connection attempt occasionally times out.
async function get(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  } catch {
    return fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  }
}

export function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
// Edge or Chrome on Windows; Chromium on a Linux server (the Dockerfile installs it). CHROME_PATH overrides both.
const BROWSER = [
  process.env.CHROME_PATH,
  ...['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'].flatMap((exe) => programFiles.map((dir) => path.join(dir, exe))),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => fs.existsSync(p))
// Inside a container the browser runs as root, where its sandbox cannot start.
export const browserPath = () => BROWSER
export const SERVER_FLAGS = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []

// Below this much text a page is assumed to be a JavaScript shell or a bot wall.
const THIN_PAGE = 500
let renderQueue = Promise.resolve()

// Loads the page in the installed Edge/Chrome, headless, and returns the DOM after scripts ran.
// One at a time: runs share a profile directory, and a second instance would just hand off to the first.
function render(url) {
  const run = () =>
    new Promise((resolve, reject) => {
      const args = [...SERVER_FLAGS, '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio', `--user-data-dir=${path.join(DATA_DIR, 'browser')}`, '--virtual-time-budget=10000', '--dump-dom', url]
      execFile(BROWSER, args, { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout) => (stdout ? resolve(stdout) : reject(err || new Error('הדפדפן לא החזיר תוכן'))))
    })
  const result = renderQueue.then(run)
  renderQueue = result.catch(() => {})
  return result
}

async function fetchText(url) {
  const res = await get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'he,en;q=0.8' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  return (res.headers.get('content-type') || '').includes('html') ? htmlToText(body) : body
}

// A short download, or a short block page, is worth a real render. A long article that merely mentions a captcha is not.
function weakPage(text) {
  if (!text || text.length < THIN_PAGE) return true
  return text.length < 8000 && pageBlocked(text)
}

// Plain fetch first. A thin, blocked or failed public page is read in Obscura, then in Chromium if that is down or
// the site rejects it. A signed-in site never takes either anonymous path.
export async function fetchPage(url, maxChars = 12000) {
  if (!/^https?:\/\//i.test(url)) throw new Error('רק כתובות http/https')
  if (isSessionUrl(url)) return readSessionPage(url, maxChars)
  let text = ''
  let error
  try {
    text = await fetchText(url)
  } catch (e) {
    error = e
  }
  if (weakPage(text)) {
    const via = await readPublicPage(url, { maxChars })
    if (via && !pageBlocked(via) && via.length > text.length) text = via
  }
  if ((text.length < THIN_PAGE || (text.length < 8000 && pageBlocked(text))) && BROWSER) {
    const rendered = await render(url).then(htmlToText, () => '')
    if (rendered.length > text.length) text = rendered
  }
  if (!text || (pageBlocked(text) && text.length < THIN_PAGE)) throw error || new Error('הדף ריק')
  return text.slice(0, maxChars)
}

async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.tavilyKey}` },
    body: JSON.stringify({ query, max_results: 6 }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
  const data = await res.json()
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300) }))
}

async function searchDuckDuckGo(query) {
  const res = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`)
  const html = await res.text()
  const results = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
  let m
  while ((m = re.exec(html)) && results.length < 6) {
    let url = decode(m[1])
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = 'https:' + url
    results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3] || '') })
  }
  return results
}

export async function webSearch(query) {
  const found = await searchPublic(query)
  if (found?.length) return found
  return config.tavilyKey ? searchTavily(query) : searchDuckDuckGo(query)
}
