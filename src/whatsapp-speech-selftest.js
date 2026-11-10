// Offline only. No model, ElevenLabs, voice identity change, or live WhatsApp.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_WHATSAPP_SPEECH, TEXT_ONLY_SPEECH, WHATSAPP_SPOKEN_NOTE, prepareWhatsAppSpeech, spokenReplySystem, deliverWhatsAppSpeech } from './whatsapp-speech.js'

let passed = 0
const check = (name, test) => { test(); passed++; console.log(`ok ${name}`) }
const plain = 'נאור, הטיסה ב-14/07/2027 בשעה 19:40. המחיר 1,234.50 ₪, לא 1,250 ₪. זה עדיין לא מאושר.'
check('complete Hebrew preserves exact dates, times, decimal prices, negation and uncertainty', () => {
  assert.deepEqual(prepareWhatsAppSpeech(plain), { speech: plain, companion: false, reason: 'complete' })
})
check('English is not translated; technical identifiers remain exact', () => {
  const text = 'Use file_name_v2, not file_name_v1. Version 1.2.3 costs $49.99.'
  assert.equal(prepareWhatsAppSpeech(text).speech, text)
})
check('multiplication and spaced negative numeric values are never mistaken for formatting', () => {
  for (const text of ['2*3*4 = 24', '- 5 מעלות', '3**2 = 9', '50_000 ₪', 'a*b*c']) assert.equal(prepareWhatsAppSpeech(text).speech, text)
})
check('no lower-case URL assumption; source link survives in original companion', () => {
  const original = 'ראה [המקור](https://example.invalid/a) וגם HTTPS://example.invalid/b.'
  const result = prepareWhatsAppSpeech(original)
  assert.equal(result.companion, true)
  assert.equal(result.speech.includes('https://'), false)
  assert.match(result.speech, /המקור/)
  assert.match(original, /https:\/\/example.invalid\/a/)
})
check('markdown cleanup keeps list numbers, minus signs, and exact numeric text', () => {
  const original = '# פרטים\n*מחיר:* 50 ₪\n- בתאריך 10.11.2026\n1. מינוס -5 מעלות\n**לא אושר**'
  assert.equal(prepareWhatsAppSpeech(original).speech, 'פרטים\nמחיר: 50 ₪\nבתאריך 10.11.2026\n1. מינוס -5 מעלות\nלא אושר')
  assert.equal(prepareWhatsAppSpeech(original).companion, true)
})
check('whole unpunctuated answer at budget is kept', () => {
  const text = 'א'.repeat(MAX_WHATSAPP_SPEECH)
  assert.equal(prepareWhatsAppSpeech(text).speech, text)
})
check('long answer gets a complete fixed notice, never a prefix losing a late condition', () => {
  for (const text of ['א'.repeat(1501), `${'משפט שלם. '.repeat(200)}אבל אל תשלם לפני שאישרתי.`]) {
    const out = prepareWhatsAppSpeech(text)
    assert.equal(out.speech, TEXT_ONLY_SPEECH)
    assert.equal(out.companion, true)
    assert.equal(out.reason, 'long')
  }
})
check('code/table content remains text instead of reading broken syntax', () => {
  for (const text of ['```js\nconst n = 50\n```', '| סכום | תאריך |\n| 50 | 10/11 |', 'סכום | תאריך |\n50 | 10/11 |']) {
    assert.deepEqual(prepareWhatsAppSpeech(text), { speech: TEXT_ONLY_SPEECH, companion: true, reason: 'structured' })
  }
})
check('empty replies never produce an audio notice', () => {
  for (const value of ['', '   ', null, undefined]) assert.equal(prepareWhatsAppSpeech(value).speech, '')
})
check('spoken instructions are in the opted-in WhatsApp system context only', () => {
  assert.equal(spokenReplySystem('base', { source: 'whatsapp', spokenReply: true }), `base\n\n${WHATSAPP_SPOKEN_NOTE}`)
  for (const ctx of [{}, { source: 'whatsapp' }, { source: 'task', spokenReply: true }, { source: 'live', spokenReply: true }, { source: 'bridge', spokenReply: true }, { source: 'whatsapp', spokenReply: true, isolated: true }]) {
    assert.equal(spokenReplySystem('base', ctx), 'base')
  }
})

// Actual inert transport behavior, not source-text assertions.
for (const companion of [false, true]) {
  const events = []
  const reply = 'המחיר 50 ₪, אבל עדיין לא אושר.'
  const result = await deliverWhatsAppSpeech({ reply, delivery: { companion }, audio: Buffer.from('audio'),
    sendText: async (value) => events.push(['text', value]),
    sendVoice: async () => { events.push(['voice']); throw new Error('offline voice rejection') },
    onVoiceError: () => { throw new Error('logging failure must not hide answer') },
  })
  check(`voice rejection keeps complete text exactly once (companion=${companion})`, () => {
    assert.deepEqual(result, { textSent: true, voiceSent: false })
    assert.equal(events.filter(([kind]) => kind === 'text').length, 1)
    assert.equal(events.find(([kind]) => kind === 'text')[1], reply)
    if (companion) assert.equal(events[0][0], 'text')
  })
}
{
  const events = []
  const reply = 'א'.repeat(1600)
  await assert.rejects(deliverWhatsAppSpeech({ reply, delivery: prepareWhatsAppSpeech(reply), audio: Buffer.from('audio'),
    sendText: async () => { events.push('text-failed'); throw new Error('offline text rejection') },
    sendVoice: async () => events.push('voice'),
  }), /text rejection/)
  check('failed mandatory companion prevents a false attached-text voice notice', () => assert.deepEqual(events, ['text-failed']))
}
{
  const events = []
  const result = await deliverWhatsAppSpeech({ reply: plain, delivery: { companion: true }, audio: Buffer.from('audio'),
    sendText: async (value) => events.push(['text', value]), sendVoice: async () => events.push(['voice']),
  })
  check('successful companion lands before voice notice', () => {
    assert.deepEqual(result, { textSent: true, voiceSent: true })
    assert.deepEqual(events.map(([kind]) => kind), ['text', 'voice'])
  })
}
{
  const events = []
  const result = await deliverWhatsAppSpeech({ reply: plain, delivery: { companion: false }, audio: null,
    sendText: async (value) => events.push(value), sendVoice: async () => { throw new Error('must not attempt audio') },
  })
  check('synthesis unavailable falls back to complete original text', () => {
    assert.deepEqual(result, { textSent: true, voiceSent: false })
    assert.deepEqual(events, [plain])
  })
}
{
  let attempts = 0
  await assert.rejects(deliverWhatsAppSpeech({ reply: plain, delivery: { companion: false }, audio: Buffer.from('audio'),
    sendVoice: async () => { throw new Error('voice failed') },
    sendText: async () => { attempts++; throw new Error('text also failed') },
  }), /text also failed/)
  check('double transport failure propagates instead of claiming delivery', () => assert.equal(attempts, 1))
}

// Set a throwaway environment before importing config. No owner .env or data is read.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-speech-'))
process.env.HELPER_ENV_FILE = path.join(dir, 'empty.env')
process.env.HELPER_DATA_DIR = dir
const savedFetch = globalThis.fetch
let calls = []
globalThis.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return new Response(new Uint8Array([79, 103, 103]), { status: 200 })
}
try {
  const { config } = await import('./config.js')
  check('new feature is off by default', () => assert.equal(config.whatsappSpokenReplies, false))
  const { speak, spokenText } = await import('./media.js')
  config.elevenlabs.apiKey = 'offline-test-key'
  config.elevenlabs.voiceId = 'unchanged-test-voice'
  config.elevenlabs.ttsModel = 'unchanged-test-model'
  await speak(plain, { prepared: true })
  check('prepared TTS sends one exact bounded input, same voice/model, no extra settings', () => {
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /unchanged-test-voice\?output_format=opus_48000_32$/)
    assert.deepEqual(calls[0].body, { text: plain, model_id: 'unchanged-test-model' })
  })
  const identifier = 'file_name_v2 נשאר בדיוק כך.'
  await speak(identifier, { prepared: true })
  check('prepared path avoids legacy underscore deletion', () => assert.equal(calls.at(-1).body.text, identifier))
  check('legacy non-WhatsApp sanitizer is unchanged', () => assert.equal(spokenText('file_name_v2'), 'filenamev2'))
  const before = calls.length
  await assert.rejects(speak('א'.repeat(1501), { prepared: true }), /budget/)
  await speak('', { prepared: true })
  check('oversize and empty prepared inputs never call provider', () => assert.equal(calls.length, before))
  config.elevenlabs.apiKey = ''
  config.voice.ttsModel = 'existing-compatible-model'
  config.voice.ttsVoice = 'existing-voice'
  config.voice.baseUrl = 'https://offline.invalid/v1'
  await speak(plain, { prepared: true })
  check('compatible provider also receives exact text with original settings', () => {
    assert.deepEqual(calls.at(-1).body, { model: 'existing-compatible-model', voice: 'existing-voice', input: plain, response_format: 'opus' })
  })
  const index = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const agent = fs.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
  check('WhatsApp wiring keeps full reply fallback/companion and matching face transcript', () => {
    assert.match(index, /config\.whatsappSpokenReplies && wantsVoice/)
    assert.match(index, /source: 'whatsapp', spokenReply,/)
    assert.match(index, /const sent = await deliverWhatsAppSpeech/)
    assert.match(index, /if \(sent\.voiceSent\) presentSpeech\(\{ text: delivery\.speech, audio: spoken/)
    assert.match(index, /await wa\.send\(state\.owner\.jid, reply\)/)
  })
  check('ordinary and exhausted-turn system prompts both include scoped delivery style', () => {
    assert.match(agent, /content: spokenReplySystem\(system, ctx\)/)
    assert.match(agent, /content: spokenReplySystem\(ctx\.isolated/)
  })
} finally {
  globalThis.fetch = savedFetch
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(`${passed} passed, 0 skipped (offline; listening and real send not tested)`)
