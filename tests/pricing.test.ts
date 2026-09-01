import { describe, expect, it } from 'vitest'
import { estimateCostUsd, formatTokens } from '../src/core/pricing.js'
import type { TokenUsage } from '../src/core/harnesses/types.js'

const usage = (partial: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...partial })
const M = 1_000_000

describe('estimateCostUsd', () => {
  it('prices input and output at the model rates', () => {
    expect(estimateCostUsd('claude-fable-5', usage({ input: M, output: M }))).toBe(10 + 50)
    expect(estimateCostUsd('claude-sonnet-5', usage({ input: M }))).toBe(2)
  })

  it('matches dated snapshots by longest prefix', () => {
    // claude-opus-4-1-YYYYMMDD must hit the opus-4-1 rate (15), not the opus-4 family rate (5).
    expect(estimateCostUsd('claude-opus-4-1-20250805', usage({ input: M }))).toBe(15)
    expect(estimateCostUsd('claude-opus-4-6', usage({ input: M }))).toBe(5)
  })

  it('defaults Anthropic cache rates to 0.1x / 1.25x input', () => {
    expect(estimateCostUsd('claude-sonnet-4-20250514', usage({ cacheRead: M }))).toBeCloseTo(0.3)
    expect(estimateCostUsd('claude-sonnet-4-20250514', usage({ cacheWrite: M }))).toBeCloseTo(3.75)
  })

  it('honors explicit cache overrides (OpenAI has no cache-write surcharge)', () => {
    expect(estimateCostUsd('gpt-5', usage({ cacheWrite: M }))).toBe(0)
    expect(estimateCostUsd('gpt-5', usage({ cacheRead: M }))).toBeCloseTo(0.125)
  })

  it('returns null — never 0 — for unknown models or missing data', () => {
    expect(estimateCostUsd('mystery-model-9', usage({ input: M }))).toBeNull()
    expect(estimateCostUsd(null, usage({ input: M }))).toBeNull()
    expect(estimateCostUsd('claude-fable-5', null)).toBeNull()
  })
})

describe('formatTokens', () => {
  it('formats for one-line listings', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(1_000)).toBe('1.0K')
    expect(formatTokens(34_500)).toBe('34.5K')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })
})
