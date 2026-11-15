// The avatar window. It gets a state name from the app ({ state, variant, paused }) and turns it into a CSS class;
// nothing else from the message is used. It never writes text it was sent, so no message content can show here.
// Dragging: the app moves the window with the mouse (it never takes the keyboard). Over the avatar the window
// catches the mouse; everywhere else clicks go through to what is behind it.
'use strict'
;(function () {
  const STATES = ['idle', 'dance', 'react', 'alert']
  const VARIANTS = ['wave', 'work', 'done']
  const LABELS = { idle: 'HELPER', dance: 'HELPER רוקד', react: 'HELPER שם לב', alert: 'HELPER: התראה חשובה' }

  /** What to show for one message: a class name and a fixed label. Only known names get through. */
  function view(msg) {
    const m = msg && typeof msg === 'object' ? msg : {}
    const state = STATES.includes(m.state) ? m.state : 'idle'
    const variant = state === 'react' && VARIANTS.includes(m.variant) ? m.variant : ''
    return { className: 'avatar s-' + state + (variant ? ' v-' + variant : '') + (m.paused === true ? ' paused' : ''), label: LABELS[state] }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { view, STATES, VARIANTS, LABELS }
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.helper) return

  const el = document.getElementById('avatar')
  let last = { state: 'idle' }
  function show(msg) {
    last = msg || last
    const v = view(Object.assign({}, last, { paused: document.hidden || (last && last.paused === true) }))
    el.className = v.className
    el.setAttribute('aria-label', v.label)
  }
  window.helper.on('avatar', show)
  document.addEventListener('visibilitychange', () => show(last))

  el.addEventListener('mouseenter', () => window.helper.send('avatar-hover', true))
  el.addEventListener('mouseleave', () => window.helper.send('avatar-hover', false))
  el.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); window.helper.send('avatar-drag', 'start') } })
  window.addEventListener('mouseup', () => window.helper.send('avatar-drag', 'end'))
  window.addEventListener('blur', () => window.helper.send('avatar-drag', 'end'))
})()
