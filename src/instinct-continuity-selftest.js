// Offline checks for the Instinct conversation staying consistent (src/instinct.js):
// - one model call at a time per conversation, even when Instinct writes again while Helper is still thinking;
// - an answer thought up for a conversation that was stopped or replaced is never sent into the new one;
// - a send whose outcome is unknown is reported to the owner as "maybe sent" and never sent again on its own;
// - a send that surely did not leave (WhatsApp down) pauses the conversation instead of being counted as sent;
// - after a restart the owner hears once that the conversation was cut off. Only metadata was kept, never the
//   goal or the messages, so the notice does not promise that the context was saved.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.HELPER_ENV_FILE = '/nonexistent/.env'
process.env.HELPER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-cont-'))
process.env.INSTINCT_NUMBER = '+1 (650) 870-2892'
const inst = await import('./instinct.js')
const { state } = await import('./store.js')

let passed = 0
const failed = []
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed.push(name)
    console.log(`FAIL ${name}`)
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const JID = '16508702892@s.whatsapp.net'
const fromInstinct = (text) => ({ jids: [JID], fromMe: false, text })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

let sent = []
let told = []
let sendImpl = async (jid, text) => (sent.push(text), `MSG${sent.length}`)
const connect = () => inst.connectInstinct({ send: (jid, text) => sendImpl(jid, text), notify: async (text) => told.push(text) })
const fresh = () => {
  inst._test.reset()
  sent = []
  told = []
  sendImpl = async (jid, text) => (sent.push(text), `MSG${sent.length}`)
  connect()
}
const start = (goal = 'למצוא מסעדה', text = 'היי, אתה מכיר מסעדה טובה?') => inst.instinctChat({ action: 'start', goal, text }, { confirm: async () => true }, { quietMs: 10 })

// 1. Serial: Instinct writes again while the first answer is still being thought up. Only one think runs; the
//    second message is answered after the first answer, in order.
fresh()
{
  let calls = 0
  let running = 0
  let overlap = false
  const gates = []
  inst._test.setThink(async () => {
    calls++
    running++
    if (running > 1) overlap = true
    const d = deferred()
    gates.push(d)
    const reply = await d.promise
    running--
    return reply
  })
  await start()
  await inst.onInstinctMessage(fromInstinct('יש את פסטה בסטה'))
  await wait(40)
  ok(calls === 1, 'serial: first message starts one think')
  await inst.onInstinctMessage(fromInstinct('רוצה שאבדוק מקום?'))
  await wait(40)
  ok(calls === 1 && !overlap, 'serial: a second message while thinking does not start a second think')
  gates[0]?.resolve('תשובה ראשונה')
  await wait(40)
  ok(calls === 2 && !overlap, 'serial: the waiting message is answered after the first think ends')
  gates[1]?.resolve('תשובה שנייה')
  await wait(40)
  ok(sent.at(-2) === '[HELPER] תשובה ראשונה' && sent.at(-1) === '[HELPER] תשובה שנייה', 'serial: answers leave in order')
  const h = inst._test.chat()?.history || []
  const roles = h.map((m) => m.role).join(',')
  ok(roles === 'assistant,user,assistant,user,assistant', `serial: history alternates (${roles})`)
}

// 2. "עצור" while thinking: nothing is sent.
fresh()
{
  const d = deferred()
  inst._test.setThink(() => d.promise)
  await start()
  await inst.onInstinctMessage(fromInstinct('מה דעתך?'))
  await wait(30)
  const before = sent.length
  inst.stopInstinctChat()
  d.resolve('תשובה מאוחרת')
  await wait(30)
  ok(sent.length === before, 'stop during think: the late answer is not sent')
}

// 3. Replaced while thinking: the old conversation's answer never reaches the new one.
fresh()
{
  const d = deferred()
  inst._test.setThink(() => d.promise)
  await start('שיחה א', 'פתיחה א')
  await inst.onInstinctMessage(fromInstinct('הודעה בשיחה א'))
  await wait(30)
  inst.stopInstinctChat()
  await start('שיחה ב', 'פתיחה ב')
  d.resolve('תשובה של שיחה א')
  await wait(30)
  ok(!sent.includes('[HELPER] תשובה של שיחה א'), 'replaced during think: old answer is not sent')
  const h = inst._test.chat()?.history || []
  ok(h.length === 1 && h[0].content === 'פתיחה ב', 'replaced during think: the new conversation history is untouched')
}

// 4. A reply whose send outcome is unknown: the owner hears "maybe sent", it is never sent again, and the model
//    later sees that it may not have arrived.
fresh()
{
  let thinkMessages = null
  const replies = ['תשובה שאולי לא יצאה', 'המשך']
  inst._test.setThink(async (messages) => ((thinkMessages = messages), replies.shift() ?? ''))
  await start()
  sendImpl = async () => {
    throw new Error('Connection Closed')
  }
  let crashed = false
  await inst.onInstinctMessage(fromInstinct('שאלה'))
  await wait(40).catch(() => (crashed = true))
  ok(!crashed, 'uncertain send: no unhandled crash')
  ok(told.some((t) => /ייתכן/.test(t) && /לא אשלח (אותה )?שוב/.test(t)), 'uncertain send: owner told it may or may not have left, and it will not be resent')
  const attempts = []
  sendImpl = async (jid, text) => (attempts.push(text), sent.push(text), `MSG${sent.length}`)
  await inst.onInstinctMessage(fromInstinct('קיבלתי, ועוד שאלה'))
  await wait(40)
  ok(!attempts.includes('[HELPER] תשובה שאולי לא יצאה'), 'uncertain send: never sent again on its own')
  ok(Boolean(thinkMessages?.some((m) => m.role === 'assistant' && /אולי לא נשלח/.test(m.content))), 'uncertain send: the model sees the reply marked as maybe not sent')
  ok(state.instinct?.lastSend?.status === 'accepted' || state.instinct?.lastSend?.status === 'uncertain', 'uncertain send: a send result is recorded')
}

// 5. A send that surely did not leave (WhatsApp not connected): paused, owner told, not counted as a turn.
fresh()
{
  inst._test.setThink(async () => 'תשובה')
  await start()
  const turns = inst._test.chat()?.turns
  sendImpl = async () => {
    const e = new Error('וואטסאפ לא מחובר כרגע')
    e.notSent = true
    throw e
  }
  await inst.onInstinctMessage(fromInstinct('שאלה'))
  await wait(40)
  const c = inst._test.chat()
  ok(Boolean(c?.paused) && c?.turns === turns, 'failed send: conversation paused, turn not counted')
  ok(told.some((t) => /לא נשלח/.test(t)), 'failed send: owner told it was not sent')
  ok(!(c?.history || []).some((m) => m.role === 'assistant' && m.content === 'תשובה'), 'failed send: not in history as if Instinct got it')
}

// 6. ask_instinct: a send that throws comes back as a clear result, not an exception.
fresh()
{
  state.instinct = { trusted: true, sent: [], lastAskAt: 0, lateUntil: 0 }
  sendImpl = async () => {
    throw new Error('timed out')
  }
  let res
  try {
    res = await inst.askInstinct({ question: 'מה השעה?' }, {}, { quietMs: 10, waitMs: 50 })
  } catch (e) {
    res = `threw: ${e.message}`
  }
  ok(/ייתכן/.test(res) && !/^threw/.test(res), 'ask uncertain: says it may have been sent, does not throw')
  ok(state.instinct.sent.length === 1, 'ask uncertain: counts toward the hourly limit (it may have left)')
  sendImpl = async () => {
    const e = new Error('וואטסאפ לא מחובר כרגע')
    e.notSent = true
    throw e
  }
  try {
    res = await inst.askInstinct({ question: 'מה השעה?' }, {}, { quietMs: 10, waitMs: 50 })
  } catch (e) {
    res = `threw: ${e.message}`
  }
  ok(/לא נשלח/.test(res) && state.instinct.sent.length === 1, 'ask failed: says not sent, not counted')
}

// 7. Only metadata is kept on disk while a conversation runs: never the goal or the messages.
fresh()
{
  inst._test.setThink(async () => 'תשובה פרטית מאוד')
  await start('מטרה סודית', 'הודעת פתיחה סודית')
  await inst.onInstinctMessage(fromInstinct('תוכן סודי מ-Instinct'))
  await wait(40)
  const kept = JSON.stringify(state.instinct || {})
  ok(Boolean(state.instinct?.chat?.active), 'metadata: an active conversation is recorded')
  ok(!/סודי|פרטית/.test(kept), 'metadata: no goal or message text in state')
}

// 8. Restart while a conversation was running and a send was in flight: one notice, no send, no content, and the
//    in-flight send is recorded as uncertain.
fresh()
{
  state.instinct = { trusted: true, sent: [], lastAskAt: 0, lateUntil: 0, generation: 4, chat: { active: true, gen: 4, learn: false, started: Date.now() - 60_000, turns: 3, paused: false }, pending: { op: 'op-x', gen: 4, at: Date.now() - 5000, kind: 'chat' } }
  const notices = []
  const notify = async (text, urgent, key) => notices.push({ text, key })
  const r1 = typeof inst.recoverInstinct === 'function' ? inst.recoverInstinct(notify) : null
  await wait(10)
  ok(notices.length === 1 && /נקטעה/.test(notices[0]?.text || ''), 'restart: one notice that the conversation was cut off')
  ok(/לא שמרתי/.test(notices[0]?.text || '') && !/ההקשר נשמר/.test(notices[0]?.text || ''), 'restart: does not promise saved context')
  ok(/ייתכן/.test(notices[0]?.text || '') && /לא אשלח/.test(notices[0]?.text || ''), 'restart: in-flight send reported as maybe sent, not resent')
  ok(/^instinct-recovery-/.test(notices[0]?.key || ''), 'restart: notice has a dedup key')
  ok(sent.length === 0 && !inst.instinctChatOn(), 'restart: nothing sent, no conversation resumed on its own')
  ok(state.instinct.lastSend?.status === 'uncertain' && !state.instinct.pending, 'restart: in-flight send recorded as uncertain')
  ok(state.instinct.generation > 4, 'restart: generation moves on')
  if (typeof inst.recoverInstinct === 'function') inst.recoverInstinct(notify)
  await wait(10)
  ok(notices.length === 1, 'restart: a second recovery pass does not notify again')
  ok(r1 !== null, 'restart: recoverInstinct exists')
}

console.log(`instinct continuity selftest: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
