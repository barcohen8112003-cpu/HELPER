// Where Claude Code's time goes on this PC: process start to its first line, to the first answer, to the end.
// Also tries a kept-open process (stream-json input) answering two asks in a row. Run: node test/claude-timing.js
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const exe = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')).find((p) => fs.existsSync(p))
const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands', '--tools', 'Bash', 'Read']

function once(text) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const marks = {}
    const p = spawn(exe, base, { cwd: require('os').tmpdir() })
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let ev; try { ev = JSON.parse(line) } catch { continue }
        if (!marks.first) marks.first = Date.now() - t0
        if (ev.type === 'assistant' && !marks.answer) marks.answer = Date.now() - t0
        if (ev.type === 'result') marks.done = Date.now() - t0
      }
    })
    p.on('close', () => resolve(marks))
    p.stdin.end(text)
  })
}

function kept(texts) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const times = []
    let start = t0
    const p = spawn(exe, [...base, '--input-format', 'stream-json'], { cwd: require('os').tmpdir() })
    let buf = ''
    let n = 0
    const send = () => { start = Date.now(); p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: texts[n] } }) + '\n') }
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let ev; try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'result') {
          times.push({ ask: texts[n], ms: Date.now() - start, result: ev.result })
          n++
          if (n < texts.length) send(); else p.stdin.end()
        }
      }
    })
    p.on('close', () => resolve({ startToFirstAsk: times.length ? 0 : null, times }))
    send()
  })
}

;(async () => {
  console.log('one process per ask:', JSON.stringify(await once('ענה במילה אחת: בירת צרפת?')))
  const k = await kept(['ענה במילה אחת: בירת צרפת?', 'ענה במילה אחת: בירת איטליה?', 'ענה במילה אחת: בירת ספרד?'])
  for (const t of k.times) console.log('kept open:', t.ms, 'ms →', t.result)
})()
