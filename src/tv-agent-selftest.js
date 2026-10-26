// node src/tv-agent-selftest.js
// Offline: the TV agent (tv-agent.js) on a stand-in TV and a scripted model. Playing a movie in Stremio goes
// through without asking; a "Rent" button is stopped by the safety check; a list with nothing to read brings a picture.
const { tvBody, formatTvNodes, runOnTv } = await import('./tv-agent.js')

let passed = 0
let failed = 0
const ok = (cond, name) => (cond ? passed++ : (failed++, console.log('FAIL', name)))

const APPS = [{ pkg: 'com.stremio.one', label: 'Stremio' }, { pkg: 'com.google.android.youtube.tv', label: 'YouTube' }]
const SCREENS = {
  home: { pkg: '', label: '', nodes: [{ i: 0, text: 'Stremio', click: true, box: '0,0,10,10' }] },
  movie: { pkg: 'com.stremio.one', label: 'Stremio', nodes: [
    { i: 0, text: 'Napoleon', box: '0,0,1,1' },
    { i: 1, text: 'Torrentio 1080p', click: true, focused: true, box: '0,0,1,1' },
    { i: 2, text: 'Rent HD ₪19.90', click: true, box: '0,0,1,1' },
  ] },
  player: { pkg: 'com.stremio.one', label: 'Stremio', nodes: [] },
}

function fakeTv() {
  const calls = []
  let screen = 'home'
  const call = async (op, args = {}) => {
    calls.push({ op, args })
    if (op === 'apps') return { apps: APPS }
    if (op === 'observe') return { ...SCREENS[screen], width: 1920, height: 1080 }
    if (op === 'capture') return { image: Buffer.from('jpeg').toString('base64'), width: 960, height: 540 }
    if (op === 'open_url') { screen = 'movie'; return {} }
    if (op === 'act' && args.type === 'select' && args.index === 1) { screen = 'player'; return { info: 'clicked' } }
    return {}
  }
  return { call, calls, screen: () => screen }
}

// A model that answers from a script, and records what it was shown.
function script(steps) {
  const seen = []
  const all = []
  let n = 0
  const think = async (messages) => {
    for (const m of messages) if (typeof m.content === 'string') all.push(m.content)
    const last = messages[messages.length - 1]
    seen.push(Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }])
    return { content: JSON.stringify(steps[Math.min(n++, steps.length - 1)]) }
  }
  return { think, seen, all }
}

ok(formatTvNodes(SCREENS.movie.nodes).includes('[1] "Torrentio 1080p" (focused, click)'), 'the screen list names the focused element')

{
  const tv = fakeTv()
  const model = script([
    { thought: 'open the movie page', action: { type: 'open_url', url: 'stremio:///detail/movie/tt13287846', app: 'Stremio' } },
    { thought: 'first source', action: { type: 'select', index: 1 } },
    { thought: 'playing', action: { type: 'done', summary: 'נפוליאון מתנגן' } },
  ])
  const out = await runOnTv('תפעיל בסטרימיו את נפוליאון', { confirm: async () => { throw new Error('asked') } }, { call: tv.call, think: model.think })
  ok(out.startsWith('DONE'), 'a movie is played to the end: ' + out.split('\n')[0])
  ok(tv.calls.some((c) => c.op === 'open_url' && c.args.pkg === 'com.stremio.one'), 'the link opens in Stremio')
  ok(tv.calls.some((c) => c.op === 'act' && c.args.type === 'select' && c.args.index === 1), 'the source is chosen by its number')
  ok(model.seen[2].some((p) => p.type === 'image_url'), 'the player, with nothing to read, comes with a picture')
}

{
  const tv = fakeTv()
  const model = script([
    { thought: 'open', action: { type: 'open_url', url: 'stremio:///detail/movie/tt13287846', app: 'Stremio' } },
    { thought: 'rent it', action: { type: 'select', index: 2 } },
    { thought: 'give up', action: { type: 'fail', summary: 'רק להשכרה' } },
  ])
  await runOnTv('תשכור את נפוליאון', {}, { call: tv.call, think: model.think })
  ok(!tv.calls.some((c) => c.op === 'act' && c.args.index === 2), 'a Rent button is not pressed without approval')
  ok(model.all.some((t) => /safety check/.test(t)), 'the model is told why')
}

{
  const tv = fakeTv()
  const body = tvBody({ call: tv.call })
  let err = ''
  try { await body.act({ type: 'key', keys: 'format' }) } catch (e) { err = e.message }
  ok(err.includes('אין כפתור'), 'an unknown key is refused')
  await body.act({ type: 'key', keys: 'down', times: 3 })
  ok(tv.calls.some((c) => c.op === 'act' && c.args.keys === 'down' && c.args.times === 3), 'keys go through with a count')
}

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
