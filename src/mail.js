import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

const connect = (account) =>
  new ImapFlow({
    host: account.host,
    port: 993,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  })

async function withInbox(account, fn) {
  const client = connect(account)
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    return await fn(client)
  } finally {
    lock.release()
    await client.logout().catch(() => {})
  }
}

async function collect(client, account, range, opts) {
  const out = []
  for await (const m of client.fetch(range, { uid: true, envelope: true, source: { maxLength: 100000 } }, opts)) {
    const parsed = await simpleParser(m.source).catch(() => null)
    const from = m.envelope?.from?.[0]
    out.push({
      account: account.user,
      uid: m.uid,
      // A UID is only unique within one UIDVALIDITY, so the pair is what identifies a message for good.
      uidValidity: String(client.mailbox?.uidValidity ?? ''),
      ms: m.envelope?.date ? new Date(m.envelope.date).getTime() : Date.now(),
      from: from ? `${from.name || ''} <${from.address}>`.trim() : '',
      subject: m.envelope?.subject || '',
      date: m.envelope?.date ? new Date(m.envelope.date).toLocaleString('he-IL') : '',
      text: (parsed?.text || '').replace(/\s+/g, ' ').slice(0, 1200),
    })
  }
  return out
}

export function recentMail(account, limit = 5) {
  return withInbox(account, async (client) => {
    const total = client.mailbox.exists
    if (!total) return []
    return (await collect(client, account, `${Math.max(1, total - limit + 1)}:*`)).reverse()
  })
}

// Returns { mails, maxUid }. With lastUid = 0 it only reports the current max, so old mail never floods the chat.
export function mailSince(account, lastUid) {
  return withInbox(account, async (client) => {
    const total = client.mailbox.exists
    if (!total) return { mails: [], maxUid: lastUid }
    if (!lastUid) {
      const last = await client.fetchOne('*', { uid: true })
      return { mails: [], maxUid: last?.uid || 0 }
    }
    const mails = (await collect(client, account, `${lastUid + 1}:*`, { uid: true })).filter((m) => m.uid > lastUid)
    return { mails, maxUid: mails.reduce((a, m) => Math.max(a, m.uid), lastUid) }
  })
}

const TOKEN_LIFE = 50 * 60000

// The same live listening for a Google account, signed in with its OAuth token instead of a password.
// The server itself announces new mail (IMAP IDLE), so nothing is polled. The inbox is opened read-only, and this
// connection is used only as a doorbell: the message is then read through the Gmail API as before.
// getToken(email) => Promise<accessToken>. Returns a function that stops the listener.
export function watchGmail(email, getToken, onNew) {
  let stopped = false
  let client
  let attempts = 0
  const run = async () => {
    if (stopped) return
    let again = false
    const retry = (delay) => {
      if (again || stopped) return
      again = true
      setTimeout(run, delay)
    }
    try {
      client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, accessToken: await getToken(email) }, logger: false })
      client.on('exists', (d) => d.count > d.prevCount && onNew())
      client.on('error', (e) => console.log(`[gmail live ${email}] ${e.message}`))
      // 3s, 6s, 12s ... up to five minutes between attempts.
      client.on('close', () => retry(Math.min(300000, 3000 * 2 ** attempts++)))
      await client.connect()
      await client.mailboxOpen('INBOX', { readOnly: true })
      attempts = 0
      console.log(`[gmail live ${email}] מאזין: מייל חדש יגיע ברגע שהוא נכנס`)
      // The token lasts an hour, so the connection is renewed a little before that.
      setTimeout(() => client.logout().catch(() => client.close()), TOKEN_LIFE)
    } catch (e) {
      const denied = /auth|credential|invalid/i.test(e.message)
      console.log(`[gmail live ${email}] ${denied ? 'אין הרשאה להאזנה חיה. חשבון שחובר לפני העדכון צריך חיבור מחדש באתר ההגדרות. בינתיים הוא נבדק כל שתי דקות.' : e.message}`)
      client?.close()
      retry(denied ? 3600000 : Math.min(300000, 3000 * 2 ** attempts++))
    }
  }
  run()
  return () => {
    stopped = true
    client?.close()
  }
}

// Keeps an IDLE connection open and calls onNew the moment the server reports new mail.
// Polling stays on as a fallback, so a dropped connection only costs speed.
export function watchInbox(account, onNew) {
  const run = async () => {
    let retrying = false
    const retry = () => {
      if (retrying) return
      retrying = true
      setTimeout(run, 60000)
    }
    const client = connect(account)
    client.on('exists', (d) => d.count > d.prevCount && onNew())
    client.on('error', (e) => console.log(`[mail ${account.user}] ${e.message}`))
    client.on('close', retry)
    try {
      await client.connect()
      await client.mailboxOpen('INBOX')
      console.log(`[mail ${account.user}] מאזין למיילים חדשים`)
    } catch (e) {
      console.log(`[mail ${account.user}] ${e.message}`)
      client.close()
      retry()
    }
  }
  run()
}
