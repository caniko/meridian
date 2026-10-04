#!/usr/bin/env bun
// Costs three real model turns. Run only with an explicitly selected, ready
// account. SDK transcripts are created/inspected/deleted only through supported
// APIs; only disposable Meridian metadata is downgraded to its legacy shape.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spyOn } from 'bun:test'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'

const checkout = resolve(process.env.E2E_MERIDIAN_ROOT ?? fileURLToPath(new URL('..', import.meta.url)))
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const selectedRoot = process.env.E2E_CLAUDE_CONFIG_DIR
assert(selectedRoot, 'Select an immutable ready grant with E2E_CLAUDE_CONFIG_DIR; no native-account fallback')
const sourceRoot = realpathSync(resolve(selectedRoot))
const sourceGrant = join(sourceRoot, '.credentials.json')
const sourceInfo = lstatSync(sourceGrant)
assert(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), 'Select an ordinary read-only credential snapshot file')
assert.equal(sourceInfo.mode & 0o222, 0, 'The source grant must be an immutable read-only snapshot')
const sourceBytes = readFileSync(sourceGrant)
assert(sourceBytes.length > 0, 'Selected credential snapshot is empty')
const initialSdkRoot = process.env.CLAUDE_CONFIG_DIR
const baselineExpected = process.argv.includes('--expect-unfixed')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-legacy-transcript-e2e-')))
const runtimeRoot = join(root, 'owned-runtime-account')
const querySdkRoot = runtimeRoot
const state = join(root, 'state')
const work = join(root, 'project')
let sdk, proxy, store, clearSessionCache, observer
const queries = [], servedModels = new Set()
const moduleAt = path => import(pathToFileURL(join(checkout, path)).href)
try {
  // Every operation after creating the private root is cleanup-owned, including
  // a write that makes the credential copy visible before reporting failure.
  mkdirSync(runtimeRoot, { mode: 0o700 })
  assert.notEqual(realpathSync(runtimeRoot), sourceRoot, 'Runtime account must be a separate owned directory')
  writeFileSync(join(runtimeRoot, '.credentials.json'), sourceBytes, { mode: 0o600, flag: 'wx' })
  mkdirSync(work)
  for (const key of Object.keys(process.env)) {
    if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key) || key === 'CLAUDECODE') delete process.env[key]
  }
  Object.assign(process.env, {
    MERIDIAN_CONFIG_DIR: join(root, 'settings'), MERIDIAN_SESSION_DIR: state,
    MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1',
    CLAUDE_CONFIG_DIR: runtimeRoot,
    MERIDIAN_WORKDIR: work, MERIDIAN_TELEMETRY_PERSIST: '0',
    MERIDIAN_SESSION_GC_GRACE_MS: '0', MERIDIAN_SESSION_PROFILE_COPY_PRUNE: '0',
    MERIDIAN_ROUTING: 'manual', MERIDIAN_PASSTHROUGH: '0',
  })
  // Baseline and candidate may have independently installed dependencies.
  // Resolve the public entry at the target checkout, not the harness location.
  const targetRequire = createRequire(pathToFileURL(join(checkout, 'package.json')))
  const sdkEntry = targetRequire.resolve('@anthropic-ai/claude-agent-sdk')
  const proxyRequire = createRequire(pathToFileURL(join(checkout, 'src/proxy/server.ts')))
  assert.equal(realpathSync(proxyRequire.resolve('@anthropic-ai/claude-agent-sdk')), realpathSync(sdkEntry),
    'Harness observer must use the exact proxy-installed SDK entry')
  sdk = await import(pathToFileURL(sdkEntry).href)
  const realQuery = sdk.query
  observer = spyOn(sdk, 'query').mockImplementation(input => {
    queries.push({ runtimeMatched: input.options?.env?.CLAUDE_CONFIG_DIR === runtimeRoot })
    return observeSdkModels(realQuery(input), servedModels)
  })
  const serverModule = await moduleAt('src/proxy/server.ts')
  clearSessionCache = serverModule.clearSessionCache
  store = await moduleAt('src/proxy/sessionStore.ts')
  const { resolveClaudeExecutableAsync } = await moduleAt('src/proxy/models.ts')
  await resolveClaudeExecutableAsync()
  proxy = serverModule.createProxyServer({ silent: true,
    profiles: [{ id: 'owned-e2e', claudeConfigDir: runtimeRoot }], defaultProfile: 'owned-e2e' })
} catch (error) {
  observer?.mockRestore()
  try {
    assertSourceUnchanged()
    assertNoPendingOwnership()
    rmSync(root, { recursive: true, force: true })
  } catch (cleanupError) {
    console.error(`Fixture initialization failed; retained ownership metadata at ${state}`)
    throw new AggregateError([error, cleanupError], 'Fixture initialization failed and cleanup is incomplete')
  }
  throw error
}
function assertSourceUnchanged() {
  const current = lstatSync(sourceGrant)
  assert(sourceBytes.equals(readFileSync(sourceGrant)), 'Source credential grant changed')
  for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
    assert.equal(current[field], sourceInfo[field], 'Source credential snapshot identity changed')
  }
}
function assertNoPendingOwnership() {
  const path = join(state, 'session-gc.json')
  const sidecar = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { resources: {} }
  const pending = Object.values(sidecar.resources).filter(resource =>
    resource.state !== 'deleted' || Object.keys(resource.activeLeases ?? {}).length > 0)
  assert.equal(pending.length, 0, 'Cleanup is incomplete; retain the fixture lifecycle authority')
}
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
    assert.equal(candidate.currentTranscript.configDir, runtimeRoot, 'Proxy used an unselected account root')
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
  assert.equal(queries.length, 3, 'Expected exactly three real SDK fixture queries')
  assert(queries.every(query => query.runtimeMatched), 'Every SDK query must use the owned runtime store')
  assert(servedModels.size > 0 && [...servedModels].every(value => value === model || value.startsWith(model + '-')), 'Upstream did not confirm the selected model')
  assertSourceUnchanged()
  result = { result: 'PASS', sourceGrantUnchanged: true, ownedRuntimeAccount: true, allQueriesUseOwnedRuntime: true, observedCheckoutSdk: true, servedModels: [...servedModels], expected: baselineExpected ? 'unfixed' : 'corrected',
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
    // Never bypass a retained writer/publication/deletion fence with direct
    // SDK deletion, even for an ID created by this fixture.
    assertNoPendingOwnership()
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
    assertNoPendingOwnership()
    assertSourceUnchanged()
    cleanupComplete = true
  } finally {
    observer.mockRestore()
    store.setSessionStoreDir(null)
    if (initialSdkRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = initialSdkRoot
    if (cleanupComplete) rmSync(root, { recursive: true, force: true })
    else console.error(`Fixture cleanup incomplete; retained Meridian ownership metadata at ${state}`)
  }
}
console.log(JSON.stringify(result))
