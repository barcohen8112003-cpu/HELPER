import { config } from './config.js'
import { state } from './store.js'

const RETRY_DELAYS = [2000, 6000]
const MAX_WAIT = 70000
const MAX_FAILURES = 8
const PATIENCE = 12000
// For the closing answer of a long task, which the user actually reads.
export const LONG_PATIENCE = 45000
// Thrown when the user stopped the turn ("עצור"). It is not a failure: nothing retries it and nobody reports it as one.
export class Aborted extends Error {
  constructor() {
    super('הופסק')
    this.name = 'Aborted'
  }
}
// A wait that ends at once when the turn is stopped.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted())
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Aborted())), { once: true })
  })

// The model for conversation turns: the one pinned with /model, else the default.
export const chatModel = () => state.modelOverride || config.llm.model

// Until when each model is out of its per-minute budget, as the provider last reported it.
const limitedUntil = new Map()
const isLimited = (model) => (limitedUntil.get(model) || 0) > Date.now()

// The last real answer and the last failure from the provider, for the settings page.
const health = { okAt: 0, errorAt: 0, error: '' }
export function llmHealth() {
  const limited = [...limitedUntil].filter(([, until]) => until > Date.now()).map(([model]) => model)
  return { ...health, limited }
}

// Every configured model has its own rate-limit budget at the provider. When the preferred one is used up, the
// next takes over at once instead of the user waiting out the minute. A pinned model is never swapped.
function lineup(preferred) {
  if (state.modelOverride) return [preferred]
  // The backup provider's model comes last: a different company, so a different daily quota altogether.
  return [...new Set([preferred, config.llm.model, ...config.llm.fallbackModels, config.llm.cheapModel, config.llm.backup.apiKey && config.llm.backup.model].filter(Boolean))]
}

// Which endpoint and key a model is reached through.
const providerOf = (model) => (config.llm.backup.apiKey && model === config.llm.backup.model ? config.llm.backup : config.llm)

async function request(body, signal) {
  const provider = providerOf(body.model)
  const res = await fetch(provider.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(120000), signal]) : AbortSignal.timeout(120000),
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
  health.okAt = Date.now()
  return msg
}

// Any OpenAI-compatible chat completions endpoint. Returns the assistant message object.
// `patience`: how long to wait for the preferred model's budget before handing the call to another model.
// `extra`: more request fields, such as max_completion_tokens.
// `signal`: an AbortSignal; when it fires the call ends at once with Aborted, whether it is waiting or in flight.
export async function llm(messages, tools, preferred = chatModel(), patience = PATIENCE, extra = {}, signal) {
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
    if (signal?.aborted) throw new Aborted()
    if (preferredIn > 0 && preferredIn <= patience) await sleep(preferredIn, signal)
    const model = models.find((m) => !isLimited(m))
    if (!model) {
      // Every model is out of budget: wait for whichever frees up first, unless that is a daily cap.
      const wait = Math.min(...models.map((m) => limitedUntil.get(m))) - Date.now()
      if (wait > MAX_WAIT) throw new Error(`נגמרה המכסה היומית של כל המודלים החינמיים. היא מתחדשת בעוד כ-${Math.ceil(wait / 60000)} דקות. אפשר להוסיף ספק גיבוי באתר ההגדרות, תחת "מודל AI".`)
      await sleep(Math.max(250, wait), signal)
      continue
    }
    try {
      return await request({ ...body, model }, signal)
    } catch (e) {
      if (signal?.aborted || e instanceof Aborted) throw new Aborted()
      health.errorAt = Date.now()
      health.error = `${model}: ${String(e.message).slice(0, 120)}`
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
