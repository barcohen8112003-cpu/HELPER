// Offline stand-ins for Google and GitHub, for the self-tests. Nothing here talks to a network: `fetch` is replaced by
// a router that answers from handlers the test gives, and records every request so a test can prove what was (and
// was not) sent. An unmatched request fails loudly, so a code path that reaches a real service is a failing test.

// routes: [[method, regex on the URL, (req) => ({ status, json, text })]], tried in order.
// scopes: what the fake token endpoint says the key grants (space-separated, like Google).
export function fakeFetch({ routes = [], scopes = '' } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method || 'GET').toUpperCase()
    let body = init.body
    if (body instanceof URLSearchParams) body = body.toString()
    else if (Buffer.isBuffer(body)) body = body.toString('utf8')
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    const req = { url: u, method, headers, body, json: () => JSON.parse(body || '{}') }
    calls.push(req)
    if (/oauth2\.googleapis\.com\/token/.test(u)) return respond({ status: 200, json: { access_token: 'ya29.fake-access-token-for-tests', expires_in: 3600, scope: typeof scopes === 'function' ? scopes() : scopes } })
    for (const [m, re, handler] of routes) {
      if (m !== method && m !== '*') continue
      const match = u.match(re)
      if (!match) continue
      const out = await handler({ ...req, match })
      if (out instanceof Error) throw out
      return respond(out)
    }
    throw new Error(`fake: no route for ${method} ${u}`)
  }
  // Requests that reached a service, without the token exchange.
  const sent = () => calls.filter((c) => !/oauth2\.googleapis\.com\/token/.test(c.url))
  const writes = () => sent().filter((c) => c.method !== 'GET')
  return { fetch, calls, sent, writes }
}

function respond({ status = 200, json, text, headers = {} } = {}) {
  const body = json !== undefined ? JSON.stringify(json) : text ?? ''
  return new Response(status === 204 || status === 304 ? null : body, { status, headers: { 'content-type': json !== undefined ? 'application/json' : 'text/plain', ...headers } })
}

export const googleError = (status, reason, message = reason) => ({ status, json: { error: { code: status, message, errors: [{ reason }], status: reason } } })

export function makeChecker() {
  let passed = 0
  let failed = 0
  const ok = (cond, name) => {
    if (cond) passed++
    else {
      failed++
      console.log(`FAIL  ${name}`)
    }
  }
  const done = (label) => {
    console.log(failed ? `\n${failed} נכשלו, ${passed} עברו (${label})` : `\nכל ${passed} הבדיקות עברו (${label})`)
    process.exit(failed ? 1 : 0)
  }
  return { ok, done }
}

// A ctx whose confirm records each question and answers from `answers` (default: no).
export function askingCtx(answers = [], extra = {}) {
  const asked = []
  const queue = [...answers]
  return {
    asked,
    ctx: { source: 'whatsapp', confirm: async (q) => (asked.push(q), queue.length ? queue.shift() : false), say: async () => {}, sendMedia: async () => {}, ...extra },
  }
}

// A scripted model for end-to-end checks through the real agent loop (src/agent.js runTurn): the first request gets
// the given tool calls, every later one a plain answer. Requests to other hosts go to `fallback` (a fakeFetch).
export function scriptedModel(config, fallback) {
  Object.assign(config.llm, { apiKey: 'test-key', model: 'fake-model', fallbackModels: [], cheapModel: '', baseUrl: 'http://fake.invalid', backup: { apiKey: '', model: '' }, light: false })
  config.memoryLearn = false
  const s = { requests: [], next: null }
  let id = 1
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://fake.invalid')) return fallback(url, init)
    s.requests.push(JSON.parse(init.body))
    const message = s.next ? { role: 'assistant', content: '', tool_calls: s.next.map(([name, args]) => ({ id: `c${id++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { role: 'assistant', content: 'סיימתי.' }
    s.next = null
    return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message }] }) }
  }
  // The tool results the model was given in the last turn.
  s.toolResults = () => (s.requests.at(-1)?.messages || []).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''))
  return s
}
