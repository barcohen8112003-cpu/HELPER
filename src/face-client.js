// In-browser HELPER face. Plays the audio the server already made and moves the mouth from the spectrum.
// If JPEG frames arrive from the home PC, they replace the drawing. If a WebRTC answer arrives, that video is used.
import { visemeFromBins } from '/face/viseme.js'

const statusEl = document.getElementById('status')
const caption = document.getElementById('caption')
const canvas = document.getElementById('face')
const frame = document.getElementById('frame')
const video = document.getElementById('live')
const playBtn = document.getElementById('play')
const ctx = canvas.getContext('2d')
const audio = new Audio()
audio.preload = 'auto'

let hello = { enabled: true, pc: false, lipDelayMs: 350, webrtc: false }
let sessionId = ''
let mouth = { shape: 'closed', open: 0 }
let blink = 0
let nextBlink = 0
let graph = null
let freq = null
let speaking = false
let synth = null
let playTimer = 0
let pendingPlay = null
let frameUrl = ''
let pc = null

function setStatus(text) {
  statusEl.textContent = text
}

function b64(data) {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function ellipse(x, y, rx, ry) {
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()
}

function draw() {
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#121c22'
  ctx.fillRect(0, 0, w, h)
  const s = w / 256
  const e = (cx, cy, rx, ry, color) => {
    ctx.fillStyle = color
    ellipse(cx * s, cy * s, rx * s, ry * s)
  }
  e(128, 214, 30, 40, '#d6a484')
  e(128, 250, 96, 42, '#20343e')
  e(128, 112, 92, 104, '#302428')
  e(128, 122, 70, 82, '#e8ba96')
  e(54, 128, 14, 20, '#d69e7e')
  e(202, 128, 14, 20, '#d69e7e')
  e(128, 58, 74, 32, '#302428')
  const shut = blink > 0.65
  if (shut) {
    ctx.strokeStyle = '#2a211c'
    ctx.lineWidth = 3 * s
    ctx.beginPath()
    ctx.moveTo(84 * s, 114 * s)
    ctx.lineTo(116 * s, 114 * s)
    ctx.moveTo(140 * s, 114 * s)
    ctx.lineTo(172 * s, 114 * s)
    ctx.stroke()
  } else {
    e(100, 114, 16, 11, '#fff8f2')
    e(156, 114, 16, 11, '#fff8f2')
    e(102, 116, 6, 6, '#186872')
    e(158, 116, 6, 6, '#186872')
    e(104, 114, 2, 2, '#fff')
    e(160, 114, 2, 2, '#fff')
  }
  e(128, 138, 5, 8, '#d29a78')
  const open = mouth.open
  const shape = mouth.shape
  ctx.fillStyle = '#5c3030'
  if (shape === 'closed' || open < 0.08) {
    ctx.strokeStyle = '#92524c'
    ctx.lineWidth = 3 * s
    ctx.beginPath()
    ctx.moveTo(106 * s, 168 * s)
    ctx.quadraticCurveTo(128 * s, 174 * s, 150 * s, 168 * s)
    ctx.stroke()
  } else {
    const wide = shape === 'ee' || shape === 'wide' ? 26 + open * 10 : shape === 'oh' ? 14 : 18
    const tall = shape === 'ee' ? 6 + open * 6 : shape === 'oh' ? 12 + open * 10 : 8 + open * 16
    e(128, 170, wide, tall, '#5c3030')
    if (open > 0.45) e(128, 166, wide * 0.55, 3, '#e8b8b4')
  }
  ctx.fillStyle = '#1f9694'
  ctx.beginPath()
  ctx.moveTo(128 * s, 190 * s)
  ctx.lineTo(136 * s, 198 * s)
  ctx.lineTo(128 * s, 206 * s)
  ctx.lineTo(120 * s, 198 * s)
  ctx.fill()
}

function loop(now) {
  if (!nextBlink) nextBlink = now + 2800
  if (now > nextBlink) {
    blink = Math.min(1, blink + 0.18)
    if (blink >= 1) nextBlink = now + 2600 + Math.random() * 2400
  } else if (blink > 0) blink = Math.max(0, blink - 0.2)
  if (speaking && graph && frame.hidden && video.hidden) {
    graph.an.getByteFrequencyData(freq)
    const bins = new Array(freq.length)
    for (let i = 0; i < freq.length; i++) bins[i] = freq[i] / 255
    mouth = visemeFromBins(bins)
  } else if (speaking && synth) {
    mouth = { shape: 'ah', open: 0.35 + 0.4 * Math.abs(Math.sin(now / 110)) }
  } else if (!speaking) mouth = { shape: 'closed', open: 0 }
  if (canvas.hidden === false) draw()
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

function stopSynth() {
  synth = null
  if (window.speechSynthesis) speechSynthesis.cancel()
}

function ensureGraph() {
  if (graph) return graph
  const ac = new AudioContext()
  const src = ac.createMediaElementSource(audio)
  const an = ac.createAnalyser()
  an.fftSize = 512
  an.smoothingTimeConstant = 0.55
  const gain = ac.createGain()
  src.connect(an)
  an.connect(gain)
  gain.connect(ac.destination)
  freq = new Uint8Array(an.frequencyBinCount)
  graph = { ac, an, gain }
  return graph
}

function startAudio(msg) {
  stopSynth()
  speaking = true
  if (msg.audio) {
    const type = msg.mime && msg.mime.startsWith('audio/') ? msg.mime : 'audio/mpeg'
    const blob = new Blob([b64(msg.audio)], { type })
    const url = URL.createObjectURL(blob)
    audio.src = url
    audio.onended = () => {
      speaking = false
      URL.revokeObjectURL(url)
      setStatus(hello.pc ? 'המחשב הביתי מחובר' : 'פנים במכשיר הזה')
    }
    const run = () => {
      ensureGraph()
      graph.gain.gain.value = msg.silent ? 0 : 1
      graph.ac.resume().catch(() => {})
      audio.play().then(() => {
        playBtn.classList.remove('on')
      }).catch(() => {
        playBtn.classList.add('on')
        setStatus('לחצו לנגן')
      })
    }
    run()
    return
  }
  if (msg.text && window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(msg.text)
    u.lang = 'he-IL'
    synth = u
    u.onend = () => {
      speaking = false
      synth = null
    }
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
    return
  }
  speaking = false
}

function begin(msg) {
  sessionId = msg.sessionId || ''
  caption.textContent = msg.text || ''
  clearTimeout(playTimer)
  frame.hidden = true
  video.hidden = true
  canvas.hidden = false
  if (frameUrl) {
    URL.revokeObjectURL(frameUrl)
    frameUrl = ''
  }
  const delay = hello.pc ? Number(hello.lipDelayMs) || 0 : 60
  pendingPlay = () => startAudio(msg)
  playTimer = setTimeout(() => {
    pendingPlay?.()
    pendingPlay = null
  }, delay)
  setStatus(hello.pc ? 'מדבר מהמחשב הביתי' : 'פנים במכשיר הזה')
}

function showFrame(msg) {
  if (msg.sessionId && sessionId && msg.sessionId !== sessionId) return
  let bytes
  try {
    bytes = b64(msg.jpeg)
  } catch {
    return
  }
  if (pendingPlay) {
    clearTimeout(playTimer)
    const wait = Number(hello.lipDelayMs) || 350
    playTimer = setTimeout(() => {
      pendingPlay?.()
      pendingPlay = null
    }, wait)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  if (frameUrl) URL.revokeObjectURL(frameUrl)
  frameUrl = url
  frame.src = url
  frame.hidden = false
  canvas.hidden = true
  video.hidden = true
  setStatus('מדבר מהמחשב הביתי')
}

async function tryWebrtc(msg) {
  if (!hello.webrtc || !navigator.mediaDevices) return
  pc?.close()
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = (ev) => {
    video.srcObject = ev.streams[0]
    video.hidden = false
    frame.hidden = true
    canvas.hidden = true
    audio.pause()
    speaking = true
    video.play().catch(() => playBtn.classList.add('on'))
  }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, 2500)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  ws?.send(JSON.stringify({ t: 'offer', sdp: pc.localDescription.sdp, type: 'offer', sessionId: msg.sessionId || '' }))
}

playBtn.addEventListener('click', () => {
  if (video.srcObject) video.play().catch(() => {})
  else audio.play().then(() => playBtn.classList.remove('on')).catch(() => {})
  graph?.ac.resume().catch(() => {})
})

let ws
let retry = 1000
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/face/watch`)
  ws.onopen = () => {
    retry = 1000
  }
  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.t === 'hello' || msg.t === 'status') {
      hello = { ...hello, ...msg }
      if (msg.enabled === false) {
        setStatus('הפנים כבויות. בהגדרות: FACE_ENABLED=on')
        caption.textContent = 'כשזה דלוק, הדף הזה מראה את הפנים בזמן שהעוזר מדבר. אם המחשב הביתי כבוי, הפנים מצוירות כאן.'
        return
      }
      setStatus(msg.pc ? 'המחשב הביתי מחובר' : 'פנים במכשיר הזה')
      return
    }
    if (msg.t === 'speech') {
      begin(msg)
      if (hello.webrtc) tryWebrtc(msg).catch(() => {})
      return
    }
    if (msg.t === 'engine' && msg.engine === 'pc') {
      hello.pc = true
      setStatus('מדבר מהמחשב הביתי')
      return
    }
    if (msg.t === 'frame') showFrame(msg)
    if (msg.t === 'answer' && pc) {
      pc.setRemoteDescription({ type: msg.type || 'answer', sdp: msg.sdp }).catch(() => {})
    }
  }
  ws.onclose = () => {
    setStatus('מתחבר מחדש…')
    setTimeout(connect, retry)
    retry = Math.min(8000, retry * 2)
  }
}
connect()
draw()
