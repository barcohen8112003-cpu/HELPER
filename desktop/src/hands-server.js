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
      try {
        onStep && onStep(step)
        const text = await hands.run(step)
        if (record) record.push({ cmd: step.cmd, args: step.args || {}, ok: true })
        send(200, { ok: true, text: String(text ?? '') })
      } catch (e) {
        if (record) record.push({ cmd: step.cmd, args: step.args || {}, ok: false })
        send(200, { ok: false, error: e.message })
      }
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
