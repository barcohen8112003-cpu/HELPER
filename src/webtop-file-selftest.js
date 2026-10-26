// node src/webtop-file-selftest.js
// A file is downloaded from a stand-in Webtop page in a real Chrome: the link whose text holds the name is clicked,
// the file lands, and it comes back with its name and bytes. A name that is not on the page is said so.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const PORT = 9351
const WEB = 9352
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find((p) => fs.existsSync(p))
if (!chrome) {
  console.log('skip: no Chrome found')
  process.exit(0)
}

const PDF = Buffer.from('%PDF-1.4 intro to science')
const PAGE = `<!doctype html><meta charset="utf-8"><body dir="rtl"><h1>חומרי לימוד - מבוא מדעי</h1>
<a href="/files/other.pdf">דף עבודה אחר</a><br><a href="/files/intro.pdf">מבוא מדעי - סיכום פרק 3</a></body>`
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/files/')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${path.basename(req.url)}"` })
    return res.end(PDF)
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(PAGE)
}).listen(WEB, '127.0.0.1')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-webtop-file-'))
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), `http://127.0.0.1:${WEB}/`], { stdio: 'ignore' })

let ok = true
const check = (name, cond, info = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); if (!cond) ok = false }
try {
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${WEB}`)) } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250))
  }
  if (!up) throw new Error(`Chrome did not start (${chrome})`)
  const { config } = await import('./config.js')
  config.webtop.port = PORT
  config.webtop.cloud = false
  config.webtop.url = `http://127.0.0.1:${WEB}/`
  const { downloadSessionFileHere } = await import('./session.js')
  const got = await downloadSessionFileHere(`http://127.0.0.1:${WEB}/`, 'סיכום פרק 3')
  check('the file named on the page is downloaded', got.name === 'intro.pdf', got.name)
  check('its bytes come back whole', Buffer.from(got.data, 'base64').equals(PDF))
  let missing = ''
  try { await downloadSessionFileHere(`http://127.0.0.1:${WEB}/`, 'מתמטיקה') } catch (e) { missing = e.message }
  check('a name that is not on the page is said so', missing.includes('לא מצאתי'), missing)
} catch (e) {
  check('ran', false, e.message)
} finally {
  proc.kill()
  server.close()
}
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
