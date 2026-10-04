#!/usr/bin/env bun
// Same synthetic replay and assertion on unchanged main and the fixed source.
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sonnetContextFixture } from './e2e-sonnet-context-fixture.mjs'

const root = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const replay = await import(pathToFileURL(join(root, 'src/proxy/replayBudget.ts')).href)
const openai = await import(pathToFileURL(join(root, 'src/proxy/openai.ts')).href)
const fixture = sonnetContextFixture()
const messages = [...fixture.messages, { role: 'user', content: fixture.prompt }]
const estimatedHistoryTokens = messages.reduce((sum, row) => sum + replay.estimateTokens(row.content), 0)
const budget = replay.replayBudgetFor('sonnet', 'claude-sonnet-5-5')
const result = replay.trimReplayHistory(messages, budget)
const facts = {
  estimatedHistoryTokens, budget,
  advertisedWindow: openai.buildModelList(false).find(row => row.id === 'claude-sonnet-5-5').context_window,
  ancientRetained: JSON.stringify(result.messages).includes(fixture.ancient),
  currentRetained: JSON.stringify(result.messages).includes(fixture.current),
  omittedMessages: result.omittedMessages,
  sonnet46Window: replay.contextWindowFor('sonnet', 'claude-sonnet-4-6'),
  unknownSonnetWindow: replay.contextWindowFor('sonnet', 'claude-sonnet-6-0'),
  explicitlyDisabledWindow: replay.contextWindowFor('sonnet', 'claude-sonnet-5-5', true),
}
console.log(JSON.stringify(facts))
assert(estimatedHistoryTokens > 200_000 && estimatedHistoryTokens < 836_000)
assert(facts.ancientRetained && facts.omittedMessages === 0, 'Native Sonnet fresh replay prematurely discarded ancient history')
assert.equal(facts.advertisedWindow, 1_000_000)
assert.equal(facts.sonnet46Window, 200_000)
assert.equal(facts.unknownSonnetWindow, 200_000)
assert.equal(facts.explicitlyDisabledWindow, 200_000)
