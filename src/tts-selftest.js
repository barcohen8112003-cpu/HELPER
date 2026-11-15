// node src/tts-selftest.js
// Offline. The Hebrew smoke that really calls Edge-TTS is scripts/edge-tts-smoke.mjs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HEBREW_VOICE,
  detectLang,
  edgeAudio,
  ffmpegArgs,
  normalizeRate,
  setEdgeExec,
  synthesizeSpeech,
  ttsProvider,
  voiceFor,
} from './tts.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`ok ${name}`)
}

check('unset provider is edge, including when an ElevenLabs key is present', () => {
  assert.equal(ttsProvider({}), 'edge')
  assert.equal(ttsProvider({ TTS_PROVIDER: '', ELEVENLABS_API_KEY: 'xi' }), 'edge')
  assert.equal(ttsProvider({ TTS_PROVIDER: 'edge' }), 'edge')
  assert.equal(ttsProvider({ TTS_PROVIDER: 'ElevenLabs' }), 'elevenlabs')
  assert.equal(ttsProvider({ TTS_PROVIDER: '11labs' }), 'elevenlabs')
  assert.equal(ttsProvider({ TTS_PROVIDER: 'openai' }), 'openai')
  assert.equal(ttsProvider({ TTS_PROVIDER: 'compatible' }), 'openai')
})

check('rate accepts the edge-tts form and clamps junk', () => {
  assert.equal(normalizeRate(''), '+0%')
  assert.equal(normalizeRate('+10%'), '+10%')
  assert.equal(normalizeRate('10%'), '+10%')
  assert.equal(normalizeRate('-20'), '-20%')
  assert.equal(normalizeRate('200'), '+100%')
  assert.equal(normalizeRate('fast'), '+0%')
})

check('Hebrew uses the configured voice; other languages pick a neural voice', () => {
  const env = { EDGE_TTS_VOICE: 'he-IL-AvriNeural', EDGE_TTS_RATE: '+5%' }
  assert.equal(voiceFor('שלום עולם', env).voice, 'he-IL-AvriNeural')
  assert.equal(voiceFor('שלום עולם', env).rate, '+5%')
  assert.equal(voiceFor('Hello there, how are you?', env).voice, 'en-US-AriaNeural')
  assert.equal(voiceFor('Bonjour, comment ça va, merci', {}).lang, 'fr')
  assert.equal(voiceFor('Danke, das ist gut', {}).voice, 'de-DE-KatjaNeural')
  assert.equal(voiceFor('Hola, como estas, gracias', {}).voice, 'es-ES-ElviraNeural')
  assert.equal(voiceFor('مرحبا كيف حالك اليوم', {}).voice, 'ar-EG-SalmaNeural')
  assert.equal(voiceFor('Привет, как дела', {}).voice, 'ru-RU-SvetlanaNeural')
  assert.equal(voiceFor('Привіт, як справи', {}).lang, 'uk')
  assert.equal(voiceFor('こんにちは、元気ですか', {}).lang, 'ja')
  assert.equal(voiceFor('你好，今天怎么样', {}).lang, 'zh')
  assert.equal(detectLang('42'), 'he')
  assert.equal(voiceFor('שלחתי את הקובץ לנאור ב-Google', env).lang, 'he')
  assert.equal(voiceFor('שלום', { EDGE_TTS_VOICE: 'he IL' }).voice, DEFAULT_HEBREW_VOICE)
})

check('opus is 48 kHz ogg and pcm is 16 kHz s16le', () => {
  const opus = ffmpegArgs('in.mp3', 'opus')
  assert.ok(opus.includes('libopus') && opus.includes('48000') && opus.includes('ogg') && opus.includes('32k'))
  const pcm = ffmpegArgs('in.mp3', 'pcm')
  assert.ok(pcm.includes('16000') && pcm.includes('s16le') && pcm.includes('1'))
})

const mp3 = Buffer.alloc(128, 1)
const ogg = Buffer.from('OggS-test')

function scripted(steps) {
  let i = 0
  return async (cmd, args) => {
    const step = steps[i++]
    assert.ok(step, `unexpected ${cmd}`)
    assert.equal(cmd, step.cmd)
    if (step.text) assert.equal(args[args.indexOf('--text') + 1], step.text)
    if (step.voice) assert.equal(args[args.indexOf('--voice') + 1], step.voice)
    if (step.rate) assert.equal(args[args.indexOf('--rate') + 1], step.rate)
    if (step.throw) throw new Error(step.throw)
    return step.out || Buffer.alloc(0)
  }
}

await (async () => {
  const audio = await edgeAudio('שלום', {
    format: 'opus',
    voice: 'he-IL-HilaNeural',
    rate: '+0%',
    exec: scripted([
      { cmd: 'edge-tts', text: 'שלום', voice: 'he-IL-HilaNeural', rate: '+0%' },
      { cmd: 'ffmpeg', out: ogg },
    ]),
  })
  assert.equal(audio.toString().startsWith('OggS'), true)
  passed++
  console.log('ok edge opus conversion asks ffmpeg for ogg')
})()

await (async () => {
  let eleven = 0
  const audio = await synthesizeSpeech('שלום', {
    format: 'mp3',
    provider: 'edge',
    edgeInstalled: true,
    delayMs: 0,
    voice: voiceFor('שלום', {}),
    elevenConfigured: true,
    eleven: async () => {
      eleven++
      return Buffer.from('eleven')
    },
    exec: scripted([
      { cmd: 'edge-tts', throw: 'network' },
      { cmd: 'edge-tts', out: mp3 },
    ]),
  })
  assert.equal(eleven, 0)
  assert.equal(audio.length, 128)
  passed++
  console.log('ok a failed Edge attempt is retried before any ElevenLabs call')
})()

await (async () => {
  let eleven = 0
  const audio = await synthesizeSpeech('Hello', {
    format: 'mp3',
    provider: 'edge',
    edgeInstalled: true,
    delayMs: 0,
    voice: voiceFor('Hello', { ELEVENLABS_API_KEY: 'xi', ELEVENLABS_VOICE_ID: 'v' }),
    elevenConfigured: true,
    eleven: async () => {
      eleven++
      return Buffer.from('eleven-audio')
    },
    exec: scripted([
      { cmd: 'edge-tts', throw: 'down' },
      { cmd: 'edge-tts', throw: 'down' },
    ]),
  })
  assert.equal(eleven, 1)
  assert.equal(audio.toString(), 'eleven-audio')
  assert.equal(voiceFor('Hello', {}).voice, 'en-US-AriaNeural')
  passed++
  console.log('ok Edge falls back to ElevenLabs only when it is configured')
})()

await (async () => {
  let eleven = 0
  await assert.rejects(
    synthesizeSpeech('שלום', {
      format: 'mp3',
      provider: 'edge',
      edgeInstalled: true,
      delayMs: 0,
      voice: voiceFor('שלום', {}),
      elevenConfigured: false,
      eleven: async () => {
        eleven++
        return Buffer.from('nope')
      },
      exec: scripted([
        { cmd: 'edge-tts', throw: 'down' },
        { cmd: 'edge-tts', throw: 'down' },
      ]),
    }),
    /down/,
  )
  assert.equal(eleven, 0)
  passed++
  console.log('ok without an ElevenLabs key a failed Edge request stays a failure so the reply can be text')
})()

await (async () => {
  let edge = 0
  const audio = await synthesizeSpeech('שלום', {
    format: 'opus',
    provider: 'elevenlabs',
    edgeInstalled: true,
    delayMs: 0,
    elevenConfigured: true,
    voice: voiceFor('שלום', {}),
    eleven: async () => Buffer.from('OggSeleven'),
    exec: async () => {
      edge++
      return mp3
    },
  })
  assert.equal(edge, 0)
  assert.equal(audio.toString(), 'OggSeleven')
  passed++
  console.log('ok TTS_PROVIDER=elevenlabs does not call Edge')
})()

const texts = [
  'שלום עולם',
  'Hello there, how are you?',
  'Bonjour, comment ça va, merci',
  'Danke, das ist gut',
  'Hola, como estas, gracias',
  'مرحبا كيف حالك اليوم',
  'Привет, как дела',
  'Привіт, як справи',
  'こんにちは、元気ですか',
  '你好，今天怎么样',
  '42',
]
const py = spawnSync('python3', ['voice/edge_pcm_selftest.py'], {
  cwd: root,
  input: JSON.stringify(texts),
  encoding: 'utf8',
  env: { ...process.env, EDGE_TTS_VOICE: 'he-IL-AvriNeural', EDGE_TTS_RATE: '+5%' },
})
assert.equal(py.status, 0, py.stderr || py.stdout)
const fromPy = JSON.parse(py.stdout)
const env = { EDGE_TTS_VOICE: 'he-IL-AvriNeural', EDGE_TTS_RATE: '+5%' }
for (const row of fromPy) {
  const js = voiceFor(row.text, env)
  assert.equal(row.voice, js.voice, row.text)
  assert.equal(row.rate, js.rate, row.text)
  assert.equal(row.lang, js.lang, row.text)
  passed++
}
console.log('ok the voice worker picks the same voice as the Node server')

setEdgeExec(null)
console.log(passed ? `ok ${passed}` : 'no checks')
