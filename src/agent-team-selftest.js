// Comprehensive self-test for Agent Team Orchestration in Helper.
// Tests the full entry path against mock model interface and real/mock tool runners,
// using the exact same adapter executor and loop that will run in production.
// Run with: node src/agent-team-selftest.js

import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// Isolate test environment
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-agent-team-'))
fs.writeFileSync(path.join(dir, '.env'), 'AGENT_TEAM_ENABLED=true\n')
Object.assign(process.env, {
  HELPER_DATA_DIR: dir,
  HELPER_ENV_FILE: path.join(dir, '.env'),
  HELPER_OFFLINE: '1',
  AGENT_TEAM_ENABLED: 'true',
})

const {
  AgentTeamAdapter,
  BudgetExceededError,
  SecurityViolationError,
  SchemaValidationError,
  validateToolArguments,
  isBlockedForSubagent,
} = await import('./agent-team/adapter.js')
const { AGENT_ROLES } = await import('./agent-team/roles.js')
const {
  AgentTeamOrchestrator,
  tryOrchestrateAgentTeam,
  parseAndValidateVerifierOutput,
  ProcessingError,
} = await import('./agent-team/orchestrator.js')
const { runTurn } = await import('./agent.js')
const { state } = await import('./store.js')
const { Aborted, callExplicitModel, OPENROUTER_ENDPOINT } = await import('./llm.js')
const { config } = await import('./config.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) {
    passed++
    console.log(`ok   ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}`)
  }
}

console.log('--- בדיקות צוות סוכנים בזמן ריצה (Helper Orchestrator) ---\n')

// 1. Simple request stays in normal single-agent path
{
  const simple1 = 'מה השעה?'
  const simple2 = 'היי, בוקר טוב'
  ok(AgentTeamOrchestrator.isEligible(simple1) === false, 'Simple query (מה השעה) not eligible for agent team')
  ok(AgentTeamOrchestrator.isEligible(simple2) === false, 'Greeting not eligible for agent team')
}

// 2b. Context awareness test: past conversation satisfies destination and dates
{
  const query = 'מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות מתל אביב'
  const contextStr = 'ניו יורק נובמבר 2026'
  const missing = AgentTeamOrchestrator.checkFlightMissingParams(query, contextStr)
  ok(missing.length === 0, 'Conversation context successfully satisfies missing destination and date parameters')
}

// 2. Flight request without details: NEVER invent dates, destinations, or airports - ask ONE question
{
  const query = 'מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות'
  ok(AgentTeamOrchestrator.isEligible(query) === true, 'Flight query with constraints is eligible')

  const orchestrator = new AgentTeamOrchestrator()
  const reply = await orchestrator.orchestrate(query, {}, { messageId: 'test_missing_params' })

  ok(typeof reply === 'string', 'Missing params returns text response')
  ok(!reply.includes('2026') && !reply.includes('קיץ') && !reply.includes('ניו יורק'), 'Did not invent year, season, or city')
  ok(reply.includes('שדה תעופה') && reply.includes('עיר יעד') && reply.includes('טווח תאריכים'), 'Asked ONE focused question gathering all missing details')
}

// 3. Schema Validation for Verifier Output (Requirement 3: Malformed output is ProcessingError, NOT "No results")
{
  // A. Malformed JSON
  let malformedCaught = false
  try {
    parseAndValidateVerifierOutput('not valid json at all')
  } catch (e) {
    if (e instanceof ProcessingError) malformedCaught = true
  }
  ok(malformedCaught, 'Malformed JSON throws ProcessingError')

  // B. Missing "approved" field
  let missingApprovedCaught = false
  try {
    parseAndValidateVerifierOutput(JSON.stringify({ disqualified: [] }))
  } catch (e) {
    if (e instanceof ProcessingError && e.message.includes('approved')) missingApprovedCaught = true
  }
  ok(missingApprovedCaught, 'Missing "approved" field throws ProcessingError')

  // C. Missing "disqualified" field
  let missingDisqualifiedCaught = false
  try {
    parseAndValidateVerifierOutput(JSON.stringify({ approved: [] }))
  } catch (e) {
    if (e instanceof ProcessingError && e.message.includes('disqualified')) missingDisqualifiedCaught = true
  }
  ok(missingDisqualifiedCaught, 'Missing "disqualified" field throws ProcessingError')

  // D. Valid schema parses successfully
  const valid = parseAndValidateVerifierOutput(JSON.stringify({
    approved: [{ route: 'TLV -> NYC', price: '$650' }],
    disqualified: [{ route: 'TLV -> LAX', reason: 'קונקשן מעל המותר' }],
  }))
  ok(valid.approved.length === 1 && valid.disqualified.length === 1, 'Valid verifier schema passes validation')
}

// 4. Argument Schema Validation (Requirement 2)
{
  const mockTool = {
    name: 'web_search',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  }

  // A. Valid arguments pass
  ok(validateToolArguments(mockTool, { query: 'טיסות לארהב', limit: 5 }) === true, 'Valid tool arguments pass schema validation')

  // B. Missing required field fails
  let missingReqCaught = false
  try {
    validateToolArguments(mockTool, { limit: 5 })
  } catch (e) {
    if (e instanceof SchemaValidationError && e.message.includes('שדה חובה')) missingReqCaught = true
  }
  ok(missingReqCaught, 'Missing required tool argument caught by schema validation')

  // C. Invalid type fails
  let invalidTypeCaught = false
  try {
    validateToolArguments(mockTool, { query: 12345 })
  } catch (e) {
    if (e instanceof SchemaValidationError && e.message.includes('מחרוזת')) invalidTypeCaught = true
  }
  ok(invalidTypeCaught, 'Invalid argument type (number instead of string) caught by schema validation')
}

// 5. Tool Blocking & Isolation (Requirement 2: Block write tools, approvals, devices, and accounts)
{
  // A. Write tools blocked
  ok(isBlockedForSubagent({ name: 'write_file', risk: 'write' }) === true, 'Write tool (write_file) strictly blocked for subagent')

  // B. Devices & Accounts blocked
  ok(isBlockedForSubagent({ name: 'pc_power', risk: 'high' }) === true, 'Computer tool (pc_power) strictly blocked for subagent')
  ok(isBlockedForSubagent({ name: 'phone_tap', risk: 'low' }) === true, 'Phone tool (phone_tap) strictly blocked for subagent')
  ok(isBlockedForSubagent({ name: 'gmail_send', risk: 'write' }) === true, 'Email tool (gmail_send) strictly blocked for subagent')
  ok(isBlockedForSubagent({ name: 'gmail_read', risk: 'read' }) === true, 'Email read tool (gmail_read) strictly blocked for subagent')
  ok(isBlockedForSubagent({ name: 'google_home_control', risk: 'write' }) === true, 'Smart home tool strictly blocked for subagent')

  // C. Safe read-only test data search tools allowed
  ok(isBlockedForSubagent({ name: 'web_search', risk: 'read' }) === false, 'Safe web search allowed for researcher')
}

// 6. Full Entry Path Test via runTurn (Integrated Entry Point with Flag Active)
{
  config.agentTeam.enabled = true
  state.history = []

  const detailedQuery = 'מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות מתל אביב לניו יורק בין 15.11.2026 ל-30.12.2026 נוסע יחיד'

  let researcherReceivedToolDef = false
  let researcherRequestedToolCall = false
  let mockToolRunnerExecuted = false
  let verifierReceivedToolFindings = false

  const syntheticFlightResults = `[נתוני בדיקה מומצאים / SYNTHETIC TEST DATA]
1. תל אביב (TLV) ➔ ניו יורק (JFK), United Airlines, 15.11.2026 - 30.12.2026 (45 ימים), קונקשן: שעתיים ו-15 דקות, מחיר: $650, מקור: https://test-flights.example/1
2. תל אביב (TLV) ➔ ניו יורק (JFK), Turkish Airlines, 15.11.2026 - 30.12.2026 (45 ימים), קונקשן: 6 שעות ו-30 דקות, מחיר: $520, מקור: https://test-flights.example/2
3. תל אביב (TLV) ➔ מיאמי (MIA), Delta, 15.11.2026 - 29.11.2026 (14 ימים - שבועיים), קונקשן: שעה ו-45 דקות, מחיר: $480, מקור: https://test-flights.example/3`

  const mockToolRunner = async (call, tools, ctx) => {
    if (call.function.name === 'web_search') {
      mockToolRunnerExecuted = true
      return {
        role: 'tool',
        tool_call_id: call.id,
        content: syntheticFlightResults,
      }
    }
    return { role: 'tool', tool_call_id: call.id, content: 'לא נמצא מידע' }
  }

  const mockModelInterface = async (messages, tools, signal) => {
    const isResearcher = messages[0]?.content?.startsWith('אתה תפקיד "חוקר"')
    const isVerifier = messages[0]?.content?.startsWith('אתה תפקיד "בודק"')

    // Step 1: Researcher receives available tool definitions and emits tool_call
    if (isResearcher && !messages.some((m) => m.role === 'tool')) {
      if (Array.isArray(tools) && tools.some((t) => t.function?.name === 'web_search')) {
        researcherReceivedToolDef = true
      }
      researcherRequestedToolCall = true
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_search_1',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'טיסות מתל אביב לניו יורק נובמבר דצמבר 2026' }),
            },
          },
        ],
        usage: { completion_tokens: 45 },
      }
    }

    // Step 2: Researcher receives tool result from runner and returns synthesized findings
    if (isResearcher && messages.some((m) => m.role === 'tool')) {
      return {
        role: 'assistant',
        content: `ממצאי החוקר שנאספו באמצעות web_search:\n${syntheticFlightResults}`,
        usage: { completion_tokens: 120 },
      }
    }

    // Step 3: Verifier receives researcher findings and evaluates constraints
    if (isVerifier) {
      const verifierPrompt = messages.find((m) => m.role === 'user')?.content || ''
      if (verifierPrompt.includes('United Airlines') && verifierPrompt.includes('Turkish Airlines')) {
        verifierReceivedToolFindings = true
      }
      return {
        role: 'assistant',
        content: JSON.stringify({
          approved: [
            {
              route: 'תל אביב (TLV) ➔ ניו יורק (JFK)',
              airline: 'United Airlines',
              dates: '15.11.2026 - 30.12.2026 (45 ימים)',
              layover: 'שעתיים ו-15 דקות',
              price: '$650',
              source: 'https://test-flights.example/1',
            },
          ],
          disqualified: [
            {
              route: 'תל אביב (TLV) ➔ ניו יורק (JFK)',
              airline: 'Turkish Airlines',
              reason: 'קונקשן של 6 שעות ו-30 דקות חורג מהתקרה של 4 שעות שהוגדרה בבקשה',
            },
            {
              route: 'תל אביב (TLV) ➔ מיאמי (MIA)',
              airline: 'Delta',
              reason: 'משך שהייה של 14 ימים אינו תואם את הבקשה לחודש וחצי',
            },
          ],
        }),
        usage: { completion_tokens: 150 },
      }
    }

    return { role: 'assistant', content: 'סיום.', usage: { completion_tokens: 10 } }
  }

  // Invoke via the real system entry point runTurn!
  const reply = await runTurn(detailedQuery, {
    source: 'whatsapp',
    messageId: 'integrated_entry_turn_test',
    modelInterface: mockModelInterface,
    toolRunner: mockToolRunner,
  })

  ok(researcherReceivedToolDef, 'Researcher received available tool definition (web_search) with parameters schema')
  ok(researcherRequestedToolCall, 'Researcher explicitly emitted tool call requesting web_search')
  ok(mockToolRunnerExecuted, 'mockToolRunner executed and returned matching test flight proposals')
  ok(verifierReceivedToolFindings, 'Tool findings successfully delivered to Verifier prompt')
  ok(reply.includes('United Airlines') && reply.includes('$650'), 'Final WhatsApp reply contains approved flight from tool result')
  ok(reply.includes('Turkish Airlines') && reply.includes('חורג מהתקרה של 4 שעות'), 'Final WhatsApp reply contains disqualified flight with layover reason')
  ok(state.history.length === 2 && state.history[1].role === 'assistant', 'Integrated runTurn appended assistant reply to state.history')
}

// 6b. Execution failure test: Researcher fails to execute search / reports inability
// MUST return execution failure ("כשל ביצוע") and MUST NOT offer relaxing constraints!
{
  const testQuery = 'מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026'

  // Model mock where researcher fails / replies with text without executing tools
  const failingResearcherModel = async (messages) => {
    const isResearcher = messages[0]?.content?.startsWith('אתה תפקיד "חוקר"')
    if (isResearcher) {
      return {
        role: 'assistant',
        content: 'אין לי גישה למערכות טיסות חיצוניות ולכן איני יכול לבצע את החיפוש המבוקש בשלב זה.',
        usage: { completion_tokens: 30 },
      }
    }
    return { role: 'assistant', content: '{}', usage: { completion_tokens: 10 } }
  }

  const orchestrator = new AgentTeamOrchestrator({
    model: 'google/gemini-2.5-flash',
    modelInterface: failingResearcherModel,
  })

  const reply = await orchestrator.orchestrate(testQuery, { messageId: 'failure_mode_test_1' })

  ok(reply.includes('כשל בביצוע החיפוש') || reply.includes('כשל באיסוף הנתונים'), 'Researcher failure returned explicit execution failure (כשל ביצוע)')
  ok(!reply.includes('תרצה שנחפש עם הגמשת תנאים'), 'Execution failure strictly omitted suggestion to relax constraints')
}

// 6c. Succeeded search with no matching results:
// All options disqualified against constraints -> MUST offer relaxing constraints
{
  const testQuery = 'מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026'

  const mockToolRunner = async (call) => ({
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify([{ route: 'TLV -> LHR', airline: 'AirX', layover: '4h', price: '$400' }]),
  })

  const searchSucceededAllDisqualifiedModel = async (messages) => {
    const isResearcher = messages[0]?.content?.startsWith('אתה תפקיד "חוקר"')
    const isVerifier = messages[0]?.content?.startsWith('אתה תפקיד "בודק"')

    if (isResearcher && !messages.some((m) => m.role === 'tool')) {
      return {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"flights"}' } }],
      }
    }
    if (isResearcher && messages.some((m) => m.role === 'tool')) {
      return {
        role: 'assistant',
        content: 'נמצאה טיסה אחת של AirX עם עצירה של 4 שעות.',
      }
    }
    if (isVerifier) {
      return {
        role: 'assistant',
        content: JSON.stringify({
          approved: [],
          disqualified: [{ route: 'TLV -> LHR (AirX)', reason: 'קונקשן של 4 שעות חורג מהתקרה של שעתיים' }],
        }),
      }
    }
    return { role: 'assistant', content: '{}' }
  }

  const orchestrator = new AgentTeamOrchestrator({
    model: 'google/gemini-2.5-flash',
    modelInterface: searchSucceededAllDisqualifiedModel,
    toolRunner: mockToolRunner,
  })

  const reply = await orchestrator.orchestrate(testQuery, { messageId: 'disqualified_all_test_1' })

  ok(reply.includes('לא נמצאה אף אפשרות') && reply.includes('שעומדת בכל התנאים'), 'Succeeded search with no matches stated no options met conditions')
  ok(reply.includes('תרצה שנחפש עם הגמשת תנאים'), 'Succeeded search with disqualified candidates offered relaxing constraints')
}

// 7. Timeout during Tool Execution (Requirement 3: Check timeout during tool run)
{
  const adapter = new AgentTeamAdapter()
  const spawned = adapter.spawn(AGENT_ROLES.researcher, { allowedTools: ['web_search'] })
  const ac = new AbortController()

  // Tool runner that hangs until aborted
  adapter.toolRunner = async (call, tools, ctx) => {
    return new Promise((resolve, reject) => {
      ctx.signal?.addEventListener('abort', () => reject(new Aborted()), { once: true })
    })
  }

  adapter.modelInterface = async () => {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'hanging_call_1',
          type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'hang' }) },
        },
      ],
    }
  }

  const promise = adapter.execute(spawned.workerId, { taskId: 'hang_test', prompt: 'test' }, { signal: ac.signal })
  
  // Abort while tool is executing
  setTimeout(() => ac.abort(), 10)

  let toolTimeoutCaught = false
  try {
    await promise
  } catch (e) {
    if (e instanceof Aborted) toolTimeoutCaught = true
  }
  ok(toolTimeoutCaught, 'Timeout / AbortSignal during tool execution immediately halts and throws Aborted')
}

// 8. Cost Ceiling Enforcement (Pre-call ceiling blocks network access)
{
  let networkAttempted = false
  // Spy modelInterface simulating external network endpoint
  const spyNetworkModel = async () => {
    networkAttempted = true
    throw new Error('NETWORK_VIOLATION: Call reached network endpoint instead of being blocked pre-call!')
  }

  // Adapter configured with strict cost ceiling ($0.0001 USD), below minimum projected cost of any call (~$0.0006)
  const lowCostAdapter = new AgentTeamAdapter({
    model: 'gemini-2.5-flash',
    maxCostPerRequestUsd: 0.0001,
    modelInterface: spyNetworkModel,
  })
  const w = lowCostAdapter.spawn(AGENT_ROLES.researcher)

  let costCeilingBlocked = false
  try {
    await lowCostAdapter.execute(w.workerId, { taskId: 'cost_test', prompt: 'הודעה לבדיקת חסימת יציאה לרשת' })
  } catch (e) {
    if (e instanceof BudgetExceededError && e.message.includes('תקרת העלות')) {
      costCeilingBlocked = true
    }
  }
  ok(costCeilingBlocked, 'Exceeding dollar cost ceiling throws BudgetExceededError before dispatch')
  ok(!networkAttempted, 'Pre-call ceiling strictly blocked invocation BEFORE going out to network')
  ok(lowCostAdapter.callCount === 0, 'No call count incremented because request was rejected at pre-call gate')
}

// 8b. Thinking tokens accounted for in output budget and cost (Direct Gemini 2.5 Flash pricing)
{
  const thinkingModelMock = async () => ({
    role: 'assistant',
    content: 'תוצאה',
    usage: {
      prompt_tokens: 200,
      completion_tokens: 350,
      completion_tokens_details: {
        reasoning_tokens: 250, // 250 thinking tokens + 100 output text tokens
      },
    },
  })

  const thinkingAdapter = new AgentTeamAdapter({
    model: 'gemini-2.5-flash',
    maxCostPerRequestUsd: 0.03,
    modelInterface: thinkingModelMock,
  })
  const w = thinkingAdapter.spawn(AGENT_ROLES.researcher)
  await thinkingAdapter.execute(w.workerId, { taskId: 'think_test', prompt: 'test' })

  ok(thinkingAdapter.cumulativeOutputTokens === 350, 'Thinking tokens (reasoning_tokens) fully counted in output tokens (350)')
  // Direct Gemini 2.5 Flash pricing: (200 * 0.30 + 350 * 2.50) / 1,000,000 = (60 + 875) / 1,000,000 = 0.000935 USD
  const expectedCost = (200 * 0.30 + 350 * 2.50) / 1000000
  ok(Math.abs(thinkingAdapter.cumulativeCostUsd - expectedCost) < 0.000001, 'Cumulative cost accurately billed thinking tokens at direct output rate ($2.50/1M)')
}

// 8c. Mock fetch on callExplicitModel (strictly matches OpenRouter endpoint and google/gemini-2.5-flash; zero keys or headers)
{
  let attempts = 0
  let capturedInspection = null
  const mockFetch = async (url, options) => {
    attempts++
    const parsedBody = JSON.parse(options.body || '{}')
    // Capture strictly URL, model, maxOutputTokens, and attempt count. Zero keys or headers logged!
    capturedInspection = {
      targetUrl: url,
      model: parsedBody.model,
      maxOutputTokens: parsedBody.max_completion_tokens,
      attempts,
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'תשובת ניסוי מדומה דרך OpenRouter' } }],
        usage: { prompt_tokens: 120, completion_tokens: 60 },
      }),
    }
  }

  const testKey = 'mock-openrouter-key'
  await callExplicitModel({
    model: 'google/gemini-2.5-flash',
    messages: [{ role: 'user', content: 'ניסוי מבודד' }],
    maxOutputTokens: 1000,
    fetchFn: mockFetch,
    apiKey: testKey,
  })

  const EXACT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
  ok(capturedInspection.targetUrl === EXACT_OPENROUTER_URL, `Target URL strictly matches exact OpenRouter endpoint: ${EXACT_OPENROUTER_URL}`)
  ok(!capturedInspection.targetUrl.includes('key='), 'Target URL does NOT contain any API key')
  ok(capturedInspection.model === 'google/gemini-2.5-flash', 'Model identifier is strictly google/gemini-2.5-flash')
  ok(capturedInspection.maxOutputTokens === 1000, 'Output limit sent to provider is exactly 1000 tokens')
  ok(capturedInspection.attempts === 1, 'Number of fetch attempts is strictly 1')
  console.log(`   [mock-fetch verified] target: ${capturedInspection.targetUrl}, model: ${capturedInspection.model}, maxOutputTokens: ${capturedInspection.maxOutputTokens}, attempts: ${capturedInspection.attempts}`)
}

// 8d. Strictly ONE attempt even when a different model and fallback lineup are configured in the regular path
{
  const originalModel = config.llm.model
  const originalFallbacks = config.llm.fallbackModels

  // Configure a different model and fallbacks for regular path (e.g. claude-3-5-haiku)
  config.llm.model = 'anthropic/claude-3-5-haiku'
  config.llm.fallbackModels = ['backup-model-alpha', 'backup-model-beta']

  let failAttempts = 0
  const modelsSeen = []
  const failingMockFetch = async (url, options) => {
    failAttempts++
    const parsed = JSON.parse(options.body || '{}')
    modelsSeen.push(parsed.model)
    return {
      ok: false,
      status: 500,
      text: async () => 'Provider 500 error',
    }
  }

  let errorCaught = false
  try {
    await callExplicitModel({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'בדיקת עמידות לכשל' }],
      maxOutputTokens: 1000,
      fetchFn: failingMockFetch,
      apiKey: 'mock-openrouter-key',
    })
  } catch (e) {
    if (e.message.includes('LLM HTTP 500')) errorCaught = true
  }

  // Restore regular configuration
  config.llm.model = originalModel
  config.llm.fallbackModels = originalFallbacks

  ok(errorCaught, 'callExplicitModel immediately threw on HTTP error without retrying')
  ok(failAttempts === 1, 'Strictly 1 attempt executed (no retry loop)')
  ok(modelsSeen.length === 1 && modelsSeen[0] === 'google/gemini-2.5-flash', 'Did NOT fall back to regular model or fallback models')
}

// 8e. Rejection of unauthorized provider URL before network dispatch
{
  let networkHit = false
  const spyFetch = async () => {
    networkHit = true
    throw new Error('NETWORK_HIT: fetch was called with unauthorized URL!')
  }

  let urlRejected = false
  try {
    await callExplicitModel({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'test' }],
      endpointUrl: 'https://api.openai.com/v1/chat/completions', // Wrong provider URL
      fetchFn: spyFetch,
      apiKey: 'mock-key',
    })
  } catch (e) {
    if (e.message.includes('כתובת ספק לא מורשית למסלול OpenRouter')) urlRejected = true
  }

  ok(urlRejected, 'Explicit route strictly rejected non-OpenRouter provider URL before dispatch')
  ok(!networkHit, 'Zero network calls made when provider URL was invalid')
}

// 8f. Missing OpenRouter authorization returns clear error without network dispatch
{
  let networkHit = false
  const spyFetch = async () => {
    networkHit = true
    throw new Error('NETWORK_HIT: fetch was called despite missing key!')
  }

  let missingKeyError = false
  try {
    await callExplicitModel({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'test' }],
      apiKey: '', // Missing key
      fetchFn: spyFetch,
    })
  } catch (e) {
    if (e.message.includes('חסר מפתח LLM_API_KEY / OPENROUTER_API_KEY')) missingKeyError = true
  }

  ok(missingKeyError, 'Missing authorization threw clear error (חסר מפתח LLM_API_KEY / OPENROUTER_API_KEY)')
  ok(!networkHit, 'Zero network calls made when key was missing')
}

// 8g. Regular path provider remains completely untouched
{
  ok(config.llm.baseUrl === (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''), 'Regular path baseUrl untouched')
  ok(config.llm.model === (process.env.LLM_MODEL || ''), 'Regular path model untouched')
}

// 9. Dynamic constraints test: London 2 weeks with layover up to 2 hours
{
  const customQuery = 'מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026'

  let promptReceivedByVerifier = ''
  const dynamicVerifierModel = async (messages) => {
    const isVerifier = messages[0]?.content?.startsWith('אתה תפקיד "בודק"')
    if (isVerifier) {
      promptReceivedByVerifier = messages.find((m) => m.role === 'user')?.content || ''
      return {
        role: 'assistant',
        content: JSON.stringify({
          approved: [{ route: 'TLV -> LHR', price: '$350', layover: 'שעה ו-15 דקות', dates: '14 ימים' }],
          disqualified: [{ route: 'TLV -> LGW', reason: 'קונקשן של שעתיים וחצי חורג מהגבלת השעתיים שהוגדרה' }],
        }),
      }
    }
    return { role: 'assistant', content: 'ממצאי חוקר: נמצאו טיסות מתל אביב ללונדון עם עצירות שונות.' }
  }

  const orchestrator = new AgentTeamOrchestrator({
    modelInterface: dynamicVerifierModel,
    toolRunner: async () => ({ role: 'tool', tool_call_id: '1', content: 'ok' }),
  })

  const customResult = await orchestrator.orchestrate(customQuery, { messageId: 'msg_custom_constraints' })
  ok(promptReceivedByVerifier.includes('מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים'), 'Verifier received actual custom user constraints in prompt')
  ok(!promptReceivedByVerifier.includes('4 שעות לכל היותר') && !promptReceivedByVerifier.includes('45 יום'), 'Verifier prompt does NOT contain hardcoded 4h or 45d')
  ok(customResult.includes('TLV -> LHR') && customResult.includes('שעתיים וחצי חורג מהגבלת השעתיים'), 'Evaluated dynamically against custom 2h constraint')
}

// 10. Deduplication: Stable messageId prevents double execution
{
  let invocations = 0
  const model = async (messages) => {
    invocations++
    return {
      role: 'assistant',
      content: JSON.stringify({ approved: [{ route: 'TLV -> NYC', price: '$500' }], disqualified: [] }),
    }
  }

  const orchestrator = new AgentTeamOrchestrator({
    modelInterface: model,
    toolRunner: async () => ({ role: 'tool', tool_call_id: '1', content: 'ok' }),
  })

  const query = 'מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות מתל אביב לניו יורק 15.11.2026 עד 30.12.2026'
  const r1 = await orchestrator.orchestrate(query, { messageId: 'stable_msg_id_200' })
  const r2 = await orchestrator.orchestrate(query, { messageId: 'stable_msg_id_200' })

  ok(r1 === r2, 'Duplicate message delivery returns cached result')
  ok(invocations === 2, 'Model interface was only invoked once per worker, not doubled on duplicate message')
}

// 11. Feature Flag Off: When AGENT_TEAM_ENABLED=false, orchestrator returns null
{
  config.agentTeam.enabled = false
  const res = await tryOrchestrateAgentTeam('מצא טיסה זולה לארה״ב לחודש וחצי, קונקשן עד 4 שעות')
  ok(res === null, 'When feature flag is false, tryOrchestrateAgentTeam returns null (falls back to single-agent turn)')
  config.agentTeam.enabled = true
}

// 12. Full-flow mock fetch test: verifies all messages are valid objects and tool responses are properly associated before each dispatch
{
  let dispatchCount = 0
  const recordedDispatches = []

  const mockFullFlowFetch = async (url, options) => {
    dispatchCount++
    const body = JSON.parse(options.body)
    recordedDispatches.push({ url, body })

    // VALIDATION 1: Before sending, every single item in messages MUST be a valid object (never string or array)
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i]
      assert(
        typeof m === 'object' && m !== null && !Array.isArray(m),
        `Message at index ${i} must be a valid object, got: ${typeof m}`
      )
      assert(
        typeof m.role === 'string' && m.role.length > 0,
        `Message at index ${i} must have a non-empty string role`
      )
    }

    // VALIDATION 2: Every tool message MUST have a matching tool_call_id from a previous assistant message
    const precedingToolCallIds = new Set()
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i]
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.id) precedingToolCallIds.add(tc.id)
        }
      }
      if (m.role === 'tool') {
        assert(
          typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0,
          `Tool message at index ${i} must have valid string tool_call_id`
        )
        assert(
          typeof m.content === 'string',
          `Tool message at index ${i} must have string content, got: ${typeof m.content}`
        )
        assert(
          precedingToolCallIds.has(m.tool_call_id),
          `Tool message at index ${i} has unmatched tool_call_id "${m.tool_call_id}"`
        )
      }
    }

    // Simulate model provider response for each step:
    if (dispatchCount === 1) {
      // Step 1: Researcher emits tool call
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_search_mock_123',
                    type: 'function',
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ query: 'טיסות ללונדון יוני 2026' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 35 },
        }),
      }
    }

    if (dispatchCount === 2) {
      // Step 2: Researcher summarizes findings after receiving tool message
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: `ממצאי טיסות מתל אביב ללונדון:\n1. British Airways: TLV -> LHR, 01.06.2026-15.06.2026, קונקשן שעה ו-20 דקות, $410\n2. easyJet: TLV -> LGW, 01.06.2026-15.06.2026, קונקשן 3 שעות ו-40 דקות, $320\n3. Wizz Air: TLV -> LTN, 01.06.2026-22.06.2026 (21 יום), קונקשן שעה, $290`,
              },
            },
          ],
          usage: { prompt_tokens: 280, completion_tokens: 75 },
        }),
      }
    }

    if (dispatchCount === 3) {
      // Step 3: Verifier receives researcher findings and validates constraints
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  approved: [
                    {
                      route: 'TLV -> LHR (בריטיש איירווייז)',
                      airline: 'British Airways',
                      dates: '01.06.2026 - 15.06.2026',
                      layover: 'שעה ו-20 דקות',
                      price: '$410',
                      source: 'סינתטי לבדיקה בלבד',
                    },
                  ],
                  disqualified: [
                    {
                      route: 'TLV -> LGW (איזיג׳ט)',
                      airline: 'easyJet',
                      reason: 'עצירת ביניים של 3 שעות ו-40 דקות חורגת מהגבלת השעתיים',
                    },
                    {
                      route: 'TLV -> LTN (וויז אייר)',
                      airline: 'Wizz Air',
                      reason: 'משך שהייה של 21 יום חורג משבועיים',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 320, completion_tokens: 110 },
        }),
      }
    }

    throw new Error(`Unexpected dispatch call count: ${dispatchCount}`)
  }

  // Safe mock tool runner matching real runCall contract:
  // returns { role: 'tool', tool_call_id: call.id, content: string }
  let mockToolRunnerCalled = false
  const mockToolRunner = async (call) => {
    mockToolRunnerCalled = true
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({
        status: 'success',
        results: [
          { flight: 'BA1', layover: '1h20m', price: 410 },
          { flight: 'U22', layover: '3h40m', price: 320 },
        ],
      }),
    }
  }

  const query = 'מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026'
  const orchestrator = new AgentTeamOrchestrator({
    fetchFn: mockFullFlowFetch,
    toolRunner: mockToolRunner,
    apiKey: 'mock-openrouter-key',
  })

  const finalReply = await orchestrator.orchestrate(query, { messageId: 'msg_full_flow_mock_fetch' })

  ok(dispatchCount === 3, `Full flow completed exactly 3 dispatches through mock fetch (actual: ${dispatchCount})`)
  ok(mockToolRunnerCalled, 'mockToolRunner executed and supplied tool output')
  
  // Verify dispatch 2 had valid messages array containing matching tool message
  const dispatch2Messages = recordedDispatches[1].body.messages
  ok(dispatch2Messages.length === 4, `Dispatch 2 contains 4 messages: system, user, assistant, tool (actual: ${dispatch2Messages.length})`)
  ok(typeof dispatch2Messages[3] === 'object' && dispatch2Messages[3].role === 'tool', 'Dispatch 2 tool message is a valid object')
  ok(dispatch2Messages[3].tool_call_id === 'call_search_mock_123', 'Tool message tool_call_id exactly matches emitted call.id')
  ok(typeof dispatch2Messages[3].content === 'string', 'Tool message content is a string')
  
  // Verify adapter did NOT wrap tool message twice
  ok(!dispatch2Messages[3].content.includes('"role":"tool"'), 'Tool message was not wrapped twice')

  // Verify Verifier received findings in dispatch 3
  const dispatch3Messages = recordedDispatches[2].body.messages
  ok(dispatch3Messages.some((m) => m.content.includes('British Airways') && m.content.includes('easyJet')), 'Verifier prompt received researcher findings')

  // Verify final synthesized WhatsApp response reached end-of-pipe
  ok(finalReply.includes('British Airways') && finalReply.includes('$410'), 'Final reply includes approved flight with price')
  ok(finalReply.includes('easyJet') && finalReply.includes('חורגת מהגבלת השעתיים'), 'Final reply includes disqualified flight with layover reason')
  ok(finalReply.includes('Wizz Air') && finalReply.includes('חורג משבועיים'), 'Final reply includes disqualified flight with duration reason')
}

// 12b. Adapter resilience: if a toolRunner returns a string, adapter safely wraps without double wrapping
{
  let caughtDispatchMessages = null
  const mockFetchCapture = async (url, options) => {
    const body = JSON.parse(options.body)
    const isVerifier = body.messages.some((m) => typeof m.content === 'string' && m.content.includes('בודק ספקני'))
    if (isVerifier) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ approved: [], disqualified: [] }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }),
      }
    }
    if (body.messages.some((m) => m.role === 'tool')) {
      caughtDispatchMessages = body.messages
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'סיום סיכום ממצאים' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'tc_str_99', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 15 },
      }),
    }
  }

  // Legacy runner returning raw string
  const stringReturningRunner = async (call) => 'raw string tool output'

  const orchestrator = new AgentTeamOrchestrator({
    fetchFn: mockFetchCapture,
    toolRunner: stringReturningRunner,
    apiKey: 'mock-openrouter-key',
  })

  await orchestrator.orchestrate('מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026', {
    messageId: 'msg_resilience_test',
  })

  ok(caughtDispatchMessages !== null, 'Captured dispatch messages after string toolRunner')
  const toolMsg = caughtDispatchMessages.find((m) => m.role === 'tool')
  ok(typeof toolMsg === 'object' && toolMsg !== null, 'Adapter converted string to valid tool message object')
  ok(toolMsg.tool_call_id === 'tc_str_99', 'Adapter attached matching tool_call_id to string runner output')
  ok(toolMsg.content === 'raw string tool output', 'Adapter preserved string content without double wrapping')
}

console.log('skip live model test (requires explicit user confirmation of provider, synthetic data, and numerical cost ceiling)')

console.log(`\nסיכום בדיקות: ${passed} עברו, ${failed} נכשלו`)
fs.rmSync(dir, { recursive: true, force: true })

if (failed > 0) process.exit(1)
console.log('כל הבדיקות של צוות הסוכנים עברו בהצלחה! ✔')
process.exit(0)
