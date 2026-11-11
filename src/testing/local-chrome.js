// A real local Chrome for self-tests, driven over the Chrome DevTools Protocol with the project's own `ws`, so a
// browser test runs wherever a Chrome or Chromium binary exists, Playwright or not. Nothing here is used in
// production. No network beyond 127.0.0.1 is needed: the tests serve their own pages.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

export function chromePath() {
  const fixed = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux64/chrome',
    ...(process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]) : [])]
  const pw = '/opt/pw-browsers'
  const found = fs.existsSync(pw)
    ? fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).flatMap((d) => ['chrome-linux64', 'chrome-linux'].map((sub) => path.join(pw, d, sub, 'chrome')))
    : []
  return [...fixed, ...found].filter(Boolean).find((p) => fs.existsSync(p)) || null
}

// -> { call(method, params), navigate(url), evaluate(expression), close() } on one page target.
// A busy CI runner can take more than 10 s to bring Chrome up (seen on GitHub Actions right after the heavy desktop
// self-test), so the wait is 30 s and a launch that still fails is tried once more with a fresh profile.
export async function launchChrome(opts = {}) {
  try {
    return await launchOnce(opts)
  } catch (e) {
    if (!/debugging port/.test(e.message)) throw e
    return launchOnce(opts)
  }
}

async function launchOnce({ binary = chromePath(), width = 1000, height = 700 } = {}) {
  if (!binary) return null
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-chrome-'))
  const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-600) })
  let exited = null
  child.once('exit', (code, sig) => { exited = sig || code })
  const cleanup = () => {
    try { child.kill('SIGKILL') } catch {}
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300).unref()
  }
  try {
    let port
    for (let i = 0; i < 600 && !port && exited === null; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch {}
      if (!port) await new Promise((r) => setTimeout(r, 50))
    }
    if (!port) throw new Error(`Chrome did not open a debugging port${exited !== null ? ` (exited: ${exited})` : ''}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    let id = 0
    const pending = new Map()
    const listeners = new Set()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      } else if (m.method) for (const l of listeners) l(m)
    })
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
    await call('Page.enable')
    await call('Runtime.enable')
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    const navigate = async (url) => {
      const loaded = new Promise((resolve) => {
        const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.delete(l); resolve() } }
        listeners.add(l)
      })
      await call('Page.navigate', { url })
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))])
    }
    const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
    return { call, navigate, evaluate, close: () => { try { ws.close() } catch {} cleanup() } }
  } catch (e) {
    cleanup()
    throw e
  }
}
