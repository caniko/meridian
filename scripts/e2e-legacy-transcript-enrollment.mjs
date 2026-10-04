#!/usr/bin/env bun
// Costs three real model turns. Run only with an explicitly selected, ready
// account. SDK transcripts are created/inspected/deleted only through supported
// APIs; only disposable Meridian metadata is downgraded to its legacy shape.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const checkout = resolve(process.env.E2E_MERIDIAN_ROOT ?? fileURLToPath(new URL('..', import.meta.url)))
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const accountRoot = process.env.E2E_CLAUDE_CONFIG_DIR
const initialSdkRoot = process.env.CLAUDE_CONFIG_DIR
const querySdkRoot = accountRoot === undefined ? initialSdkRoot
  : resolve(accountRoot) === join(homedir(), '.claude') ? undefined : resolve(accountRoot)
if (querySdkRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
else process.env.CLAUDE_CONFIG_DIR = querySdkRoot
const baselineExpected = process.argv.includes('--expect-unfixed')
const root = mkdtempSync(join(tmpdir(), 'meridian-legacy-transcript-e2e-'))
const state = join(root, 'state')
const work = join(root, 'project')
mkdirSync(work)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'settings'), MERIDIAN_SESSION_DIR: state,
  MERIDIAN_WORKDIR: work, MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_SESSION_GC_GRACE_MS: '0', MERIDIAN_SESSION_PROFILE_COPY_PRUNE: '0',
  MERIDIAN_ROUTING: 'manual', MERIDIAN_PASSTHROUGH: '0',
})
const moduleAt = path => import(pathToFileURL(join(checkout, path)).href)
const { createProxyServer, clearSessionCache } = await moduleAt('src/proxy/server.ts')
const store = await moduleAt('src/proxy/sessionStore.ts')
const { resolveClaudeExecutableAsync } = await moduleAt('src/proxy/models.ts')
await resolveClaudeExecutableAsync()
const profiles = accountRoot && resolve(accountRoot) !== join(homedir(), '.claude')
  ? [{ id: 'owned-e2e', claudeConfigDir: resolve(accountRoot) }] : undefined
const proxy = createProxyServer({ silent: true, profiles, defaultProfile: profiles?.[0].id })
const created = []
const original = new Map()
let result
async function inSdkRoot(configDir, operation) {
  process.env.CLAUDE_CONFIG_DIR = configDir
  try { return await operation() }
  finally {
    if (querySdkRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = querySdkRoot
  }
}
const physical = locator => {
  const { lifecycleGeneration: _generation, ...result } = locator
  return result
}
async function waitSettled() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (proxy.getInFlightCount() === 0) return
    await Bun.sleep(50)
  }
  throw new Error('SDK request ownership did not settle')
}
async function request(key) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const response = await proxy.app.fetch(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-meridian-agent': 'opencode', 'x-opencode-session': key },
      body: JSON.stringify({ model, stream: false, max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with OK. Do not use tools.' }] }),
    }))
    const result = await response.json()
    assert.equal(response.status, 200, 'Real SDK request did not succeed')
    assert.equal(result.error, undefined, 'Real SDK response contained an error')
    assert(result.content?.some(block => block.type === 'text' && block.text), 'Real model text is required')
    await waitSettled()
    const mappings = store.readSessionStoreSnapshot()
    const candidate = Object.values(mappings).find(entry => !created.some(prior => prior.claudeSessionId === entry.claudeSessionId))
    assert(candidate?.currentTranscript, 'Real proxy did not publish a transcript locator')
    created.push(candidate)
    // Standalone SDK history helpers use this process's config root. This
    // inspection has no credential or CLI/model side effects.
    const messages = await inSdkRoot(candidate.currentTranscript.configDir,
      () => sdk.getSessionMessages(candidate.claudeSessionId, { dir: candidate.currentTranscript.projectDir }))
    assert(messages.length > 0, 'A real persisted SDK session is required')
    original.set(candidate.claudeSessionId, messages)
  } finally { clearTimeout(timer) }
}
function seed(key, entry) {
  store.storeSharedSession(key, entry.claudeSessionId, entry.messageCount, entry.lineageHash,
    entry.messageHashes, entry.sdkMessageUuids, entry.contextUsage, entry.messageBlockHashes,
    entry.passthroughToolCallAssistantUuid, entry.passthroughToolCallIds, physical(entry.currentTranscript))
}
try {
  for (const key of ['owned-previous', 'owned-current', 'unowned-control']) await request(key)
  await proxy.sweepSessionGc()
  assert.equal(created.length, 3)
  assert(created.every(entry => entry.currentTranscript.configDir === created[0].currentTranscript.configDir))
  // All real writers and opportunistic collectors are joined above. Simulate
  // legacy Meridian metadata, never the SDK's private persistence format.
  store.clearSharedSessions()
  rmSync(join(state, 'session-gc.json'))
  seed('legacy-e2e', created[0])
  seed('legacy-e2e', created[1])
  await proxy.sweepSessionGc()
  for (const entry of created) {
    assert.deepEqual(await inSdkRoot(entry.currentTranscript.configDir, () => sdk.getSessionMessages(entry.claudeSessionId, { dir: entry.currentTranscript.projectDir })), original.get(entry.claudeSessionId),
      'Pinned or unrelated native history changed')
  }
  const enrolled = store.readSessionStoreSnapshot()['legacy-e2e']
  const generationAttached = !!enrolled.currentTranscript.lifecycleGeneration && !!enrolled.previousTranscript.lifecycleGeneration
  assert.equal(generationAttached, !baselineExpected, 'Legacy ownership enrollment did not match the selected before/after arm')
  assert.equal(store.evictSharedSession('legacy-e2e'), true)
  await proxy.sweepSessionGc()
  const sessions = await inSdkRoot(created[0].currentTranscript.configDir, () => sdk.listSessions({ dir: created[0].currentTranscript.projectDir, includeWorktrees: false }))
  const remains = id => sessions.some(session => session.sessionId === id)
  for (const entry of created.slice(0, 2)) {
    assert.equal(remains(entry.claudeSessionId), baselineExpected, 'Recorded unpinned legacy session was not collected as expected')
  }
  assert(remains(created[2].claudeSessionId), 'Unknown shared-root control was deleted')
  assert.deepEqual(await inSdkRoot(created[2].currentTranscript.configDir, () => sdk.getSessionMessages(created[2].claudeSessionId, { dir: created[2].currentTranscript.projectDir })), original.get(created[2].claudeSessionId))
  result = { result: 'PASS', expected: baselineExpected ? 'unfixed' : 'corrected',
    checkout, platform: process.platform, model, client: 'real HTTP/SDK fixture',
    currentAndPreviousPinnedUnchanged: true, generationAttached,
    trackedLegacyCollected: !baselineExpected, unknownSessionPreserved: true }
} finally {
  let cleanupComplete = false
  try {
    proxy.beginDrain()
    await waitSettled()
    // Drop only this fixture's Meridian mappings after joining every request.
    // Fenced GC also sees failed-request targets never added to `created`.
    clearSessionCache()
    store.clearSharedSessions()
    await proxy.sweepSessionGc()
    // The deliberately unowned control and baseline legacy targets cannot be
    // recovered by GC. These exact IDs were created by this fixture, so only
    // they are eligible for direct supported SDK cleanup.
    for (const entry of created) {
      await inSdkRoot(entry.currentTranscript.configDir, async () => {
        const sessions = await sdk.listSessions({ dir: entry.currentTranscript.projectDir, includeWorktrees: false })
        if (sessions.some(session => session.sessionId === entry.claudeSessionId)) {
          await sdk.deleteSession(entry.claudeSessionId, { dir: entry.currentTranscript.projectDir })
        }
      })
    }
    await proxy.sweepSessionGc()
    const sidecarPath = join(state, 'session-gc.json')
    const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : { resources: {} }
    const pending = Object.values(sidecar.resources).filter(resource =>
      resource.state !== 'deleted' || Object.keys(resource.activeLeases ?? {}).length > 0)
    assert.equal(pending.length, 0, 'Cleanup is incomplete; retain the fixture lifecycle authority')
    cleanupComplete = true
  } finally {
    store.setSessionStoreDir(null)
    if (initialSdkRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = initialSdkRoot
    if (cleanupComplete) rmSync(root, { recursive: true, force: true })
    else console.error(`Fixture cleanup incomplete; retained Meridian ownership metadata at ${state}`)
  }
}
console.log(JSON.stringify(result))
