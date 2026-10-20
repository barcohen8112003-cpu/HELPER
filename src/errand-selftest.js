// node src/errand-selftest.js
// Offline: no model, no browser, temp data folder. A scripted "model" drives a fake body, and the test checks what
// reached the body: a committing action never does without an approval, and a denial ends the run with no side effect.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-errand-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
fs.writeFileSync(process.env.HELPER_ENV_FILE, 'COMPUTER_MODE=ask\n')
delete process.env.WEBTOP_CLOUD
delete process.env.GOOGLE_HOME_CLOUD
delete process.env.CLOUD_DESKTOP
delete process.env.WEBTOP_PROXY
delete process.env.ERRAND_PROXY
delete process.env.ERRAND_DEBUG_PORT
delete process.env.PC_BRIDGE_SECRET

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

// 11. Survey mode never reaches a cart or a payment, and the instructions name the comparison.
{
  const { body, acts } = fakeBody()
  body.probe = async () => ({ label: 'הוסף לסל', secret: false })
  const seen = []
  const think = async (messages) => {
    seen.push(messages[0].content)
    if (seen.length === 1) return { content: JSON.stringify({ thought: 't', action: { type: 'click', x: 10, y: 10 } }) }
    return { content: JSON.stringify({ thought: 't', action: { type: 'done', summary: '1. זאפ 100 ₪ כולל משלוח' } }) }
  }
  const out = await runGoal({ goal: 'הכי זול', survey: true, body, ctx: {}, think })
  ok(acts.length === 0 && out.startsWith('DONE'), 'survey mode does not add to the cart and ends with the list')
  ok(seen[0].includes('zap.co.il') && seen[0].includes('compare_prices') && seen[0].includes('PayPal'), 'the errand rules require a multi-shop survey and PayPal')
}
{
  const { body, acts } = fakeBody()
  let i = 0
  const steps = [gate, { type: 'done', summary: 'רשימה' }]
  const out = await runGoal({
    goal: 'הכי זול',
    survey: true,
    body,
    ctx: { confirm: async () => true },
    think: async () => ({ content: JSON.stringify({ thought: 't', action: steps[i++] }) }),
  })
  ok(commits(acts) === 0 && out.startsWith('DONE'), 'survey mode refuses a payment gate')
}
ok(/PayPal/.test(_test.gateCard(gate)), 'an order approval says to prefer PayPal')

// 12. Cloud errand Chromium: localhost CDP, Israeli proxy, sign-in flag, desktop window. No published port.
const { config } = await import('./config.js')
const browser = await import('./webtop-browser.js')
const errand = await import('./errand-browser.js')
config.computerMode = 'off'
ok(!browser.errandCloudOn() && !errand.errandBrowserEnabled(), 'COMPUTER_MODE=off disables the errand browser')
config.computerMode = 'ask'
config.webtop.cloud = false
config.googleHome.cloud = false
config.desktop.enabled = false
ok(!browser.errandCloudOn(), 'without a cloud site the errand browser is not the container Chromium')
config.webtop.cloud = true
config.webtop.proxy = 'http://il.example:8080'
config.errand.proxy = ''
ok(browser.errandCloudOn() && errand.errandBrowserEnabled(), 'WEBTOP_CLOUD with computer control enables the cloud errand browser')
let args = browser.browserLaunchArgs('errand')
ok(args.includes('--allow-browser-signin=false') && args.indexOf('--allow-browser-signin=false') < args.indexOf('about:blank'), 'the errand Chromium turns off browser sign-in before the start URL')
ok(args.includes('--proxy-server=http://il.example:8080'), 'an empty ERRAND_PROXY reuses WEBTOP_PROXY')
ok(args.includes('--remote-debugging-address=127.0.0.1') && args.includes(`--remote-debugging-port=${config.errand.port}`), 'the errand debugging port is bound to localhost')
ok(config.errand.port === 9227 && args.some((a) => String(a).includes('errand-profile')), 'the default port is 9227 and the profile is errand-profile')
ok(!browser.browserLaunchArgs('google-home').some((a) => String(a).startsWith('--proxy-server')), 'Google Home does not inherit the errand proxy')
ok(!browser.browserLaunchArgs('webtop').includes('--allow-browser-signin=false'), 'Webtop does not take the shop sign-in switch')
config.errand.proxy = 'direct'
ok(!browser.browserLaunchArgs('errand').some((a) => String(a).startsWith('--proxy-server')), 'ERRAND_PROXY=direct disables the proxy')
config.errand.proxy = 'socks5://tailscale:1055'
ok(browser.browserLaunchArgs('errand').includes('--proxy-server=socks5://tailscale:1055'), 'ERRAND_PROXY overrides WEBTOP_PROXY')
config.desktop.enabled = true
args = browser.browserLaunchArgs('errand')
ok(!args.includes('--headless=new') && args.includes('--class=helper-errand') && browser.browserProcessPlan('errand').env.DISPLAY === ':99', 'the errand window is headful on the shared :99 desktop')
config.desktop.enabled = false
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const menu = (await import('./cloud-desktop.js')).fluxboxMenu('/tmp/raise.sh')
ok(menu.includes('(קניות)') && menu.includes('helper-errand'), 'the desktop menu can raise the shopping window')
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
ok(!/9227:9227/.test(compose) && !/9225:9225/.test(compose), 'compose does not publish the errand debugging port')
const ui = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
ok(ui.includes('🛒 דפדפן קניות') && ui.includes("href: '/errand'"), 'settings links to the shopping browser')
const page = fs.readFileSync(path.join(root, 'src', 'webtop.html'), 'utf8')
ok(page.includes('data-site="errand"') && page.includes('href="/desktop/"') && page.includes('דפדפן קניות'), 'the shopping page signs in through the cloud desktop')
const agent = fs.readFileSync(path.join(root, 'src', 'agent.js'), 'utf8')
const light = agent.slice(agent.indexOf('function lightPrompt'), agent.indexOf('function systemPrompt'))
ok(light.includes('compare_prices') && light.includes('run_errand') && light.includes('הכי זול'), 'light mode tells the model to compare prices and to order')

console.log(`${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
