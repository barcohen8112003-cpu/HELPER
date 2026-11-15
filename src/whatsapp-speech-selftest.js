// Offline only. No model, ElevenLabs, voice identity change, or live WhatsApp.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { humanError } from './style.js'
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
    sendText: async (value) => { events.push(['text', value]); return 'synthetic-text-id' },
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
    sendText: async (value) => { events.push(['text', value]); return 'synthetic-text-id' }, sendVoice: async () => { events.push(['voice']); return 'synthetic-voice-id' },
  })
  check('successful companion lands before voice notice', () => {
    assert.deepEqual(result, { textSent: true, voiceSent: true })
    assert.deepEqual(events.map(([kind]) => kind), ['text', 'voice'])
  })
}
{
  const events = []
  const result = await deliverWhatsAppSpeech({ reply: plain, delivery: { companion: false }, audio: null,
    sendText: async (value) => { events.push(value); return 'synthetic-text-id' }, sendVoice: async () => { throw new Error('must not attempt audio') },
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

for (const unconfirmed of [null, undefined, '', '   ']) {
  for (const companion of [true, false]) {
    const events = []
    await assert.rejects(deliverWhatsAppSpeech({ reply: plain, delivery: { companion }, audio: Buffer.from('audio'),
      sendText: async () => { events.push('text'); return unconfirmed },
      sendVoice: async () => { events.push('voice'); throw new Error('synthetic voice rejection') },
    }), error => error.deliveryUncertain === true)
    check(`unconfirmed text suppresses notice and never retries original (${String(unconfirmed)}, companion=${companion})`, () => {
      assert.equal(events.filter(kind => kind === 'text').length, 1)
      assert.deepEqual(events, companion ? ['text'] : ['voice', 'text'])
    })
  }
}

// Execute the exact production delivery block with inert transports, not the server.
// This catches disconnects between the tested helper and the actual WhatsApp call site.
{
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const start = source.indexOf('      const delivery = spokenReply')
  const end = source.indexOf('      answered = true', start)
  assert(start >= 0 && end > start, 'production delivery block located')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const deliver = new AsyncFunction('reply', 'spokenReply', 'wantsVoice', 'speak', 'wa', 'state', 'presentSpeech', 'prepareWhatsAppSpeech', 'deliverWhatsAppSpeech', source.slice(start, end))
  for (const scenario of ['ok', 'synthesis-null', 'synthesis-reject', 'voice-reject', 'text-reject', 'text-null', 'text-undefined']) {
    const events = []
    let faceCalls = 0
    const reply = '```js\nconst file_name_v2 = 50\n```'
    const operation = deliver(reply, true, true,
      async () => { if (scenario === 'synthesis-reject') throw new Error('synthetic synthesis failure'); return scenario === 'synthesis-null' ? null : Buffer.from('synthetic') },
      { send: async (_, text) => { events.push(['text', text]); if (scenario === 'text-reject') throw new Error('synthetic text failure'); return scenario === 'text-null' ? null : scenario === 'text-undefined' ? undefined : 'synthetic-text-id' },
        sendVoice: async () => { events.push(['voice']); if (scenario === 'voice-reject') throw new Error('synthetic voice failure'); return 'synthetic-voice-id' } },
      { owner: { jid: 'synthetic' } }, async () => { faceCalls++ }, prepareWhatsAppSpeech, deliverWhatsAppSpeech)
    if (scenario.startsWith('text-')) await assert.rejects(operation, /text failure|could not be confirmed/)
    else await operation
    check(`executable production delivery: ${scenario}`, () => {
      assert.equal(events[0][0], 'text')
      assert.equal(events[0][1], reply)
      assert.equal(events.filter(([kind]) => kind === 'text').length, 1)
      assert.equal(faceCalls, scenario === 'ok' ? 1 : 0)
      assert.equal(events.filter(([kind]) => kind === 'voice').length, ['ok', 'voice-reject'].includes(scenario) ? 1 : 0)
    })
  }
  const legacy = []
  await deliver(plain, false, true, async () => Buffer.from('synthetic'),
    { send: async () => legacy.push('text'), sendVoice: async () => legacy.push('voice') },
    { owner: { jid: 'synthetic' } }, async () => {}, prepareWhatsAppSpeech, deliverWhatsAppSpeech)
  check('executable flag-off delivery still sends simple voice without companion', () => assert.deepEqual(legacy, ['voice']))
}

// Execute the production outer catch with the real scoped helper error and humanError.
{
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const start = source.indexOf('    } catch (e) {', source.indexOf('      const delivery = spokenReply'))
  const end = source.indexOf('    } finally {', start)
  const body = source.slice(start + '    } catch (e) {'.length, end)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const handle = new AsyncFunction('e', 'config', 'wa', 'state', 'humanError', 'settle', 'Aborted', 'ac', body)
  for (const noticeReturn of ['synthetic-notice-id', null, undefined]) {
    let error
    try {
      await deliverWhatsAppSpeech({ reply: plain, delivery: { companion: true }, audio: Buffer.from('synthetic'),
        sendText: async () => null, sendVoice: async () => { throw new Error('must not send notice audio') } })
    } catch (e) { error = e }
    const events = []
    let genericCalls = 0
    await handle(error, { whatsappSpokenReplies: true },
      { send: async (_, text) => { events.push(['notice', text]); return noticeReturn } },
      { owner: { jid: 'synthetic' } }, e => { genericCalls++; return humanError(e) },
      how => events.push(['settle', how]), class Aborted extends Error {}, { signal: { aborted: false } })
    check(`production outer catch keeps delivery uncertainty scoped (notice=${String(noticeReturn)})`, () => {
      assert.equal(genericCalls, 0)
      assert.equal(events.filter(([kind]) => kind === 'notice').length, 1)
      assert.equal(events[0][1].includes(plain), false)
      assert.doesNotMatch(events[0][1], /נסה שוב|תבקש שוב|תגיד לי מה ביקשת/)
      assert.match(events[0][1], /התשובה/)
      assert.equal(events.filter(([kind]) => kind === 'settle').length, typeof noticeReturn === 'string' ? 1 : 0)
    })
  }
  let genericCalls = 0
  await handle(new Error('generic test failure'), { whatsappSpokenReplies: false },
    { send: async () => 'synthetic-notice-id' }, { owner: { jid: 'synthetic' } },
    e => { genericCalls++; return humanError(e) }, () => {}, class Aborted extends Error {}, { signal: { aborted: false } })
  check('production generic flag-off error still uses real humanError', () => assert.equal(genericCalls, 1))
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
  const { setEdgeExec } = await import('./tts.js')
  const edgeCalls = []
  setEdgeExec(async (cmd, args) => {
    edgeCalls.push({ cmd, args })
    if (cmd === 'ffmpeg') return Buffer.from('OggS-test-audio')
    return Buffer.alloc(128)
  })
  delete process.env.TTS_PROVIDER
  process.env.EDGE_TTS_VOICE = 'he-IL-HilaNeural'
  process.env.EDGE_TTS_RATE = '+0%'
  config.elevenlabs.apiKey = 'offline-test-key'
  config.elevenlabs.voiceId = 'unchanged-test-voice'
  config.elevenlabs.ttsModel = 'unchanged-test-model'
  await speak(plain, { prepared: true })
  check('prepared TTS uses Edge by default and keeps the exact text, even when an ElevenLabs key is set', () => {
    assert.equal(calls.length, 0)
    const spoken = edgeCalls.find((c) => c.cmd === 'edge-tts')
    assert.ok(spoken)
    assert.equal(spoken.args[spoken.args.indexOf('--text') + 1], plain)
    assert.equal(spoken.args[spoken.args.indexOf('--voice') + 1], 'he-IL-HilaNeural')
    const ff = edgeCalls.find((c) => c.cmd === 'ffmpeg')
    assert.ok(ff.args.includes('48000') && ff.args.includes('libopus') && ff.args.includes('ogg'))
  })
  const identifier = 'file_name_v2 נשאר בדיוק כך.'
  await speak(identifier, { prepared: true })
  check('prepared path avoids legacy underscore deletion', () => {
    const texts = edgeCalls.filter((c) => c.cmd === 'edge-tts').map((c) => c.args[c.args.indexOf('--text') + 1])
    assert.equal(texts.at(-1), identifier)
  })
  check('legacy non-WhatsApp sanitizer is unchanged', () => assert.equal(spokenText('file_name_v2'), 'filenamev2'))
  const beforeFetch = calls.length
  const beforeEdge = edgeCalls.length
  await assert.rejects(speak('א'.repeat(1501), { prepared: true }), /budget/)
  await speak('', { prepared: true })
  check('oversize and empty prepared inputs never call provider', () => {
    assert.equal(calls.length, beforeFetch)
    assert.equal(edgeCalls.length, beforeEdge)
  })
  process.env.TTS_PROVIDER = 'elevenlabs'
  await speak(plain, { prepared: true })
  check('TTS_PROVIDER=elevenlabs still sends one exact bounded input, same voice/model, no extra settings', () => {
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /unchanged-test-voice\?output_format=opus_48000_32$/)
    assert.deepEqual(calls[0].body, { text: plain, model_id: 'unchanged-test-model' })
  })
  config.elevenlabs.apiKey = ''
  config.elevenlabs.voiceId = ''
  config.voice.ttsModel = 'existing-compatible-model'
  config.voice.ttsVoice = 'existing-voice'
  config.voice.baseUrl = 'https://offline.invalid/v1'
  process.env.TTS_PROVIDER = 'openai'
  await speak(plain, { prepared: true })
  check('compatible provider also receives exact text with original settings', () => {
    assert.deepEqual(calls.at(-1).body, { model: 'existing-compatible-model', voice: 'existing-voice', input: plain, response_format: 'opus' })
  })
  delete process.env.TTS_PROVIDER
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
