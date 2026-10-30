// The TV agent on the real TV over ADB, without the cloud: the same ops the HELPER home screen answers (observe,
// capture, act, apps, open_app, open_url, restart_app) done with adb from this computer. For trying tv_do end to end.
//
//   node scripts/tv-agent-adb.mjs <host:port> "תפעיל בסטרימיו את נפוליאון"
//
// Needs adb (Android SDK platform-tools) and the TV paired for Wireless debugging. Uses the model from .env.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOnTv } from '../src/tv-agent.js'

const [device, ...words] = process.argv.slice(2)
const goal = words.join(' ')
if (!device || !goal) {
  console.log('usage: node scripts/tv-agent-adb.mjs <host:port> "<goal>"')
  process.exit(2)
}
const ADB = [process.env.ADB, path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe'), path.join(os.homedir(), 'Android/Sdk/platform-tools/adb'), 'adb'].find((p) => p && (p === 'adb' || fs.existsSync(p)))
const adb = (args, opts = {}) => execFileSync(ADB, ['-s', device, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts })
const sh = (cmd) => adb(['shell', cmd]).toString()

const KEYCODES = { up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', ok: 'DPAD_CENTER', back: 'BACK', home: 'HOME', play_pause: 'MEDIA_PLAY_PAUSE', play: 'MEDIA_PLAY', pause: 'MEDIA_PAUSE', stop: 'MEDIA_STOP', next: 'MEDIA_NEXT', previous: 'MEDIA_PREVIOUS', rewind: 'MEDIA_REWIND', fast_forward: 'MEDIA_FAST_FORWARD', mute: 'VOLUME_MUTE', volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN' }
let nodes = []

const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function observe() {
  sh('uiautomator dump /sdcard/helper-ui.xml >/dev/null 2>&1')
  const xml = sh('cat /sdcard/helper-ui.xml')
  nodes = []
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]))
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    const useful = a.text || a['content-desc'] || a.focused === 'true' || a.clickable === 'true'
    if (!useful || !b) continue
    const n = { i: nodes.length, box: `${b[1]},${b[2]},${b[3]},${b[4]}` }
    if (a.text) n.text = a.text.slice(0, 120)
    if (a['content-desc']) n.desc = a['content-desc'].slice(0, 120)
    if (a['resource-id']) n.id = a['resource-id'].replace(/^.*:id\//, '')
    if (a.clickable === 'true') n.click = true
    if (a.focused === 'true') n.focused = true
    if (a.selected === 'true') n.selected = true
    if (a.class === 'android.widget.EditText') n.editable = true
    nodes.push(n)
  }
  const pkg = (sh('dumpsys window | grep -m1 mCurrentFocus').match(/ (\S+?)\//) || [])[1] || ''
  return { nodes, pkg, label: pkg, width: 1920, height: 1080 }
}

const center = (n) => { const [x1, y1, x2, y2] = n.box.split(',').map(Number); return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)] }

async function call(op, args = {}) {
  console.log(`  tv <- ${op} ${JSON.stringify(args).slice(0, 120)}`)
  if (op === 'observe') return observe()
  if (op === 'capture') {
    const png = adb(['exec-out', 'screencap', '-p'])
    return { image: png.toString('base64'), width: 1920, height: 1080 }
  }
  if (op === 'apps') {
    const pkgs = sh('pm list packages -3').split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean)
    const names = { 'com.stremio.one': 'Stremio', 'com.google.android.youtube.tv': 'YouTube', 'com.netflix.ninja': 'Netflix', 'com.disney.disneyplus': 'Disney+' }
    return { apps: pkgs.map((pkg) => ({ pkg, label: names[pkg] || pkg })) }
  }
  if (op === 'open_app') return void sh(`monkey -p ${args.pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1`)
  if (op === 'open_url') return void sh(`am start -a android.intent.action.VIEW -d '${String(args.url).replace(/'/g, '')}' ${args.pkg || ''}`)
  if (op === 'restart_app') {
    sh(`am force-stop ${args.pkg}`)
    sh(args.url ? `am start -a android.intent.action.VIEW -d '${String(args.url).replace(/'/g, '')}' ${args.pkg}` : `monkey -p ${args.pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1`)
    return {}
  }
  if (op === 'act') {
    if (args.type === 'key') {
      for (let i = 0; i < (args.times || 1); i++) sh(`input keyevent KEYCODE_${KEYCODES[args.keys] || 'DPAD_CENTER'}`)
      return { ok: true }
    }
    const n = nodes[args.index]
    if (args.type === 'select' || args.type === 'tap') {
      if (!n) throw new Error(`אין רכיב ${args.index} ברשימה`)
      const [x, y] = center(n)
      sh(`input tap ${x} ${y}`)
      return { ok: true, info: `tapped ${x},${y}` }
    }
    if (args.type === 'type') {
      if (n) { const [x, y] = center(n); sh(`input tap ${x} ${y}`) }
      sh(`input text '${String(args.text).replace(/'/g, '').replace(/ /g, '%s')}'`)
      return { ok: true }
    }
    if (args.type === 'scroll') return void sh(`input keyevent KEYCODE_DPAD_${args.direction === 'up' ? 'UP' : 'DOWN'}`)
  }
  throw new Error(`op ${op} not handled over adb`)
}

const started = Date.now()
const result = await runOnTv(goal, { confirm: async (q) => (console.log('GATE:', q), false) }, { call })
console.log(`\n${result}\n(${Math.round((Date.now() - started) / 1000)} s)`)
process.exit(0)
