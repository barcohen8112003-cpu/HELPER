// The recorder hears when the user stops talking: real Hebrew speech (with room noise, quiet before and after) is
// fed through ui/recorder.js in place of the microphone. It must find the speech, not end in the middle of it,
// end soon after it, and give up on silence. Needs ffmpeg. Run: node test/endpoint-check.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

const RATE = 16000
const sample = path.join(__dirname, '..', '..', 'voice-v4-turbo-sample.mp3')
const raw = path.join(os.tmpdir(), 'helper-endpoint.raw')
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-ar', String(RATE), '-ac', '1', '-f', 'f32le', raw])
const b = fs.readFileSync(raw)
const speech = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))

/** Runs samples through a fresh recorder; returns when (in ms of audio) each hook fired. */
async function run(audio) {
  let port = null
  const ctxStub = { sampleRate: RATE, audioWorklet: { addModule: async () => {} }, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), close() {} }
  const sandbox = {
    window: {},
    navigator: { mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) } },
    AudioContext: function () { return ctxStub },
    AudioWorkletNode: function () { port = { onmessage: null }; return { port, disconnect() {} } },
    Math, Int16Array, Float32Array, ArrayBuffer, DataView,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'recorder.js'), 'utf8'), sandbox)
  const R = sandbox.window.Recorder
  const at = {}
  let fed = 0
  const mark = (k) => () => { if (!(k in at)) at[k] = Math.round((fed / RATE) * 1000) }
  await R.start('ask', null, { onSpeech: mark('speech'), onQuiet: mark('quiet'), onEnd: mark('end') })
  for (let i = 0; i + 128 <= audio.length && !('end' in at); i += 128) {
    fed = i + 128
    port.onmessage({ data: audio.slice(i, i + 128) })
  }
  const snap = R.snapshot()
  R.stop(true)
  return { at, snap }
}

function noise(seconds, amp) {
  const n = Math.round(seconds * RATE), out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amp
  return out
}
function join(...parts) {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
function mix(a, amp) { const out = a.slice(); for (let i = 0; i < out.length; i++) out[i] += (Math.random() * 2 - 1) * amp; return out }

;(async () => {
  let ok = true
  const check = (name, cond, info) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + (info ? '  ' + info : '')); if (!cond) ok = false }
  const speechMs = Math.round((speech.length / RATE) * 1000)
  // Where the clip itself goes quiet at its end (it may have a tail of silence).
  let lastLoud = speech.length
  for (let i = speech.length - 320; i > 0; i -= 320) {
    let s = 0
    for (let j = i; j < i + 320; j++) s += speech[j] * speech[j]
    if (Math.sqrt(s / 320) > 0.02) { lastLoud = i + 320; break }
  }
  const spokenEnd = 1000 + Math.round((lastLoud / RATE) * 1000)

  for (const amp of [0.001, 0.004]) {
    const audio = join(noise(1, amp), mix(speech, amp), noise(3, amp))
    const { at, snap } = await run(audio)
    check(`room noise ${amp}: speech found`, at.speech >= 1000 && at.speech < 1600, `at ${at.speech} ms`)
    check(`room noise ${amp}: not ended mid-speech`, at.end >= spokenEnd, `ended ${at.end} ms, speech ends ${spokenEnd} ms (clip ${speechMs} ms)`)
    check(`room noise ${amp}: ends soon after`, at.end - spokenEnd <= 1100, `${at.end - spokenEnd} ms after`)
    check(`room noise ${amp}: snapshot is a WAV`, snap && snap.wav.byteLength > 44 && snap.lastLoud > 0)
  }
  const { at } = await run(noise(10, 0.003))
  check('silence: no speech', !('speech' in at))
  check('silence: gives up', at.end >= 7900 && at.end <= 8200, `at ${at.end} ms`)
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
