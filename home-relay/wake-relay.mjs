// Runs on any always-on device in the home (Raspberry Pi, mini PC, NAS, a phone with Termux). Needs Node 18 or newer
// and nothing else. It listens for signed wake requests on a topic and broadcasts the magic packet to the PC.
// It only makes outgoing connections: no port is opened on the router.
//
//   node wake-relay.mjs            (reads config.json next to this file)
//
// config.json: { "topic": "...", "secret": "...", "mac": "74-56-3C-E5-17-D9", "broadcast": ["192.168.0.255"],
//                "port": 9, "base": "https://ntfy.sh" }
import dgram from 'node:dgram'
import fs from 'node:fs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const file = process.env.WAKE_RELAY_CONFIG || path.join(dir, 'config.json')
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
const BASE = (cfg.base || 'https://ntfy.sh').replace(/\/+$/, '')
const PORTS = cfg.port ? [Number(cfg.port)] : [9, 7]
const ADDRESSES = [...new Set(['255.255.255.255', ...[].concat(cfg.broadcast || [])])]
const MAX_AGE = 90
const hex = String(cfg.mac).replace(/[^0-9a-f]/gi, '').toLowerCase()
if (hex.length !== 12 || !cfg.topic || !cfg.secret) throw new Error('config.json needs topic, secret and a valid mac')
const PACKET = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))])
const seen = new Map()
const log = (line) => console.log(`${new Date().toLocaleString('sv-SE')} ${line}`)

function valid(message) {
  const [verb, ts, nonce, sig] = String(message).trim().split(/\s+/)
  if (verb !== 'wake' || !/^\d+$/.test(ts) || !/^[0-9a-f]{8,32}$/.test(nonce || '') || !/^[0-9a-f]{64}$/.test(sig || '')) return 'malformed'
  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (age > MAX_AGE) return 'too old'
  const want = createHmac('sha256', cfg.secret).update(`wake|${ts}|${nonce}|${hex}`).digest()
  if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) return 'bad signature'
  if (seen.has(nonce)) return 'repeat'
  seen.set(nonce, Date.now())
  for (const [n, at] of seen) if (Date.now() - at > MAX_AGE * 2000) seen.delete(n)
  return null
}

function broadcast() {
  const socket = dgram.createSocket('udp4')
  socket.bind(() => {
    socket.setBroadcast(true)
    const targets = ADDRESSES.flatMap((a) => PORTS.map((p) => [a, p]))
    let left = targets.length
    for (const [address, port] of targets) socket.send(PACKET, port, address, () => --left === 0 && socket.close())
  })
}

async function listen() {
  const since = Math.floor(Date.now() / 1000)
  const res = await fetch(`${BASE}/${cfg.topic}/json?since=${since}`)
  if (!res.ok) throw new Error(`server answered ${res.status}`)
  log('listening')
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true })
    let i
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim()
      pending = pending.slice(i + 1)
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.event !== 'message') continue
      const problem = valid(event.message)
      if (problem) log(`ignored a request: ${problem}`)
      else {
        broadcast()
        log('wake request accepted, magic packet sent')
      }
    }
  }
}

let wait = 2000
for (;;) {
  try {
    await listen()
    wait = 2000
  } catch (e) {
    log(`connection lost (${e.message}), retrying in ${wait / 1000}s`)
  }
  await new Promise((r) => setTimeout(r, wait))
  wait = Math.min(60000, wait * 2)
}
