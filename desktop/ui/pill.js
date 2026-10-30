'use strict'
const pill = document.getElementById('pill'), label = document.getElementById('label')
const c = document.getElementById('w'), g = c.getContext('2d')
let mode = 'listening', t = 0, shown = 0
function draw() {
  t += 0.08
  const w = c.width, h = c.height
  g.clearRect(0, 0, w, h)
  const live = mode === 'listening' ? Recorder.level() : mode === 'working' ? 0.18 : 0.04
  shown += (live - shown) * 0.3
  const bars = 14
  for (let i = 0; i < bars; i++) {
    const x = (i + 0.5) * (w / bars)
    const env = Math.sin(((i + 0.5) / bars) * Math.PI)
    const a = (0.15 + shown * 0.85) * env * (0.6 + 0.4 * Math.sin(t * 3 + i * 0.9))
    const bh = Math.max(4, a * h)
    g.fillStyle = mode === 'done' ? '#6EE7A8' : mode === 'error' ? '#FF7A7A' : 'rgba(139,124,255,0.95)'
    g.beginPath()
    g.roundRect(x - 3, (h - bh) / 2, 6, bh, 3)
    g.fill()
  }
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)

helper.on('state', (s) => {
  mode = s.mode
  pill.classList.toggle('done', s.mode === 'done')
  pill.classList.toggle('error', s.mode === 'error')
  label.textContent = s.mode === 'listening' ? 'מכתיב… עזוב את Ctrl כשסיימת'
    : s.mode === 'working' ? 'כותב…'
    : s.mode === 'done' ? '✓ ' + (s.text || '')
    : s.text || ''
})
helper.on('record', async (r) => {
  if (r.action === 'start') {
    try { await Recorder.start(r.purpose, r.mic) } catch { mode = 'error'; label.textContent = 'אין גישה למיקרופון' }
  } else {
    const wav = Recorder.stop(r.action === 'cancel')
    if (wav) helper.send('audio', { wav, purpose: r.purpose })
  }
})
