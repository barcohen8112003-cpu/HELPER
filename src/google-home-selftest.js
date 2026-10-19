// node src/google-home-selftest.js
// Offline: no Chromium, no WhatsApp. Routing, sign-in detection, and the re-login notice.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-ghome-'))
process.env.HELPER_ENV_FILE = path.join(process.env.HELPER_DATA_DIR, 'no.env')
delete process.env.GOOGLE_HOME_CLOUD
delete process.env.PC_BRIDGE_SECRET
delete process.env.PC_BRIDGE_EXECUTOR

const home = await import('./google-home.js')

let failed = 0
let passed = 0
function ok(cond, name) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

ok(home.googleHomeSignedOut('https://accounts.google.com/ServiceLogin'), 'accounts.google.com is a sign-in page')
ok(home.googleHomeSignedOut('https://accounts.google.com/v3/signin/identifier'), 'the identifier step is a sign-in page')
ok(!home.googleHomeSignedOut('https://home.google.com/'), 'home.google.com itself is signed in')
ok(home.googleHomeSignedOut('https://home.google.com/', true), 'a password field on any page is signed out')
ok(home.isGoogleHomeLoginError(Object.assign(new Error('Google Home לא מחובר.'), { code: 'google-home-login' })), 'the login error is recognized')

const cloud = home.googleHomeTransport({ cloud: true, remote: true, bridgeUp: true })
ok(cloud.primary === 'cloud' && cloud.fallback === 'home', 'cloud Google Home is local, with the home bridge as fallback')
ok(home.googleHomeTransport({ cloud: true, remote: true, bridgeUp: false }).fallback === null, 'a disconnected bridge is not a fallback')
ok(home.googleHomeTransport({ cloud: false, remote: true, bridgeUp: true }).primary === 'home', 'without the cloud flag, the server uses the home bridge')
ok(home.googleHomeTransport({ cloud: false, remote: false, bridgeUp: false }).primary === 'local', 'on the home PC the local Webtop window is used')

const login = Object.assign(new Error('Google Home לא מחובר.'), { code: 'google-home-login' })
let homeCalls = 0
const fromHome = await home.runGoogleHome(
  async () => { throw login },
  async () => { homeCalls++; return 'אור דלוק' },
  { primary: 'cloud', fallback: 'home' },
)
ok(fromHome === 'אור דלוק' && homeCalls === 1, 'a signed-in home window answers when the cloud session is logged out')

let both = 0
try {
  await home.runGoogleHome(
    async () => { throw login },
    async () => { both++; throw login },
    { primary: 'cloud', fallback: 'home' },
  )
  ok(false, 'both sessions logged out should throw')
} catch (e) {
  ok(home.isGoogleHomeLoginError(e) && both === 1, 'when home is also logged out the reply stays Google Home לא מחובר')
}

let other = 0
try {
  await home.runGoogleHome(
    async () => { throw new Error('דפדפן Google Home בענן לא עלה.') },
    async () => { other++; return 'nope' },
    { primary: 'cloud', fallback: 'home' },
  )
  ok(false, 'a browser failure should not be swallowed')
} catch (e) {
  ok(/לא עלה|לא זמין/.test(e.message) && other === 0, 'only a sign-in page falls back to the home bridge')
}

home.setGoogleHomeLoginUrl(() => 'http://203.0.113.10:3210/google-home?t=token')
const box = {}
const first = home.planGoogleHomeLoginNotice(box, 1_000_000)
ok(first.includes('התחברות מחדש') && first.includes('/google-home?t=token'), 'the notice is Hebrew and carries the Google Home link')
ok(home.planGoogleHomeLoginNotice(box, 1_000_000 + 60_000) === '', 'the same outage does not send another notice')
home.clearGoogleHomeLoginNotice(box)
ok(home.planGoogleHomeLoginNotice(box, 1_000_000 + 60_000) === '', 'a flap inside 12 hours still does not send')
const later = home.planGoogleHomeLoginNotice(box, 1_000_000 + home.GOOGLE_HOME_LOGIN_NOTIFY_MS + 1)
ok(later.includes('/google-home'), 'after the gap, and after the session had recovered, a new notice can go out')

const { googleHomeProfileDir, browserSite } = await import('./webtop-browser.js')
ok(googleHomeProfileDir().endsWith(`${path.sep}google-home-profile`), 'Google Home uses its own profile directory')
ok(browserSite('google-home') === 'google-home' && browserSite('nope') === 'webtop', 'the login view only selects Webtop or Google Home')

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
process.exit(failed ? 1 : 0)
