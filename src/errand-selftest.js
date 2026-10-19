// node src/errand-selftest.js
// Offline: no model, no browser, temp data folder. A scripted "model" drives a fake body, and the test checks what
// reached the body: a committing action never does without an approval, and a denial ends the run with no side effect.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-errand-'))

const { runGoal, _test } = await import('./computer-use.js')
const { Aborted } = await import('./llm.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// A checkout page: the button at (600, 500) reads "Place order"; everything else is harmless.
// `focusSecret` makes the focused field a password box.
function fakeBody({ focusSecret = false } = {}) {
  const acts = []
  return {
    acts,
    body: {
      ..._test.BODIES.browser,
      maxSteps: 10,
      screenshot: async () => ({ image: 'data:image/jpeg;base64,', buffer: Buffer.from('x'), mime: 'image/jpeg', width: 1280, height: 860, scale: 1, left: 0, top: 0, url: 'https://shop.example/checkout' }),
      act: async (a) => acts.push(a),
      probe: async (a) => ({ label: a.type === 'click' && a.x === 600 && a.y === 500 ? 'Place order' : 'Continue', secret: focusSecret }),
    },
  }
}
// Replies with the scripted actions in order, then "done".
const script = (...actions) => {
  let i = 0
  return async () => ({ content: JSON.stringify({ thought: 't', action: actions[i++] ?? { type: 'done', summary: 'בוצע' } }) })
}
const commits = (acts) => acts.filter((a) => a.type === 'click' && a.x === 600 && a.y === 500).length
const pay = { type: 'click', x: 600, y: 500 }
const gate = { type: 'gate', kind: 'order', site: 'shop.example', items: 'זר פרחים', total: '189', currency: '₪', when: 'מחר', uncertain: '', then: pay }

// 1. The model clicks "Place order" straight away, then gates, and the user says no.
{
  const { body, acts } = fakeBody()
  const asked = []
  const out = await runGoal({ goal: 'תזמין פרחים', body, ctx: { confirm: async (t, media) => (asked.push({ t, media }), false) }, think: script(pay, gate) })
  ok(commits(acts) === 0, 'an ungated click on a commit control never reaches the page')
  ok(out.startsWith('DENIED'), 'a denial ends the run as DENIED')
  ok(asked.length === 1 && asked[0].media?.buffer, 'the approval is asked once, with the screenshot')
  ok(/189 ₪/.test(asked[0]?.t) && /shop\.example/.test(asked[0]?.t) && /זר פרחים/.test(asked[0]?.t), 'the card names the site, items and total')
}

// 2. No way to ask (no confirm in ctx): treated as a no.
{
  const { body, acts } = fakeBody()
  const out = await runGoal({ goal: 'תזמין', body, ctx: {}, think: script(gate) })
  ok(commits(acts) === 0 && out.startsWith('DENIED'), 'without a confirm path nothing is committed')
}

// 3. Approved: the committing action runs exactly once, then the run continues to done.
{
  const { body, acts } = fakeBody()
  const out = await runGoal({ goal: 'תזמין', body, ctx: { confirm: async () => true }, think: script(gate, { type: 'done', summary: 'ההזמנה התקבלה' }) })
  ok(commits(acts) === 1, 'an approved commit runs once')
  ok(out.startsWith('DONE'), 'and the run ends DONE')
}

// 4. An approval covers one action: a second commit click afterwards is blocked again.
{
  const { body, acts } = fakeBody()
  let asks = 0
  await runGoal({ goal: 'תזמין', body, ctx: { confirm: async () => (++asks, asks === 1) }, think: script(gate, pay, gate) })
  ok(commits(acts) === 1 && asks === 2, 'a second commit needs a second approval')
}

// 5. Enter on a focused commit control is blocked like a click.
{
  const { body, acts } = fakeBody()
  body.probe = async () => ({ label: 'לתשלום עכשיו', secret: false })
  await runGoal({ goal: 'תשלם', body, ctx: {}, think: script({ type: 'key', keys: 'enter' }) })
  ok(!acts.some((a) => a.type === 'key'), 'enter on a pay button is blocked')
}

// 6. Secrets: a card number or a password field is never typed into.
{
  const { body, acts } = fakeBody()
  const out = await runGoal({ goal: 'תשלם', body, ctx: {}, think: script({ type: 'type', text: '4580 1234 5678 9012' }) })
  ok(!acts.some((a) => a.type === 'type') && out.startsWith('NEED_USER'), 'a card number is not typed')
  const secret = fakeBody({ focusSecret: true })
  const out2 = await runGoal({ goal: 'תתחבר', body: secret.body, ctx: {}, think: script({ type: 'type', text: 'hunter2' }) })
  ok(!secret.acts.some((a) => a.type === 'type') && out2.startsWith('NEED_USER'), 'nothing is typed into a password field')
}

// 7. "עצור": an aborted signal ends the loop before the next action.
{
  const { body, acts } = fakeBody()
  const ac = new AbortController()
  const think = async () => (ac.abort(), { content: JSON.stringify({ action: { type: 'click', x: 10, y: 10 } }) })
  let threw = false
  try {
    await runGoal({ goal: 'משהו', body, ctx: { signal: ac.signal }, think })
  } catch (e) {
    threw = e instanceof Aborted
  }
  ok(threw && acts.length === 0, 'abort stops the loop with no further action')
}

// 8. The commit words are generic, not a site's wording, and ordinary controls pass.
ok(['Place order', 'Pay now', 'לתשלום עכשיו', 'בצע הזמנה', 'אישור הזמנה', 'שלח', 'Buy now'].every((l) => _test.COMMIT.test(l)), 'commit labels are recognised')
ok(!['Continue', 'המשך', 'הוסף לסל', 'Add to cart', 'חיפוש', 'PayPal info'].some((l) => _test.COMMIT.test(l)), 'ordinary controls are not')

// 9. Survey notes: each step's "found" is shown back to the model, and the card says why this choice.
{
  const { body } = fakeBody()
  const seen = []
  let i = 0
  const steps = [
    { found: 'בורגר א: 69 ₪, משלוח 0, דירוג 9.2', action: { type: 'scroll', x: 600, y: 400, amount: 3 } },
    { found: 'בורגר ב: 58 ₪, משלוח 15, דירוג 8.1', action: { type: 'scroll', x: 600, y: 400, amount: 3 } },
    { action: { ...gate, why: 'א זול יותר בסך הכול (69 מול 73) ועם משלוח חינם' } },
  ]
  const asked = []
  const think = async (messages) => {
    seen.push(messages.at(-1).content[0].text)
    return { content: JSON.stringify({ thought: 't', ...steps[i++] }) }
  }
  const out = await runGoal({ goal: 'המבורגר', body, ctx: { confirm: async (t) => (asked.push(t), false) }, think })
  ok(seen[2]?.includes('בורגר א: 69') && seen[2]?.includes('בורגר ב: 58'), 'notes are carried to later steps')
  ok(/למה זה: א זול יותר/.test(asked[0] || ''), 'the card says why this choice')
  ok(out.startsWith('DENIED'), 'a denied surveyed order still ends DENIED')
}

// 10. The shared location errands deliver to: a place shared with its address needs no geocoder, live updates are
// recognised, and a week-old location is no longer offered.
{
  const { state } = await import('./store.js')
  const { setLocation, isLiveUpdate, locationLine } = await import('./location.js')
  const saved = await setLocation({ lat: 32.0853, lng: 34.7818, name: 'הבית', address: 'דיזנגוף 50, תל אביב', live: false })
  ok(saved.address === 'הבית, דיזנגוף 50, תל אביב' && state.location.lat === 32.0853, 'a shared place is saved as given')
  ok(locationLine().includes('דיזנגוף 50') && locationLine(true).includes('32.08530'), 'the model sees the location')
  ok(!isLiveUpdate({ live: true }), 'the first live location is not an update')
  await setLocation({ lat: 32.1, lng: 34.8, address: 'x', live: true })
  ok(isLiveUpdate({ live: true }), 'later live locations are updates')
  state.location.at = Date.now() - 8 * 86400000
  ok(locationLine() === '', 'a week-old location is dropped')
}

console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
