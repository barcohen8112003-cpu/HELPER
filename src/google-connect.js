// Connects one Google account from the terminal: `npm run google`. Run it again for each extra account.
// The settings site (start the assistant, then open the address it prints) does the same with a button.
import http from 'node:http'
import { exec } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { config } from './config.js'
import { authUrl, connectWithCode, googleAccounts } from './google.js'

if (!config.google.clientId || !config.google.clientSecret) {
  console.log('חסר GOOGLE_CLIENT_ID או GOOGLE_CLIENT_SECRET בקובץ .env. ההוראות ב-README.')
  process.exit(1)
}

const state = randomBytes(16).toString('hex')
const redirectUri = () => `http://127.0.0.1:${server.address().port}`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return res.end()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  const finish = (msg, code) => {
    res.end(`<body dir="rtl" style="font-family:sans-serif;padding:40px"><h2>${msg}</h2>אפשר לסגור את הלשונית.</body>`)
    console.log(msg)
    server.close(() => process.exit(code))
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state לא תואם')
    if (url.searchParams.has('error')) throw new Error(url.searchParams.get('error'))
    const email = await connectWithCode(url.searchParams.get('code'), redirectUri())
    finish(`החשבון ${email} חובר ✔ (מחוברים: ${googleAccounts().join(', ')})`, 0)
  } catch (e) {
    finish(`החיבור נכשל: ${e.message}`, 1)
  }
})

server.listen(0, '127.0.0.1', () => {
  const auth = authUrl(redirectUri(), state)
  console.log(`\nפותח את הדפדפן לאישור. אם הוא לא נפתח, היכנס לכתובת:\n\n${auth}\n`)
  if (process.platform === 'win32') exec(`start "" "${auth.replace(/&/g, '^&')}"`)
})
