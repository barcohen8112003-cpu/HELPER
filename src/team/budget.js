// The team's limits, kept by code: model calls, tokens, time and money for one request, and money for the day.
// Every model call reserves its worst case BEFORE it is sent; a call that would not fit is not sent. A failed call
// keeps its reservation (the provider may have billed it), so a retry is paid for out of the same cap.

export class BudgetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetError'
  }
}

// Hebrew runs at about 2-3 characters a token. 2.5 errs on the side of counting too many.
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value ?? '').length / 2.5)

export function makeBudget(limits, { spentToday = 0, live = false } = {}) {
  const used = { calls: 0, inTokens: 0, outTokens: 0, usd: 0 }
  const price = (inT, outT) => (live ? (inT * limits.priceInPerMTok + outT * limits.priceOutPerMTok) / 1e6 : 0)
  return {
    used,
    limits,
    // Returns the output cap for this call; throws BudgetError when it does not fit.
    reserve(inTokens, wantOut) {
      if (used.calls + 1 > limits.maxModelCalls) throw new BudgetError(`הגעתי למגבלה של ${limits.maxModelCalls} קריאות מודל לבקשה`)
      if (used.inTokens + inTokens > limits.maxInTokens) throw new BudgetError(`הקלט חורג מ-${limits.maxInTokens} טוקנים לבקשה`)
      const out = Math.min(wantOut, limits.maxOutTokens - used.outTokens)
      if (out < 64) throw new BudgetError(`נגמר תקציב הפלט (${limits.maxOutTokens} טוקנים לבקשה)`)
      const cost = price(inTokens, out)
      if (live && used.usd + cost > limits.maxUsdPerRequest) throw new BudgetError(`העלות הצפויה חורגת מהתקרה לבקשה ($${limits.maxUsdPerRequest})`)
      if (live && spentToday + used.usd + cost > limits.maxUsdPerDay) throw new BudgetError(`העלות הצפויה חורגת מהתקרה היומית ($${limits.maxUsdPerDay})`)
      used.calls++
      used.inTokens += inTokens
      used.outTokens += out
      used.usd += cost
      return { inTokens, out, cost }
    },
    // After the call: what the provider reported replaces the estimate, but never lowers it below zero spend.
    // Without a report the reservation stands.
    settle(r, usage) {
      if (!usage) return
      const inT = Number(usage.prompt_tokens ?? usage.inputTokens)
      const outT = Number(usage.completion_tokens ?? usage.outputTokens)
      if (!Number.isFinite(inT) || !Number.isFinite(outT)) return
      used.inTokens += inT - r.inTokens
      used.outTokens += outT - r.out
      const real = price(inT, outT)
      used.usd += real - r.cost
    },
  }
}
