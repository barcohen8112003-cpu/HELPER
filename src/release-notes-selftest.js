// Offline. No WhatsApp and no model: the deploy note decides when to send, and what it is allowed to say.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-release-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, 'empty.env')

const { config } = await import('./config.js')
const notes = await import('./release-notes.js')

const file = path.join(tmp, 'last-release.json')
const sha = '3775c28b488cdcb849df38b05014bcd84d141cab'
const older = '7efafa42a5194b8e8e3c173cf6d39ad202c52388'
const info = {
  sha,
  short: '3775c28',
  commits: [
    { sha, subject: 'קבוצות ומצב סוכן', body: 'LLM_API_KEY=supersecretvalue123' },
    { sha: older, subject: 'תיקון מנעול', body: 'nothing secret' },
    { sha: '67864eb90583cf9950e2beca187f4a6f132174f7', subject: 'ישן', body: '' },
  ],
}

let passed = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  passed++
}

ok(notes.redact('LLM_API_KEY=supersecretvalue123').includes('LLM_API_KEY=[סודי]') && !notes.redact('LLM_API_KEY=supersecretvalue123').includes('supersecretvalue123'), 'env assignments are stripped')
ok(notes.redact('sk-abcdefghijklmnopqrstuvwxyz').includes('[סודי]') && !notes.redact('sk-abcdefghijklmnopqrstuvwxyz').includes('sk-abc'), 'api-key shaped strings are stripped')
ok(notes.commitsSince(info, older).length === 1 && notes.commitsSince(info, older)[0].sha === sha, 'only commits after the announced sha')
ok(notes.commitsSince(info, null).length === 1, 'a first run keeps the latest commit only')

config.updateNotes = false
let sent = []
let r = await notes.announceRelease({ send: async (t) => sent.push(t), info, file, enabled: false })
ok(r.reason === 'off' && sent.length === 0 && !fs.existsSync(file), 'UPDATE_NOTES=off sends nothing and writes nothing')

r = await notes.announceRelease({ send: async (t) => sent.push(t), info: { sha: 'unknown', commits: [] }, file, enabled: true })
ok(r.reason === 'no-sha' && sent.length === 0, 'an unknown sha stays quiet')

let asked = ''
const ask = async (system, user) => {
  asked = user
  return '• קורא שמות של קבוצות\n• מצב סוכן'
}
r = await notes.announceRelease({ send: async (t) => sent.push(t), ask, info, file, enabled: true })
ok(r.sent && sent.length === 1 && sent[0].includes('עודכנתי לגרסה 3775c28') && sent[0].includes('קבוצות'), 'the first run says the version and a short summary')
ok(!asked.includes('supersecretvalue123') && !sent[0].includes('supersecretvalue123'), 'the secret never reaches the model or the chat')
ok(JSON.parse(fs.readFileSync(file, 'utf8')).announced === true, 'the sha is stored after a successful send')
sent.length = 0
r = await notes.announceRelease({ send: async (t) => sent.push(t), ask, info, file, enabled: true })
ok(r.reason === 'same' && sent.length === 0, 'the same sha on a later start does not send again')

fs.writeFileSync(file, JSON.stringify({ sha: older, attempts: 0, announced: true }))
asked = ''
r = await notes.announceRelease({
  send: async (t) => sent.push(t),
  ask: async () => { throw new Error('model down') },
  info,
  file,
  enabled: true,
})
ok(r.sent && sent[0].includes('עודכנתי לגרסה 3775c28') && sent[0].includes('קבוצות ומצב סוכן'), 'a failed model falls back to the commit subject')
ok(!sent[0].includes('תיקון מנעול'), 'the fallback does not repeat commits already announced')

fs.writeFileSync(file, JSON.stringify({ sha, attempts: 0, announced: false }))
sent.length = 0
r = await notes.announceRelease({
  send: async () => { throw new Error('whatsapp down') },
  ask: async () => '• שורה',
  info,
  file,
  enabled: true,
})
ok(r.reason === 'send-failed' && JSON.parse(fs.readFileSync(file, 'utf8')).announced === false, 'a failed send is not marked announced')
r = await notes.announceRelease({
  send: async () => { throw new Error('whatsapp down') },
  ask: async () => '• שורה',
  info,
  file,
  enabled: true,
})
ok(r.reason === 'send-failed' && JSON.parse(fs.readFileSync(file, 'utf8')).attempts === 2, 'a second crash is counted')
r = await notes.announceRelease({
  send: async (t) => sent.push(t),
  ask: async () => '• שורה',
  info,
  file,
  enabled: true,
})
ok(r.reason === 'gave-up' && sent.length === 0, 'a crash loop stops after two attempts')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, 0 נכשלו`)
