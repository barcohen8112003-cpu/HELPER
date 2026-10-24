'use strict'
const $ = (id) => document.getElementById(id)
const card = $('card'), heard = $('heard'), text = $('text'), ask = $('ask'), steps = $('steps'), buttons = $('buttons'), note = $('note'), markEl = $('mark')
let mode = 'hidden'

// ---- the waves: loud while listening, a slow shimmer while thinking, still otherwise -------------
const canvas = $('waves'), g = canvas.getContext('2d')
let t = 0, shown = 0
function draw() {
  t += 0.06
  const w = canvas.width, h = canvas.height
  g.clearRect(0, 0, w, h)
  const live = mode === 'listening' ? Recorder.level() : mode === 'thinking' ? 0.22 + 0.08 * Math.sin(t * 1.3) : mode === 'answer' ? 0.06 : 0.1
  shown += (live - shown) * 0.25
  const colors = ['rgba(139,124,255,0.95)', 'rgba(79,209,255,0.75)', 'rgba(255,255,255,0.45)']
  for (let k = 0; k < 3; k++) {
    g.beginPath()
    for (let x = 0; x <= w; x += 2) {
      const env = Math.sin((x / w) * Math.PI)
      const y = h / 2 + Math.sin(x * (0.06 + k * 0.018) + t * (2.2 + k * 0.6) + k) * env * (4 + shown * (h * 0.42)) * (1 - k * 0.22)
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
    }
    g.strokeStyle = colors[k]
    g.lineWidth = 3 - k * 0.6
    g.lineCap = 'round'
    g.stroke()
  }
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)

// ---- state from the app ------------------------------------------------------------------------
function show(on) { card.classList.toggle('on', on) }

helper.on('state', (s) => {
  mode = s.mode
  markEl.classList.toggle('hidden', !s.mark)
  ask.classList.add('hidden')
  buttons.classList.add('hidden')
  text.classList.remove('error', 'copyable')
  note.textContent = ''
  steps.textContent = ''
  if (s.mode === 'hidden') { show(false); return }
  show(true)
  heard.textContent = s.heard || ''
  if (s.mode === 'listening') {
    heard.textContent = ''
    text.innerHTML = '<span class="status">מקשיב… עזוב את המקשים כשסיימת</span>'
  } else if (s.mode === 'thinking') {
    text.innerHTML = ''
    const st = document.createElement('span')
    st.className = 'status'
    st.textContent = s.text || 'רגע…'
    text.appendChild(st)
    for (const line of s.steps || []) { const d = document.createElement('div'); d.textContent = line; steps.appendChild(d) }
  } else if (s.mode === 'answer') {
    text.textContent = s.text || ''
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
    note.textContent = 'Enter לאישור · Esc לביטול · או להגיד כן / לא'
    setTimeout(() => $('yes').focus(), 30)
  } else if (s.mode === 'hint') {
    heard.textContent = ''
    text.innerHTML = ''
    const st = document.createElement('span')
    st.className = 'status'
    st.textContent = s.text || ''
    text.appendChild(st)
  }
})

// ---- the microphone ------------------------------------------------------------------------------
helper.on('record', async (r) => {
  if (r.action === 'start') {
    try { await Recorder.start(r.purpose) } catch (e) {
      mode = 'answer'
      text.textContent = 'אין גישה למיקרופון. בודקים בהגדרות Windows ← פרטיות ← מיקרופון שמותר לאפליקציות שולחן עבודה.'
      text.classList.add('error')
    }
  } else {
    const wav = Recorder.stop(r.action === 'cancel')
    if (wav) helper.send('audio', { wav, purpose: r.purpose })
  }
})

// ---- HELPER's voice ------------------------------------------------------------------------------
helper.on('play', (b64) => {
  const a = $('voice')
  a.src = 'data:audio/mpeg;base64,' + b64
  a.play().catch(() => {})
})

// ---- typing, confirming, copying ---------------------------------------------------------------
ask.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const v = ask.value.trim(); ask.value = ''; helper.send('typed', v) }
  if (e.key === 'Escape') { e.preventDefault(); helper.send('dismiss') }
})
$('yes').onclick = () => helper.send('confirm', true)
$('no').onclick = () => helper.send('confirm', false)
document.addEventListener('keydown', (e) => {
  if (mode !== 'confirm') return
  if (e.key === 'Enter') { e.preventDefault(); helper.send('confirm', document.activeElement !== $('no')) }
  if (e.key === 'Escape') { e.preventDefault(); helper.send('confirm', false) }
})
text.addEventListener('click', async () => {
  if (mode !== 'answer' || !text.textContent) return
  try {
    await navigator.clipboard.writeText(text.textContent)
    note.textContent = 'הועתק'
  } catch { }
})
card.addEventListener('mouseenter', () => helper.send('hover', true))
card.addEventListener('mouseleave', () => helper.send('hover', false))
