#!/usr/bin/env node
// HELPER's hands for Claude Code: node hands.mjs <cmd> '<json args>'. Talks to the running HELPER app on this PC.
//   node hands.mjs windows
//   node hands.mjs place '{"name":"Chrome","where":"left"}'
import fs from 'node:fs'
import path from 'node:path'

const [cmd, json] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: hands.mjs <cmd> [json]')
  process.exit(2)
}
let args = {}
if (json) {
  try { args = JSON.parse(json) } catch (e) {
    console.error('the arguments must be JSON in single quotes, e.g. \'{"name":"Chrome"}\'')
    process.exit(2)
  }
}
const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
let conf
try {
  conf = JSON.parse(fs.readFileSync(path.join(base, 'helper-desktop', 'hands.json'), 'utf8'))
} catch {
  console.error('HELPER for Windows is not running')
  process.exit(3)
}
try {
  const r = await fetch(`http://127.0.0.1:${conf.port}/hands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + conf.token },
    body: JSON.stringify({ cmd, args }),
  })
  const j = await r.json()
  if (!j.ok) {
    console.error(j.error || 'failed')
    process.exit(1)
  }
  if (j.text) console.log(j.text)
} catch (e) {
  console.error('HELPER for Windows did not answer: ' + e.message)
  process.exit(3)
}
