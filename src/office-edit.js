// Native edits to an existing Google Docs, Sheets or Slides file the user picked, through each product's own API:
// Docs documents.batchUpdate, Sheets values.batchUpdate / values.append, Slides presentations.batchUpdate.
//
// What this is and is not:
// - It edits a named part of a file and leaves the rest alone: replace an exact passage, insert next to an exact
//   anchor, append, set a range of cells, append rows, replace text on slides, add a slide. There is no "replace the
//   whole document", no clear-sheet and no delete-slide.
// - Every edit is bound to the revision the user saw. Docs and Slides send writeControl.requiredRevisionId, so Google
//   itself refuses the write if anyone changed the file after the question. Sheets has no such lock on values, so the
//   target cells are read again right before the write and must equal what was shown (a narrow window remains
//   between that read and the write; it is stated, not hidden).
// - Access: Helper asks Google for drive.file, which reaches only files Helper created (docs_create) or files the
//   user opened with Helper. It is not access to any file in Drive, and this code does not ask for more. A file outside
//   that grant comes back from Google as not found, and the result says so.
// - The account and the file id are always explicit, and the scopes are checked against what Google actually granted.
// - Word/Excel/PowerPoint files stored in Drive are not Google formats: native edits are refused for them, by name.
import { config } from './config.js'
import * as google from './google.js'
import { boundMutation, googleWriteAccount, outcome } from './bound-actions.js'
import { str, obj } from './tool-helpers.js'

const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const DOCS = 'https://docs.googleapis.com/v1/documents'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const SLIDES = 'https://slides.googleapis.com/v1/presentations'

const S = (name) => `https://www.googleapis.com/auth/${name}`
// Any one of these lets the product's API write the file (drive.file only for files in its grant).
export const EDIT_SCOPES = {
  doc: [S('documents'), S('drive'), S('drive.file')],
  sheet: [S('spreadsheets'), S('drive'), S('drive.file')],
  slides: [S('presentations'), S('drive'), S('drive.file')],
}
export const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
}
const LABEL = { doc: 'מסמך Docs', sheet: 'גיליון Sheets', slides: 'מצגת Slides' }
const OFFICE = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
  'application/msword': 'Word (.doc)',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel (.xlsx)',
  'application/vnd.ms-excel': 'Excel (.xls)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint (.pptx)',
  'application/vnd.ms-powerpoint': 'PowerPoint (.ppt)',
}

const MAX_EDITS = 20
const MAX_CELLS = 500
const MAX_TEXT = 4000

const fail = (message, code) => Object.assign(new Error(message), code && { code })

// A file id, or a Google link to one. Anything else is refused: the file must be named, never searched for here.
export function fileIdOf(input) {
  const s = String(input || '').trim()
  const fromUrl = s.match(/^https:\/\/(?:docs|drive)\.google\.com\/(?:document|spreadsheets|presentation|file)\/d\/([A-Za-z0-9_-]{10,200})/)
  const id = fromUrl ? fromUrl[1] : s
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw fail('צריך מזהה קובץ מדויק (או קישור Google לקובץ). לא מחפש קובץ לבד.')
  return id
}

// The file's name and type, from Drive, as the given account. Refuses a type that does not match the tool.
export async function fileFor(email, id, kind) {
  let meta
  try {
    meta = await google.gcall(email, 'GET', `${DRIVE}/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,capabilities(canEdit)&supportsAllDrives=true`)
  } catch (e) {
    if (e.status === 404) throw fail(`הקובץ ${id} לא נגיש לחשבון ${email} בהרשאה שיש ל-Helper (drive.file: רק קבצים ש-Helper יצר או שנפתחו דרכו). זו לא גישה לכל ה-Drive.`, 'unsupported')
    if (e.status === 403) throw fail(`גוגל סירב לגשת לקובץ (${e.reason || 403}). ייתכן שחסרה הרשאה.`, 'setup_needed')
    throw e
  }
  if (meta.trashed) throw fail(`הקובץ "${meta.name}" נמצא באשפה. לא עורך אותו.`)
  if (meta.mimeType !== MIME[kind]) {
    const office = OFFICE[meta.mimeType]
    if (office) throw fail(`"${meta.name}" הוא קובץ ${office} שמור ב-Drive, לא ${LABEL[kind]}. עריכה מקורית עובדת רק על פורמטים של Google; אפשר לפתוח אותו ב-Google ולשמור כ-${LABEL[kind]}.`, 'unsupported')
    const other = Object.entries(MIME).find(([, m]) => m === meta.mimeType)?.[0]
    if (other) throw fail(`"${meta.name}" הוא ${LABEL[other]}, לא ${LABEL[kind]}. צריך את הכלי של ${LABEL[other]}.`, 'unsupported')
    throw fail(`"${meta.name}" מסוג ${meta.mimeType}: אין לו עריכה מקורית כאן.`, 'unsupported')
  }
  if (meta.capabilities && meta.capabilities.canEdit === false) throw fail(`לחשבון ${email} אין הרשאת עריכה ל-"${meta.name}".`)
  return meta
}

const clip = (s, n = 300) => {
  const t = String(s)
  return t.length > n ? `${t.slice(0, n)}…` : t
}
// What is sent is shown whole: no clipping of text that will be written (the shared length limit in bound-actions
// then refuses a change too long to read). Line breaks, tabs and invisible or direction-changing characters are
// made visible so nothing written is hidden in the question.
const quote = (s) => `«${String(s).replace(/\n/g, '⏎').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)}»`


// Every text the request will write or match must be visible in the question, as shown by quote(). A planner bug
// that shortened or left out a text would otherwise be approved unseen; this refuses instead.
function sentTexts(requests) {
  const out = []
  for (const r of requests || []) {
    if (r.insertText?.text) out.push(r.insertText.text)
    if (r.replaceAllText) out.push(r.replaceAllText.replaceText || '', r.replaceAllText.containsText?.text || '')
  }
  return out
}
export function assertAllShown(question, requests) {
  for (const t of sentTexts(requests)) {
    for (const seg of String(t).split('\n')) {
      if (seg && !question.includes(quote(seg).slice(1, -1))) throw fail(`חלק מהטקסט שיישלח לא מוצג בשאלת האישור במלואו, אז לא מבצע (${seg.length} תווים).`, 'unsupported')
    }
  }
  return question
}

// ---- Docs ----

// The body's text with the document index of every character. Docs counts in UTF-16 code units, like JS strings.
// Tables are walked too. A gap (a table or section marker) is recorded so a match across it can be refused.
export function docTextMap(doc) {
  let text = ''
  const index = []
  const walk = (content = []) => {
    for (const el of content) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) {
          const run = pe.textRun?.content
          if (typeof run !== 'string' || !Number.isInteger(pe.startIndex)) continue
          for (let i = 0; i < run.length; i++) index.push(pe.startIndex + i)
          text += run
        }
      } else if (el.table) {
        for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content)
      }
    }
  }
  walk(doc?.body?.content)
  return { text, index }
}

function findAll(haystack, needle) {
  const out = []
  if (!needle) return out
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) out.push(at)
  return out
}

// Turns the requested edits into Docs requests against this exact document text. Each edit must hit exactly the
// number of places it expects (default one). Overlapping edits, a match across a table boundary, a match on the
// document's final newline, or an edit that would remove most of the document are refused.
export function planDocEdits(doc, edits) {
  if (!Array.isArray(edits) || !edits.length) throw fail('אין עריכות.')
  if (edits.length > MAX_EDITS) throw fail(`יותר מדי עריכות בבת אחת (${edits.length}, מקסימום ${MAX_EDITS}).`)
  const { text, index } = docTextMap(doc)
  const bodyEnd = doc?.body?.content?.at?.(-1)?.endIndex
  const spans = []
  const lines = []
  for (const [n, e] of edits.entries()) {
    const op = e?.op
    const insert = e.text ?? e.replace ?? ''
    if (typeof insert !== 'string' || insert.length > MAX_TEXT) throw fail(`עריכה ${n + 1}: טקסט חסר או ארוך מדי.`)
    if (op === 'append') {
      if (!insert) throw fail(`עריכה ${n + 1}: אין מה להוסיף.`)
      // The body always ends with a newline that cannot be removed; text goes in before it, as a new paragraph.
      spans.push({ n, kind: 'insert', at: Number.isInteger(bodyEnd) ? bodyEnd - 1 : null, end: true, text: `\n${insert.replace(/\n+$/, '')}` })
      lines.push(`${n + 1}. פסקה חדשה בסוף המסמך: ${quote(insert)}`)
      continue
    }
    const find = e.find ?? e.anchor
    if (typeof find !== 'string' || !find) throw fail(`עריכה ${n + 1}: צריך את הטקסט המדויק לחפש (find).`)
    const expected = e.expected_count ?? 1
    const at = findAll(text, find)
    if (at.length !== expected) throw fail(`עריכה ${n + 1}: ${quote(clip(find, 80))} נמצא ${at.length} פעמים במסמך, ציפיתי ל-${expected}. צריך טקסט ייחודי יותר או expected_count נכון.`)
    for (const offset of at) {
      const start = index[offset]
      const last = index[offset + find.length - 1]
      if (last - start !== find.length - 1) throw fail(`עריכה ${n + 1}: הטקסט חוצה טבלה או מעבר מקטע, ואי אפשר לערוך אותו כיחידה אחת.`)
      if (Number.isInteger(bodyEnd) && last >= bodyEnd - 1 && (op === 'replace' || op === 'delete')) throw fail(`עריכה ${n + 1}: אי אפשר למחוק את סוף המסמך.`)
      if ((op === 'replace' || op === 'delete') && find.length > 200 && find.length > text.length / 2) throw fail(`עריכה ${n + 1}: זה ימחק את רוב המסמך. החלפה של כל המסמך לא נתמכת כאן; עדיף ליצור מסמך חדש.`)
      if (op === 'replace') spans.push({ n, kind: 'replace', start, endEx: last + 1, text: insert })
      else if (op === 'delete') spans.push({ n, kind: 'replace', start, endEx: last + 1, text: '' })
      else if (op === 'insert_after') spans.push({ n, kind: 'insert', at: last + 1, text: insert })
      else if (op === 'insert_before') spans.push({ n, kind: 'insert', at: start, text: insert })
      else throw fail(`עריכה ${n + 1}: פעולה לא מוכרת "${op}". אפשר: replace, delete, insert_after, insert_before, append.`)
    }
    const around = (offset) => clip(text.slice(Math.max(0, offset - 30), offset + find.length + 30), 200)
    if (op === 'replace') lines.push(`${n + 1}. להחליף ${quote(find)} ב-${quote(insert)}${expected > 1 ? ` (${expected} מקומות)` : ''}\n   בהקשר: ${quote(around(at[0]))}`)
    else if (op === 'delete') lines.push(`${n + 1}. למחוק ${quote(find)}${expected > 1 ? ` (${expected} מקומות)` : ''}\n   בהקשר: ${quote(around(at[0]))}`)
    else lines.push(`${n + 1}. להוסיף ${quote(insert)} ${op === 'insert_after' ? 'אחרי' : 'לפני'} ${quote(find)}`)
  }
  // Two edits may not touch the same characters, and an insert may not land inside a replaced passage.
  const ranges = spans.filter((s) => s.kind === 'replace').map((s) => [s.start, s.endEx, s.n])
  for (const s of spans) {
    for (const [a, b, m] of ranges) {
      if (m === s.n && s.kind === 'replace' && s.start === a) continue
      if (s.kind === 'replace' && s.start < b && a < s.endEx) throw fail(`עריכות ${m + 1} ו-${s.n + 1} חופפות.`)
      if (s.kind === 'insert' && s.at > a && s.at < b) throw fail(`עריכה ${s.n + 1} נופלת בתוך טקסט שעריכה ${m + 1} מחליפה.`)
    }
  }
  // From the end of the document backwards, so earlier indexes stay valid while later ones change.
  const pos = (s) => (s.kind === 'replace' ? s.start : s.at ?? Infinity)
  const requests = []
  for (const s of [...spans].sort((x, y) => pos(y) - pos(x))) {
    if (s.kind === 'insert') {
      requests.push({ insertText: s.end && s.at == null ? { endOfSegmentLocation: {}, text: s.text } : { location: { index: s.at }, text: s.text } })
    } else {
      requests.push({ deleteContentRange: { range: { startIndex: s.start, endIndex: s.endEx } } })
      if (s.text) requests.push({ insertText: { location: { index: s.start }, text: s.text } })
    }
  }
  return { requests, lines }
}

// ---- Sheets ----

const COL = /^[A-Z]{1,3}$/
const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)

// "'גיליון 1'!A1:C3" -> { sheet, rows, cols }. The sheet name is required: a bare A1 would mean "the first sheet",
// which may not be the one the user means.
export function parseRange(range) {
  const m = String(range || '').match(/^('(?:[^']|'')+'|[^!'\s:]+)!([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/)
  if (!m) throw fail(`טווח לא תקין: "${range}". צריך שם גיליון וטווח מלא, למשל 'גיליון1'!A1:C3.`)
  const sheet = m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]
  const [c1, r1, c2 = m[2], r2 = m[3]] = [m[2], Number(m[3]), m[4], m[5] && Number(m[5])]
  if (!COL.test(c1) || !COL.test(c2)) throw fail(`עמודה לא תקינה ב-"${range}".`)
  const rows = Number(r2) - r1 + 1
  const cols = colNum(c2) - colNum(c1) + 1
  if (rows < 1 || cols < 1) throw fail(`הטווח "${range}" הפוך.`)
  return { sheet, rows, cols, a1: range }
}

const looksLikeFormula = (v) => typeof v === 'string' && /^\s*[=+]/.test(v)

export function planSheetUpdates(meta, updates, input) {
  if (!Array.isArray(updates) || !updates.length) throw fail('אין עדכונים.')
  if (updates.length > MAX_EDITS) throw fail(`יותר מדי טווחים (${updates.length}, מקסימום ${MAX_EDITS}).`)
  const sheets = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties]))
  let cells = 0
  let formulas = false
  const data = updates.map((u, n) => {
    const r = parseRange(u?.range)
    if (!sheets.has(r.sheet)) throw fail(`אין גיליון בשם "${r.sheet}". יש: ${[...sheets.keys()].join(', ')}`)
    const values = u.values
    if (!Array.isArray(values) || values.length !== r.rows || values.some((row) => !Array.isArray(row) || row.length !== r.cols)) {
      throw fail(`עדכון ${n + 1}: הטווח ${r.a1} הוא ${r.rows}×${r.cols}, והערכים לא באותו גודל בדיוק.`)
    }
    for (const row of values) for (const v of row) {
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw fail(`עדכון ${n + 1}: ערך לא נתמך בתא.`)
      if (looksLikeFormula(v)) formulas = true
    }
    cells += r.rows * r.cols
    return { range: r.a1, values }
  })
  if (cells > MAX_CELLS) throw fail(`יותר מדי תאים בבת אחת (${cells}, מקסימום ${MAX_CELLS}).`)
  if (formulas && !['formulas', 'raw'].includes(input)) throw fail('יש ערכים שמתחילים ב-= או +. צריך לבחור במפורש: input="formulas" (נוסחאות שיחושבו) או input="raw" (טקסט כמו שהוא).')
  return { data, cells, valueInputOption: input === 'raw' ? 'RAW' : 'USER_ENTERED' }
}

// ---- Slides ----

function shapeText(el) {
  return (el?.shape?.text?.textElements || []).map((t) => t.textRun?.content || '').join('')
}

export function planSlideEdits(pres, edits) {
  if (!Array.isArray(edits) || !edits.length) throw fail('אין עריכות.')
  if (edits.length > MAX_EDITS) throw fail(`יותר מדי עריכות בבת אחת (${edits.length}, מקסימום ${MAX_EDITS}).`)
  const slides = pres.slides || []
  const slideIds = new Set(slides.map((s) => s.objectId))
  const shapes = new Map()
  for (const [i, s] of slides.entries()) for (const el of s.pageElements || []) if (el.shape) shapes.set(el.objectId, { slide: i + 1, slideId: s.objectId, text: shapeText(el) })
  const requests = []
  const lines = []
  const expect = []
  for (const [n, e] of edits.entries()) {
    const text = e?.text ?? e?.replace ?? ''
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw fail(`עריכה ${n + 1}: טקסט חסר או ארוך מדי.`)
    if (e.op === 'replace_text') {
      if (typeof e.find !== 'string' || !e.find) throw fail(`עריכה ${n + 1}: צריך find מדויק.`)
      if (e.slide_id && !slideIds.has(e.slide_id)) throw fail(`עריכה ${n + 1}: אין שקף ${e.slide_id}.`)
      const scope = [...shapes.values()].filter((s) => !e.slide_id || s.slideId === e.slide_id)
      const count = scope.reduce((c, s) => c + findAll(s.text, e.find).length, 0)
      const expected = e.expected_count ?? 1
      if (count !== expected) throw fail(`עריכה ${n + 1}: ${quote(clip(e.find, 80))} מופיע ${count} פעמים${e.slide_id ? ' בשקף' : ' במצגת'}, ציפיתי ל-${expected}.`)
      requests.push({ replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: text, ...(e.slide_id && { pageObjectIds: [e.slide_id] }) } })
      expect.push({ at: requests.length - 1, occurrences: expected })
      lines.push(`${n + 1}. להחליף ${quote(e.find)} ב-${quote(text)}${e.slide_id ? ` בשקף ${e.slide_id}` : ' בכל המצגת'} (${expected} מקומות)`)
    } else if (e.op === 'insert_text') {
      const shape = shapes.get(e.shape_id)
      if (!shape) throw fail(`עריכה ${n + 1}: אין צורה עם טקסט בשם ${e.shape_id}. אפשר לראות מזהים עם office_outline.`)
      if (!text) throw fail(`עריכה ${n + 1}: אין מה להוסיף.`)
      // A shape's text ends with a newline; "end" inserts before it.
      const len = shape.text.length
      const index = e.at === 'start' ? 0 : Math.max(0, shape.text.endsWith('\n') ? len - 1 : len)
      requests.push({ insertText: { objectId: e.shape_id, insertionIndex: index, text } })
      lines.push(`${n + 1}. להוסיף ${quote(text)} ${e.at === 'start' ? 'בתחילת' : 'בסוף'} התיבה ${e.shape_id} (שקף ${shape.slide})`)
    } else if (e.op === 'add_slide') {
      const at = e.insertion_index ?? slides.length
      if (!Number.isInteger(at) || at < 0 || at > slides.length) throw fail(`עריכה ${n + 1}: מיקום שקף לא תקין (0 עד ${slides.length}).`)
      const id = `helper_${Date.now().toString(36)}_${n}`
      const title = e.title ? `${id}_t` : null
      const body = e.body ? `${id}_b` : null
      const layout = title && body ? 'TITLE_AND_BODY' : title ? 'TITLE_ONLY' : 'BLANK'
      const mappings = [title && { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: title }, body && { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: body }].filter(Boolean)
      requests.push({ createSlide: { objectId: id, insertionIndex: at, slideLayoutReference: { predefinedLayout: layout }, ...(mappings.length && { placeholderIdMappings: mappings }) } })
      if (title) requests.push({ insertText: { objectId: title, insertionIndex: 0, text: String(e.title) } })
      if (body) requests.push({ insertText: { objectId: body, insertionIndex: 0, text: String(e.body) } })
      lines.push(`${n + 1}. להוסיף שקף חדש במקום ${at + 1}${e.title ? `, כותרת ${quote(e.title)}` : ''}${e.body ? `, תוכן ${quote(e.body)}` : ''}`)
    } else {
      throw fail(`עריכה ${n + 1}: פעולה לא מוכרת "${e?.op}". אפשר: replace_text, insert_text, add_slide.`)
    }
  }
  return { requests, lines, expect }
}

// ---- tools ----

const writeAccount = (account, kind) => googleWriteAccount(account, { scopesAny: EDIT_SCOPES[kind], google, readOnly: config.google.readOnly })

// Google answers a write against an old revision with 400 and a message about the revision.
const revisionAware = (e) => {
  if (e.status === 400 && /revision/i.test(e.message)) throw Object.assign(new Error('הקובץ השתנה מאז האישור'), { status: 400, code: 'revision-changed' })
  throw e
}

export async function editDoc(ctx, { account, file_id, edits }) {
  let email, id
  return boundMutation(ctx, {
    tool: 'docs_edit',
    async prepare() {
      email = await writeAccount(account, 'doc')
      id = fileIdOf(file_id)
      const meta = await fileFor(email, id, 'doc')
      const doc = await google.gcall(email, 'GET', `${DOCS}/${encodeURIComponent(id)}`)
      const { requests, lines } = planDocEdits(doc, edits)
      return {
        account: email,
        op: { email, id, revision: doc.revisionId, requests },
        fingerprint: { revision: doc.revisionId },
        question: assertAllShown(`לערוך את ${LABEL.doc} "${meta.name}"?\n*חשבון:* ${email}\n*קובץ:* ${id}\n\n${lines.join('\n')}\n\nשאר המסמך לא משתנה. אם מישהו ישנה את המסמך לפני שזה נשלח, גוגל יסרב והשינוי לא יבוצע.`, requests),
      }
    },
    recheck: async (op) => ({ revision: (await google.gcall(op.email, 'GET', `${DOCS}/${encodeURIComponent(op.id)}?fields=revisionId`)).revisionId }),
    async execute(op) {
      const res = await google.gcall(op.email, 'POST', `${DOCS}/${encodeURIComponent(op.id)}:batchUpdate`, { json: { requests: op.requests, writeControl: { requiredRevisionId: op.revision } } }).catch(revisionAware)
      const confirmed = res.documentId === op.id
      return { confirmed, ref: `https://docs.google.com/document/d/${op.id}/edit`, text: `המסמך עודכן (${op.requests.length} שינויים): https://docs.google.com/document/d/${op.id}/edit` }
    },
  })
}

export async function editSheet(ctx, { account, file_id, updates, append, input }) {
  let email
  return boundMutation(ctx, {
    tool: 'sheets_edit',
    async prepare() {
      email = await writeAccount(account, 'sheet')
      const id = fileIdOf(file_id)
      const file = await fileFor(email, id, 'sheet')
      const meta = await google.gcall(email, 'GET', `${SHEETS}/${encodeURIComponent(id)}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties))`)
      if (append) {
        if (updates?.length) throw fail('או עדכון טווחים או הוספת שורות, לא שניהם באותה פעולה.')
        const sheet = String(append.sheet || '')
        if (!(meta.sheets || []).some((s) => s.properties.title === sheet)) throw fail(`אין גיליון בשם "${sheet}".`)
        const rows = append.rows
        if (!Array.isArray(rows) || !rows.length || rows.some((r) => !Array.isArray(r))) throw fail('rows צריך להיות רשימת שורות.')
        const cells = rows.reduce((n, r) => n + r.length, 0)
        if (cells > MAX_CELLS) throw fail(`יותר מדי תאים (${cells}).`)
        const formulas = rows.some((r) => r.some(looksLikeFormula))
        if (formulas && !['formulas', 'raw'].includes(input)) throw fail('יש ערכים שמתחילים ב-= או +. צריך input="formulas" או input="raw".')
        const range = `'${sheet.replace(/'/g, "''")}'!A1`
        const shown = rows.map((r) => `  ${r.map((v) => String(v ?? '')).join(' | ')}`).join('\n')
        return {
          account: email,
          op: { email, id, kind: 'append', range, rows, valueInputOption: input === 'raw' ? 'RAW' : 'USER_ENTERED', cells },
          fingerprint: null,
          question: `להוסיף ${rows.length} שורות חדשות בסוף הטבלה בגיליון "${sheet}" של "${file.name}"?\n*חשבון:* ${email}\n*קובץ:* ${id}\n*ערכים:* ${input === 'formulas' ? 'נוסחאות יחושבו' : input === 'raw' ? 'טקסט כמו שהוא' : 'כמו הקלדה'}\n\n${shown}\n\nשורות קיימות לא נדרסות.`,
        }
      }
      const plan = planSheetUpdates(meta, updates, input)
      const before = await readRanges(email, id, plan.data.map((d) => d.range))
      const shown = plan.data.map((d, i) => `*${d.range}*\nלפני:\n${grid(before[i])}\nאחרי:\n${grid(d.values)}`).join('\n\n')
      return {
        account: email,
        op: { email, id, kind: 'update', data: plan.data, valueInputOption: plan.valueInputOption, cells: plan.cells },
        fingerprint: { before },
        question: `לעדכן ${plan.cells} תאים ב-"${file.name}"?\n*חשבון:* ${email}\n*קובץ:* ${id}\n*ערכים:* ${plan.valueInputOption === 'RAW' ? 'טקסט כמו שהוא' : input === 'formulas' ? 'נוסחאות יחושבו' : 'כמו הקלדה'}\n\n${shown}\n\nתאים מחוץ לטווחים האלה לא משתנים. אם התאים ישתנו לפני השליחה, לא אשנה כלום.`,
      }
    },
    async recheck(op) {
      if (op.kind === 'append') return null
      return { before: await readRanges(op.email, op.id, op.data.map((d) => d.range)) }
    },
    async execute(op) {
      if (op.kind === 'append') {
        const url = `${SHEETS}/${encodeURIComponent(op.id)}/values/${encodeURIComponent(op.range)}:append?valueInputOption=${op.valueInputOption}&insertDataOption=INSERT_ROWS`
        const res = await google.gcall(op.email, 'POST', url, { json: { majorDimension: 'ROWS', values: op.rows } })
        const updated = res.updates?.updatedCells
        return { confirmed: res.spreadsheetId === op.id && Number.isInteger(updated), ref: res.updates?.updatedRange, text: `נוספו ${op.rows.length} שורות (${res.updates?.updatedRange || '?'})` }
      }
      const res = await google.gcall(op.email, 'POST', `${SHEETS}/${encodeURIComponent(op.id)}/values:batchUpdate`, { json: { valueInputOption: op.valueInputOption, data: op.data.map((d) => ({ range: d.range, majorDimension: 'ROWS', values: d.values })) } })
      const confirmed = res.spreadsheetId === op.id && res.totalUpdatedCells != null
      const partial = confirmed && res.totalUpdatedCells !== op.cells
      return { confirmed, ref: (res.responses || []).map((r) => r.updatedRange).join(','), text: `הגיליון עודכן: ${res.totalUpdatedCells ?? '?'} תאים${partial ? ` (ביקשתי ${op.cells}; גוגל לא סופר תאים שערכם לא השתנה)` : ''}` }
    },
  })
}

async function readRanges(email, id, ranges) {
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')
  const res = await google.gcall(email, 'GET', `${SHEETS}/${encodeURIComponent(id)}/values:batchGet?${q}&valueRenderOption=FORMULA&majorDimension=ROWS`)
  return (res.valueRanges || []).map((v) => v.values || [])
}

const grid = (rows) => (rows.length ? rows.map((r) => `  ${r.map((v) => String(v ?? '')).join(' | ')}`).join('\n') : '  (ריק)')

export async function editSlides(ctx, { account, file_id, edits }) {
  let email
  return boundMutation(ctx, {
    tool: 'slides_edit',
    async prepare() {
      email = await writeAccount(account, 'slides')
      const id = fileIdOf(file_id)
      const meta = await fileFor(email, id, 'slides')
      const pres = await google.gcall(email, 'GET', `${SLIDES}/${encodeURIComponent(id)}`)
      const { requests, lines, expect } = planSlideEdits(pres, edits)
      // The new slide ids are made in the plan; they are part of what is approved, so a retry asks again.
      return {
        account: email,
        op: { email, id, revision: pres.revisionId, requests, expect },
        fingerprint: { revision: pres.revisionId },
        question: assertAllShown(`לערוך את ${LABEL.slides} "${meta.name}"?\n*חשבון:* ${email}\n*קובץ:* ${id}\n\n${lines.join('\n')}\n\nשאר המצגת לא משתנה. אם מישהו ישנה אותה לפני השליחה, גוגל יסרב.`, requests),
      }
    },
    recheck: async (op) => ({ revision: (await google.gcall(op.email, 'GET', `${SLIDES}/${encodeURIComponent(op.id)}?fields=revisionId`)).revisionId }),
    async execute(op) {
      const res = await google.gcall(op.email, 'POST', `${SLIDES}/${encodeURIComponent(op.id)}:batchUpdate`, { json: { requests: op.requests, writeControl: { requiredRevisionId: op.revision } } }).catch(revisionAware)
      const off = op.expect.filter((x) => (res.replies?.[x.at]?.replaceAllText?.occurrencesChanged ?? 0) !== x.occurrences)
      const link = `https://docs.google.com/presentation/d/${op.id}/edit`
      return { confirmed: res.presentationId === op.id, ref: link, text: `המצגת עודכנה: ${link}${off.length ? ` (שים לב: ${off.length} החלפות שינו מספר מקומות שונה מהצפוי)` : ''}` }
    },
  })
}

// Read-only: what can be named in an edit (sheet names and sizes, slide and text box ids, the document revision).
export async function outline(email, fileId) {
  const id = fileIdOf(fileId)
  const meta = await google.gcall(email, 'GET', `${DRIVE}/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`)
  if (meta.mimeType === MIME.sheet) {
    const s = await google.gcall(email, 'GET', `${SHEETS}/${encodeURIComponent(id)}?fields=sheets(properties(title,gridProperties))`)
    return { kind: 'sheet', name: meta.name, id, sheets: (s.sheets || []).map((x) => ({ title: x.properties.title, rows: x.properties.gridProperties?.rowCount, cols: x.properties.gridProperties?.columnCount })) }
  }
  if (meta.mimeType === MIME.slides) {
    const p = await google.gcall(email, 'GET', `${SLIDES}/${encodeURIComponent(id)}`)
    return { kind: 'slides', name: meta.name, id, slides: (p.slides || []).map((s, i) => ({ n: i + 1, slide_id: s.objectId, boxes: (s.pageElements || []).filter((e) => e.shape?.text).map((e) => ({ shape_id: e.objectId, text: clip(shapeText(e).trim(), 120) })) })) }
  }
  if (meta.mimeType === MIME.doc) {
    const d = await google.gcall(email, 'GET', `${DOCS}/${encodeURIComponent(id)}`)
    const { text } = docTextMap(d)
    return { kind: 'doc', name: meta.name, id, chars: text.length, text: clip(text, 6000) }
  }
  return { kind: 'unsupported', name: meta.name, id, mimeType: meta.mimeType, note: OFFICE[meta.mimeType] ? `${OFFICE[meta.mimeType]}: לא פורמט של Google, אין עריכה מקורית` : 'אין עריכה מקורית לסוג הזה' }
}

const ACCOUNT_W = str('חשבון Google שבו נמצא הקובץ. חובה כשיש יותר מחשבון אחד לכתיבה.')
const FILE = str('מזהה הקובץ (או קישור docs.google.com אליו). מ-docs_create, drive_search או מהמשתמש.')

export const officeEditTools = [
  {
    name: 'office_outline',
    enabled: google.googleEnabled,
    description: 'קריאה בלבד: מבנה של קובץ Google לפני עריכה. גיליון: שמות הגיליונות והגודל. מצגת: מזהי שקפים ותיבות טקסט. מסמך: הטקסט.',
    parameters: obj({ account: str('החשבון שבו נמצא הקובץ'), file_id: FILE }, ['file_id']),
    async run({ account, file_id }) {
      const email = google.resolveAccounts(account)[0]
      if (!email) return 'אין חשבון Google מחובר'
      try {
        return JSON.stringify(await outline(email, file_id))
      } catch (e) {
        return e.status === 404 ? `הקובץ לא נגיש לחשבון ${email} בהרשאה שיש ל-Helper (drive.file).` : `שגיאה: ${e.message}`
      }
    },
  },
  {
    name: 'docs_edit',
    enabled: google.googleEnabled,
    description:
      'עורך מסמך Google Docs קיים במקום, בלי לגעת בשאר המסמך: replace (החלפת טקסט מדויק), delete, insert_after / insert_before (ליד עוגן מדויק), append (בסוף). כל find חייב להופיע בדיוק expected_count פעמים (ברירת מחדל 1). המשתמש מאשר את השינויים המדויקים; אם המסמך השתנה בינתיים, השינוי לא נשלח.',
    parameters: obj(
      {
        account: ACCOUNT_W,
        file_id: FILE,
        edits: {
          type: 'array',
          description: 'השינויים, לפי הסדר',
          items: { type: 'object', properties: { op: str('replace | delete | insert_after | insert_before | append'), find: str('הטקסט המדויק במסמך (לא ב-append)'), text: str('הטקסט החדש'), expected_count: { type: 'number', description: 'בכמה מקומות find מופיע (ברירת מחדל 1)' } }, required: ['op'] },
        },
      },
      ['file_id', 'edits']
    ),
    run: (args, ctx) => editDoc(ctx, args),
  },
  {
    name: 'sheets_edit',
    enabled: google.googleEnabled,
    description:
      'עורך גיליון Google Sheets קיים: updates = טווחים מדויקים עם שם גיליון (\'גיליון1\'!A1:B2) וערכים באותו גודל בדיוק, או append = הוספת שורות בסוף הטבלה. ערך שמתחיל ב-= דורש input="formulas" (נוסחה) או input="raw" (טקסט). המשתמש רואה לפני/אחרי ומאשר.',
    parameters: obj(
      {
        account: ACCOUNT_W,
        file_id: FILE,
        updates: { type: 'array', description: 'טווחים לעדכן', items: { type: 'object', properties: { range: str("'שם גיליון'!A1:C3"), values: { type: 'array', items: { type: 'array', items: {} } } }, required: ['range', 'values'] } },
        append: { type: 'object', description: 'הוספת שורות', properties: { sheet: str('שם הגיליון'), rows: { type: 'array', items: { type: 'array', items: {} } } } },
        input: str('formulas | raw | ריק (כמו הקלדה, רק כשאין נוסחאות)'),
      },
      ['file_id']
    ),
    run: (args, ctx) => editSheet(ctx, args),
  },
  {
    name: 'slides_edit',
    enabled: google.googleEnabled,
    description:
      'עורך מצגת Google Slides קיימת: replace_text (טקסט מדויק, בכל המצגת או בשקף slide_id, בדיוק expected_count מקומות), insert_text (לתיבה shape_id, בסוף או בהתחלה), add_slide (שקף חדש עם title/body). מזהים מ-office_outline. בלי מחיקת שקפים. המשתמש מאשר.',
    parameters: obj(
      {
        account: ACCOUNT_W,
        file_id: FILE,
        edits: {
          type: 'array',
          items: { type: 'object', properties: { op: str('replace_text | insert_text | add_slide'), find: str('לטקסט להחלפה'), text: str('הטקסט החדש'), slide_id: str('שקף מסוים'), shape_id: str('תיבת טקסט'), at: str('start | end'), expected_count: { type: 'number' }, insertion_index: { type: 'number' }, title: str('כותרת לשקף חדש'), body: str('תוכן לשקף חדש') }, required: ['op'] },
        },
      },
      ['file_id', 'edits']
    ),
    run: (args, ctx) => editSlides(ctx, args),
  },
]
