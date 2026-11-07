// node src/live-voice-selftest.js
// Offline: no LiveKit server, no Groq, no ElevenLabs. Tokens are signed and checked locally.
import { AccessToken } from 'livekit-server-sdk'
import {
  COST_NOTE,
  callerAllowed,
  isCloudUrl,
  phoneKey,
  LIVE_NOTE,
  createCall,
  createVad,
  liveCallReply,
  liveJoin,
  liveLink,
  liveVoiceFrom,
  liveVoiceStatus,
  livekitSignalPath,
  livekitUpstream,
  mintJoinToken,
  parseLiveCall,
  secretOk,
  signalingUrl,
  spokenLine,
  synthesize,
  takeSlot,
  resetSlots,
  verifyJoinToken,
  wavFromPcm,
} from './live-voice.js'

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

const off = liveVoiceFrom({})
ok(off.enabled === false && off.ready === false, 'unset flag is off and not ready')
ok(!liveVoiceFrom({ LIVE_VOICE: 'on' }).ready, 'the flag without keys does not open a room')
ok(liveVoiceFrom({ LIVE_VOICE: 'on', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secretsecretsecretsecret' }).ready, 'flag plus key pair is ready')
ok(liveVoiceFrom({ LIVE_VOICE: 'off', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secretsecretsecretsecret' }).ready === false, 'keys alone stay off')
const shown = liveVoiceStatus({ LIVE_VOICE: 'on', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secretsecretsecretsecret' })
ok(shown.ready && !JSON.stringify(shown).includes('secretsecret'), 'status has no secret')

ok(parseLiveCall('תתקשר אליי'), 'call me, Hebrew')
ok(parseLiveCall('תתקשר אליי!'), 'punctuation')
ok(parseLiveCall('היי הלפר תתקשר אליי בבקשה'), 'name and please')
ok(parseLiveCall('call me'), 'english')
ok(parseLiveCall('שיחה חיה'), 'live session phrase')
for (const no of ['', 'תתקשר לאמא', 'תתקשר אליי מחר', 'תתקשר אליי ותגיד לו', 'מה נשמע', 'היי']) {
  ok(!parseLiveCall(no), `not a call command: ${no || '(empty)'}`)
}

const link = liveLink('http://37.60.240.231:3210/?t=abc123')
ok(link === 'http://37.60.240.231:3210/live?t=abc123', 'join link keeps the settings token')
const replyOff = liveCallReply('http://127.0.0.1:3210/?t=abc', {})
ok(replyOff.includes('כבויה') && replyOff.includes('/live?t=abc'), 'a closed feature still explains where to read')
const readyEnv = { LIVE_VOICE: 'on', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secretsecretsecretsecret' }
ok(liveCallReply('http://127.0.0.1:3210/?t=abc', readyEnv).includes('אפשר לקטוע'), 'an open feature sends the link')

ok(signalingUrl('37.60.240.231:3210') === 'ws://37.60.240.231:3210/livekit', 'signal stays on the settings port')
ok(signalingUrl('helper.example', 'https') === 'wss://helper.example/livekit', 'https becomes wss')
ok(livekitSignalPath('/livekit/rtc?access_token=abc') === '/rtc?access_token=abc', 'signal path is forwarded')
ok(livekitSignalPath('/livekit/rtc/validate') === '/rtc/validate', 'validate is part of the signal')
ok(livekitSignalPath('/livekit/twirp/livekit.RoomService/ListRooms') === null, 'admin API is not proxied')
ok(livekitSignalPath('/rtc') === null, 'a bare rtc path is not ours')
ok(livekitUpstream('ws://livekit:7880').hostname === 'livekit' && livekitUpstream('ws://livekit:7880').port === 7880, 'upstream is the docker name')

const cfg = liveVoiceFrom(readyEnv)
const jwt = await mintJoinToken(cfg, 'phone')
const claims = await verifyJoinToken(cfg, jwt)
ok(claims.sub === 'phone', 'token identity is the phone')
ok(claims.video?.room === 'helper' && claims.video?.roomJoin === true, 'token joins the helper room')
ok(claims.video?.canPublish === true && claims.video?.canSubscribe === true, 'phone can talk and hear')
let rejected = false
try {
  await mintJoinToken(cfg, 'helper-voice')
} catch {
  rejected = true
}
ok(rejected, 'the owner cannot mint the agent identity')
const joined = await liveJoin({ identity: 'browser', host: '10.0.0.5:3210', env: readyEnv })
ok(joined.ok && joined.url === 'ws://10.0.0.5:3210/livekit' && joined.token, 'browser join returns a token')
ok((await liveJoin({ identity: 'phone', host: 'h', env: {} })).ok === false, 'join while off does not return a token')

ok(secretOk('secretsecretsecretsecret', 'secretsecretsecretsecret'), 'matching secret')
ok(!secretOk('secretsecretsecretsecret', 'secretsecretsecretsecreT'), 'one character off')
ok(!secretOk('', 'secretsecretsecretsecret') && !secretOk('x', ''), 'empty secret never matches')

ok(spokenLine('ראו https://example.com *מודגש*').includes('קישור') && !spokenLine('ראו https://example.com').includes('http'), 'links are not spoken')
ok(LIVE_NOTE.includes('וואטסאפ') && LIVE_NOTE.includes('מוחקת'), 'the live turn still names the approval gates')

const pcm = await synthesize('שלום', readyEnv, {
  eleven: async (line) => Buffer.from(line, 'utf8'),
})
ok(pcm.engine === 'edge', 'without an ElevenLabs voice the free Hebrew voice is chosen')
const withVoice = { ...readyEnv, ELEVENLABS_API_KEY: 'xi', ELEVENLABS_VOICE_ID: 'voice' }
const eleven = await synthesize('שלום עולם', withVoice, {
  eleven: async (line, opts) => {
    ok(opts.elevenVoice === 'voice' && line === 'שלום עולם', 'eleven gets the spoken line and the saved voice')
    return Buffer.from([1, 2, 3, 4])
  },
})
ok(eleven.engine === 'eleven' && eleven.pcm.length === 4, 'eleven audio is returned')
const fell = await synthesize('שלום', withVoice, {
  eleven: async () => {
    throw new Error('quota')
  },
})
ok(fell.engine === 'edge' && fell.fellBack && fell.voice === 'he-IL-HilaNeural', 'a failed eleven voice falls back to edge')

const wav = wavFromPcm(Buffer.from([1, 2, 3, 4]))
ok(wav.slice(0, 4).toString() === 'RIFF' && wav.readUInt32LE(40) === 4, 'wav wraps pcm')

const vad = createVad({ threshold: 0.02, startFrames: 2, endFrames: 2 })
const silence = Buffer.alloc(320 * 2)
const loud = Buffer.alloc(320 * 2)
for (let i = 0; i < 320; i++) loud.writeInt16LE(8000, i * 2)
ok(vad.push(silence).event === 'quiet', 'silence is quiet')
ok(vad.push(loud).event === 'quiet', 'one loud frame is not speech yet')
ok(vad.push(loud).event === 'start', 'two loud frames start speech')
ok(vad.push(silence).event === 'speech', 'a short gap stays inside the utterance')
const ended = vad.push(silence)
ok(ended.event === 'end' && ended.audio.length > 100, 'silence ends the utterance and keeps the audio')

let interrupted = 0
let heard = 0
const call = createCall({
  vad: createVad({ threshold: 0.02, startFrames: 2, endFrames: 2 }),
  onInterrupt: () => interrupted++,
  onUtterance: () => heard++,
})
call.setPlaying(true)
call.push(loud)
ok(call.push(loud).event === 'start' && interrupted === 1 && call.playing === false && call.generation === 1, 'talking over HELPER interrupts')
call.push(silence)
call.push(silence)
ok(heard === 1, 'the utterance is still delivered after the interrupt')


// Phone numbers on LiveKit Cloud: the worker is named, the browser token asks for it, only the owner gets in.
ok(isCloudUrl('wss://helper-abc.livekit.cloud') && !isCloudUrl('ws://livekit:7880') && !isCloudUrl('wss://evil.example/livekit.cloud'), 'only a livekit.cloud wss address is Cloud')
ok(phoneKey('+972 50-123-4567') === '972501234567' && phoneKey('050-1234567') === '972501234567' && phoneKey('00972501234567') === '972501234567', 'Israeli number forms match')
ok(callerAllowed('+972501234567', '972501234567', {}), 'the owner may call')
ok(callerAllowed('0501234567', '972501234567', {}), 'the owner in local form may call')
ok(!callerAllowed('+14845550000', '972501234567', {}), 'a stranger is hung up')
ok(!callerAllowed('', '972501234567', {}) && !callerAllowed('+972501234567', '', {}), 'no caller id or no owner means no')
ok(callerAllowed('+14845550000', '972501234567', { LIVE_VOICE_PHONE_ALLOW: '+1 484 555 0000, 0529999999' }), 'an allowed extra number may call')
const cloudEnv = { ...readyEnv, LIVEKIT_URL: 'wss://helper-abc.livekit.cloud', LIVE_VOICE_AGENT_NAME: 'helper-voice' }
const cloudJoin = await liveJoin({ identity: 'browser', host: '37.60.240.231:3210', env: cloudEnv })
ok(cloudJoin.ok && cloudJoin.url === 'wss://helper-abc.livekit.cloud', 'Cloud join goes straight to Cloud, not through the proxy')
const cloudClaims = await verifyJoinToken(liveVoiceFrom(cloudEnv), cloudJoin.token)
ok(cloudClaims.roomConfig?.agents?.[0]?.agentName === 'helper-voice', 'a named worker is dispatched by the join token')
const plainClaims = await verifyJoinToken(cfg, await mintJoinToken(cfg, 'browser'))
ok(!plainClaims.roomConfig, 'no agent name keeps the old automatic join')

resetSlots()
ok(takeSlot('turn', 2, 0) && takeSlot('turn', 2, 10) && !takeSlot('turn', 2, 20), 'a minute has a cap')
ok(takeSlot('turn', 2, 60000), 'the next minute starts over')

// A token minted the same way LiveKit checks it still names the room. Guards a claim-shape change.
const sample = new AccessToken('key', 'secretsecretsecretsecret', { identity: 'phone', ttl: '1h' })
sample.addGrant({ roomJoin: true, room: 'helper', canPublish: true, canSubscribe: true })
ok(typeof (await sample.toJwt()) === 'string', 'the sdk still mints a string token')

for (const note of Object.values(COST_NOTE)) ok(note.length > 20, 'cost note is written')

console.log(failed ? `${failed} failed, ${passed} passed` : `ok ${passed}`)
process.exit(failed ? 1 : 0)
