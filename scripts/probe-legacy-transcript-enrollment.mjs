// Credentialless baseline ownership probe. Creates Meridian metadata only;
// the deleter is an injected recorder and no SDK transcript/CLI/model exists.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const checkout = resolve(process.env.E2E_MERIDIAN_ROOT ?? fileURLToPath(new URL('..', import.meta.url)))
const moduleAt = path => import(pathToFileURL(join(checkout, path)).href)
const lifecycle = await moduleAt('src/proxy/sessionLifecycle.ts')
const store = await moduleAt('src/proxy/sessionStore.ts')
const root = mkdtempSync(join(tmpdir(), 'meridian-legacy-enrollment-probe-'))
const deleted = []
let now = 10_000
const results = {}
const pins = () => Object.values(store.readSessionStoreSnapshot())
  .flatMap(entry => [entry.currentTranscript, entry.previousTranscript].filter(Boolean))
async function fixture(name, operation) {
  const state = join(root, name)
  store.setSessionStoreDir(state)
  deleted.length = 0
  const locator = { sessionId: 'metadata-only-session', configDir: join(root, 'synthetic-config'), projectDir: join(root, 'synthetic-project') }
  await operation(locator, { storeDir: state, now: () => now, retiredGraceMs: 0,
    preparedGraceMs: 0, pinProvider: pins, deleter: async entry => { deleted.push(entry.sessionId) } })
}
const publish = locator => store.storeSharedSession('legacy-key', locator.sessionId, 1,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, locator)
try {
  await fixture('legacy', async (locator, options) => {
    assert.notEqual(publish(locator), false)
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 0)
    assert.equal(store.evictSharedSession('legacy-key'), true)
    now++
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 0)
    assert.deepEqual(deleted, [])
    results.legacyGap = 'unowned after loss of exact durable locator'
  })
  await fixture('modern', async (locator, options) => {
    await lifecycle.prepareFork(locator, options)
    await lifecycle.commitFork(locator, options)
    assert.notEqual(publish(locator), false)
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 0)
    assert.equal(store.evictSharedSession('legacy-key'), true)
    now++
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 1)
    assert.deepEqual(deleted, [locator.sessionId])
    results.modernControl = 'pinned target retained; unpinned owned target collected'
  })
  await fixture('primitive', async (locator, options) => {
    const generation = publish(locator)
    assert.notEqual(generation, false)
    assert.notEqual(await lifecycle.attachPinnedTranscript(locator,
      () => store.attachSharedTranscriptLocator('legacy-key', locator.sessionId, locator, generation), options), false)
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 0)
    assert.equal(store.evictSharedSession('legacy-key'), true)
    now++
    assert.equal((await lifecycle.runGc(pins(), options)).deleted, 1)
    assert.deepEqual(deleted, [locator.sessionId])
    results.existingCasPrimitive = 'exact recorded ownership can be enrolled safely'
  })
  await fixture('stale', async (locator, options) => {
    const generation = publish(locator)
    assert.notEqual(generation, false)
    assert.equal(store.evictSharedSession('legacy-key'), true)
    assert.equal(await lifecycle.attachPinnedTranscript(locator,
      () => store.attachSharedTranscriptLocator('legacy-key', locator.sessionId, locator, generation), options), false)
    assert.equal((await lifecycle.runGc([], options)).deleted, 0)
    assert.deepEqual(deleted, [])
    results.staleCasControl = 'lost mapping CAS rolls back ownership'
  })
  console.log(JSON.stringify({ result: 'PASS', checkout, credentialless: true, results }))
} finally {
  store.setSessionStoreDir(null)
  rmSync(root, { recursive: true, force: true })
}
