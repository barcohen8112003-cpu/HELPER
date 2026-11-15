// Gmail beyond a plain send: a real reply in the thread, attachments both ways, drafts that never send on their own,
// and labels by their real ids. The existing check_mail / gmail_search / gmail_read / gmail_send stay as they were.
//
// Rules this file keeps, in code:
// - The account is explicit (or the only writable one) and must hold, in the grant Google returned, a scope that
//   allows the call. The scopes Helper asks for (gmail.send, gmail.readonly, mail.google.com) are a request, not proof.
// - A reply is bound to one message id in that account: its thread id, its Message-ID/References headers and its
//   sender. A thread id passed alongside must be that message's thread. Recipients are computed from the message and
//   shown in full; anything added must be a plain address.
// - Saving a draft never sends. Sending a draft reads its raw bytes from Gmail, shows the real From, every recipient,
//   the whole text, any other header and each attachment's type, size and SHA-256, and sends those same bytes (not
//   whatever the draft holds later). Shapes that cannot be shown whole (HTML or alternative parts, inline parts,
//   nested multiparts) and a From other than the account are refused. A draft changed after the question is not sent.
// - Labels are resolved from the account's own label list by name; an unknown name is refused, never guessed or
//   created. Trash and spam are not offered here.
// - Attachments to send come from Drive (by id, same account) or from one local folder (HELPER_ATTACH_DIR, default
//   data/attachments) by bare file name: no paths, no symlinks, size bounded. Received attachments go to the chat;
//   nothing is written to disk.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { simpleParser } from 'mailparser'
import { config, DATA_DIR } from './config.js'
import * as google from './google.js'
import { boundMutation, googleWriteAccount } from './bound-actions.js'
import { str, obj } from './tool-helpers.js'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const S = (name) => `https://www.googleapis.com/auth/${name}`
const FULL = 'https://mail.google.com/'
export const GMAIL_SCOPES = {
  read: [S('gmail.readonly'), S('gmail.modify'), FULL],
  send: [S('gmail.send'), S('gmail.compose'), S('gmail.modify'), FULL],
  draft: [S('gmail.compose'), S('gmail.modify'), FULL],
  labels: [S('gmail.modify'), FULL],
}

// Gmail takes up to 25MB per message, and base64 adds a third.
export const MAX_ATTACH_BYTES = 18 * 1024 * 1024
const MAX_RECIPIENTS = 20
const MAX_BODY = 4000
const ID = /^[A-Za-z0-9_-]{6,64}$/

const fail = (message, code) => Object.assign(new Error(message), code && { code })
const writeAccount = (account, scopes) => googleWriteAccount(account, { scopesAny: scopes, google, readOnly: config.google.readOnly })

// ---- addresses ----

const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
export const isAddress = (s) => typeof s === 'string' && s.length <= 254 && ADDR.test(s)

// "Name <a@b>, "Last, First" <c@d>, e@f" -> [{ name, email }]. Commas inside quotes or angle brackets are not splits.
export function parseAddressList(header) {
  const out = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of String(header || '')) {
    if (ch === '"' && !angle) quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (ch === ',' && !quoted && !angle) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*)<([^<>]+)>\s*$/)
      const email = (m ? m[2] : part).trim()
      const name = m ? m[1].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"') : ''
      return { name, email }
    })
    .filter((a) => isAddress(a.email))
}

// The address list the model gives: plain addresses only, nothing that could carry a header.
export function plainAddresses(list, label) {
  const arr = list == null ? [] : Array.isArray(list) ? list : [list]
  return arr.map((a) => {
    const s = String(a).trim()
    if (!isAddress(s)) throw fail(`כתובת לא תקינה ב-${label}: "${s.slice(0, 80)}". נדרשת כתובת מייל אחת בכל פריט.`)
    return { name: '', email: s }
  })
}

const noBreak = (s) => {
  if (/[\r\n\0]/.test(String(s))) throw fail('ירידת שורה בכותרת של מייל לא מותרת.')
  return String(s)
}
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`)
const formatAddress = ({ name, email }) => (name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeWord(name)} <${email}>` : email)
const shown = (list) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
const wrap76 = (b64) => b64.replace(/.{76}/g, '$&\r\n')

// ---- attachments ----

export const attachDir = () => process.env.HELPER_ATTACH_DIR || path.join(DATA_DIR, 'attachments')

const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.zip': 'application/zip', '.json': 'application/json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export const safeFileName = (name) => String(name || 'file').replace(/[\x00-\x1f\x7f"\\/:*?<>|]/g, '_').replace(/^\.+/, '_').slice(0, 150) || 'file'

// A file from the attachments folder by its bare name. Refuses paths, dot-files, links, non-files and big files.
export function localAttachment(name, root = attachDir()) {
  const n = String(name || '')
  if (!n || n !== path.basename(n) || /[\\/\0]/.test(n) || n.startsWith('.') || n.length > 200) throw fail(`שם קובץ לא תקין: "${n.slice(0, 60)}". רק שם קובץ מתיקיית הקבצים המצורפים, בלי נתיב.`)
  let realRoot
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    throw fail(`אין תיקיית קבצים מצורפים (${root}).`, 'setup_needed')
  }
  const full = path.join(realRoot, n)
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw fail(`אין קובץ בשם "${n}" בתיקיית הקבצים המצורפים.`)
  }
  if (st.isSymbolicLink() || !st.isFile()) throw fail(`"${n}" אינו קובץ רגיל (קיצור דרך או תיקייה). לא מצרף.`)
  if (path.dirname(fs.realpathSync(full)) !== realRoot) throw fail(`"${n}" מחוץ לתיקיית הקבצים המצורפים.`)
  if (st.size > MAX_ATTACH_BYTES) throw fail(`"${n}" גדול מדי (${Math.round(st.size / 1048576)}MB, מקסימום ${MAX_ATTACH_BYTES / 1048576}MB).`)
  const buffer = fs.readFileSync(full)
  return { name: safeFileName(n), mime: MIME_BY_EXT[path.extname(n).toLowerCase()] || 'application/octet-stream', buffer }
}

async function gatherAttachments(email, { files = [], drive_files = [] }) {
  const out = []
  for (const f of [].concat(files || [])) out.push(localAttachment(f))
  for (const id of [].concat(drive_files || [])) {
    if (!ID.test(String(id))) throw fail(`מזהה קובץ Drive לא תקין: "${String(id).slice(0, 60)}".`)
    const got = await google.driveDownload(email, id, { maxBytes: MAX_ATTACH_BYTES })
    out.push({ name: safeFileName(got.name), mime: got.mime, buffer: got.buffer })
  }
  const total = out.reduce((n, a) => n + a.buffer.length, 0)
  if (total > MAX_ATTACH_BYTES) throw fail(`הקבצים המצורפים יחד גדולים מדי (${Math.round(total / 1048576)}MB, מקסימום ${MAX_ATTACH_BYTES / 1048576}MB).`)
  return out
}

// ---- MIME ----

// The exact bytes Gmail is given. Headers are refused if they contain a line break; names are RFC 2047/2231 encoded.
export function buildMime({ from, to = [], cc = [], bcc = [], subject = '', body = '', inReplyTo, references, attachments = [] }) {
  const lines = []
  if (from) lines.push(`From: ${noBreak(from)}`)
  if (to.length) lines.push(`To: ${to.map(formatAddress).map(noBreak).join(', ')}`)
  if (cc.length) lines.push(`Cc: ${cc.map(formatAddress).map(noBreak).join(', ')}`)
  if (bcc.length) lines.push(`Bcc: ${bcc.map(formatAddress).map(noBreak).join(', ')}`)
  lines.push(`Subject: ${encodeWord(noBreak(subject))}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${noBreak(inReplyTo)}`)
  if (references) lines.push(`References: ${noBreak(references)}`)
  lines.push('MIME-Version: 1.0')
  const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(String(body), 'utf8').toString('base64'))]
  if (!attachments.length) return [...lines, ...text].join('\r\n')
  // Base64 has no "_" or "=" in the middle of a line, so this boundary cannot occur in any part. It is made from the
  // content, so the same mail always gives the same bytes and a repeated request is recognised as the same one.
  const seed = crypto.createHash('sha256').update(lines.join('\n')).update(String(body))
  for (const a of attachments) seed.update(a.name).update(a.buffer)
  const boundary = `=_helper_${seed.digest('hex').slice(0, 24)}`
  const parts = [...lines, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...text]
  for (const a of attachments) {
    const name = safeFileName(a.name)
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${encodeWord(name)}"`,
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(a.buffer.toString('base64'))
    )
  }
  parts.push(`--${boundary}--`, '')
  return parts.join('\r\n')
}

const rawOf = (mime) => Buffer.from(mime, 'utf8').toString('base64url')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const attachLines = (list) => (list.length ? `\n*קבצים מצורפים:* ${list.map((a) => `${a.name} (${Math.max(1, Math.round(a.buffer.length / 1024))}KB, ${sha(a.buffer).slice(0, 8)})`).join(', ')}` : '')

function bodyText(body) {
  const b = String(body ?? '')
  if (!b.trim()) throw fail('אין תוכן למייל.')
  if (b.length > MAX_BODY) throw fail(`המייל ארוך מכדי להציג אותו במלואו לאישור (${b.length} תווים, מקסימום ${MAX_BODY}).`)
  return b
}

const hdr = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

// The message being answered, from this account. Refuses ids that are not a message here, and a thread id that is
// not that message's thread.
async function sourceMessage(email, messageId, threadId) {
  if (!ID.test(String(messageId || ''))) throw fail('צריך message_id מדויק של המייל שעונים עליו (מ-gmail_search או gmail_thread).')
  let m
  try {
    const q = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'References'].map((h) => `metadataHeaders=${h}`).join('&')
    m = await google.gcall(email, 'GET', `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=metadata&${q}`)
  } catch (e) {
    if (e.status === 404) throw fail(`אין מייל עם המזהה ${messageId} בחשבון ${email}.`)
    throw e
  }
  if (threadId && threadId !== m.threadId) throw fail(`המייל ${messageId} שייך לשרשור ${m.threadId}, לא ל-${threadId}. לא עונה על שרשור אחר.`)
  if (!hdr(m, 'Message-ID')) throw fail('למייל המקורי אין Message-ID, אז אי אפשר לבנות תשובה נכונה בשרשור.')
  const thread = await google.gcall(email, 'GET', `${GMAIL}/threads/${encodeURIComponent(m.threadId)}?format=minimal`)
  const ids = (thread.messages || []).map((x) => x.id)
  return { m, latest: ids.at(-1) === m.id, count: ids.length }
}

// To/Cc for a reply: Reply-To, else From; reply-all adds the original To and Cc. The account itself is never a
// recipient, and nobody appears twice.
export function replyRecipients(m, self, { replyAll = false } = {}) {
  const me = self.toLowerCase()
  const from = parseAddressList(hdr(m, 'From'))
  const fromSelf = from.some((a) => a.email.toLowerCase() === me)
  let to = fromSelf ? parseAddressList(hdr(m, 'To')) : parseAddressList(hdr(m, 'Reply-To')).length ? parseAddressList(hdr(m, 'Reply-To')) : from
  let cc = replyAll ? [...(fromSelf ? [] : parseAddressList(hdr(m, 'To'))), ...parseAddressList(hdr(m, 'Cc'))] : []
  const seen = new Set([me])
  const keep = (a) => {
    const k = a.email.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }
  to = to.filter(keep)
  cc = cc.filter(keep)
  return { to, cc }
}

const reSubject = (s) => (/^\s*(re|תגובה)\s*:/i.test(s) ? s : `Re: ${s}`)

async function replyParts(email, { message_id, thread_id, reply_all, cc, bcc }) {
  const { m, latest, count } = await sourceMessage(email, message_id, thread_id)
  const auto = replyRecipients(m, email, { replyAll: reply_all === true })
  const extraCc = plainAddresses(cc, 'cc')
  const extraBcc = plainAddresses(bcc, 'bcc')
  const seen = new Set([...auto.to, ...auto.cc].map((a) => a.email.toLowerCase()))
  const allCc = [...auto.cc, ...extraCc.filter((a) => !seen.has(a.email.toLowerCase()) && seen.add(a.email.toLowerCase()))]
  const allBcc = extraBcc.filter((a) => !seen.has(a.email.toLowerCase()))
  if (!auto.to.length) throw fail('לא מצאתי למי לענות במייל המקורי.')
  if (auto.to.length + allCc.length + allBcc.length > MAX_RECIPIENTS) throw fail(`יותר מדי נמענים (מקסימום ${MAX_RECIPIENTS}).`)
  const msgId = hdr(m, 'Message-ID')
  const refs = `${hdr(m, 'References')} ${msgId}`.trim().split(/\s+/).slice(-20).join(' ')
  return {
    threadId: m.threadId,
    to: auto.to,
    cc: allCc,
    bcc: allBcc,
    subject: reSubject(hdr(m, 'Subject')),
    inReplyTo: msgId,
    references: refs,
    about: `${hdr(m, 'From')} · ${hdr(m, 'Subject')} · ${hdr(m, 'Date')}`,
    note: latest ? '' : `\n⚠️ זה לא המייל האחרון בשרשור (יש בו ${count}). התשובה תהיה למייל הזה.`,
  }
}

// ---- tools' work ----

export async function reply(ctx, args) {
  return boundMutation(ctx, {
    tool: 'gmail_reply',
    async prepare() {
      const email = await writeAccount(args.account, GMAIL_SCOPES.send)
      const body = bodyText(args.body)
      const r = await replyParts(email, args)
      const attachments = await gatherAttachments(email, args)
      const mime = buildMime({ from: email, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, body, inReplyTo: r.inReplyTo, references: r.references, attachments })
      return {
        account: email,
        op: { email, threadId: r.threadId, raw: rawOf(mime) },
        question: `לשלוח תשובה בשרשור?\n*מאת:* ${email}\n*אל:* ${shown(r.to)}${r.cc.length ? `\n*עותק:* ${shown(r.cc)}` : ''}${r.bcc.length ? `\n*עותק נסתר:* ${shown(r.bcc)}` : ''}\n*נושא:* ${r.subject}\n*בתשובה ל:* ${r.about}${attachLines(attachments)}${r.note}\n\n${body}`,
      }
    },
    async execute(op) {
      const res = await google.gcall(op.email, 'POST', `${GMAIL}/messages/send`, { json: { raw: op.raw, threadId: op.threadId } })
      const confirmed = Boolean(res.id) && res.threadId === op.threadId
      return { confirmed, ref: res.id, text: confirmed ? `נשלח בשרשור (מזהה ${res.id})` : `Gmail החזיר ${res.id ? `מזהה ${res.id} בשרשור אחר (${res.threadId})` : 'תשובה בלי מזהה'}` }
    },
  })
}

export async function saveDraft(ctx, args) {
  return boundMutation(ctx, {
    tool: 'gmail_draft_save',
    async prepare() {
      const email = await writeAccount(args.account, GMAIL_SCOPES.draft)
      const body = bodyText(args.body)
      let head
      if (args.reply_to_message_id) {
        if (args.to?.length) throw fail('בטיוטת תשובה הנמענים נלקחים מהמייל המקורי. אפשר להוסיף cc/bcc.')
        head = await replyParts(email, { ...args, message_id: args.reply_to_message_id })
      } else {
        const to = plainAddresses(args.to, 'to')
        if (!to.length) throw fail('צריך לפחות נמען אחד (to).')
        const cc = plainAddresses(args.cc, 'cc')
        const bcc = plainAddresses(args.bcc, 'bcc')
        if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw fail(`יותר מדי נמענים (מקסימום ${MAX_RECIPIENTS}).`)
        head = { to, cc, bcc, subject: noBreak(args.subject || ''), note: '' }
      }
      let replacing = ''
      if (args.draft_id) {
        if (!ID.test(String(args.draft_id))) throw fail('draft_id לא תקין.')
        try {
          await google.gcall(email, 'GET', `${GMAIL}/drafts/${encodeURIComponent(args.draft_id)}?format=minimal`)
        } catch (e) {
          if (e.status === 404) throw fail(`אין טיוטה ${args.draft_id} בחשבון ${email}.`)
          throw e
        }
        replacing = `\n*מחליף את הטיוטה:* ${args.draft_id}`
      }
      const attachments = await gatherAttachments(email, args)
      const mime = buildMime({ from: email, to: head.to, cc: head.cc, bcc: head.bcc, subject: head.subject, body, inReplyTo: head.inReplyTo, references: head.references, attachments })
      return {
        account: email,
        op: { email, draftId: args.draft_id || null, threadId: head.threadId || null, raw: rawOf(mime) },
        question: `לשמור טיוטה ב-Gmail? (רק טיוטה. שום דבר לא נשלח.)\n*חשבון:* ${email}\n*אל:* ${shown(head.to)}${head.cc.length ? `\n*עותק:* ${shown(head.cc)}` : ''}${head.bcc.length ? `\n*עותק נסתר:* ${shown(head.bcc)}` : ''}\n*נושא:* ${head.subject}${head.about ? `\n*בתשובה ל:* ${head.about}` : ''}${replacing}${attachLines(attachments)}${head.note}\n\n${body}`,
      }
    },
    async execute(op) {
      const message = { raw: op.raw, ...(op.threadId && { threadId: op.threadId }) }
      const res = op.draftId
        ? await google.gcall(op.email, 'PUT', `${GMAIL}/drafts/${encodeURIComponent(op.draftId)}`, { json: { id: op.draftId, message } })
        : await google.gcall(op.email, 'POST', `${GMAIL}/drafts`, { json: { message } })
      return { confirmed: Boolean(res.id && res.message?.id), ref: res.id, text: `הטיוטה נשמרה (draft_id ${res.id}). לא נשלחה.` }
    },
  })
}

// Invisible and direction-changing characters in what is reviewed are shown, so nothing in it is hidden.
const visible = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)

// One MIME entity: its headers (unfolded, in order) and its body, from the raw bytes as latin1.
function entity(str) {
  const m = str.match(/\r?\n\r?\n/)
  const head = m ? str.slice(0, m.index) : str
  const body = m ? str.slice(m.index + m[0].length) : ''
  const headers = []
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].value += ` ${line.trim()}`
    else {
      const h = line.match(/^([!-9;-~]+):[ \t]*(.*)$/)
      if (!h) throw fail('בטיוטה יש שורת כותרת לא תקינה, אז אי אפשר להציג אותה במלואה. לא שולח.', 'unsupported')
      headers.push({ name: h[1].toLowerCase(), value: h[2] })
    }
  }
  return { headers, body }
}
const headerAll = (e, name) => e.headers.filter((h) => h.name === name).map((h) => h.value)
function contentType(e) {
  const v = headerAll(e, 'content-type')[0] || 'text/plain'
  return { type: v.split(';')[0].trim().toLowerCase(), boundary: v.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i)?.slice(1).find(Boolean) }
}
const disposition = (e) => (headerAll(e, 'content-disposition')[0] || '').split(';')[0].trim().toLowerCase()

// The only shapes a draft may have here: one text/plain part, or multipart/mixed with one text/plain part first and
// then files marked as attachments. Anything a mail program could show that is not reviewed here (an HTML or
// alternative part, inline or related parts, nested multiparts, text outside the parts) is refused, not sent unseen.
export function draftStructure(rawBuffer) {
  const root = entity(rawBuffer.toString('latin1'))
  const unsupported = (why) => fail(`צורת הטיוטה לא נתמכת כאן (${why}), אז אי אפשר להציג את כל מה שיישלח. לא שולח; אפשר לשלוח אותה מ-Gmail.`, 'unsupported')
  const { type, boundary } = contentType(root)
  if (type === 'text/plain') return { root, files: 0 }
  if (type !== 'multipart/mixed' || !boundary) throw unsupported(type)
  const lines = root.body.split(/\r?\n/)
  const parts = []
  let cur = null
  let closed = false
  const outside = []
  for (const line of lines) {
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (cur) parts.push(cur.join('\r\n'))
      if (line.endsWith('--')) {
        closed = true
        cur = null
        continue
      }
      cur = closed ? null : []
      continue
    }
    if (cur) cur.push(line)
    else outside.push(line)
  }
  if (!closed) throw unsupported('אין סוף לחלקים')
  if (outside.some((l) => l.trim())) throw unsupported('טקסט מחוץ לחלקים')
  if (!parts.length) throw unsupported('אין חלקים')
  const ents = parts.map(entity)
  const first = contentType(ents[0])
  if (first.type !== 'text/plain' || disposition(ents[0]) === 'attachment') throw unsupported(`החלק הראשון הוא ${first.type}`)
  for (const e of ents.slice(1)) {
    const t = contentType(e).type
    if (t.startsWith('multipart/')) throw unsupported('חלקים מקוננים')
    if (disposition(e) !== 'attachment') throw unsupported(`חלק ${t} שאינו קובץ מצורף`)
  }
  return { root, files: ents.length - 1 }
}

// Headers a draft may carry that are shown or are pure transport. Any other header is shown to the owner as is.
const KNOWN = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding', 'in-reply-to', 'references', 'reply-to'])

// The draft as Gmail holds it now, frozen: the exact bytes that will be sent, their hash, and everything a person
// needs to see to approve sending them: the real From, every recipient, the whole text, every other header, and
// each attachment's name, type, size and SHA-256.
export async function readDraft(email, draftId) {
  let d
  try {
    d = await google.gcall(email, 'GET', `${GMAIL}/drafts/${encodeURIComponent(draftId)}?format=raw`)
  } catch (e) {
    if (e.status === 404) throw fail(`אין טיוטה ${draftId} בחשבון ${email}.`)
    throw e
  }
  const raw = d.message?.raw
  if (!raw) throw fail('Gmail לא החזיר את תוכן הטיוטה.')
  const bytes = Buffer.from(raw, 'base64url')
  return { raw, bytes, hash: sha(bytes), messageId: d.message.id, threadId: d.message.threadId || null }
}

export async function reviewDraft(email, d) {
  const { root, files } = draftStructure(d.bytes)
  const one = (name) => {
    const v = headerAll(root, name)
    if (v.length > 1) throw fail(`בטיוטה יש יותר מכותרת ${name} אחת. לא שולח.`, 'unsupported')
    return v[0]
  }
  for (const n of ['to', 'cc', 'bcc', 'subject', 'reply-to', 'content-type']) one(n)
  const parsed = await simpleParser(d.bytes)
  const fromList = (parsed.from?.value || []).filter((a) => a.address)
  if (headerAll(root, 'from').length !== 1 || fromList.length !== 1) throw fail('לטיוטה אין שולח אחד ברור (From). לא שולח.', 'unsupported')
  const from = fromList[0].address
  if (from.toLowerCase() !== email.toLowerCase()) throw fail(`הטיוטה נשלחת מ-${from}, לא מהחשבון ${email}. שליחה מכתובת אחרת (alias) לא נתמכת כאן. לא שולח.`, 'unsupported')
  if (headerAll(root, 'sender').length) throw fail('לטיוטה יש כותרת Sender. לא נתמך כאן. לא שולח.', 'unsupported')
  const list = (field) => (parsed[field]?.value || []).map((a) => ({ name: visible(a.name || ''), email: a.address || '' }))
  const to = list('to')
  const cc = list('cc')
  const bcc = list('bcc')
  const replyTo = list('replyTo')
  if (!to.length && !cc.length && !bcc.length) throw fail('בטיוטה אין נמענים.')
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw fail(`יותר מדי נמענים בטיוטה (מקסימום ${MAX_RECIPIENTS}).`)
  if (parsed.html) throw fail('לטיוטה יש גרסת HTML, שאי אפשר להציג כאן במלואה. לא שולח; אפשר לשלוח אותה מ-Gmail.', 'unsupported')
  const body = parsed.text || ''
  if (body.length > MAX_BODY) throw fail(`הטיוטה ארוכה מכדי להציג אותה במלואה לאישור (${body.length} תווים).`)
  const atts = parsed.attachments || []
  if (atts.length !== files) throw fail('מספר הקבצים המצורפים בטיוטה לא ברור. לא שולח.', 'unsupported')
  const fileLines = atts.map((a) => `  ${safeFileName(a.filename)} · ${a.contentType} · ${a.content.length} בתים · SHA-256 ${sha(a.content).slice(0, 16)}`)
  const extra = root.headers.filter((h) => !KNOWN.has(h.name)).map((h) => `  ${h.name}: ${visible(h.value)}`)
  const question = [
    'לשלוח את הטיוטה הזאת כמו שהיא?',
    `*מאת:* ${from}`,
    `*אל:* ${shown(to) || '(אין)'}`,
    cc.length && `*עותק:* ${shown(cc)}`,
    bcc.length && `*עותק נסתר:* ${shown(bcc)}`,
    replyTo.length && `*תשובות יגיעו אל:* ${shown(replyTo)}`,
    `*נושא:* ${visible(parsed.subject || '')}`,
    d.threadId && `*בשרשור:* ${d.threadId}`,
    fileLines.length && `*קבצים מצורפים (${fileLines.length}):*\n${fileLines.join('\n')}`,
    extra.length && `*כותרות נוספות:*\n${extra.join('\n')}`,
    '',
    visible(body),
    '',
    'בדיוק הגרסה הזאת תישלח. אם הטיוטה תשתנה לפני השליחה, לא אשלח.',
  ].filter((x) => x !== 0 && x !== false && x != null && x !== undefined).join('\n')
  return { question, from, to, cc, bcc }
}

export async function sendDraft(ctx, args) {
  return boundMutation(ctx, {
    tool: 'gmail_draft_send',
    async prepare() {
      const email = await writeAccount(args.account, GMAIL_SCOPES.draft)
      if (!ID.test(String(args.draft_id || ''))) throw fail('צריך draft_id מדויק (מ-gmail_draft_save או מהמשתמש).')
      const d = await readDraft(email, args.draft_id)
      const { question } = await reviewDraft(email, d)
      return {
        account: email,
        // The reviewed bytes themselves are what is sent (drafts.send with the message), not whatever the draft holds
        // at that moment.
        op: { email, draftId: args.draft_id, raw: d.raw, threadId: d.threadId },
        fingerprint: { hash: d.hash },
        question,
      }
    },
    recheck: async (op) => ({ hash: (await readDraft(op.email, op.draftId)).hash }),
    async execute(op) {
      const message = { raw: op.raw, ...(op.threadId && { threadId: op.threadId }) }
      const res = await google.gcall(op.email, 'POST', `${GMAIL}/drafts/send`, { json: { id: op.draftId, message } })
      const confirmed = Boolean(res.id) && (!op.threadId || res.threadId === op.threadId)
      return { confirmed, ref: res.id, text: confirmed ? `הטיוטה נשלחה (מזהה ${res.id})` : `Gmail החזיר ${res.id ? `מזהה ${res.id} בשרשור אחר` : 'תשובה בלי מזהה'}` }
    },
  })
}

// System labels that can be added or removed here. TRASH and SPAM are left out on purpose; DRAFT, SENT and CHAT
// cannot be changed by hand at all.
const SYSTEM_OK = new Set(['INBOX', 'STARRED', 'UNREAD', 'IMPORTANT'])
const SYSTEM_NO = new Set(['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT'])

// Names -> the account's own label ids. Exact name first, then a single case-insensitive match. Never guesses.
export function resolveLabels(names, labels) {
  return [].concat(names || []).map((raw) => {
    const name = String(raw).trim()
    const upper = name.toUpperCase()
    if (SYSTEM_NO.has(upper)) throw fail(`התווית ${upper} לא זמינה כאן (מחיקה, ספאם וטיוטות לא משתנים דרך תוויות).`)
    const exact = labels.filter((l) => l.name === name)
    const loose = exact.length ? exact : labels.filter((l) => l.name.toLowerCase() === name.toLowerCase())
    if (loose.length > 1) throw fail(`יש כמה תוויות בשם "${name}". צריך את השם המדויק.`)
    const hit = loose[0]
    if (!hit) throw fail(`אין תווית בשם "${name}" בחשבון. לא יוצר תווית חדשה ולא מנחש.`)
    if (hit.type === 'system' && !SYSTEM_OK.has(hit.id)) throw fail(`התווית ${hit.name} לא זמינה כאן.`)
    return { id: hit.id, name: hit.name }
  })
}

async function targetOf(email, kind, id) {
  if (!['message', 'thread'].includes(kind)) throw fail('target צריך להיות message או thread.')
  if (!ID.test(String(id || ''))) throw fail('צריך מזהה מדויק של מייל או שרשור.')
  const base = kind === 'thread' ? 'threads' : 'messages'
  let t
  try {
    t = await google.gcall(email, 'GET', `${GMAIL}/${base}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`)
  } catch (e) {
    if (e.status === 404) throw fail(`אין ${kind === 'thread' ? 'שרשור' : 'מייל'} ${id} בחשבון ${email}.`)
    throw e
  }
  const first = kind === 'thread' ? t.messages?.[0] : t
  const labelIds = kind === 'thread' ? [...new Set((t.messages || []).flatMap((m) => m.labelIds || []))].sort() : [...(t.labelIds || [])].sort()
  return { subject: hdr(first || {}, 'Subject'), from: hdr(first || {}, 'From'), labelIds, count: kind === 'thread' ? (t.messages || []).length : 1 }
}

export async function modifyLabels(ctx, args) {
  return boundMutation(ctx, {
    tool: 'gmail_label_modify',
    async prepare() {
      const email = await writeAccount(args.account, GMAIL_SCOPES.labels)
      const { labels = [] } = await google.gcall(email, 'GET', `${GMAIL}/labels`)
      const add = resolveLabels(args.add, labels)
      const remove = resolveLabels(args.remove, labels)
      if (!add.length && !remove.length) throw fail('אין תוויות להוסיף או להסיר.')
      const both = add.filter((a) => remove.some((r) => r.id === a.id))
      if (both.length) throw fail(`התווית ${both[0].name} גם להוספה וגם להסרה.`)
      const t = await targetOf(email, args.target, args.id)
      const what = args.target === 'thread' ? `השרשור (${t.count} מיילים)` : 'המייל'
      return {
        account: email,
        op: { email, kind: args.target, id: args.id, add: add.map((l) => l.id), remove: remove.map((l) => l.id) },
        fingerprint: { labels: t.labelIds },
        question: `לשנות תוויות של ${what} "${t.subject}" (${t.from})?\n*חשבון:* ${email}${add.length ? `\n*להוסיף:* ${add.map((l) => l.name).join(', ')}` : ''}${remove.length ? `\n*להסיר:* ${remove.map((l) => l.name).join(', ')}` : ''}`,
      }
    },
    recheck: async (op) => ({ labels: (await targetOf(op.email, op.kind, op.id)).labelIds }),
    async execute(op) {
      const base = op.kind === 'thread' ? 'threads' : 'messages'
      const res = await google.gcall(op.email, 'POST', `${GMAIL}/${base}/${encodeURIComponent(op.id)}/modify`, { json: { addLabelIds: op.add, removeLabelIds: op.remove } })
      const now = op.kind === 'thread' ? new Set((res.messages || []).flatMap((m) => m.labelIds || [])) : new Set(res.labelIds || [])
      const confirmed = res.id === op.id && op.add.every((l) => now.has(l)) && (op.kind === 'thread' || op.remove.every((l) => !now.has(l)))
      return { confirmed, ref: op.id, text: 'התוויות עודכנו' }
    },
  })
}

// ---- reading ----

function walkParts(part, out = []) {
  if (!part) return out
  if (part.filename && part.body?.attachmentId) out.push({ part_id: part.partId, filename: safeFileName(part.filename), mime: part.mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId })
  for (const p of part.parts || []) walkParts(p, out)
  return out
}
function plainText(part) {
  if (!part) return ''
  if (part.mimeType === 'text/plain' && part.body?.data && !part.filename) return Buffer.from(part.body.data, 'base64url').toString('utf8')
  for (const p of part.parts || []) {
    const t = plainText(p)
    if (t) return t
  }
  return ''
}

export async function readThread(email, threadId) {
  if (!ID.test(String(threadId || ''))) throw fail('צריך thread_id מדויק.')
  const t = await google.gcall(email, 'GET', `${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`)
  return {
    account: email,
    thread_id: t.id,
    messages: (t.messages || []).map((m) => ({
      message_id: m.id,
      from: hdr(m, 'From'),
      to: hdr(m, 'To'),
      cc: hdr(m, 'Cc'),
      date: hdr(m, 'Date'),
      subject: hdr(m, 'Subject'),
      labels: m.labelIds || [],
      text: plainText(m.payload).slice(0, 3000),
      attachments: walkParts(m.payload).map(({ attachmentId, ...a }) => a),
    })),
  }
}

// Gmail's attachment ids are not stable between requests, so an attachment is named by its message and part id.
export async function fetchAttachment(email, messageId, partId) {
  if (!ID.test(String(messageId || ''))) throw fail('צריך message_id מדויק.')
  const m = await google.gcall(email, 'GET', `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`)
  const part = walkParts(m.payload).find((p) => p.part_id === String(partId))
  if (!part) throw fail(`אין במייל הזה קובץ מצורף בחלק ${partId}.`)
  if (part.size > 25 * 1024 * 1024) throw fail('הקובץ גדול מ-25MB.')
  const a = await google.gcall(email, 'GET', `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.attachmentId)}`)
  const buffer = Buffer.from(a.data || '', 'base64url')
  if (part.size && buffer.length !== part.size) throw fail(`הקובץ הגיע בגודל ${buffer.length} במקום ${part.size}. לא שולח קובץ חלקי.`)
  return { name: part.filename, mime: part.mime || 'application/octet-stream', buffer }
}

// ---- tools ----

const ACC = str('חשבון Gmail. חובה כשיש יותר מחשבון אחד לכתיבה.')
const list = (d) => ({ type: 'array', items: { type: 'string' }, description: d })
const readAccount = async (account) => {
  const email = google.resolveAccounts(account)[0]
  if (!email) throw fail('אין חשבון Google מחובר.')
  const granted = await google.grantedScopes(email)
  if (!granted || !GMAIL_SCOPES.read.some((s) => granted.includes(s))) throw fail(`לחשבון ${email} אין הרשאת קריאה ל-Gmail בגישה שגוגל נתן.`)
  return email
}

export const gmailPlusTools = [
  {
    name: 'gmail_thread',
    enabled: google.googleEnabled,
    description: 'קריאה בלבד: כל המיילים בשרשור Gmail לפי thread_id, עם message_id של כל מייל, נמענים, טקסט ורשימת קבצים מצורפים (part_id).',
    parameters: obj({ account: str('החשבון'), thread_id: str('מזהה השרשור') }, ['thread_id']),
    async run({ account, thread_id }) {
      try {
        return JSON.stringify(await readThread(await readAccount(account), thread_id))
      } catch (e) {
        return `שגיאה: ${e.message}`
      }
    },
  },
  {
    name: 'gmail_attachment_send',
    enabled: google.googleEnabled,
    description: 'שולח למשתמש בשיחה קובץ מצורף ממייל (message_id + part_id מ-gmail_thread). לא שומר אותו בדיסק.',
    parameters: obj({ account: str('החשבון'), message_id: str('מזהה המייל'), part_id: str('part_id של הקובץ') }, ['message_id', 'part_id']),
    async run({ account, message_id, part_id }, ctx) {
      if (!ctx?.sendMedia) return 'אין לאן לשלוח קובץ מהשיחה הזאת.'
      try {
        const got = await fetchAttachment(await readAccount(account), message_id, part_id)
        await ctx.sendMedia({ buffer: got.buffer, mime: got.mime, name: got.name, caption: got.name })
        return `נשלח: ${got.name}`
      } catch (e) {
        return `שגיאה: ${e.message}`
      }
    },
  },
  {
    name: 'gmail_reply',
    enabled: google.googleEnabled,
    description: 'עונה על מייל בתוך השרשור שלו (In-Reply-To/References נכונים). הנמענים נלקחים מהמייל המקורי; reply_all מוסיף את מי שהיה בו. אפשר cc/bcc וקבצים (files מתיקיית הקבצים המצורפים, drive_files מ-Drive). המשתמש רואה את הנוסח המלא ומאשר.',
    parameters: obj(
      { account: ACC, message_id: str('מזהה המייל שעונים עליו'), thread_id: str('מזהה השרשור, לבדיקה'), body: str('גוף התשובה, טקסט רגיל'), reply_all: { type: 'boolean' }, cc: list('כתובות נוספות'), bcc: list('עותק נסתר'), files: list('שמות קבצים מתיקיית הקבצים המצורפים'), drive_files: list('מזהי קבצי Drive') },
      ['message_id', 'body']
    ),
    run: (args, ctx) => reply(ctx, args),
  },
  {
    name: 'gmail_draft_save',
    enabled: google.googleEnabled,
    description: 'שומר טיוטה ב-Gmail ולא שולח. מייל חדש (to, subject) או טיוטת תשובה (reply_to_message_id). draft_id = עדכון טיוטה קיימת. לשליחה: gmail_draft_send.',
    parameters: obj(
      { account: ACC, to: list('נמענים'), cc: list('עותק'), bcc: list('עותק נסתר'), subject: str('נושא'), body: str('תוכן'), reply_to_message_id: str('לטיוטת תשובה'), thread_id: str('לבדיקה, עם reply_to_message_id'), reply_all: { type: 'boolean' }, draft_id: str('טיוטה קיימת לעדכן'), files: list('קבצים מקומיים'), drive_files: list('קבצי Drive') },
      ['body']
    ),
    run: (args, ctx) => saveDraft(ctx, args),
  },
  {
    name: 'gmail_draft_send',
    enabled: google.googleEnabled,
    description: 'שולח טיוטה קיימת כמו שהיא ב-Gmail. המשתמש רואה את התוכן האמיתי של הטיוטה ומאשר; אם היא משתנה בינתיים, לא נשלח.',
    parameters: obj({ account: ACC, draft_id: str('מזהה הטיוטה') }, ['draft_id']),
    run: (args, ctx) => sendDraft(ctx, args),
  },
  {
    name: 'gmail_labels',
    enabled: google.googleEnabled,
    description: 'קריאה בלבד: התוויות בחשבון Gmail, שם ומזהה.',
    parameters: obj({ account: str('החשבון') }, []),
    async run({ account }) {
      try {
        const email = await readAccount(account)
        const { labels = [] } = await google.gcall(email, 'GET', `${GMAIL}/labels`)
        return JSON.stringify(labels.map((l) => ({ name: l.name, id: l.id, type: l.type })))
      } catch (e) {
        return `שגיאה: ${e.message}`
      }
    },
  },
  {
    name: 'gmail_label_modify',
    enabled: google.googleEnabled,
    description: 'מוסיף או מסיר תוויות קיימות (לפי שם) למייל (target=message) או לשרשור שלם (target=thread). לא יוצר תוויות ולא מוחק מיילים. המשתמש מאשר.',
    parameters: obj({ account: ACC, target: str('message או thread'), id: str('מזהה המייל או השרשור'), add: list('שמות תוויות להוסיף'), remove: list('שמות תוויות להסיר') }, ['target', 'id']),
    run: (args, ctx) => modifyLabels(ctx, args),
  },
]
