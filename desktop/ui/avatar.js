// The avatar window. It gets a state from the app ({ state, variant, design, paused }) and turns it into a CSS class
// and a data-design attribute; nothing else from the message is used, and only names on the lists below get through.
// It never writes text it was sent, so no message content can show here.
// Mouse: over the avatar the window catches the mouse, everywhere else clicks go through to what is behind it.
// A click asks HELPER (the bubble's typing box), a drag moves it, a right-click opens its menu. It never takes the
// keyboard itself.
'use strict'
;(function () {
  const STATES = ['idle', 'dance', 'react', 'alert']
  const VARIANTS = ['wave', 'work', 'done', 'listen', 'think', 'speak']
  const DESIGNS = ['orb', 'chip', 'figure']
  const LABELS = { idle: 'HELPER', dance: 'HELPER רוקד', react: 'HELPER שם לב', alert: 'HELPER: התראה חשובה' }
  const VARIANT_LABELS = { listen: 'HELPER מקשיב', think: 'HELPER חושב', speak: 'HELPER מדבר', work: 'HELPER עובד', wave: 'HELPER שם לב', done: 'HELPER סיים' }

  /** What to show for one message: a class name, a design and a fixed label. Only known names get through. */
  function view(msg) {
    const m = msg && typeof msg === 'object' ? msg : {}
    const state = STATES.includes(m.state) ? m.state : 'idle'
    const variant = state === 'react' && VARIANTS.includes(m.variant) ? m.variant : ''
    const design = DESIGNS.includes(m.design) ? m.design : 'orb'
    return {
      className: 'avatar s-' + state + (variant ? ' v-' + variant : '') + (m.paused === true ? ' paused' : ''),
      design,
      label: variant ? VARIANT_LABELS[variant] : LABELS[state],
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { view, STATES, VARIANTS, DESIGNS, LABELS, VARIANT_LABELS }
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.helper) return

  const el = document.getElementById('avatar')
  let last = { state: 'idle' }
  function show(msg) {
    if (msg && typeof msg === 'object') last = msg
    const v = view(Object.assign({}, last, { paused: document.hidden || last.paused === true }))
    el.className = v.className
    document.body.setAttribute('data-design', v.design)
    el.setAttribute('aria-label', v.label)
  }
  window.helper.on('avatar', show)
  document.addEventListener('visibilitychange', () => show(null))

  // A press that hardly moved and was short is a click; anything else was a drag (the app moves the window).
  let down = null
  el.addEventListener('mouseenter', () => window.helper.send('avatar-hover', true))
  el.addEventListener('mouseleave', () => window.helper.send('avatar-hover', false))
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    down = { x: e.screenX, y: e.screenY, at: Date.now() }
    window.helper.send('avatar-drag', 'start')
  })
  window.addEventListener('mouseup', (e) => {
    window.helper.send('avatar-drag', 'end')
    if (down && e.button === 0 && Math.abs(e.screenX - down.x) < 5 && Math.abs(e.screenY - down.y) < 5 && Date.now() - down.at < 500) window.helper.send('avatar-click', 'click')
    down = null
  })
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.helper.send('avatar-menu', 'open') })
  window.addEventListener('blur', () => { down = null; window.helper.send('avatar-drag', 'end') })
})()
