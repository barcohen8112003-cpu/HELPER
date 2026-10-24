// The hands, over a local HTTP port for Claude Code: bin/hands.mjs posts {cmd, args} here. Only this PC can reach it
// (127.0.0.1), and only with the random key written to hands.json under the app's folder each start.
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const hands = require('./hands')

let server = null
let record = null   // the current ask's steps, for learning: [{cmd, args, ok}]

function start(dataDir, onStep) {
  const token = crypto.randomBytes(24).toString('hex')
  server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || req.url !== '/hands') return send(404, { error: 'not found' })
    if ((req.headers.authorization || '') !== 'Bearer ' + token) return send(403, { error: 'forbidden' })
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
    req.on('end', async () => {
      let step
      try { step = JSON.parse(body) } catch { return send(400, { error: 'bad json' }) }
      if (!step || typeof step.cmd !== 'string') return send(400, { error: 'no cmd' })
      // batch: {cmd:"batch", args:{steps:[{cmd,args}...]}}: several steps in one call, in order, one line back for
      // each. A step that fails stops the rest and says which one failed. Saves a round trip per step.
      const steps = step.cmd === 'batch' ? (step.args && Array.isArray(step.args.steps) ? step.args.steps.slice(0, 12) : null) : [step]
      if (!steps) return send(200, { ok: false, error: 'batch needs {"steps":[{"cmd":...,"args":{...}}]}' })
      const lines = []
      for (let i = 0; i < steps.length; i++) {
        const one = steps[i]
        try {
          if (!one || typeof one.cmd !== 'string' || one.cmd === 'batch') throw new Error('step ' + (i + 1) + ': no cmd')
          onStep && onStep(one)
          const text = await hands.run(one)
          if (record) record.push({ cmd: one.cmd, args: one.args || {}, ok: true })
          if (text) lines.push(String(text))
          if (one.cmd === 'open' && i < steps.length - 1) await new Promise((r) => setTimeout(r, 300))   // the window appears
        } catch (e) {
          if (record && one && one.cmd) record.push({ cmd: one.cmd, args: one.args || {}, ok: false })
          const done = lines.length ? 'כבר בוצע: ' + lines.join(' · ') + '. ' : ''
          return send(200, { ok: false, error: done + (steps.length > 1 ? 'צעד ' + (i + 1) + ' נכשל: ' : '') + e.message })
        }
      }
      send(200, { ok: true, text: lines.join('\n') })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      fs.writeFileSync(path.join(dataDir, 'hands.json'), JSON.stringify({ port, token }))
      resolve(port)
    })
  })
}

const startRecording = () => { record = [] }
const stopRecording = () => { const r = record; record = null; return r || [] }

module.exports = { start, startRecording, stopRecording }
