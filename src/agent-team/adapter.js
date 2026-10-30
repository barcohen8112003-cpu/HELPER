// Adapter for subagent lifecycle and execution in Helper.
// Bridges Ruflo / @claude-flow/cli orchestration semantics (spawn, execute, terminate)
// while strictly enforcing Helper's permission boundaries, tool gating, and resource limits.
//
// Key Architectural Resolution:
// We connect subagents directly to Helper's existing LLM interface (`llm` from src/llm.js)
// and Helper's real tool dispatcher (`runCall` from src/agent.js) rather than Ruflo's raw
// agent_execute, because Ruflo v3 lacks an interface to Helper's internal tool registry and approval gates.
//
// Features & Guarantees:
// 1. Explicit Model & Provider (NO Fallback Lineup): Fixed model with strict per-call output limits and bounded attempts.
// 2. Pre-Call Ceilings: Verifies input tokens, call count, and numerical dollar cost ceiling BEFORE dispatching.
// 3. Strict Tool Isolation: Blocks ALL write tools, approval-requiring tools, and device/account access for subagents.
// 4. Schema-level Argument Validation: Validates parsed arguments against tool.parameters schema (not just JSON.parse).
// 5. AbortSignal pass-through: "עצור" halts both in-flight model calls and running tool operations immediately.

import { callExplicitModel, Aborted } from '../llm.js'
import { runCall, needsApproval } from '../agent.js'
import { activeTools, toolDefs } from '../tools.js'

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export class SecurityViolationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecurityViolationError'
  }
}

export class SchemaValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemaValidationError'
  }
}

// Verified pricing table (USD per 1,000,000 tokens)
// Direct Google AI Studio / Gemini API pricing for Gemini 2.5 Flash:
// $0.30 per 1M input tokens, $2.50 per 1M output tokens (including thinking tokens)
// Verified pricing table (USD per 1,000,000 tokens)
// OpenRouter official pricing for google/gemini-2.5-flash:
// $0.30 per 1M input tokens, $2.50 per 1M output tokens (including thinking tokens)
export const MODEL_PRICING = {
  'google/gemini-2.5-flash': { inputPer1M: 0.30, outputPer1M: 2.50 },
  'gemini-2.5-flash': { inputPer1M: 0.30, outputPer1M: 2.50 },
  'google/gemini-2.0-flash-001': { inputPer1M: 0.10, outputPer1M: 0.40 },
  'claude-3-5-haiku': { inputPer1M: 0.80, outputPer1M: 4.00 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  default: { inputPer1M: 0.30, outputPer1M: 2.50 },
}

// Validates tool arguments against the tool's JSON schema
export function validateToolArguments(tool, args) {
  if (!tool || !tool.parameters) return true
  const schema = tool.parameters

  if (schema.type === 'object') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new SchemaValidationError(`הארגומנטים לכלי ${tool.name} חייבים להיות אובייקט JSON.`)
    }

    // Required fields check
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (args[req] === undefined || args[req] === null || (typeof args[req] === 'string' && args[req].trim() === '')) {
          throw new SchemaValidationError(`חסר שדה חובה "${req}" עבור הכלי ${tool.name}.`)
        }
      }
    }

    // Property types check
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, val] of Object.entries(args)) {
        const propSchema = schema.properties[key]
        if (!propSchema) continue

        if (propSchema.type === 'string' && typeof val !== 'string') {
          throw new SchemaValidationError(`שדה "${key}" בכלי ${tool.name} חייב להיות מחרוזת (string), התקבל: ${typeof val}.`)
        }
        if (propSchema.type === 'number' && (typeof val !== 'number' || isNaN(val))) {
          throw new SchemaValidationError(`שדה "${key}" בכלי ${tool.name} חייב להיות מספר (number), התקבל: ${typeof val}.`)
        }
        if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
          throw new SchemaValidationError(`שדה "${key}" בכלי ${tool.name} חייב להיות בוליאני (boolean), התקבל: ${typeof val}.`)
        }
        if (propSchema.type === 'array' && !Array.isArray(val)) {
          throw new SchemaValidationError(`שדה "${key}" בכלי ${tool.name} חייב להיות מערך (array), התקבל: ${typeof val}.`)
        }
        if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
          throw new SchemaValidationError(`ערך לא חוקי "${val}" עבור "${key}" בכלי ${tool.name}. ערכים מותרים: ${propSchema.enum.join(', ')}.`)
        }
      }
    }
  }

  return true
}

// Determines whether a tool is completely blocked for subagents
export function isBlockedForSubagent(tool) {
  if (!tool) return true

  // 1. Write tools or tools requiring user confirmation
  if (tool.risk === 'write') return true
  if (typeof needsApproval === 'function' && needsApproval(tool)) return true

  // 2. Sensitive accounts, devices, communication tools, and local execution
  const SENSITIVE_PREFIXES = [
    'pc_', 'phone_', 'tv_', 'google_home_', 'gmail_', 'drive_', 'docs_',
    'tasks_', 'calendar_', 'vm_', 'send_whatsapp', 'send_discord', 'call_me',
  ]
  if (SENSITIVE_PREFIXES.some((p) => tool.name.startsWith(p))) return true

  const SENSITIVE_EXACT = new Set([
    'run_command', 'write_file', 'read_file', 'wake_pc', 'use_computer',
    'run_on_phone', 'run_errand', 'check_mail', 'get_calendar', 'classroom_assignments',
  ])
  if (SENSITIVE_EXACT.has(tool.name)) return true

  return false
}

export class AgentTeamAdapter {
  constructor(options = {}) {
    this.maxWorkers = options.maxWorkers ?? 2
    this.maxCalls = options.maxCalls ?? 4
    this.maxInputTokens = options.maxInputTokens ?? 12000
    this.maxOutputTokens = options.maxOutputTokens ?? 4000
    this.defaultTimeoutMs = options.timeoutMs ?? 90000

    // Explicit model configuration (NO fallback)
    this.model = options.model || 'google/gemini-2.5-flash'
    this.provider = options.provider || 'openrouter'
    this.maxOutputTokensPerCall = options.maxOutputTokensPerCall ?? 1000
    this.maxAttemptsPerCall = options.maxAttemptsPerCall ?? 1
    this.maxCostPerRequestUsd = options.maxCostPerRequestUsd ?? 0.03 // $0.03 limit per request
    this.fetchFn = options.fetchFn || fetch
    this.apiKey = options.apiKey

    // Concrete interfaces stored in constructor and passed from entry point
    this.modelInterface = options.modelInterface || this.defaultModelInterface.bind(this)
    this.toolRunner = options.toolRunner || defaultToolRunner
    this.executor = options.executor || this.defaultLlmExecutor.bind(this)

    // State tracking per request/session
    this.workers = new Map() // workerId -> { id, role, config, status, ac }
    this.callCount = 0
    this.cumulativeInputTokens = 0
    this.cumulativeOutputTokens = 0
    this.cumulativeCostUsd = 0
    this.events = [] // audit trail of orchestration events
  }

  logEvent(type, payload) {
    this.events.push({
      timestamp: Date.now(),
      type,
      payload,
    })
  }

  // Explicit model caller: single explicit model, maxAttempts=1, NO fallback lineup
  async defaultModelInterface(messages, tools, signal) {
    return await callExplicitModel({
      model: this.model,
      messages,
      tools,
      maxOutputTokens: this.maxOutputTokensPerCall,
      signal,
      fetchFn: this.fetchFn,
      apiKey: this.apiKey,
    })
  }

  // Ruflo-compatible agent_spawn lifecycle
  spawn(roleSpec, options = {}) {
    if (this.workers.size >= this.maxWorkers) {
      throw new BudgetExceededError(`חרגת ממספר העובדים המרבי (${this.maxWorkers}). לא ניתן לפתוח עובד נוסף.`)
    }

    const workerId = `worker_${roleSpec.name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const ac = new AbortController()

    const workerRecord = {
      id: workerId,
      role: roleSpec.name,
      title: roleSpec.title,
      systemPrompt: roleSpec.systemPrompt,
      allowedTools: new Set(options.allowedTools || []),
      readOnlyOnly: true, // V1 restriction: strictly read-only
      status: 'ready',
      ac,
    }

    this.workers.set(workerId, workerRecord)
    this.logEvent('agent_spawn', { workerId, role: roleSpec.name, allowedTools: Array.from(workerRecord.allowedTools) })
    return { workerId, role: roleSpec.name, status: 'ready' }
  }

  // Pre-call ceilings check (Tokens, Calls, and Cost)
  checkPreCallLimits(messages, worker) {
    // 1. Call count limit
    if (this.callCount >= this.maxCalls) {
      throw new BudgetExceededError(`הגעת למגבלת קריאות המודל (${this.maxCalls}) לתזמור הבקשה הזו.`)
    }

    // 2. Input token budget estimation
    let totalChars = worker.systemPrompt ? worker.systemPrompt.length : 0
    for (const m of messages) {
      if (typeof m.content === 'string') totalChars += m.content.length
      if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length
    }
    const estimatedInputTokens = Math.ceil(totalChars / 3.5)

    if (this.cumulativeInputTokens + estimatedInputTokens > this.maxInputTokens) {
      throw new BudgetExceededError(`חריגה ממגבלת טוקני הקלט (${this.maxInputTokens}). אומדן: ${this.cumulativeInputTokens + estimatedInputTokens}.`)
    }

    // 3. Dollar cost ceiling check before dispatch
    const pricing = MODEL_PRICING[this.model] || MODEL_PRICING.default
    const estimatedCallCost = (estimatedInputTokens * pricing.inputPer1M + this.maxOutputTokensPerCall * pricing.outputPer1M) / 1000000

    if (this.cumulativeCostUsd + estimatedCallCost > this.maxCostPerRequestUsd) {
      throw new BudgetExceededError(`חריגה מתקרת העלות המאושרת לבקשה ($${this.maxCostPerRequestUsd}). עלות מצטברת צפויה: $${(this.cumulativeCostUsd + estimatedCallCost).toFixed(4)}.`)
    }

    return { estimatedInputTokens, estimatedCallCost }
  }

  // Tool validation gate: ensures subagent only calls authorized read-only tools without accounts/devices
  validateToolCall(workerId, toolName) {
    const worker = this.workers.get(workerId)
    if (!worker) throw new Error(`Worker ${workerId} לא זוהה.`)

    if (!worker.allowedTools.has(toolName)) {
      this.logEvent('tool_access_blocked', { workerId, toolName, reason: 'unauthorized_tool' })
      throw new SecurityViolationError(`העובד (${worker.role}) ניסה להפעיל כלי שלא הורשה למשימה: ${toolName}. הגישה נחסמה.`)
    }

    // Check global subagent tool restrictions
    const allRegistered = activeTools()
    const tool = allRegistered.find((t) => t.name === toolName)
    if (tool && isBlockedForSubagent(tool)) {
      this.logEvent('tool_access_blocked', { workerId, toolName, reason: 'blocked_sensitive_or_write_tool' })
      throw new SecurityViolationError(`הכלי ${toolName} חסום לעובדי משנה (כלי כתיבה, דורש אישור, או ניגש לחשבונות ומכשירים).`)
    }

    return true
  }

  // Ruflo-compatible agent_execute lifecycle
  async execute(workerId, task, options = {}) {
    const worker = this.workers.get(workerId)
    if (!worker) {
      throw new Error(`Worker ${workerId} לא נמצא.`)
    }
    if (worker.status === 'terminated') {
      throw new Error(`Worker ${workerId} כבר בוטל/הסתיים.`)
    }

    worker.status = 'active'
    const signal = options.signal
      ? AbortSignal.any([options.signal, worker.ac.signal])
      : worker.ac.signal

    if (signal.aborted) {
      worker.status = 'terminated'
      throw new Aborted()
    }

    this.logEvent('agent_execute_start', {
      workerId,
      role: worker.role,
      taskId: task.taskId,
    })

    try {
      const result = await this.executor({
        worker,
        task,
        signal,
        adapter: this,
        ctx: options.ctx || {},
      })

      if (signal.aborted) throw new Aborted()

      worker.status = 'idle'
      this.logEvent('agent_execute_end', {
        workerId,
        role: worker.role,
        taskId: task.taskId,
        tokens: result.tokens,
        status: 'completed',
      })

      return {
        workerId,
        role: worker.role,
        output: result.content,
        data: result.data || null,
        tokens: result.tokens,
        toolCallsCount: result.toolCallsCount || 0,
      }
    } catch (e) {
      worker.status = 'failed'
      this.logEvent('agent_execute_error', { workerId, role: worker.role, error: e.message })
      throw e
    }
  }

  // The concrete LLM + Tool Call execution loop
  async defaultLlmExecutor({ worker, task, signal, ctx }) {
    const messages = [
      { role: 'system', content: worker.systemPrompt },
      { role: 'user', content: task.prompt },
    ]

    // Resolve authorized read-only tools for this worker from Helper's tool registry
    const allRegistered = activeTools()
    const availableTools = allRegistered.filter((t) => worker.allowedTools.has(t.name) && !isBlockedForSubagent(t))
    const defs = toolDefs(availableTools)

    const MAX_STEPS = 4
    let stepOutputTokens = 0
    let totalToolCallsExecuted = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Aborted()

      // 1. Pre-call ceilings check (tokens, call count, cost)
      const { estimatedInputTokens, estimatedCallCost } = this.checkPreCallLimits(messages, worker)
      this.callCount++
      this.cumulativeInputTokens += estimatedInputTokens

      // 2. Model call with bounded attempts and explicit model
      let assistantMsg
      let attempt = 0
      while (attempt < this.maxAttemptsPerCall) {
        attempt++
        try {
          assistantMsg = await this.modelInterface(messages, defs.length ? defs : null, signal)
          break
        } catch (callErr) {
          if (signal?.aborted || callErr instanceof Aborted) throw new Aborted()
          if (attempt >= this.maxAttemptsPerCall) throw callErr
        }
      }

      if (signal?.aborted) throw new Aborted()

      // Extract output tokens (including thinking/reasoning tokens)
      let outTokens = 0
      if (assistantMsg.usage?.candidatesTokenCount || assistantMsg.usage?.thoughtsTokenCount) {
        // Google Gemini native usage format
        const candidates = Number(assistantMsg.usage.candidatesTokenCount) || 0
        const thoughts = Number(assistantMsg.usage.thoughtsTokenCount) || 0
        outTokens = candidates + thoughts
      } else if (assistantMsg.usage?.completion_tokens) {
        // OpenAI-compatible format (completion_tokens includes reasoning_tokens)
        outTokens = Number(assistantMsg.usage.completion_tokens)
      } else {
        outTokens = Math.ceil((assistantMsg.content?.length || 0) / 3.5)
      }
      stepOutputTokens += outTokens
      this.cumulativeOutputTokens += outTokens

      const inTokens = Number(assistantMsg.usage?.prompt_tokens) || Number(assistantMsg.usage?.promptTokenCount) || estimatedInputTokens

      // Update actual monetary cost
      const pricing = MODEL_PRICING[this.model] || MODEL_PRICING.default
      const actualCallCost = (inTokens * pricing.inputPer1M + outTokens * pricing.outputPer1M) / 1000000
      this.cumulativeCostUsd += actualCallCost

      if (this.cumulativeOutputTokens > this.maxOutputTokens) {
        throw new BudgetExceededError(`חריגה ממגבלת טוקני הפלט (${this.maxOutputTokens}).`)
      }

      messages.push(assistantMsg)

      // If no tool calls, model provided its answer
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        return {
          content: assistantMsg.content || '',
          tokens: { input: estimatedInputTokens, output: stepOutputTokens },
          toolCallsCount: totalToolCallsExecuted,
        }
      }

      // 3. Process tool calls
      for (const call of assistantMsg.tool_calls) {
        if (signal?.aborted) throw new Aborted()

        // Validate tool against worker permissions and sensitive access block
        this.validateToolCall(worker.id, call.function.name)

        const tool = availableTools.find((t) => t.name === call.function.name)
        if (!tool) {
          throw new SecurityViolationError(`הכלי ${call.function.name} אינו מורשה לשימוש על ידי עובד זה.`)
        }

        // Parse and validate arguments against tool's JSON schema
        let parsedArgs
        try {
          parsedArgs = JSON.parse(call.function.arguments || '{}')
        } catch (jsonErr) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `שגיאה בפענוח JSON של הארגומנטים: ${jsonErr.message}`,
          })
          continue
        }

        try {
          validateToolArguments(tool, parsedArgs)
        } catch (schemaErr) {
          this.logEvent('tool_schema_validation_failed', { workerId: worker.id, tool: call.function.name, error: schemaErr.message })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `שגיאת אימות ארגומנטים מול סכמת הכלי ${call.function.name}: ${schemaErr.message}`,
          })
          continue
        }

        // Execute via stored toolRunner (Helper's runCall)
        this.logEvent('tool_execute_start', { workerId: worker.id, tool: call.function.name })
        
        // Timeout check before tool run
        if (signal?.aborted) throw new Aborted()

        totalToolCallsExecuted++
        const toolMsg = await this.toolRunner(call, availableTools, { ...ctx, source: `subagent:${worker.role}`, signal })
        
        // Timeout check after tool run
        if (signal?.aborted) throw new Aborted()

        this.logEvent('tool_execute_end', { workerId: worker.id, tool: call.function.name })

        // Ensure tool message adheres strictly to standard tool message contract:
        // { role: 'tool', tool_call_id: call.id, content: string }
        // If toolRunner already returned a tool message object with role: 'tool', do NOT wrap it twice!
        let finalToolMsg
        if (toolMsg && typeof toolMsg === 'object' && toolMsg.role === 'tool') {
          finalToolMsg = {
            role: 'tool',
            tool_call_id: toolMsg.tool_call_id || call.id,
            content: typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content ?? ''),
          }
        } else {
          finalToolMsg = {
            role: 'tool',
            tool_call_id: call.id,
            content: typeof toolMsg === 'string' ? toolMsg : JSON.stringify(toolMsg ?? ''),
          }
        }

        messages.push(finalToolMsg)
      }
    }

    // Out of steps: closing response without tools
    const { estimatedInputTokens: closingTokens } = this.checkPreCallLimits(messages, worker)
    this.callCount++
    this.cumulativeInputTokens += closingTokens

    const finalMsg = await this.modelInterface(
      [
        ...messages,
        { role: 'user', content: 'סכם את הממצאים שלך עד כה בהתאם למשימה. אל תקרא לכלים נוספים.' },
      ],
      null,
      signal
    )

    const finalOutTokens = finalMsg.usage?.completion_tokens || Math.ceil((finalMsg.content?.length || 0) / 3.5)
    stepOutputTokens += finalOutTokens
    this.cumulativeOutputTokens += finalOutTokens

    return {
      content: finalMsg.content || '',
      toolCallsCount: totalToolCallsExecuted,
      tokens: { input: this.cumulativeInputTokens, output: stepOutputTokens },
    }
  }

  // Ruflo-compatible agent_terminate lifecycle
  terminate(workerId) {
    const worker = this.workers.get(workerId)
    if (worker) {
      worker.ac.abort()
      worker.status = 'terminated'
      this.logEvent('agent_terminate', { workerId, role: worker.role })
    }
  }

  terminateAll() {
    for (const [id] of this.workers) {
      this.terminate(id)
    }
    this.workers.clear()
  }
}

async function defaultToolRunner(call, tools, ctx) {
  return await runCall(call, tools, ctx)
}
