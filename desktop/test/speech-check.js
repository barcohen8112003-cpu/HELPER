// With HELPER running (its speech server up): real Hebrew speech passes the speech check and comes back as the
// right words; the same clip turned to near-silence does not pass. Needs ffmpeg for the conversion.
// Run: node test/speech-check.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const speech = require('../src/speech')

const root = path.join(__dirname, '..')
const sample = path.join(root, '..', 'voice-v4-turbo-sample.mp3')
const wavFile = path.join(os.tmpdir(), 'helper-speech-check.wav')
const quietFile = path.join(os.tmpdir(), 'helper-speech-quiet.wav')
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavFile])
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-ar', '16000', '-ac', '1', '-af', 'volume=0.01', '-c:a', 'pcm_s16le', quietFile])

;(async () => {
  let ok = true
  const wav = fs.readFileSync(wavFile)
  const quiet = fs.readFileSync(quietFile)
  const voiced = speech.hasSpeech(wav)
  const hushed = speech.hasSpeech(quiet)
  console.log('real speech passes:', voiced, '| near-silence passes:', hushed)
  if (!voiced || hushed) ok = false
  const t0 = Date.now()
  const text = await speech.transcribe(root, wav, 'HELPER')
  console.log(`transcribed in ${Date.now() - t0} ms:`, text)
  if (!/התכוונת/.test(text)) ok = false
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
