// Isolated single-run live trial script for Agent Team Orchestration via OpenRouter.
// Uses real OpenRouter endpoint (https://openrouter.ai/api/v1/chat/completions) with mock/synthetic tools and data ONLY.
// Zero access to real accounts, devices, emails, or live WhatsApp messages.
// Strictly capped at max 4 calls and $0.03 USD total cost.
// Run with explicit user approval: node scripts/trial-agent-team.mjs

import { config } from '../src/config.js'
import { AgentTeamOrchestrator } from '../src/agent-team/orchestrator.js'
import { MODEL_PRICING } from '../src/agent-team/adapter.js'
import { callExplicitModel, OPENROUTER_ENDPOINT } from '../src/llm.js'

async function runSingleTrial() {
  console.log('=== ניסוי מבודד יחיד: צוות סוכנים דרך OpenRouter (Helper Orchestrator) ===\n')

  const apiKey = process.env.OPENROUTER_API_KEY || config.llm?.apiKey || process.env.LLM_API_KEY
  if (!apiKey) {
    console.error('❌ שגיאה: חסרה הרשאת OpenRouter (LLM_API_KEY או OPENROUTER_API_KEY ב-.env).')
    process.exit(1)
  }

  // Trial parameters
  const trialConfig = {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    maxCalls: 4,
    maxOutputTokensPerCall: 1000,
    maxCostPerRequestUsd: 0.03, // Hard cap of 3 cents ($0.03)
  }

  console.log('פרמטרי ניסוי מאומתים:')
  console.log(`• ספק: OpenRouter`)
  console.log(`• יעד: ${OPENROUTER_ENDPOINT}`)
  console.log(`• מודל: ${trialConfig.model}`)
  console.log(`• תקרת קריאות: ${trialConfig.maxCalls} לכל היותר`)
  console.log(`• תקרת עלות קשיחה: $${trialConfig.maxCostPerRequestUsd} USD`)
  console.log(`• תעריף פלט OpenRouter (כולל חשיבה): $${MODEL_PRICING[trialConfig.model].outputPer1M}/1M טוקנים`)
  console.log(`• תעריף קלט OpenRouter: $${MODEL_PRICING[trialConfig.model].inputPer1M}/1M טוקנים`)
  console.log(`• כלי בדיקה: מדומה בלבד (ללא גישה לחשבונות/מכשירים/הודעות אמת)\n`)

  // Synthetic safe mock tool: returns fictitious test flights without network/device access
  const SYNTHETIC_FLIGHT_DB = [
    {
      route: 'TLV -> LHR (בריטיש איירווייז - טיסה מומצאת)',
      airline: 'British Airways',
      dates: '01.06.2026 - 15.06.2026 (14 ימים)',
      layover: 'שעה ו-20 דקות (קונקשן קצר)',
      price: '$410',
      source: 'סינתטי לבדיקה בלבד (נתון מומצא)',
    },
    {
      route: 'TLV -> LGW (איזיג׳ט עם עצירה - טיסה מומצאת)',
      airline: 'easyJet',
      dates: '01.06.2026 - 15.06.2026 (14 ימים)',
      layover: '3 שעות ו-40 דקות (עצירה ארוכה מעל שעתיים)',
      price: '$320',
      source: 'סינתטי לבדיקה בלבד (נתון מומצא)',
    },
    {
      route: 'TLV -> LTN (וויז אייר - טיסה מומצאת)',
      airline: 'Wizz Air',
      dates: '01.06.2026 - 22.06.2026 (21 ימים, חורג משבועיים)',
      layover: 'שעה (קונקשן קצר)',
      price: '$290',
      source: 'סינתטי לבדיקה בלבד (נתון מומצא)',
    },
  ]

  let capturedToolCalls = []
  let capturedToolResults = []
  const mockToolRunner = async (toolCall, tools, ctx) => {
    capturedToolCalls.push(toolCall)
    const res = JSON.stringify({
      status: 'success',
      synthetic_note: 'נתוני בדיקה סינתטיים בלבד - טיסות מומצאות לצורך הבדיקה, לא בוצעה פנייה לשירות חיצוני',
      results: SYNTHETIC_FLIGHT_DB,
    })
    capturedToolResults.push(res)
    console.log(`\n==================================================`)
    console.log(`[1. רצף בקשת הכלי מהחוקר (Tool Request Sequence)]:`)
    console.log(`• שם הכלי שהופעל: ${toolCall.function?.name}`)
    console.log(`• ארגומנטים שנשלחו מהמודל: ${toolCall.function?.arguments}`)
    console.log(`==================================================`)
    console.log(`[2. תוצאת הכלי המדומה (Mock Tool Output)]:`)
    console.log(res)
    console.log(`==================================================\n`)
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: res,
    }
  }

  // Intercept and record raw live calls from OpenRouter
  const capturedCalls = []
  let httpAttempts = 0
  let successfulModelCalls = 0
  let verifierDeliveredPrompt = ''
  let verifierRawOutput = ''

  const liveOpenRouterModelInterface = async (messages, tools, signal) => {
    const isVerifier = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('אתה בודק ספקני (Reality Checker)')
    )
    if (isVerifier) {
      verifierDeliveredPrompt = messages[messages.length - 1]?.content || ''
      console.log(`==================================================`)
      console.log(`[3. מה הגיע לבודק (Delivered to Verifier Prompt)]:`)
      console.log(verifierDeliveredPrompt)
      console.log(`==================================================\n`)
    }

    httpAttempts++
    const callStart = Date.now()
    const msg = await callExplicitModel({
      model: trialConfig.model,
      messages,
      tools,
      maxOutputTokens: trialConfig.maxOutputTokensPerCall,
      signal,
    })
    successfulModelCalls++
    const callDuration = Date.now() - callStart

    if (isVerifier) {
      verifierRawOutput = msg.content || ''
      console.log(`==================================================`)
      console.log(`[4. הכרעת הבודק (Verifier Schema Output)]:`)
      console.log(verifierRawOutput)
      console.log(`==================================================\n`)
    }

    capturedCalls.push({
      durationMs: callDuration,
      usage: msg.usage || null,
      rawCost: msg.usage?.cost ?? msg.usage?.total_cost ?? null,
    })
    return msg
  }

  // Initialize isolated orchestrator with OpenRouter caller and synthetic mock tool runner
  const orchestrator = new AgentTeamOrchestrator({
    model: trialConfig.model,
    provider: trialConfig.provider,
    maxCalls: trialConfig.maxCalls,
    maxOutputTokensPerCall: trialConfig.maxOutputTokensPerCall,
    maxCostPerRequestUsd: trialConfig.maxCostPerRequestUsd,
    modelInterface: liveOpenRouterModelInterface,
    toolRunner: mockToolRunner,
  })

  const testQuery = 'מצא טיסה ללונדון לשבועיים, קונקשן עד שעתיים מתל אביב בין 01.06.2026 ל-15.06.2026'
  console.log(`מריץ ניסוי יחיד עבור השאילתה: "${testQuery}"\n`)

  const startedAt = Date.now()
  try {
    const finalReply = await orchestrator.orchestrate(testQuery, {
      messageId: `trial_${Date.now()}`,
      toolRunner: mockToolRunner,
    })

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    const adapter = orchestrator.adapter

    console.log('\n--- סיכום תוצאות הניסוי ---')
    console.log(`• סטטוס: הושלם`)
    console.log(`• משך כולל: ${durationSec} שניות`)
    console.log(`• ניסיונות HTTP שבוצעו: ${httpAttempts}`)
    console.log(`• קריאות מודל שהצליחו (200 OK): ${successfulModelCalls}`)
    const toolCount = adapter.events.filter((e) => e.type === 'tool_execute_end').length
    console.log(`• כלי בדיקה שהופעלו: ${toolCount}`)

    if (toolCount === 0) {
      console.log('⚠️ שים לב: הכלי לא הופעל על ידי החוקר! דיווח על כשל ביצוע ללא ניסיון נוסף.')
    }

    // Check if provider reported direct cost
    let totalDirectCost = 0
    let hasDirectCost = true
    for (const c of capturedCalls) {
      if (typeof c.rawCost === 'number') {
        totalDirectCost += c.rawCost
      } else {
        hasDirectCost = false
      }
    }

    if (hasDirectCost && capturedCalls.length > 0) {
      console.log(`• עלות שדווחה בפועל מהספק: $${totalDirectCost.toFixed(6)} USD`)
    } else {
      console.log(`• עלות שדווחה בפועל מהספק: לא אומתה (OpenRouter לא החזיר שדה cost ישיר בגוף התשובה)`)
      console.log(`• אומדן מחושב לפי תעריפי OpenRouter הרשמיים ($0.30 קלט / $2.50 פלט ל-1M טוקנים):`)
      console.log(`  - טוקני קלט: ${adapter.cumulativeInputTokens}`)
      console.log(`  - טוקני פלט (כולל חשיבה): ${adapter.cumulativeOutputTokens}`)
      console.log(`  - עלות מחושבת: $${adapter.cumulativeCostUsd.toFixed(6)} USD (תקרה מותרת: $${trialConfig.maxCostPerRequestUsd})`)
    }

    console.log('\n==================================================')
    console.log('[5. התשובה הסופית לוואטסאפ (עם סימון ברור שהטיסות מומצאות)]:')
    console.log('⚠️ שימו לב: הטיסות והנתונים המוצגים להלן הינם סינתטיים ומיועדים לבדיקה בלבד.')
    console.log('--------------------------------------------------')
    console.log(finalReply)
    console.log('==================================================')
  } catch (err) {
    console.error(`\n❌ כשל במהלך הניסוי: ${err.message}`)
    console.log(`• ניסיונות HTTP שבוצעו: ${httpAttempts}`)
    console.log(`• קריאות מודל שהצליחו (200 OK): ${successfulModelCalls}`)
    console.log(`• עלות שדווחה בפועל מהספק: לא אומתה`)
    console.log('בלי ניסיון נוסף אוטומטי.')
    process.exit(1)
  }
}

runSingleTrial()
