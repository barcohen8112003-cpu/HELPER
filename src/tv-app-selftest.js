// node src/tv-app-selftest.js
// Offline: a fake TV connects over a real WebSocket the way the HELPER home screen does, and the tv_* tools run
// against it. Checks what reached the TV: the right package, keys, volume and button mappings.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-tv-'))

const { WebSocket } = await import('ws')
const tv = await import('./tv-app.js')
const { tvTools, tvPrompt } = await import('./tv-tools.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

const TOKEN = 'test-token'
const server = http.createServer()
server.on('upgrade', (req, socket, head) => tv.handleTvUpgrade(req, socket, head, (r) => r.headers.authorization === `Bearer ${TOKEN}`))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `ws://127.0.0.1:${server.address().port}/bridge/tv`
const tool = (name) => tvTools.find((t) => t.name === name)

ok(!tv.tvConnected() && tvPrompt() === '', 'no TV, no prompt line')
ok((await tool('tv_open_app').run({ app: 'x' }).catch((e) => e.message)).includes('לא מחוברת'), 'a missing TV is said plainly')

// A wrong token is refused.
const refused = await new Promise((resolve) => {
  const ws = new WebSocket(url, { headers: { authorization: 'Bearer nope' } })
  ws.on('error', () => resolve(true))
  ws.on('open', () => resolve(false))
})
ok(refused, 'a wrong token is refused')

const calls = []
const APPS = [
  { pkg: 'com.netflix.ninja', label: 'Netflix' },
  { pkg: 'com.google.android.youtube.tv', label: 'YouTube' },
  { pkg: 'com.spotify.tv.android', label: 'Spotify' },
  { pkg: 'com.stremio.one', label: 'Stremio' },
  { pkg: 'com.android.vending', label: 'Google Play Store' },
]
const ws = await new Promise((resolve) => {
  const s = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } })
  s.on('open', () => {
    s.send(JSON.stringify({ type: 'hello', device: 'Chromecast HD', version: '2.6-helper' }))
    setTimeout(() => resolve(s), 50)
  })
  s.on('message', (data) => {
    const msg = JSON.parse(data)
    calls.push(msg)
    const result = msg.op === 'apps' ? { apps: APPS }
      : msg.op === 'state' ? { pkg: 'com.netflix.ninja', label: 'Netflix', volume: 35, muted: false }
      : msg.op === 'volume' ? { level: msg.args.level }
      : {}
    s.send(JSON.stringify({ id: msg.id, ok: true, result }))
  })
})

ok(tv.tvConnected() && tv.tvInfo().device === 'Chromecast HD', 'the TV connects and says hello')
ok(tvPrompt().includes('tv_open_app'), 'the model hears about the TV once it is connected')

const last = (op) => [...calls].reverse().find((c) => c.op === op)
ok((await tool('tv_open_app').run({ app: 'נטפליקס' })).includes('Netflix') && last('open_app').args.pkg === 'com.netflix.ninja', 'Hebrew app name opens Netflix')
ok((await tool('tv_open_app').run({ app: 'גוגל פליי' })) && last('open_app').args.pkg === 'com.android.vending', 'Google Play by its Hebrew name')
ok((await tool('tv_open_app').run({ app: 'nothing-like-this' })).includes('לא מצאתי'), 'an unknown app is not guessed')
await tool('tv_key').run({ key: 'volume_up', times: 99 })
ok(last('key').args.key === 'volume_up' && last('key').args.times === 20, 'key presses are capped at 20')
ok((await tool('tv_key').run({ key: 'format_disk' })).includes('אין כפתור'), 'an unknown key is refused')
await tool('tv_volume').run({ level: 140 })
ok(last('volume').args.level === 100, 'volume is clamped to 100')
ok((await tool('tv_status').run({})).includes('35%'), 'status reads the volume')
ok((await tool('tv_set_button').run({ button: 'youtube', app: 'spotify' })).includes('Spotify') && last('set_button').args.pkg === 'com.spotify.tv.android', 'the YouTube button can open Spotify')
await tool('tv_set_button').run({ button: 'youtube', app: 'default' })
ok(last('set_button').args.pkg === '', 'a button goes back to its default')

// Stremio: its Hebrew name, and a movie opened on its own page (the catalog answered offline here).
await tool('tv_open_app').run({ app: 'סטרימיו' })
ok(last('open_app').args.pkg === 'com.stremio.one', 'סטרימיו opens Stremio')
const CATALOG = { metas: [
  { id: 'tt0374900', name: 'Napoleon Dynamite', releaseInfo: '2004' },
  { id: 'tt0018192', name: 'Napoleon', releaseInfo: '1927' },
  { id: 'tt13287846', name: 'Napoleon', releaseInfo: '2023' },
] }
const realFetch = globalThis.fetch
const asked = []
globalThis.fetch = async (url) => (asked.push(String(url)), { ok: true, json: async () => CATALOG })
const played = await tool('tv_play').run({ title: 'Napoleon' })
ok(last('open_url')?.args.url === 'stremio:///detail/movie/tt13287846' && last('open_url').args.pkg === 'com.stremio.one', 'Napoleon opens the 2023 film in Stremio')
ok(played.includes('2023') && asked[0].includes('search=Napoleon'), 'it says which one it opened')
await tool('tv_play').run({ title: 'Napoleon', year: '1927' })
ok(last('open_url').args.url.endsWith('tt0018192'), 'a year picks that one')
globalThis.fetch = async () => ({ ok: true, json: async () => ({ metas: [] }) })
ok((await tool('tv_play').run({ title: 'Nothing Like This' })).includes('לא מצאתי'), 'a title not in the catalog is said so')
globalThis.fetch = realFetch

ws.close()
await new Promise((r) => setTimeout(r, 100))
ok(!tv.tvConnected(), 'a closed TV is no longer connected')

server.close()
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
