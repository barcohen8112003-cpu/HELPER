// node src/answers-selftest.js: offline checks for the fixes from the "robotic Helper" review.
// Every message gets an answer (inbox ledger + watchdog note), dead links never reach him, the morning news cites a
// real headline with its link and rides inside the morning brief, and a WhatsApp reply is never split in two.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-answers-'))
Object.assign(process.env, {
  HELPER_DATA_DIR: dir,
  WATCH_STATE_PATH: path.join(dir, 'watch-state.json'),
  QUIET_HOURS: '22:00-07:00',
  DAILY_BRIEF_TIME: '07:30',
  NEWS_BRIEF_TIME: '07:30',
  DAILY_BRIEF_ALWAYS: 'false',
  DAILY_BRIEF_ONLY_TODAY: 'true',
})

const { config } = await import('./config.js')
const inbox = await import('./inbox.js')
const { checkLinks, linkOpens, urlsIn } = await import('./links.js')
const { attachSources, numberedNews, formatNews } = await import('./news.js')
const { newsInBrief } = await import('./scheduler.js')
const { createDelivery } = await import('./monitoring/delivery.js')
const { styleTells, polish } = await import('./style.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// ── every message gets an answer ─────────────────────────────────────────────
{
  const t0 = new Date(2026, 9, 29, 16, 52).getTime()
  let list = inbox.received([], 'A1', 'היי מה העדכון 33 עושה', t0)
  list = inbox.received(list, 'A1', 'twice', t0)
  ok(list.length === 1, 'the same message is logged once')
  ok(!inbox.overdue(list, { minutes: 5, now: t0 + 4 * 60000 }).length, 'no note before the wait is over')
  const late = inbox.overdue(list, { minutes: 5, now: t0 + 6 * 60000 })
  ok(late.length === 1 && /16:52/.test(late[0].text) && /תשלח אותה שוב/.test(late[0].text), 'an unanswered message gets one note with its time')
  ok(!inbox.overdue(list, { minutes: 5, now: t0 + 20 * 60000 }).length, 'the note goes once')
  list = inbox.received(list, 'B2', 'מה המערכת מחר', t0)
  const queued = inbox.overdue(list, { minutes: 5, now: t0 + 6 * 60000, busy: true, active: 'C3' })
  ok(/בתור/.test(queued[0].text), 'behind a long turn it says the message is in the queue')
  list = inbox.received(list, 'C3', 'משימה ארוכה', t0)
  ok(/לוקח יותר זמן/.test(inbox.overdue(list, { minutes: 5, now: t0 + 6 * 60000, busy: true, active: 'C3' })[0].text), 'the message being worked on gets a "still on it"')
  list = inbox.received(list, 'D4', 'תודה', t0)
  inbox.answered(list, 'D4', 'reply', t0 + 3000)
  ok(!inbox.overdue(list, { minutes: 5, now: t0 + 60 * 60000 }).some((l) => l.id === 'D4'), 'an answered message is never flagged')
  ok(!inbox.overdue(inbox.received([], 'E5', 'x', t0), { minutes: 0, now: t0 + 60 * 60000 }).length, 'UNANSWERED_ALERT_MIN=0 turns it off')
  let many = []
  for (let i = 0; i < 80; i++) many = inbox.received(many, `M${i}`, 'x', t0)
  ok(many.length === 50, 'the ledger keeps the last 50')
  ok(inbox.NO_ANSWER && !styleTells(inbox.NO_ANSWER).length, 'the empty-answer fallback is a short human question')
}

// ── links: only ones that open reach him ─────────────────────────────────────
{
  const fake = (alive) => async (url, { method }) => ({ ok: alive.includes(url), status: alive.includes(url) ? 200 : method === 'HEAD' ? 405 : 404 })
  ok(urlsIn('ראה https://a.co/x. ו-https://b.co').join(' ') === 'https://a.co/x https://b.co', 'urls are found without trailing punctuation')
  const reply = 'הכי שווה: X ב-349 ₪\nhttps://shop.example/x\nוגם: https://dead.example/y'
  const out = await checkLinks(reply, '', { fetchFn: fake(['https://shop.example/x']), offline: false })
  ok(out.includes('https://shop.example/x') && !out.includes('dead.example') && /לא נפתח לי/.test(out), 'a dead link is removed and said in one line')
  ok(!out.split('\n').some((l) => l.trim() === 'וגם'), 'the line that only carried the dead link goes with it')
  let calls = 0
  const counting = async () => (calls++, { ok: false, status: 404 })
  ok((await checkLinks(reply, 'tool said https://shop.example/x and https://dead.example/y', { fetchFn: counting, offline: false })) === reply && calls === 0, 'links a tool returned are not re-checked')
  ok((await linkOpens('https://blocked.example', async () => ({ ok: false, status: 403 }))) === true, 'a site that blocks robots still counts as open')
  ok((await linkOpens('https://gone.example', async () => { throw new Error('ENOTFOUND') })) === false, 'a host that does not resolve is dead')
  ok((await checkLinks(reply, '', { fetchFn: counting, offline: true })) === reply, 'offline checks never touch the network')
}

// ── the morning news cites real headlines ────────────────────────────────────
{
  const items = [
    { source: 'ynet.co.il', title: 'הכנסת אישרה את התקציב', link: 'https://www.ynet.co.il/a1', at: Date.now() },
    { source: 'maariv.co.il', title: 'התקציב עבר בקריאה שלישית', link: 'https://www.maariv.co.il/b2', at: Date.now() },
    { source: 'israelhayom.co.il', title: 'סערה בצפון', link: 'https://www.israelhayom.co.il/c3', at: Date.now() },
  ]
  ok(/^\[1\] .*\[ynet\.co\.il\] הכנסת/.test(numberedNews(items)), 'the model sees numbered headlines')
  ok(formatNews(items).includes('https://www.ynet.co.il/a1'), 'get_news gives the model the links too')
  const digest = attachSources('• הכנסת אישרה את התקציב [1,2]\n• הרמטכ"ל ניצח בבחירות\n• סערה בצפון [3]\n• משהו [9]', items)
  ok(digest.includes('• הכנסת אישרה את התקציב (ynet.co.il)\nhttps://www.ynet.co.il/a1'), 'a line keeps its source and link')
  ok(!digest.includes('בבחירות'), 'a line that cites no headline is dropped')
  ok(!digest.includes('משהו'), 'a line that cites a headline that does not exist is dropped')
  ok(digest.includes('https://www.israelhayom.co.il/c3'), 'every cited line has its link')
}

// ── news and the day in one morning message ──────────────────────────────────
{
  ok(newsInBrief(), 'news at the brief time goes inside the brief')
  config.newsTime = '12:00'
  ok(!newsInBrief(), 'news hours apart stays its own message')
  config.newsTime = '07:30'
  process.env.NEWS_WITH_BRIEF = 'off'
  ok(!newsInBrief(), 'NEWS_WITH_BRIEF=off keeps two messages')
  delete process.env.NEWS_WITH_BRIEF

  const sent = []
  const clock = new Date(2026, 9, 29, 7, 31)
  const delivery = createDelivery({
    send: async (t) => (sent.push(t), 'id'),
    now: () => clock,
    getDay: async () => ({ events: [{ when: '09:00', title: 'מבחן במתמטיקה' }], tasks: [], reminders: [], lessons: '', groups: [] }),
    news: async () => '• הכנסת אישרה את התקציב (ynet.co.il)\nhttps://www.ynet.co.il/a1',
  })
  await delivery.brief()
  ok(sent.length === 1, 'the morning is one message')
  ok(/מבחן במתמטיקה/.test(sent[0]) && /הכנסת אישרה/.test(sent[0]) && /ynet\.co\.il\/a1/.test(sent[0]), 'it has the day and the sourced news')

  const sent2 = []
  const d2 = createDelivery({ send: async (t) => (sent2.push(t), 'id'), now: () => new Date(2026, 9, 30, 7, 31), getDay: async () => ({ events: [], tasks: [], reminders: [], lessons: '', groups: [] }), news: async () => '• סערה בצפון (israelhayom.co.il)' })
  await d2.brief()
  ok(sent2.length === 1 && /^בוקר טוב\./.test(sent2[0]) && /סערה/.test(sent2[0]), 'an empty day still sends the news, as the morning message')
}

// ── one WhatsApp reply, not a run of messages ────────────────────────────────
{
  const { activeTools } = await import('./tools.js')
  const sendTool = activeTools(new Set()).find((t) => t.name === 'send_whatsapp') || (await import('./tools.js')).allTools?.().find?.((t) => t.name === 'send_whatsapp')
  if (sendTool) {
    const said = []
    const res = await sendTool.run({ text: 'מה שראיתי ב-Gemini' }, { source: 'whatsapp', say: (t) => said.push(t) })
    ok(!said.length && /בתוך התשובה/.test(res), 'send_whatsapp inside the WhatsApp chat folds into the reply')
    await sendTool.run({ text: 'סיכום' }, { source: 'discord', say: (t) => said.push(t) })
    ok(said.length === 1, 'from Discord it still sends to WhatsApp')
  } else ok(false, 'send_whatsapp tool found')
  ok(config.agent.showPlan === false, 'the plan card is off unless AGENT_SHOW_PLAN=on')
}

// ── the voice tells from the review ──────────────────────────────────────────
for (const bad of ['תיקון: הקישור הקודם לא נבדק', 'מה שראיתי ב-Gemini', 'הקישור הוא gemini.google.com, אבל הוא לא יעזור לך', 'אין לי יעד, אז אני לא יכול לתת מחיר אמיתי. שני דפים שווה לפתוח כבר עכשיו'])
  ok(styleTells(bad).length > 0, `caught: ${bad}`)
for (const good of ['רגע, הקישור הקודם לא נבדק, אל תפתח אותו עדיין.', 'לאן ומתי בערך? תן לי יעד וחודש ואני מוצא לך את הכי זול ✈️', "מה אתה צריך בג'מיני?"])
  ok(!styleTells(good).length && polish(good) === good, `passes: ${good}`)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
