// Talks to the face service on this machine only. The cloud never calls this directly:
// homeHandlers() runs it on the Windows PC, where 127.0.0.1 is the GPU box.
// A FACE_LOCAL_URL that is not loopback is ignored, so the bridge secret cannot be sent off-box.
import { config } from './config.js'

export function localFaceUrl() {
  const raw = process.env.FACE_LOCAL_URL || config.face.localUrl || 'http://127.0.0.1:8771'
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:') return ''
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return ''
  if (url.username || url.password) return ''
  return url.origin
}

async function call(pathname, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const secret = config.pcBridge.secret
  const base = localFaceUrl()
  if (!secret || !base) return { ok: false, running: false, engine: 'unavailable', error: 'no local face' }
  try {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { ok: false, error: 'bad json' }
    }
    if (!res.ok) return { ok: false, running: false, engine: 'unavailable', error: data.error || `http ${res.status}` }
    return data
  } catch (e) {
    return { ok: false, running: false, engine: 'unavailable', error: e.message }
  }
}

export const faceStatus = () => call('/health', { timeoutMs: 2500 })
export const faceAudio = (body) => call('/audio', { method: 'POST', body, timeoutMs: 20000 })
export const faceSignal = (body) => call('/signal', { method: 'POST', body, timeoutMs: 15000 })
export const faceClose = (body) => call('/close', { method: 'POST', body, timeoutMs: 4000 })

// Forwards JPEG frames from the local service to the cloud socket. Outbound only.
// Returns a stop function. Does nothing when this process is not the home bridge.
export function startFacePump(ws, secret) {
  let stopped = false
  let since = 0
  let lastKey = ''
  let lastSent = 0
  const loop = async () => {
    const base = localFaceUrl()
    if (!base || !secret || process.env.PC_BRIDGE_EXECUTOR !== '1') return
    while (!stopped && ws.readyState === 1) {
      try {
        const res = await fetch(`${base}/frames?since=${since}`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8000),
        })
        if (res.status === 401) {
          console.log('[face] השירות המקומי דחה את הסוד של הגשר')
          return
        }
        if (!res.ok) throw new Error(`http ${res.status}`)
        const body = await res.json()
        const { seal } = await import('./pc-bridge.js')
        for (const frame of body.frames || []) {
          since = Math.max(since, Number(frame.seq) || 0)
          if (!frame.jpeg || String(frame.jpeg).length > 200000) continue
          ws.send(seal(secret, {
            t: 'event',
            name: 'face',
            data: { t: 'frame', sid: String(frame.sid || ''), seq: frame.seq, jpeg: frame.jpeg },
          }))
        }
        const st = body.status
        if (st) {
          const key = `${Boolean(st.running)}|${st.engine || ''}|${st.relay !== false}`
          const now = Date.now()
          if (key !== lastKey || now - lastSent > 10000) {
            lastKey = key
            lastSent = now
            ws.send(seal(secret, {
              t: 'event',
              name: 'face',
              data: { t: 'status', running: Boolean(st.running), engine: st.engine || 'unavailable', relay: st.relay !== false },
            }))
          }
        }
      } catch {
        if (stopped) return
        await new Promise((r) => setTimeout(r, 4000))
      }
    }
  }
  loop()
  return () => {
    stopped = true
  }
}
