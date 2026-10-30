'use strict'
let picking = false, start = null, box = null, ringTimer = null

function clear() {
  document.body.innerHTML = ''
  document.body.className = ''
  picking = false
  box = null
}

helper.on('overlay', (o) => {
  if (o.mode === 'clear') return clear()
  if (o.mode === 'ring') {
    document.querySelectorAll('.ring, .label').forEach((e) => e.remove())
    const r = document.createElement('div')
    r.className = 'ring'
    r.style.left = o.x + 'px'
    r.style.top = o.y + 'px'
    document.body.appendChild(r)
    if (o.label) {
      const l = document.createElement('div')
      l.className = 'label'
      l.style.left = o.x + 'px'
      l.style.top = o.y + 'px'
      l.textContent = o.label
      document.body.appendChild(l)
    }
    clearTimeout(ringTimer)
    ringTimer = setTimeout(() => document.querySelectorAll('.ring, .label').forEach((e) => e.remove()), 12000)
  }
  if (o.mode === 'pick') {
    clear()
    picking = true
    document.body.className = 'pick'
    const h = document.createElement('div')
    h.className = 'hint'
    h.textContent = 'לחיצה על משהו, או גרירה סביבו · Esc לביטול'
    document.body.appendChild(h)
  }
})

document.addEventListener('mousedown', (e) => {
  if (!picking) return
  start = { x: e.clientX, y: e.clientY }
  box = document.createElement('div')
  box.className = 'box'
  document.body.appendChild(box)
  move(e)
})
function move(e) {
  if (!picking || !start || !box) return
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY)
  box.style.left = x + 'px'; box.style.top = y + 'px'
  box.style.width = Math.abs(e.clientX - start.x) + 'px'; box.style.height = Math.abs(e.clientY - start.y) + 'px'
}
document.addEventListener('mousemove', move)
document.addEventListener('mouseup', (e) => {
  if (!picking || !start) return
  let x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY)
  let w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y)
  if (w < 12 && h < 12) {   // a click: a box around the spot
    x = start.x - 70; y = start.y - 45; w = 140; h = 90
    box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px'
  }
  picking = false
  start = null
  document.body.className = ''
  document.querySelectorAll('.hint').forEach((n) => n.remove())
  helper.send('mark', { x, y, width: w, height: h })
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) { clear(); helper.send('mark-cancel') }
})
