'use strict'
const $ = (id) => document.getElementById(id)
const card = $('card'), heard = $('heard'), text = $('text'), ask = $('ask'), steps = $('steps')
const buttons = $('buttons'), note = $('note'), markEl = $('mark'), statusDot = $('status-dot')
let mode = 'hidden'

// ---- sound earcons (tactile audio cues) -----------------------------------------------------------
let audioCtx = null
function playTone(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    if (type === 'start') {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(520, now)
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12)
      gain.gain.setValueAtTime(0.04, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(now)
      osc.stop(now + 0.15)
    } else if (type === 'done') {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(659.25, now) // E5
      osc.frequency.setValueAtTime(880, now + 0.08) // A5
      gain.gain.setValueAtTime(0.035, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(now)
      osc.stop(now + 0.22)
    } else if (type === 'error') {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(320, now)
      osc.frequency.setValueAtTime(240, now + 0.09)
      gain.gain.setValueAtTime(0.05, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(now)
      osc.stop(now + 0.2)
    }
  } catch {}
}

// ---- waves: loud while listening, shimmer while thinking, subtle resting wave ----------------------
const canvas = $('waves'), g = canvas.getContext('2d')
let t = 0, shown = 0
function draw() {
  t += 0.055
  const w = canvas.width, h = canvas.height
  g.clearRect(0, 0, w, h)
  const live = mode === 'listening' ? Recorder.level() : mode === 'thinking' ? 0.25 + 0.08 * Math.sin(t * 1.5) : mode === 'answer' ? 0.05 : 0.08
  shown += (live - shown) * 0.25
  const colors = ['rgba(139,124,255,0.95)', 'rgba(79,209,255,0.80)', 'rgba(255,255,255,0.40)']
  for (let k = 0; k < 3; k++) {
    g.beginPath()
    for (let x = 0; x <= w; x += 2) {
      const env = Math.sin((x / w) * Math.PI)
      const y = h / 2 + Math.sin(x * (0.055 + k * 0.016) + t * (2.0 + k * 0.5) + k) * env * (3 + shown * (h * 0.44)) * (1 - k * 0.2)
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
    }
    g.strokeStyle = colors[k]
    g.lineWidth = 2.8 - k * 0.5
    g.lineCap = 'round'
    g.stroke()
  }
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)

// ---- markdown formatting -------------------------------------------------------------------------
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderFormatted(raw) {
  if (!raw) return ''
  // 1. Code blocks: ```lang ... ```
  let html = raw.replace(/```(?:[a-z]*)\r?\n([\s\S]*?)```/g, (m, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`
  })
  // 2. Inline code: `...`
  html = html.replace(/`([^`]+)`/g, (m, c) => `<code>${escapeHtml(c)}</code>`)
  // 3. Bold: **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, (m, b) => `<strong>${escapeHtml(b)}</strong>`)
  // 4. Bullet lists
  html = html.replace(/^[•\-\*]\s+(.+)$/gm, (m, item) => `• ${item}`)
  return html
}

// ---- state from the app --------------------------------------------------------------------------
function show(on) { card.classList.toggle('on', on) }

helper.on('state', (s) => {
  const prevMode = mode
  mode = s.mode
  markEl.classList.toggle('hidden', !s.mark)
  ask.classList.add('hidden')
  buttons.classList.add('hidden')
  text.classList.remove('error', 'copyable')
  note.textContent = ''
  steps.textContent = ''

  if (statusDot) {
    statusDot.className = 'dot'
    if (s.mode === 'listening') statusDot.classList.add('listening')
    else if (s.mode === 'thinking') statusDot.classList.add('thinking')
  }

  if (s.mode === 'hidden') {
    show(false)
    return
  }
  show(true)
  heard.textContent = s.heard || ''

  if (s.mode === 'listening') {
    if (prevMode !== 'listening') playTone('start')
    heard.textContent = ''
    text.innerHTML = '<span class="status">מקשיב… לחץ שוב לסיום (או שחרר אם החזקת)</span>'
  } else if (s.mode === 'thinking') {
    text.innerHTML = ''
    const st = document.createElement('span')
    st.className = 'status'
    st.textContent = s.text || 'חושב…'
    text.appendChild(st)
    for (const line of s.steps || []) {
      const d = document.createElement('div')
      d.textContent = line
      steps.appendChild(d)
    }
  } else if (s.mode === 'answer') {
    if (s.error) playTone('error')
    else if (prevMode === 'thinking') playTone('done')

    text.innerHTML = renderFormatted(s.text || '')
    text.classList.toggle('error', Boolean(s.error))
    text.classList.add('copyable')
    if (s.note) note.textContent = s.note
  } else if (s.mode === 'typing') {
    heard.textContent = ''
    text.textContent = ''
    ask.classList.remove('hidden')
    ask.value = ''
    setTimeout(() => ask.focus(), 30)
  } else if (s.mode === 'confirm') {
    text.textContent = s.text || 'לאשר?'
    buttons.classList.remove('hidden')
    note.textContent = 'Enter לאישור · Esc לביטול'
    setTimeout(() => $('yes').focus(), 30)
  }
})

// ---- microphone ----------------------------------------------------------------------------------
helper.on('record', async (r) => {
  if (r.action === 'start') {
    try {
      await Recorder.start(r.purpose)
    } catch (e) {
      mode = 'answer'
      playTone('error')
      text.textContent = 'אין גישה למיקרופון: ' + e.message
      text.classList.add('error')
    }
  } else {
    const wav = Recorder.stop(r.action === 'cancel')
    if (wav) helper.send('audio', { wav, purpose: r.purpose })
  }
})

// ---- HELPER voice playback -----------------------------------------------------------------------
helper.on('play', (sound) => {
  const a = $('voice')
  if (!sound) { a.pause(); a.removeAttribute('src'); return }
  a.src = 'data:' + (sound.mime || 'audio/mpeg') + ';base64,' + sound.b64
  a.play()
    .then(() => helper.send('voice-state', 'playing ' + (sound.mime || '')))
    .catch((e) => helper.send('voice-state', 'failed: ' + e.message))
})

// ---- interactions --------------------------------------------------------------------------------
ask.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    const v = ask.value.trim()
    ask.value = ''
    helper.send('typed', v)
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    helper.send('dismiss')
  }
})

$('yes').onclick = () => helper.send('confirm', true)
$('no').onclick = () => helper.send('confirm', false)

document.addEventListener('keydown', (e) => {
  if (mode !== 'confirm') return
  if (e.key === 'Enter') { e.preventDefault(); helper.send('confirm', document.activeElement !== $('no')) }
  if (e.key === 'Escape') { e.preventDefault(); helper.send('confirm', false) }
})

text.addEventListener('click', async () => {
  if (mode !== 'answer' || !text.innerText) return
  try {
    await navigator.clipboard.writeText(text.innerText)
    note.textContent = '✓ הועתק ללוח'
    setTimeout(() => { if (note.textContent === '✓ הועתק ללוח') note.textContent = '' }, 2500)
  } catch {}
})

card.addEventListener('mouseenter', () => helper.send('hover', true))
card.addEventListener('mouseleave', () => helper.send('hover', false))
