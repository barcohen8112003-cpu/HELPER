// Offline checks for learning which of Helper's own messages to keep sending.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-notices-'))
delete process.env.NOTICE_LEARNING
const { state } = await import('./store.js')
const { kindOf, noticeLevel, noticeSent, noticeEngaged, noticeStatus, parseNoticeCommand, runNoticeCommand, learningOn, ENGAGED_WITHIN, DEMOTE_AFTER, DROP_AFTER } = await import('./notice-learning.js')
let passed = 0
const ok = (cond) => (assert.ok(cond), passed++)
const MIN = 60000
const DAY = 24 * 3600000
let t = Date.UTC(2026, 9, 27, 10)

// Follow-up pacing (src/proactive.js) keeps its own object. Learning must not replace it.
const pace = { lastUserAt: 1, unanswered: 2, lastOutAt: 3, followDay: 'x', followCount: 1 }
state.proactive = { ...pace }
ok(learningOn() === false)
ok(noticeLevel('news', false, t) === 'interrupt')
noticeSent('news', t)
noticeEngaged(t)
ok(!state.notices && JSON.stringify(state.proactive) === JSON.stringify(pace), 'off: nothing is recorded and follow-ups are untouched')
runNoticeCommand(parseNoticeCommand('תפסיק לשלוח לי הודעות על חדשות'))
ok(noticeLevel('news', false, t) === 'drop', 'an explicit mute is honored while learning is off')
ok(noticeLevel('news', true, t) === 'interrupt')
runNoticeCommand(parseNoticeCommand('תחזור לשלוח חדשות'))
ok(noticeLevel('news', false, t) === 'interrupt')
ok(JSON.stringify(state.proactive) === JSON.stringify(pace))

process.env.NOTICE_LEARNING = 'true'
ok(learningOn() === true)
for (let i = 0; i < DROP_AFTER; i++) noticeSent('loop', t + i)
ok(noticeLevel('loop', false, t) === 'interrupt', 'follow-ups are never quieted by notice learning')
ok(JSON.stringify(state.proactive) === JSON.stringify(pace))

ok(kindOf('homework-new:a,b') === 'homework-new')
ok(kindOf(undefined, 'checkin') === 'checkin')
ok(kindOf() === 'general')

// A new kind is sent; urgent and protected kinds always are.
ok(noticeLevel('news', false, t) === 'interrupt')
ok(noticeLevel('news', true, t) === 'interrupt')
ok(noticeLevel('cost-month', false, t) === 'interrupt')

// Replies keep a kind at full volume.
for (let i = 0; i < 5; i++) { noticeSent('news', t); t += 5 * MIN; noticeEngaged(t); t += DAY }
ok(noticeLevel('news', false, t) === 'interrupt')

// Silence turns it down in steps: next brief after 3 ignored, dropped after 6.
for (let i = 0; i < DEMOTE_AFTER; i++) { noticeSent('weekly', t); t += ENGAGED_WITHIN + MIN }
ok(noticeLevel('weekly', false, t) === 'batch')
for (let i = 0; i < DROP_AFTER - DEMOTE_AFTER; i++) { noticeSent('weekly', t); t += ENGAGED_WITHIN + MIN }
ok(noticeLevel('weekly', false, t) === 'drop')
// A reply to the next one that does get through starts it over.
t += 8 * DAY
ok(noticeLevel('weekly', false, t) === 'batch') // a week of quiet forgives three ignores
t += 7 * DAY
ok(noticeLevel('weekly', false, t) === 'interrupt') // and another week, the rest
noticeSent('weekly', t); t += 10 * MIN; noticeEngaged(t)
ok(noticeLevel('weekly', false, t) === 'interrupt')

// A reply later than the window is not credited.
noticeSent('checkin', t); t += ENGAGED_WITHIN + MIN; noticeEngaged(t)
ok(noticeStatus(t).includes('בדיקות מיוזמתי: נשלח מיד (נשלחו 1, הגבת ל-0)'))

// Commands.
ok(JSON.stringify(parseNoticeCommand('תפסיק לשלוח לי הודעות על חדשות')) === '{"action":"mute","kinds":["news"]}')
ok(parseNoticeCommand('תפסיק לשלוח לי מטלות').kinds.includes('homework-new'))
ok(parseNoticeCommand('תחזור לשלוח לי חדשות').action === 'unmute')
ok(parseNoticeCommand('מה אתה שולח לי').action === 'status')
ok(parseNoticeCommand('תפסיק') === null)
ok(parseNoticeCommand('תפסיק לשלוח לי הודעות על הכלב') === null)
ok(parseNoticeCommand('מה מזג האוויר') === null)
runNoticeCommand(parseNoticeCommand('תפסיק לשלוח לי הודעות על חדשות'))
ok(noticeLevel('news', false, t) === 'drop')
ok(noticeLevel('news', true, t) === 'interrupt')
ok(noticeStatus(t).includes('חדשות הבוקר: מושתק'))
runNoticeCommand(parseNoticeCommand('תחזור לשלוח חדשות'))
ok(noticeLevel('news', false, t) === 'interrupt')

console.log(`${passed} בדיקות עברו, 0 נכשלו`)
