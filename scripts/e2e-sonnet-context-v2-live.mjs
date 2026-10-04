#!/usr/bin/env bun
// Linux / released OpenCode 2.0.16 / installed V2 plugin / native Sonnet 5.5.
// Imports synthetic history through the supported client API: no SDK files
// are read and no preparatory model turns are needed. Main fails the same
// ancient-marker/no-trim assertion before the optional tiny resume control.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spyOn } from 'bun:test'
import { sonnetContextFixture } from './e2e-sonnet-context-fixture.mjs'

assert.equal(process.platform, 'linux', 'Run this affected-platform gate on Linux')
const repo = realpathSync(resolve(process.env.E2E_MERIDIAN_ROOT ?? '.'))
// Observe the exact external module resolved by the selected server bundle,
// including a baseline/package with its own dependency installation.
const sdkPath = createRequire(join(repo, 'dist/server.js')).resolve('@anthropic-ai/claude-agent-sdk')
const sdkVersion = JSON.parse(readFileSync(join(dirname(sdkPath), 'package.json'))).version
assert.equal(sdkVersion, '0.2.141', 'This acceptance gate requires the implicated SDK version')
const client = realpathSync(process.env.E2E_OPENCODE_BIN)
const importOnly = process.env.E2E_IMPORT_ONLY === '1'
const owned = importOnly ? undefined : realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const proof = resolve(process.env.E2E_PROOF_DIR ?? '.')
mkdirSync(proof, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-native-sonnet-')))
const project = join(root, 'project'), config = join(root, 'client-config'), auth = join(root, 'private-native-auth')
for (const directory of [project, config, auth]) mkdirSync(directory, { mode: 0o700 })
const fixture = sonnetContextFixture()
const facts = { platform: `${process.platform}/${process.arch}`, model: 'claude-sonnet-5-5', client: '2.0.16',
  sdk: sdkVersion,
  root, readiness: {}, catalogRequests: 0, wire: [], queries: [], resumed: false, result: 'INCOMPLETE' }
const savedConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug }
let logCount = 0
for (const key of Object.keys(savedConsole)) console[key] = () => { logCount++ }
let proxy, relay, server, serverOutput, observer, sdk, censusTimer
const trackedProcesses = new Map()
const writeFacts = () => writeFileSync(join(proof, 'sonnet-context-results.json'), JSON.stringify({ ...facts, suppressedLogLines: logCount }, null, 2), { mode: 0o600 })
async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
function ownedProcesses() {
  const processes = new Map()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
      const cwd = realpathSync(`/proc/${name}/cwd`)
      const start = fields[19]
      processes.set(Number(name), { parent: Number(fields[1]), start,
        owned: cwd === root || cwd.startsWith(`${root}/`) || trackedProcesses.get(Number(name)) === start })
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) continue
      throw new Error('Owned process census failed')
    }
  }
  // Include descendants that changed cwd while their owned parent is alive.
  let changed
  do {
    changed = false
    for (const row of processes.values()) if (!row.owned && processes.get(row.parent)?.owned) { row.owned = true; changed = true }
  } while (changed)
  const owned = new Map([...processes].filter(([, row]) => row.owned))
  for (const [pid, row] of owned) trackedProcesses.set(pid, row.start)
  for (const [pid, start] of trackedProcesses) if (processes.get(pid)?.start !== start) trackedProcesses.delete(pid)
  return owned
}
async function joinOwnedProcesses() {
  const signal = kind => {
    for (const [pid, row] of ownedProcesses()) {
      // Recheck the process incarnation before signaling; PID reuse is not
      // permission to terminate another process. No command/env/grant is read.
      const current = ownedProcesses().get(pid)
      if (current?.start !== row.start) continue
      try { process.kill(pid, kind) }
      catch (error) { if (error.code !== 'ESRCH') throw new Error('Owned process termination failed') }
    }
  }
  signal('SIGTERM')
  await Bun.sleep(500)
  if (ownedProcesses().size) signal('SIGKILL')
  for (let attempt = 0; attempt < 50 && ownedProcesses().size; attempt++) await Bun.sleep(100)
  facts.ownedResidualProcesses = ownedProcesses().size
  assert.equal(facts.ownedResidualProcesses, 0, 'Owned native/client descendants survived cleanup')
}
try {
  if (!importOnly) {
    // The source mount remains read-only. Only this private disposable copy can
    // be used by a native SDK runtime; it is deleted even when readiness fails.
    let credentials
    try { credentials = JSON.parse(readFileSync(join(owned, '.credentials.json'), 'utf8')) }
    catch { throw new Error('Owned native credential fixture is unavailable or unreadable') }
    const grant = credentials.claudeAiOauth
    facts.readiness = { credentialPresent: typeof grant?.accessToken === 'string', expiryFuture: grant?.expiresAt > Date.now() }
    assert(facts.readiness.credentialPresent && facts.readiness.expiryFuture, 'Owned native fixture is absent or expired')
    const ready = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${grant.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000),
    })
    facts.readiness.status = ready.status
    await ready.body?.cancel()
    assert(ready.ok, 'Owned native OAuth readiness failed; no generation started')
    writeFileSync(join(auth, '.credentials.json'), JSON.stringify(credentials), { mode: 0o600 })
  }
  for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
  const attestation = randomBytes(32).toString('base64url')
  Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'proxy-config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
    MERIDIAN_WORKDIR: project, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1',
    MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_OPENCODE_ATTESTATION_KEY: attestation, CLAUDE_CONFIG_DIR: join(root, 'unlinked-default') })
  process.env.HOME = join(root, 'proxy-home')
  mkdirSync(process.env.HOME, { mode: 0o700 })
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) process.env[`XDG_${kind}_HOME`] = join(root, `proxy-${kind.toLowerCase()}`)
  sdk = await import(pathToFileURL(sdkPath).href)
  const actualQuery = sdk.query
  observer = spyOn(sdk, 'query').mockImplementation(input => {
    assert(!importOnly, 'Import rehearsal fenced native generation')
    assert(facts.queries.length < 2, 'Bounded gate refused an additional native generation')
    const text = typeof input.prompt === 'string' ? input.prompt : undefined
    const row = { credentialDirectoryMatched: input.options.env?.CLAUDE_CONFIG_DIR === auth,
      resolvedSonnet: input.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, sdkModel: input.options.model,
      resumed: typeof input.options.resume === 'string', promptCharacters: text?.length,
      ancientRetained: text?.includes(fixture.ancient) ?? false,
      currentRetained: text?.includes(fixture.current) ?? false,
      omitted: text?.includes('were omitted from this replay') ?? false,
      nativeModels: [], inputTokens: 0, completed: false }
    facts.queries.push(row)
    const query = actualQuery(input)
    return new Proxy(query, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
          for await (const event of query) {
            if (event.type === 'assistant' && typeof event.message?.model === 'string') {
              if (!row.nativeModels.includes(event.message.model)) row.nativeModels.push(event.message.model)
              const usage = event.message.usage
              if (usage) row.inputTokens = Math.max(row.inputTokens, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0))
            }
            yield event
          }
          row.completed = true
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  const { startProxyServer } = await import(pathToFileURL(join(repo, 'dist/server.js')).href)
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true,
    pluginDir: join(root, 'isolated-plugins'), pluginConfigPath: join(root, 'isolated-plugins.json'),
    profiles: [{ id: 'owned-native-sonnet', claudeConfigDir: auth }], defaultProfile: 'owned-native-sonnet' })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const upstream = `http://127.0.0.1:${proxy.server.address().port}`
  if (!importOnly) {
    const healthResponse = await fetch(`${upstream}/health`)
    const health = await healthResponse.json()
    facts.readiness.nativeCliLoggedIn = health.auth?.loggedIn === true
    const executable = health.claudeExecutable?.path
    assert(healthResponse.ok && facts.readiness.nativeCliLoggedIn && typeof executable === 'string', 'Native CLI readiness failed before generation')
    const version = Bun.spawnSync([executable, '--version'], { env: process.env })
    const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)/.exec(new TextDecoder().decode(version.stdout).trim())
    facts.claudeCode = match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
    assert(version.exitCode === 0 && match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && (Number(match[2]) > 1 || (Number(match[2]) === 1 && Number(match[3]) >= 284)))), 'Native CLI does not support the implicated Sonnet 5.5')
  }
  const catalog = await fetch(`${upstream}/v1/models`).then(response => response.json())
  facts.proxyWindow = catalog.data.find(row => row.id === facts.model)?.context_window
  assert(Number.isSafeInteger(facts.proxyWindow) && facts.proxyWindow > 0, 'Proxy did not advertise the actual Sonnet model')
  relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    if (url.pathname === '/v1/models' && request.method === 'GET') facts.catalogRequests++
    if (url.pathname === '/v1/messages' && body) {
      const input = JSON.parse(new TextDecoder().decode(body))
      const text = JSON.stringify(input.messages)
      facts.wire.push({ model: input.model, session: request.headers.get('x-opencode-session'), agent: request.headers.get('x-opencode-agent-name'),
        mode: request.headers.get('x-opencode-agent-mode'), attested: request.headers.has('x-meridian-opencode-turn'),
        ancientRetained: text.includes(fixture.ancient), currentRetained: text.includes(fixture.current), characters: text.length })
      if (importOnly) return new Response('Import rehearsal fences generation', { status: 503 })
    }
    const response = await fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }) })
    return new Response(response.body, { status: response.status, headers: response.headers })
  } })
  // No model capacity is hardcoded: the installed V2 plugin must discover it.
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({ model: `anthropic/${facts.model}`,
    providers: { anthropic: { settings: { apiKey: 'local-e2e', baseURL: `http://127.0.0.1:${relay.port}/v1` } } },
    share: 'disabled', compaction: { auto: false } }), { mode: 0o600 })
  const clientEnv = { ...process.env }
  for (const key of Object.keys(clientEnv)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete clientEnv[key]
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) clientEnv[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  Object.assign(clientEnv, { HOME: join(root, 'client-home'), OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_SERVER_PASSWORD: 'local-e2e',
    MERIDIAN_CONFIG_DIR: process.env.MERIDIAN_CONFIG_DIR, MERIDIAN_OPENCODE_ATTESTATION_KEY: attestation, PWD: project, INIT_CWD: project })
  const version = Bun.spawnSync([client, '--version'], { env: clientEnv })
  assert.equal(new TextDecoder().decode(version.stdout).trim(), 'opencode v2.0.16')
  const setup = Bun.spawnSync(['node', join(repo, 'dist/cli.js'), 'setup', '--v2', '--opencode-bin', client], { cwd: project, env: clientEnv })
  assert.equal(setup.exitCode, 0, 'Installed package setup failed')
  const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
  assert.deepEqual(configured.plugins.map(path => realpathSync(path)), [realpathSync(join(repo, 'dist/meridian-v2'))])
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const port = reservation.port
  await reservation.stop(true)
  server = Bun.spawn([client, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env: clientEnv, stdout: 'pipe', stderr: 'pipe' })
  // Retain observed incarnations through cwd changes and reparenting, before
  // terminating a parent. This inspects only process metadata, never argv/env.
  censusTimer = setInterval(() => {
    try { ownedProcesses() } catch { facts.processCensusFailed = true }
  }, 100)
  serverOutput = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()])
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Basic ${Buffer.from('opencode:local-e2e').toString('base64')}`, 'content-type': 'application/json' }
  async function api(path, body) {
    const response = await fetch(`${base}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000) })
    assert(response.ok, `OpenCode API ${path} status ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const models = await api('/api/model')
      facts.clientWindow = models.data.find(row => row.providerID === 'anthropic' && row.modelID === facts.model)?.limit.context
      if (facts.clientWindow === facts.proxyWindow) break
    } catch (error) { if (server.exitCode !== null) throw error }
    await Bun.sleep(100)
  }
  assert.equal(facts.clientWindow, facts.proxyWindow, 'Installed V2 client did not adopt the advertised catalog')
  assert(facts.catalogRequests > 0, 'Installed V2 plugin never fetched the proxy catalog')
  const created = await api('/api/session', { location: { directory: project }, title: 'Native Sonnet context proof', agent: 'build', model: { providerID: 'anthropic', id: facts.model } })
  const info = { ...created.data, id: `ses_${randomUUID().replaceAll('-', '')}` }
  let time = Date.now()
  const messages = fixture.messages.map(message => message.role === 'user'
    ? { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'user', time: { created: time++ }, text: message.content }
    : { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'assistant', time: { created: time++, completed: time++ }, agent: 'build', model: info.model,
      content: [{ type: 'text', text: message.content }], finish: 'stop' })
  messages.push({ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'idle', time: { created: time++ }, outcome: 'succeeded' })
  await api('/api/experimental/session/import', { info, messages })
  facts.importedMessages = messages.length
  if (importOnly) {
    const imported = await api(`/api/session/${info.id}/message?order=asc&limit=100`)
    const content = JSON.stringify(imported)
    facts.importedHistoryCharacters = content.length
    assert(content.includes(fixture.ancient) && content.length > 900_000, 'Supported import did not retain the complete synthetic fixture')
    assert.equal(facts.queries.length, 0, 'Import rehearsal started a model query')
    assert.equal(facts.wire.length, 0, 'Import rehearsal started a client model request')
    facts.result = 'IMPORT_REHEARSAL_PASS'
  } else {
    async function prompt(text) {
      await api(`/api/session/${info.id}/prompt`, { text })
      await api(`/api/experimental/session/${info.id}/wait`, {})
      return api(`/api/session/${info.id}/message?order=desc&limit=4`)
  }
  function assistantText(response) {
    return response.data.filter(row => row.type === 'assistant' && row.agent === 'build'
      && row.model.id === facts.model && row.finish === 'stop' && !row.error)
      .flatMap(row => row.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
  }
  const answer = await prompt(fixture.prompt)
  const fresh = facts.queries.find(row => !row.resumed && row.currentRetained)
  facts.sameAncientNoTrimAssertion = Boolean(fresh?.ancientRetained && !fresh.omitted)
  facts.receiptDelivered = assistantText(answer).includes(`console.log("${fixture.current}");`)
  writeFacts()
  assert(facts.wire.some(row => row.model === facts.model && row.agent === 'build' && row.mode === 'primary' && row.attested && row.ancientRetained), 'Actual V2 primary request did not carry the imported history and signed identity')
  assert(fresh?.credentialDirectoryMatched && fresh.nativeModels.includes(facts.model) && fresh.completed, 'Wrong native account/model or incomplete SDK query')
  assert(facts.sameAncientNoTrimAssertion, 'Native Sonnet fresh replay prematurely discarded ancient history')
  assert.equal(facts.proxyWindow, 1_000_000)
  assert(fresh.inputTokens > 200_000, 'Actual native input did not exceed the old context window')
  assert(facts.receiptDelivered, 'Actual V2 response lacks the current coding receipt')
  const start = facts.queries.length
  const resumed = await prompt(`For the follow-up coding task, return only console.log("${fixture.current}_RESUMED"); Do not call tools.`)
  facts.resumed = facts.queries.slice(start).some(row => row.resumed && row.nativeModels.includes(facts.model) && row.completed)
    && assistantText(resumed).includes(`console.log("${fixture.current}_RESUMED");`)
  assert(facts.resumed, 'Minimal actual V2/SDK resume control failed')
  facts.result = 'PASS'
  }
} catch (error) {
  facts.result = 'FAIL'
  facts.failure = error instanceof Error ? error.message : 'Unknown gate failure'
  process.exitCode = 1
} finally {
  const cleanupFailures = []
  try {
    clearInterval(censusTimer)
    try { ownedProcesses() } catch { cleanupFailures.push('Owned process pre-termination census') }
    if (facts.processCensusFailed) cleanupFailures.push('Owned process census')
    if (server) {
      try {
        server.kill('SIGTERM')
        try { await bounded(server.exited, 5000, 'OpenCode termination') }
        catch {
          server.kill('SIGKILL')
          await bounded(server.exited, 5000, 'OpenCode kill')
        }
        await bounded(serverOutput, 5000, 'OpenCode pipes')
      } catch { cleanupFailures.push('OpenCode termination or pipes') }
    }
    try { if (relay) await bounded(Promise.resolve(relay.stop(true)), 5000, 'Relay close') }
    catch { cleanupFailures.push('Relay close') }
    try { if (proxy) await bounded(proxy.close(), 10000, 'Proxy close') }
    catch { cleanupFailures.push('Proxy close') }
    try { await bounded(joinOwnedProcesses(), 7000, 'Owned process join') }
    catch { cleanupFailures.push('Owned native/client process join') }
  } finally {
    try { observer?.mockRestore() } catch { cleanupFailures.push('SDK observer restore') }
    try {
      rmSync(auth, { recursive: true, force: true })
      facts.privateCredentialCopyRemoved = true
    } catch { cleanupFailures.push('Private credential removal') }
    for (const key of Object.keys(savedConsole)) console[key] = savedConsole[key]
    facts.cleanupJoined = cleanupFailures.length === 0
    if (cleanupFailures.length) {
      facts.cleanupFailures = cleanupFailures
      facts.result = 'FAIL'
      process.exitCode = 1
    }
    writeFacts()
    console.log(JSON.stringify({ result: facts.result, proof: join(proof, 'sonnet-context-results.json'), readiness: facts.readiness, generationQueries: facts.queries.length }))
  }
}
