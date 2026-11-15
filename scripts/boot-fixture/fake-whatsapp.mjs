// A stand-in for src/whatsapp.js in the boot fixture. It is "connected" at once, never touches the network, and
// writes each send to BOOT_FIXTURE_LOG (one JSON line), so the test can see exactly what the owner would get.
import fs from 'node:fs'

const log = (entry) => fs.appendFileSync(process.env.BOOT_FIXTURE_LOG, JSON.stringify({ ...entry, at: Date.now() }) + '\n')
const pairing = { qr: '', code: '', number: '' }
export const pairingInfo = () => ({ ...pairing })
export const publishPairing = (next = {}) => Object.assign(pairing, next)
export const requestPairing = async () => ({ code: '', number: '' })
export const pairingNumber = (raw) => String(raw || '').replace(/\D/g, '')

export async function startWhatsApp(onMessage, onReady = () => {}) {
  const openedAt = Date.now()
  log({ type: 'start' })
  setTimeout(() => Promise.resolve(onReady({ jid: '972500000000@s.whatsapp.net', lid: null })).catch((e) => log({ type: 'error', message: e.message })), 50)
  const tracked = async (kind, jid) => (log({ type: kind, jid }), `FAKE${Date.now()}`)
  return {
    async send(jid, text) {
      log({ type: 'send', jid, text })
      return `FAKE${Date.now()}`
    },
    sendAs: (jid, text) => (log({ type: 'sendAs', jid, text }), Promise.resolve(`FAKE${Date.now()}`)),
    sendVoice: (jid) => tracked('voice', jid),
    sendMedia: (jid) => tracked('media', jid),
    react: (jid) => tracked('react', jid),
    findContact: async () => ({ error: 'fixture' }),
    connectedSince: () => openedAt,
    typing: () => {},
  }
}
