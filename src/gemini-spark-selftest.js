// runSpark against a stand-in Gemini page in a real Chrome: it picks Spark from the mode picker, attaches a file,
// sends the task, waits while "Spark" keeps working, and returns the Google Docs link that shows up later.
// Needs Chrome or Chromium (CHROME_PATH, or the usual install places). Run: node src/gemini-spark-selftest.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const PORT = 9341
const WEB = 9342
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find((p) => fs.existsSync(p))
if (!chrome) {
  console.log('skip: no Chrome found')
  process.exit(0)
}

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<button aria-label="Open mode picker" id="mode">2.5 Flash</button>
<div id="menu" hidden><div role="menuitem" id="spark">Spark</div><div role="menuitem">Deep Research</div></div>
<div id="files"></div>
<button aria-label="Upload files" id="up">+</button><input type="file" id="fi" hidden>
<div contenteditable="true" role="textbox" id="box"></div>
<button aria-label="Send message" id="send">send</button>
<div id="chat"></div>
<script>
window.picked = ''; window.sent = []
mode.onclick = () => { menu.hidden = false }
spark.onclick = () => { window.picked = 'spark'; menu.hidden = true; mode.textContent = 'Spark' }
up.onclick = () => fi.click()
fi.onchange = () => { for (const f of fi.files) { const d = document.createElement('div'); d.className = 'file-preview'; d.textContent = f.name; files.appendChild(d) } }
send.onclick = () => {
  window.sent.push({ text: box.innerText, files: files.children.length })
  box.innerText = ''
  const r = document.createElement('model-response')
  r.innerText = 'Spark מתחיל לעבוד על המסמך...'
  chat.appendChild(r)
  setTimeout(() => { r.innerHTML = 'הנה המסמך: <a href="https://docs.google.com/document/d/AbC123_x/edit">מבוא מדעי - סיכום</a>' }, 7000)
}
</script>`

const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE) }).listen(WEB, '127.0.0.1')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-spark-'))
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', `http://127.0.0.1:${WEB}/`], { stdio: 'ignore' })

process.env.GEMINI_URL = `http://127.0.0.1:${WEB}/`
process.env.GEMINI_DEBUG_PORT = String(PORT)
process.env.GEMINI_CLOUD = 'off'
let ok = true
const check = (name, cond, info = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); if (!cond) ok = false }
try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  const { runSpark } = await import('./gemini.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-spark-work-'))
  const file = path.join(dir, 'intro-science.pdf')
  fs.writeFileSync(file, '%PDF-1.4 stand-in')
  const steps = []
  const t0 = Date.now()
  const done = await runSpark({ prompt: 'תעשה מהקובץ מסמך דוקס מסודר', files: [file], dir, timeoutMs: 120000, onStep: (s) => steps.push(s) })
  check('returns the Docs link that appeared later', done.url === 'https://docs.google.com/document/d/AbC123_x/edit', done.url)
  check('Spark was picked from the mode picker', done.spark === true)
  check('waited for Spark to finish', Date.now() - t0 >= 7000, `${Date.now() - t0} ms`)
  check('told what it was doing', steps.length >= 2, steps.join(' / '))
} catch (e) {
  check('ran', false, e.message)
} finally {
  proc.kill()
  server.close()
}
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
