// Read homework as it was written: from a group photo, a PDF, or the message text.
// The image itself is not stored — only the extracted assignment text (book, pages, questions, sections).

const DETAIL = /עמוד(?:ים)?|עמ[׳'"]\.?|שאלה|שאלות|סעיף|סעיפים|ספר|חוברת|תרגיל(?:ים)?|דף(?:י)?\s*עבודה/

// The assignment details as written: book, pages, questions, sections — not the rest of the message.
const SNIPPET =
  /(?:ספר|חוברת)\s+[^\s,]+(?:\s+[^\s,]+){0,2}|(?:ב)?(?:עמוד(?:ים)?|עמ[׳']\.?)\s*[\d]+(?:\s*(?:-|–|עד|ו-?)\s*[\d]+)?|(?:שאל(?:ה|ות)|תרגיל(?:ים)?)\s*[\d]+(?:\s*(?:,|ו-?|-|–)\s*[\d]+)*(?:\s*סעיף(?:ים)?\s*[א-ת\d]+(?:\s*(?:,|ו-?)\s*[א-ת\d]+)*)?|(?:סעיף(?:ים)?)\s*[א-ת\d]+(?:\s*(?:,|ו-?|-|–)\s*[א-ת\d]+)*/g

export function homeworkSnippets(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const found = t.match(SNIPPET) || []
  const uniq = []
  for (const s of found) {
    const bit = s.trim().replace(/^ב(?=עמוד)/, '')
    if (bit && !uniq.includes(bit)) uniq.push(bit)
  }
  return uniq.join(', ')
}

export function preferHomeworkTitle(written, fallback) {
  const raw = String(written || '').replace(/\s+/g, ' ').trim()
  const fb = String(fallback || '').replace(/\s+/g, ' ').trim()
  const pick = (s) => s.replace(/^[!.،, ]+|[!.،, ]+$/g, '').slice(0, 400)
  const details = homeworkSnippets(raw) || (DETAIL.test(raw) && raw.length <= 400 ? raw : '')
  if (fb && DETAIL.test(fb) && (!details || fb.includes(details.slice(0, Math.min(16, details.length))) || fb.length >= details.length)) return pick(fb)
  if (fb && details && !fb.includes(details.slice(0, Math.min(16, details.length)))) return pick(`${fb}, ${details}`)
  if (details) return pick(details)
  return pick(fb || raw)
}

const VISION = `זו תמונה משיעורי בית שנשלחו בקבוצת וואטסאפ של כיתה.
כתוב בעברית בדיוק את מה שרשום על השיעורים: שם הספר או החוברת, מספרי העמודים, מספרי השאלות והסעיפים, וכל הוראה (מה לעשות, עד מתי).
אל תקצר ל"שיעורי בית במתמטיקה". אל תוסיף מה שלא כתוב. אם אין שיעורי בית בתמונה, החזר שורה ריקה.`

export async function readHomeworkMedia({ buffer, mime = '', name = '', caption = '' } = {}) {
  if (!buffer?.length) return ''
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name)
  const isImage = /^image\//i.test(mime) || /\.(jpe?g|png|webp|gif|heic)$/i.test(name)
  if (isPdf) {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf')
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), { mergePages: true })
      const raw = String(text || '').replace(/\s+/g, ' ').trim()
      if (raw) return preferHomeworkTitle(raw, caption)
    } catch (e) {
      console.log(`[schoolwork-media] pdf: ${e.message}`)
    }
  }
  if (!isImage) return ''
  const url = `data:${mime || 'image/jpeg'};base64,${Buffer.from(buffer).toString('base64')}`
  const { llm } = await import('./llm.js')
  const { config } = await import('./config.js')
  const models = [config.llm.cheapModel, config.llm.model].filter((m, i, a) => m && a.indexOf(m) === i)
  let last = ''
  for (const model of models) {
    try {
      const msg = await llm(
        [
          { role: 'system', content: VISION },
          {
            role: 'user',
            content: [
              { type: 'text', text: caption ? `כיתוב ההודעה: ${caption}\nקרא את שיעורי הבית שבתמונה.` : 'קרא את שיעורי הבית שבתמונה.' },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
        null,
        model,
        0,
        { max_completion_tokens: 500 },
      )
      last = String(msg?.content || '').trim()
      if (last) return last.slice(0, 1500)
    } catch (e) {
      console.log(`[schoolwork-media] vision ${model}: ${e.message}`)
    }
  }
  return last.slice(0, 1500)
}

export function quotedAndCaption(content, textOf) {
  const parts = []
  const main = textOf(content)
  if (main) parts.push(main)
  const file = content?.documentMessage?.fileName
  if (file) parts.push(`(קובץ: ${file})`)
  const ctx =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.documentMessage?.contextInfo ||
    content?.videoMessage?.contextInfo
  const q = ctx?.quotedMessage
  if (q) {
    const qt = textOf(q)
    if (qt) parts.push(`(ציטוט: ${qt})`)
  }
  return parts.join('\n')
}
