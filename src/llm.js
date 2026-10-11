import { config } from './config.js'
import { state } from './store.js'

const RETRY_DELAYS = [2000, 6000]
const MAX_WAIT = 70000
const MAX_FAILURES = 8
const PATIENCE = 12000
// For the closing answer of a long task, which the user actually reads.
export const LONG_PATIENCE = 45000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The model for conversation turns: the one pinned with /model, else the default.
export const chatModel = () => state.modelOverride || config.llm.model

// Until when each model is out of its per-minute budget, as the provider last reported it.
const limitedUntil = new Map()
const isLimited = (model) => (limitedUntil.get(model) || 0) > Date.now()

// Every configured model has its own rate-limit budget at the provider. When the preferred one is used up, the
// next takes over at once instead of the user waiting out the minute. A pinned model is never swapped.
function lineup(preferred) {
  if (state.modelOverride) return [preferred]
  return [...new Set([preferred, config.llm.model, ...config.llm.fallbackModels, config.llm.cheapModel].filter(Boolean))]
}

async function request(body) {
  const res = await fetch(config.llm.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const error = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    error.status = res.status
    // Rate limits and server errors pass; a bad key or bad request will not get better.
    error.retry = res.status === 429 || res.status >= 500
    // The provider says how long until this model's budget frees up: seconds for the per-minute one, hours for a daily cap.
    const wait = Number(res.headers.get('retry-after')) * 1000
    if (wait > 0) error.wait = wait + 500
    if (res.status === 413) error.message = 'הבקשה גדולה מהמכסה לדקה של המודל הזה. נסה /new כדי לקצר את השיחה, או הודעה קצרה יותר.'
    throw error
  }
  const msg = (await res.json()).choices?.[0]?.message
  if (!msg) throw new Error('תשובה ריקה מהמודל')
  return msg
}

// Any OpenAI-compatible chat completions endpoint. Returns the assistant message object.
// `patience`: how long to wait for the preferred model's budget before handing the call to another model.
// `extra`: more request fields, such as max_completion_tokens.
export async function llm(messages, tools, preferred = chatModel(), patience = PATIENCE, extra = {}) {
  if (!config.llm.apiKey || !preferred) throw new Error('חסר LLM_API_KEY או LLM_MODEL בקובץ .env')
  const body = { messages, ...extra }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const models = lineup(preferred)
  let failures = 0
  for (;;) {
    // The preferred model writes the best Hebrew, so a short wait for it beats an instant answer from a weaker one.
    const preferredIn = (limitedUntil.get(preferred) || 0) - Date.now()
    if (preferredIn > 0 && preferredIn <= patience) await sleep(preferredIn)
    const model = models.find((m) => !isLimited(m))
    if (!model) {
      // Every model is out of budget: wait for whichever frees up first, unless that is a daily cap.
      const wait = Math.min(...models.map((m) => limitedUntil.get(m))) - Date.now()
      if (wait > MAX_WAIT) throw new Error(`המכסה של המודלים נגמרה כרגע. אפשר לנסות שוב בעוד כ-${Math.ceil(wait / 60000)} דקות.`)
      await sleep(Math.max(250, wait))
      continue
    }
    try {
      return await request({ ...body, model })
    } catch (e) {
      // A bad key or bad request will not get better, on this model or another.
      if (e.retry === false || ++failures > MAX_FAILURES) throw e
      // Out of budget, or a server or network hiccup: this model sits out and the next one is tried.
      limitedUntil.set(model, Date.now() + (e.wait || RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length) - 1]))
    }
  }
}

// One-off background question (mail triage, watch checks, summaries): the cheap model first.
export async function ask(system, user) {
  const msg = await llm(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    null,
    config.llm.cheapModel || config.llm.model,
    0
  )
  return (msg.content || '').trim()
}
