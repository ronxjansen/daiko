import type { TokenUsage } from './harnesses/types.js'

/** USD per million tokens. cacheRead/cacheWrite default to the provider's usual multipliers of input. */
interface ModelRates {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Matched by longest prefix against the model id recorded in the transcript, so
 * dated snapshots (claude-sonnet-4-6-20251114) and variants (gpt-5.6-sol) hit
 * their family's rate. Rates are first-party API list prices — sessions run on
 * subscription plans (Claude Max, ChatGPT) cost what the plan costs; the
 * estimate is the API-equivalent spend. Unknown models estimate as null, never 0.
 */
const RATES: Record<string, ModelRates> = {
  // Anthropic: cache read = 0.1x input, cache write (5m) = 1.25x input.
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 }, // 4.6/4.7/4.8; overridden below for older 4.x
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4-0': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 1, output: 5 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  // OpenAI (Codex): cached input = 0.1x input, no cache-write surcharge.
  'gpt-5': { input: 1.25, output: 10, cacheWrite: 0 },
  'gpt-4.1': { input: 2, output: 8, cacheWrite: 0 },
  'o3': { input: 2, output: 8, cacheWrite: 0 },
  'codex-mini': { input: 1.5, output: 6, cacheWrite: 0 },
  // Google (Gemini CLI): implicit cache read ≈ 0.1x input, no write surcharge.
  'gemini-3-pro': { input: 2, output: 12, cacheWrite: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheWrite: 0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheWrite: 0 },
}

function ratesFor(model: string): ModelRates | null {
  let best: string | null = null
  for (const prefix of Object.keys(RATES)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix
  }
  return best ? RATES[best] : null
}

/** Estimated USD cost for the given usage, or null when the model is unknown/unpriced. */
export function estimateCostUsd(model: string | null, usage: TokenUsage | null): number | null {
  if (!model || !usage) return null
  const rates = ratesFor(model)
  if (!rates) return null
  const cacheRead = rates.cacheRead ?? rates.input * 0.1
  const cacheWrite = rates.cacheWrite ?? rates.input * 1.25
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * cacheRead +
      usage.cacheWrite * cacheWrite) /
    1_000_000
  )
}

/** "1.2M" / "34.5K" / "812" — token counts for one-line listings. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
