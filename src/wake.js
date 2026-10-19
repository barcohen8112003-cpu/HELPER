// Wake-on-LAN: turning on the user's own PC with a "magic packet" (6 bytes of 0xFF, then the card's MAC 16 times).
// A packet only reaches the PC from a machine on the same home network. So there are two ways out of here:
//   direct: this program runs on the home network (a Raspberry Pi, a mini PC) and broadcasts the packet itself;
//   relay:  this program runs elsewhere (a cloud server). It posts a signed request to a public topic, and a small
//           script on any always-on device at home (home-relay/wake-relay.mjs) picks it up and broadcasts the packet.
import dgram from 'node:dgram'
import { createHmac, randomBytes } from 'node:crypto'
import { config } from './config.js'

const MIN_GAP = 90000
let lastWake = 0

export const wakeEnabled = () => Boolean(config.wake.mac)

const macHex = (mac) => {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (hex.length !== 12) throw new Error('כתובת MAC לא תקינה: צריך 12 ספרות הקסדצימליות')
  return hex
}

export function magicPacket(mac) {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(macHex(mac), 'hex'))])
}

// Broadcasts the packet on every address and port a network card is likely to listen on.
export function sendDirect(mac, { addresses = ['255.255.255.255', config.wake.broadcast], ports = [9, 7] } = {}) {
  const packet = magicPacket(mac)
  const targets = [...new Set(addresses.filter(Boolean))].flatMap((a) => ports.map((p) => [a, p]))
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', (e) => (socket.close(), reject(e)))
    socket.bind(() => {
      socket.setBroadcast(true)
      let left = targets.length
      for (const [address, port] of targets) {
        socket.send(packet, port, address, () => --left === 0 && (socket.close(), resolve(targets.length)))
      }
    })
  })
}

// "wake <unix seconds> <nonce> <signature>". The signature covers the time, the nonce and the MAC, so a captured
// message cannot be altered, and the relay refuses an old or repeated one.
export function signWake(secret, mac, now = Date.now(), nonce = randomBytes(8).toString('hex')) {
  const ts = Math.floor(now / 1000)
  const sig = createHmac('sha256', secret).update(`wake|${ts}|${nonce}|${macHex(mac)}`).digest('hex')
  return `wake ${ts} ${nonce} ${sig}`
}

async function publish(message) {
  const { relayBase, relayTopic } = config.wake
  const res = await fetch(`${relayBase}/${relayTopic}`, { method: 'POST', body: message, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`שרת ההעברה ענה ${res.status}`)
}

// Wakes the PC every way that is set up. Returns what was done, in words.
export async function wakePc() {
  const { mac, relayTopic, secret } = config.wake
  if (!mac) throw new Error('לא הוגדרה כתובת MAC של המחשב (WAKE_MAC)')
  if (Date.now() - lastWake < MIN_GAP) return 'כבר שלחתי הדלקה לפני פחות מדקה וחצי. המחשב לוקח בדרך כלל חצי דקה עד דקה לעלות.'
  lastWake = Date.now()
  const done = []
  try {
    await sendDirect(mac)
    done.push('חבילת הדלקה נשלחה ישירות ברשת')
  } catch (e) {
    done.push(`שליחה ישירה נכשלה (${e.message})`)
  }
  if (relayTopic && secret) {
    try {
      await publish(signWake(secret, mac))
      done.push('בקשת הדלקה נשלחה למשדר הביתי')
    } catch (e) {
      done.push(`הבקשה למשדר הביתי נכשלה (${e.message})`)
    }
  }
  return `${done.join('; ')}. אם ההשכמה מוגדרת נכון המחשב יעלה בתוך כדקה.`
}
