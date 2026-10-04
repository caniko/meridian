import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsAsync from "node:fs/promises"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as sessionStore from "../proxy/sessionStore"
import {
  SessionLifecycleBacklogError,
  abandonFork,
  acquireActiveTranscriptLease,
  canonicalizeTranscriptLocator,
  enrollLegacyMappedTranscripts,
  getTranscriptResourceKey,
  prepareFork,
  prepareForkForPublication,
  registerLiveTranscript,
  releaseActiveTranscriptLease,
  releaseSupersededProfileCopies,
  runGc,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"

interface StoredResource {
  key: string
  generation: string
  locator: TranscriptLocator
  state: string
  activeLeases?: Record<string, unknown>
}

interface StoredSidecar {
  version: number
  meta: { fenceSlots: Record<string, number> }
  resources: Record<string, StoredResource>
}

describe("legacy mapped transcript enrollment", () => {
  let directory: string
  let storeDir: string
  let options: SessionLifecycleOptions
  let deleted: TranscriptLocator[]
  let originalMaximum: string | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-legacy-enrollment-"))
    storeDir = join(directory, "store")
    mkdirSync(storeDir)
    mkdirSync(join(directory, "claude"))
    mkdirSync(join(directory, "project"))
    sessionStore.setSessionStoreDir(storeDir)
    originalMaximum = process.env.MERIDIAN_MAX_STORED_SESSIONS
    deleted = []
    options = {
      storeDir,
      now: () => 10_000,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 1,
      pinProvider: durablePins,
      deleter: async locator => { deleted.push(locator) },
    }
  })

  afterEach(() => {
    sessionStore.setSessionStoreDir(null)
    if (originalMaximum === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSIONS
    else process.env.MERIDIAN_MAX_STORED_SESSIONS = originalMaximum
    rmSync(directory, { recursive: true, force: true })
  })

  function locator(sessionId: string): TranscriptLocator {
    return { sessionId, configDir: join(directory, "claude"), projectDir: join(directory, "project") }
  }

  function physical(entry: TranscriptLocator): TranscriptLocator {
    const { lifecycleGeneration: _generation, ...result } = entry
    return result
  }

  function resourceKey(entry: TranscriptLocator): string {
    return getTranscriptResourceKey(canonicalizeTranscriptLocator(entry))
  }

  function readSidecar(): StoredSidecar {
    const path = join(storeDir, "session-gc.json")
    if (!existsSync(path)) return { version: 2, meta: { fenceSlots: {} }, resources: {} }
    // Only Meridian-owned lifecycle metadata is inspected; no SDK files exist.
    return JSON.parse(readFileSync(path, "utf8")) as StoredSidecar
  }

  function mapping(key: string): sessionStore.StoredSession {
    const entry = sessionStore.readSessionStoreSnapshot()[key]
    if (!entry) throw new Error(`fixture mapping ${key} is absent`)
    return entry
  }

  function publishMapping(key: string, entry: TranscriptLocator, messageCount = 7) {
    return sessionStore.storeSharedSession(
      key, entry.sessionId, messageCount, "fixture-lineage", ["fixture-message"], ["fixture-assistant"],
      undefined, [["fixture-block"]], "fixture-checkpoint", ["fixture-tool"], entry,
    )
  }

  function storeMapping(key: string, entry: TranscriptLocator, messageCount = 7): void {
    expect(publishMapping(key, entry, messageCount)).not.toBe(false)
  }

  function storePair(key: string, current: TranscriptLocator, previous: TranscriptLocator): void {
    storeMapping(key, previous)
    storeMapping(key, current)
  }

  function publishPriorityMapping(key: string, entry: TranscriptLocator, messageCount = 7) {
    const stored = sessionStore.lookupSharedSessionResult(key)
    const routeKey = `${key}-route`
    const route = sessionStore.lookupPriorityAssignmentResult(routeKey)
    if (stored.status === "error") throw stored.error
    if (route.status === "error") throw route.error
    if (!stored.generation) throw new Error("fixture mapping lacks its exact generation")
    return sessionStore.storeSharedSessionAndPriorityAssignment({
      key, claudeSessionId: entry.sessionId, messageCount,
      lineageHash: "fixture-lineage", messageHashes: ["fixture-message"], messageBlockHashes: [["fixture-block"]],
      currentTranscript: entry, expectedMappingGeneration: stored.generation,
      priority: { routeKey, profileId: "work", lastHumanTurnDigest: "A".repeat(43),
        lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: route.generation },
    })
  }

  function durablePins(): TranscriptLocator[] {
    const pins: TranscriptLocator[] = []
    for (const entry of Object.values(sessionStore.readSessionStoreSnapshot())) {
      if (entry.currentTranscript?.sessionId === entry.claudeSessionId) pins.push(entry.currentTranscript)
      if (entry.previousTranscript && entry.previousTranscript.sessionId === entry.previousClaudeSessionId) pins.push(entry.previousTranscript)
    }
    return pins
  }

  it("distinguishes owned pins, owned garbage, mapped legacy resources and unknown transcripts", async () => {
    const pinned = await registerLiveTranscript(locator("owned-pinned"), options)
    const garbage = await registerLiveTranscript(locator("owned-unpinned"), options)
    const legacy = locator("mapped-but-unjournaled")
    const unknown = locator("unknown-shared-root-session")
    storeMapping("modern", pinned)
    storeMapping("legacy", legacy)

    // This is the pre-enrollment failure: removing the legacy mapping would
    // leave no owned resource for supported deletion to collect.
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual([garbage.sessionId])
    expect(readSidecar().resources[resourceKey(legacy)]).toBeUndefined()
    expect(readSidecar().resources[resourceKey(unknown)]).toBeUndefined()
    expect(sessionStore.evictSharedSession("legacy")).toBe(true)
    expect((await runGc([], options)).deleted).toBe(0)
    expect(deleted.map(entry => entry.sessionId)).toEqual([garbage.sessionId])
    storeMapping("legacy", legacy)

    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    expect((await runGc([], options)).deleted).toBe(0)
    expect(sessionStore.evictSharedSession("legacy")).toBe(true)
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual([garbage.sessionId, legacy.sessionId])
    expect(readSidecar().resources[resourceKey(pinned)]?.state).toBe("live")
    expect(readSidecar().resources[resourceKey(unknown)]).toBeUndefined()
  })

  it("enrolls current and direct predecessor together, preserves pins, then collects both after eviction", async () => {
    const current = locator("legacy-current")
    const previous = locator("legacy-previous")
    storePair("conversation", current, previous)
    const before = mapping("conversation")

    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    const after = mapping("conversation")
    expect(after.currentTranscript?.lifecycleGeneration).toBe(readSidecar().resources[resourceKey(current)]?.generation)
    expect(after.previousTranscript?.lifecycleGeneration).toBe(readSidecar().resources[resourceKey(previous)]?.generation)
    expect(after.currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
    expect(after.previousTranscript?.lifecycleGeneration).toMatch(/^r:/)
    expect(after).toEqual({
      ...before,
      revision: (before.revision ?? 0) + 1,
      generationId: after.generationId,
      currentTranscript: after.currentTranscript,
      previousTranscript: after.previousTranscript,
    })
    expect(after.generationId).not.toBe(before.generationId)
    expect((await runGc([], options)).deleted).toBe(0)
    expect(deleted).toEqual([])
    expect(sessionStore.evictSharedSession("conversation")).toBe(true)
    expect((await runGc([], options)).deleted).toBe(2)
    expect(deleted.map(entry => entry.sessionId).sort()).toEqual([current.sessionId, previous.sessionId].sort())
  })

  it("leaves modern mappings and their lifecycle metadata unchanged", async () => {
    const current = await registerLiveTranscript(locator("modern-current"), options)
    const previous = await registerLiveTranscript(locator("modern-previous"), options)
    storePair("modern", current, previous)
    const beforeMapping = mapping("modern")
    const beforeSidecar = readSidecar()

    expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
    expect(mapping("modern")).toEqual(beforeMapping)
    expect(readSidecar()).toEqual(beforeSidecar)
  })

  it("does not infer ownership for absent mappings or mappings without exact locators", async () => {
    expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
    sessionStore.storeSharedSession("ids-only", "old-id")
    sessionStore.storeSharedSession("ids-only", "new-id")
    const before = mapping("ids-only")

    expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
    expect(mapping("ids-only")).toEqual(before)
    expect(mapping("ids-only").previousClaudeSessionId).toBe("old-id")
    expect(readSidecar().resources).toEqual({})
    expect((await runGc([], options)).deleted).toBe(0)
  })

  it("never recreates missing resources for locators which already carry an ownership fence", async () => {
    const fenced = locator("missing-fenced-resource")
    fenced.lifecycleGeneration = `r:${resourceKey(fenced)}:1`
    storeMapping("fenced", fenced)
    const before = mapping("fenced")

    expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
    expect(mapping("fenced")).toEqual(before)
    expect(readSidecar().resources).toEqual({})
  })

  for (const legacyField of ["current", "previous"] as const) {
    it(`enrolls only the legacy ${legacyField} locator in a mixed mapping`, async () => {
      const current = locator("mixed-current")
      const previous = locator("mixed-previous")
      const modern = legacyField === "current" ? previous : current
      modern.lifecycleGeneration = `r:${resourceKey(modern)}:1`
      storePair("mixed", current, previous)

      expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
      const after = mapping("mixed")
      const legacy = legacyField === "current" ? current : previous
      const field = legacyField === "current" ? after.currentTranscript : after.previousTranscript
      expect(field?.lifecycleGeneration).toMatch(/^r:/)
      expect(readSidecar().resources[resourceKey(legacy)]?.state).toBe("live")
      expect(readSidecar().resources[resourceKey(modern)]).toBeUndefined()
      expect(legacyField === "current" ? after.previousTranscript : after.currentTranscript).toEqual(modern)
    })
  }

  it("rolls back all new ownership and fence counters when the exact mapping CAS becomes stale", async () => {
    const current = locator("stale-current")
    const previous = locator("stale-previous")
    storePair("stale", current, previous)
    const before = readSidecar()
    const capturedGeneration = sessionStore.getStoredSessionGeneration(mapping("stale"), "stale")
    const attach = sessionStore.attachLegacyTranscriptGenerations
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation((key, expected, locators) => {
      expect(expected).toBe(capturedGeneration)
      storeMapping(key, current, 99)
      return attach(key, expected, locators)
    })
    try {
      expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
      expect(cas).toHaveBeenCalledTimes(1)
      expect(mapping("stale").messageCount).toBe(99)
      expect(mapping("stale").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(mapping("stale").previousTranscript?.lifecycleGeneration).toBeUndefined()
      expect(readSidecar()).toEqual(before)
    } finally {
      cas.mockRestore()
    }
  })

  it("retains issued ownership conservatively when mapping attachment throws with uncertain publication", async () => {
    const current = await registerLiveTranscript(locator("throw-existing"), options)
    await abandonFork(current, options)
    const previous = locator("throw-new")
    storePair("throw", physical(current), previous)
    const beforeMapping = mapping("throw")
    const beforeSidecar = readSidecar()
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation(() => {
      throw new Error("fixture mapping write failed")
    })
    try {
      await expect(enrollLegacyMappedTranscripts(options)).rejects.toThrow("fixture mapping write failed")
      expect(cas).toHaveBeenCalledTimes(1)
      expect(mapping("throw")).toEqual(beforeMapping)
      const after = readSidecar()
      expect(after.resources[resourceKey(current)]).toEqual(beforeSidecar.resources[resourceKey(current)])
      expect(after.resources[resourceKey(previous)]?.state).toBe("live")
      expect(after.resources[resourceKey(previous)]?.generation).toMatch(/^r:/)
      expect((await runGc([], options)).deleted).toBe(0)
    } finally {
      cas.mockRestore()
    }
  })

  it("retains matching ownership and issued fences after a successful mapping rename reports failure", async () => {
    const current = locator("rename-current")
    const previous = locator("rename-previous")
    storePair("rename", current, previous)
    const rename = fs.renameSync
    let fault = true
    const boundary = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination)
      if (fault && destination === join(storeDir, "sessions.json")) {
        fault = false
        throw new Error("fixture post-rename publication failure")
      }
    })
    try {
      await expect(enrollLegacyMappedTranscripts(options)).rejects.toThrow("fixture post-rename publication failure")
      expect(fault).toBe(false)
      const published = mapping("rename")
      const sidecar = readSidecar()
      for (const field of ["currentTranscript", "previousTranscript"] as const) {
        const attached = published[field]
        expect(attached?.lifecycleGeneration).toBe(sidecar.resources[resourceKey(attached!)]?.generation)
        expect(attached?.lifecycleGeneration).toMatch(/^r:/)
      }
      expect((await runGc([], options)).deleted).toBe(0)
      expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
      expect(readSidecar()).toEqual(sidecar)
    } finally {
      boundary.mockRestore()
    }
  })

  it("preserves the rollback failure cause and does not retry cleanup after an exact CAS rejection", async () => {
    const target = locator("rollback-failure")
    storeMapping("rollback-failure", target)
    const rename = fsAsync.rename
    let writes = 0
    const boundary = spyOn(fsAsync, "rename").mockImplementation(async (source, destination) => {
      if (destination === join(storeDir, "session-gc.json") && ++writes === 2) {
        throw new Error("fixture ownership rollback failure")
      }
      await rename(source, destination)
    })
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockReturnValue(false)
    try {
      let rejected: unknown
      try { await enrollLegacyMappedTranscripts(options) }
      catch (error) { rejected = error }
      expect(rejected).toBeInstanceOf(Error)
      expect((rejected as Error).message).toBe("legacy enrollment CAS was rejected; ownership rollback failed")
      expect((rejected as Error).cause).toMatchObject({ message: "fixture ownership rollback failure" })
      expect(writes).toBe(2)
      expect(mapping("rollback-failure").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(readSidecar().resources[resourceKey(target)]?.generation).toMatch(/^r:/)
      expect((await runGc([], options)).deleted).toBe(0)
    } finally {
      cas.mockRestore()
      boundary.mockRestore()
    }
  })

  it("keeps publication and writer leases intact during enrollment and subsequent eviction", async () => {
    const target = await prepareForkForPublication(locator("leased-legacy"), options)
    const writer = await acquireActiveTranscriptLease([target], options)
    const leases = readSidecar().resources[resourceKey(target)]?.activeLeases
    expect(Object.keys(leases ?? {})).toHaveLength(2)
    storeMapping("leased", physical(target))

    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    expect(readSidecar().resources[resourceKey(target)]?.activeLeases).toEqual(leases)
    expect(mapping("leased").currentTranscript?.lifecycleGeneration).toBe(target.lifecycleGeneration)
    sessionStore.evictSharedSession("leased")
    expect((await runGc([], options)).deleted).toBe(0)
    await releaseActiveTranscriptLease(writer, options)
    expect((await runGc([], options)).deleted).toBe(0)
    await abandonFork(target, options)
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual([target.sessionId])
  })

  for (const state of ["prepared", "retired"] as const) {
    it(`attaches an existing ${state} resource without altering its ownership state or generation`, async () => {
      const target = state === "prepared"
        ? await prepareFork(locator(`existing-${state}`), options)
        : await registerLiveTranscript(locator(`existing-${state}`), options)
      if (state === "retired") await abandonFork(target, options)
      const beforeCounters = readSidecar().meta.fenceSlots
      storeMapping("existing", physical(target))

      expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
      expect(mapping("existing").currentTranscript?.lifecycleGeneration).toBe(target.lifecycleGeneration)
      expect(readSidecar().resources[resourceKey(target)]?.state).toBe(state)
      expect(readSidecar().meta.fenceSlots).toEqual(beforeCounters)
      expect((await runGc([], options)).deleted).toBe(0)
      expect(readSidecar().resources[resourceKey(target)]?.state).toBe("live")
    })
  }

  for (const state of ["deleting", "deleted"] as const) {
    it(`keeps a ${state} resource fenced without changing its mapping, ownership or deletion count`, async () => {
      const target = await registerLiveTranscript(locator(`unsafe-${state}`), options)
      await abandonFork(target, options)
      const pending = Promise.withResolvers<void>()
      let deletionStarts = 0
      try {
        const result = await runGc([], state === "deleting" ? {
          ...options,
          deletionTimeoutMs: 10,
          deleter: async () => { deletionStarts++; await pending.promise },
        } : options)
        expect(result.deleted).toBe(state === "deleted" ? 1 : 0)
        expect(readSidecar().resources[resourceKey(target)]?.state).toBe(state)
        storeMapping("unsafe", physical(target))
        const beforeMapping = mapping("unsafe")
        const beforeSidecar = readSidecar()
        const beforeDeletes = deleted.length

        if (state === "deleting") expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
        else await expect(enrollLegacyMappedTranscripts(options)).rejects.toThrow(`from state ${state}`)
        expect(mapping("unsafe")).toEqual(beforeMapping)
        expect(readSidecar()).toEqual(beforeSidecar)
        expect(deleted).toHaveLength(beforeDeletes)
        expect(deletionStarts).toBe(state === "deleting" ? 1 : 0)
      } finally {
        pending.resolve()
      }
    })
  }

  it("preserves recorded aliases while canonicalizing ownership and pin identity", async () => {
    const configAlias = join(directory, "config-alias")
    const projectAlias = join(directory, "project-alias")
    symlinkSync(join(directory, "claude"), configAlias, process.platform === "win32" ? "junction" : "dir")
    symlinkSync(join(directory, "project"), projectAlias, process.platform === "win32" ? "junction" : "dir")
    const aliased = { sessionId: "aliased-legacy", configDir: configAlias, projectDir: projectAlias }
    storeMapping("aliased", aliased)

    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    const attached = mapping("aliased").currentTranscript
    expect(attached).toMatchObject(aliased)
    expect(readSidecar().resources[resourceKey(aliased)]?.locator).toEqual(physical(canonicalizeTranscriptLocator(attached!)))
    expect((await runGc([], options)).deleted).toBe(0)
  })

  it("bounds each batch by mappings and advances through the remaining eligible mappings", async () => {
    for (let index = 0; index < 3; index++) {
      storePair(`batch-${index}`, locator(`batch-current-${index}`), locator(`batch-previous-${index}`))
    }
    const bounded = { ...options, maxDeletesPerRun: 1 }

    for (let completed = 1; completed <= 3; completed++) {
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(1)
      const mappings = Object.values(sessionStore.readSessionStoreSnapshot())
      expect(mappings.filter(entry => entry.currentTranscript?.lifecycleGeneration)).toHaveLength(completed)
      expect(mappings.filter(entry => entry.previousTranscript?.lifecycleGeneration)).toHaveLength(completed)
      expect(Object.keys(readSidecar().resources)).toHaveLength(completed * 2)
    }
    expect(await enrollLegacyMappedTranscripts(bounded)).toBe(0)
  })

  it("continues other selected mappings after one CAS loss without retaining the rejected ownership", async () => {
    storeMapping("first", locator("cas-loss"))
    storeMapping("second", locator("cas-success"))
    const attach = sessionStore.attachLegacyTranscriptGenerations
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation((key, expected, locators) =>
      key === "first" ? false : attach(key, expected, locators))
    try {
      expect(await enrollLegacyMappedTranscripts({ ...options, maxDeletesPerRun: 2 })).toBe(1)
      expect(cas).toHaveBeenCalledTimes(2)
      expect(mapping("first").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(mapping("second").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
      expect(Object.values(readSidecar().resources).map(entry => entry.locator.sessionId)).toEqual(["cas-success"])
    } finally {
      cas.mockRestore()
    }
  })

  it("limits explicit enrollment to the named mapping keys", async () => {
    storeMapping("outside", locator("outside-request-snapshot"))
    storeMapping("requested", locator("requested-snapshot"))

    expect(await enrollLegacyMappedTranscripts(options, ["requested", "absent"])).toBe(1)
    expect(mapping("outside").currentTranscript?.lifecycleGeneration).toBeUndefined()
    expect(mapping("requested").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
    expect(Object.values(readSidecar().resources).map(entry => entry.locator.sessionId)).toEqual(["requested-snapshot"])
  })

  it("rejects generation attachment which substitutes the recorded session, config root or project", () => {
    const target = locator("recorded-identity")
    storeMapping("authority", target)
    const before = mapping("authority")
    const expected = sessionStore.getStoredSessionGeneration(before, "authority")
    const substitutions = [
      { ...target, sessionId: "different-session" },
      { ...target, configDir: join(directory, "different-root") },
      { ...target, projectDir: join(directory, "different-project") },
    ]
    for (const substitution of substitutions) {
      expect(sessionStore.attachLegacyTranscriptGenerations("authority", expected, {
        currentTranscript: { ...substitution, lifecycleGeneration: `r:${resourceKey(substitution)}:1` },
      })).toBe(false)
      expect(mapping("authority")).toEqual(before)
    }
    expect(readSidecar().resources).toEqual({})
  })

  it("skips exact priority rollback authorities without starving another bounded candidate", async () => {
    storeMapping("work:rollback", locator("rollback-authority"))
    const routed = locator("current-route")
    storeMapping("work:routed", routed)
    storeMapping("ordinary", locator("ordinary-legacy"))
    const protectedMapping = mapping("work:rollback")
    const routedMapping = mapping("work:routed")
    const ownerToken = randomUUID()
    const metadata = {
      version: 3,
      slots: {},
      priorityAssignments: {
        "route-a": {
          profileId: "work",
          lastHumanTurnDigest: "A".repeat(43),
          lastHumanTurnIssuedAt: 1,
          mappingKey: "work:routed",
          mappingGeneration: sessionStore.getStoredSessionGeneration(routedMapping, "work:routed"),
          generationId: randomUUID(),
          updatedAt: Date.now(),
        },
      },
      priorityAttempts: {
        "route-a": {
          blocked: false,
          blockedTurnDigest: null,
          blockedTurnIssuedAt: null,
          pendingTurnDigest: "B".repeat(43),
          pendingTurnIssuedAt: 2,
          ownerToken,
          generationId: randomUUID(),
          updatedAt: Date.now(),
        },
      },
      priorityRollbackMappings: {
        "route-a": {
          mappingKey: "work:rollback",
          mappingGeneration: sessionStore.getStoredSessionGeneration(protectedMapping, "work:rollback"),
        },
      },
    }
    const writeMetadata = (): void => {
      writeFileSync(join(storeDir, "sessions.json"), JSON.stringify({
        ...sessionStore.readSessionStoreSnapshot(),
        "\u0000meridian-session-store": metadata,
      }), { mode: 0o600 })
    }
    writeMetadata()
    const beforeRollbackEnrollment = mapping("work:rollback")
    const beforeRoutedEnrollment = mapping("work:routed")

    expect(await enrollLegacyMappedTranscripts({ ...options, maxDeletesPerRun: 1 })).toBe(1)
    expect(mapping("work:rollback")).toEqual(beforeRollbackEnrollment)
    expect(mapping("work:routed")).toEqual(beforeRoutedEnrollment)
    expect(mapping("ordinary").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
    expect(readSidecar().resources[resourceKey(locator("rollback-authority"))]).toBeUndefined()
    expect(readSidecar().resources[resourceKey(routed)]).toBeUndefined()
    expect(await enrollLegacyMappedTranscripts(options, ["work:rollback"])).toBe(0)
    expect(await enrollLegacyMappedTranscripts(options, ["work:routed"])).toBe(0)

    const document = JSON.parse(readFileSync(join(storeDir, "sessions.json"), "utf8")) as Record<string, unknown>
    expect(document["\u0000meridian-session-store"]).toMatchObject({
      priorityAssignments: metadata.priorityAssignments,
      priorityAttempts: metadata.priorityAttempts,
      priorityRollbackMappings: metadata.priorityRollbackMappings,
    })
    expect(durablePins().find(entry => entry.sessionId === protectedMapping.claudeSessionId)).toEqual(beforeRollbackEnrollment.currentTranscript)
    // Maintenance left the exact request authority intact, so its pending
    // publication can still finalize with the captured mapping and route CAS.
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    expect(sessionStore.finalizeSharedSessionAndPriorityAssignment({
      key: "work:routed",
      routeKey: "route-a",
      expectedMappingGeneration: sessionStore.getStoredSessionGeneration(routedMapping, "work:routed"),
      expectedAssignmentGeneration: sessionStore.getPriorityAssignmentGeneration(metadata.priorityAssignments["route-a"], "route-a"),
      rollbackMappingKey: "work:rollback",
      attemptOwnerToken: ownerToken,
    })).toBe(true)
    expect(mapping("work:rollback")).toEqual(beforeRollbackEnrollment)
    expect(await enrollLegacyMappedTranscripts(options)).toBe(2)
    expect(mapping("work:rollback").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
    expect(mapping("work:routed").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
  })

  it("rolls back a partially enrolled pair when the ownership capacity cannot hold both locators", async () => {
    storePair("capacity", locator("capacity-current"), locator("capacity-previous"))
    const beforeMapping = mapping("capacity")
    const beforeSidecar = readSidecar()

    await expect(enrollLegacyMappedTranscripts({ ...options, maxOwned: 1 })).rejects.toBeInstanceOf(SessionLifecycleBacklogError)
    expect(mapping("capacity")).toEqual(beforeMapping)
    expect(readSidecar()).toEqual(beforeSidecar)
  })

  it("rejects a count-cap write when every victim is unenrolled, then admits it after enrollment", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    const legacy = locator("count-protected")
    const replacement = await registerLiveTranscript(locator("count-replacement"), options)
    storeMapping("legacy", legacy)
    const before = mapping("legacy")

    expect(publishMapping("replacement", replacement)).toBe(false)
    expect(mapping("legacy")).toEqual(before)
    expect(sessionStore.readSessionStoreSnapshot()["replacement"]).toBeUndefined()
    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    expect(publishMapping("replacement", replacement)).not.toBe(false)
    expect(sessionStore.readSessionStoreSnapshot()["legacy"]).toBeUndefined()
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual([legacy.sessionId])
  })

  it("evicts a modern victim while retaining an older unenrolled mapping at the count cap", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
    storeMapping("old-legacy", locator("old-protected"))
    const modern = await registerLiveTranscript(locator("modern-victim"), options)
    const newest = await registerLiveTranscript(locator("modern-newest"), options)
    storeMapping("modern", modern)
    storeMapping("newest", newest)

    expect(Object.keys(sessionStore.readSessionStoreSnapshot()).sort()).toEqual(["newest", "old-legacy"])
    expect(mapping("old-legacy").currentTranscript?.lifecycleGeneration).toBeUndefined()
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual([modern.sessionId])
  })

  it("retains count-cap protection when enrollment loses its mapping CAS", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    storeMapping("uncertain", locator("uncertain-legacy"))
    const before = mapping("uncertain")
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation(() => false)
    try {
      expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
      const replacement = await registerLiveTranscript(locator("rejected-replacement"), options)
      expect(publishMapping("replacement", replacement)).toBe(false)
      expect(mapping("uncertain")).toEqual(before)
      expect(readSidecar().resources[resourceKey(locator("uncertain-legacy"))]).toBeUndefined()
    } finally {
      cas.mockRestore()
    }
  })

  it("protects a modern mapping whose only unenrolled locator is its predecessor", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    const previous = locator("previous-only-legacy")
    const current = await registerLiveTranscript(locator("current-already-owned"), options)
    const replacement = await registerLiveTranscript(locator("previous-replacement"), options)
    storePair("conversation", current, previous)

    expect(publishMapping("replacement", replacement)).toBe(false)
    expect(mapping("conversation").currentTranscript).toEqual(current)
    expect(mapping("conversation").previousTranscript?.lifecycleGeneration).toBeUndefined()
    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    expect(publishMapping("replacement", replacement)).not.toBe(false)
    expect((await runGc([], options)).deleted).toBe(2)
    expect(deleted.map(entry => entry.sessionId).sort()).toEqual([current.sessionId, previous.sessionId].sort())
  })

  it("rotates a bounded global batch past a repeated CAS loss in sorted mapping order", async () => {
    storeMapping("z-later", locator("rotating-later"))
    storeMapping("a-lost", locator("rotating-lost"))
    const cursor: NonNullable<SessionLifecycleOptions["legacyEnrollmentCursor"]> = {}
    const bounded = { ...options, maxDeletesPerRun: 1, legacyEnrollmentCursor: cursor }
    const attach = sessionStore.attachLegacyTranscriptGenerations
    const attempted: string[] = []
    const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation((key, expected, locators) => {
      attempted.push(key)
      return key === "a-lost" ? false : attach(key, expected, locators)
    })
    try {
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(0)
      expect(cursor.afterMappingKey).toBe("a-lost")
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(1)
      expect(cursor.afterMappingKey).toBe("z-later")
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(0)
      expect(attempted).toEqual(["a-lost", "z-later", "a-lost"])
      expect(mapping("a-lost").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(mapping("z-later").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
    } finally {
      cas.mockRestore()
    }
  })

  it("rotates past an unjoined deletion claim without changing its fence", async () => {
    const target = await registerLiveTranscript(locator("cursor-deleting"), options)
    await abandonFork(target, options)
    const pending = Promise.withResolvers<void>()
    try {
      await runGc([], { ...options, deletionTimeoutMs: 10, deleter: async () => pending.promise })
      const deleting = readSidecar().resources[resourceKey(target)]
      storeMapping("z-later", locator("cursor-after-deleting"))
      storeMapping("a-deleting", physical(target))
      const cursor: NonNullable<SessionLifecycleOptions["legacyEnrollmentCursor"]> = {}
      const bounded = { ...options, maxDeletesPerRun: 1, legacyEnrollmentCursor: cursor }

      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(0)
      expect(cursor.afterMappingKey).toBe("a-deleting")
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(1)
      expect(mapping("z-later").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
      expect(mapping("a-deleting").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(readSidecar().resources[resourceKey(target)]).toEqual(deleting)
    } finally {
      pending.resolve()
    }
  })

  it("does not consume or change the global cursor during identity-scoped enrollment", async () => {
    storeMapping("a-outside", locator("cursor-outside"))
    storeMapping("z-requested", locator("cursor-requested"))
    const cursor = { afterMappingKey: "a-outside" }

    expect(await enrollLegacyMappedTranscripts({ ...options, legacyEnrollmentCursor: cursor }, ["z-requested"])).toBe(1)
    expect(cursor).toEqual({ afterMappingKey: "a-outside" })
    expect(mapping("a-outside").currentTranscript?.lifecycleGeneration).toBeUndefined()
    expect(mapping("z-requested").currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
  })

  it("bounds profile-copy enrollment and retains later legacy victims until they can be enrolled", async () => {
    let clock = 1_000_000
    const time = spyOn(Date, "now").mockImplementation(() => clock++)
    try {
      storeMapping("work:copy-a", locator("old-copy-a"))
      storeMapping("work:copy-b", locator("old-copy-b"))
      storeMapping("copy-a", await registerLiveTranscript(locator("new-copy-a"), options))
      storeMapping("copy-b", await registerLiveTranscript(locator("new-copy-b"), options))
      const copies = { profileIds: ["work"], graceMs: 0, isConversationActive: () => false }
      const bounded = { ...options, maxDeletesPerRun: 1 }

      expect(await releaseSupersededProfileCopies(copies, bounded)).toBe(0)
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(1)
      expect(await releaseSupersededProfileCopies(copies, bounded)).toBe(1)
      expect(sessionStore.readSessionStoreSnapshot()["work:copy-a"]).toBeUndefined()
      expect(mapping("work:copy-b").currentTranscript?.lifecycleGeneration).toBeUndefined()
      expect(readSidecar().resources[resourceKey(locator("old-copy-b"))]).toBeUndefined()
      expect((await runGc([], options)).deleted).toBe(1)
      expect(await releaseSupersededProfileCopies(copies, bounded)).toBe(0)
      expect(await enrollLegacyMappedTranscripts(bounded)).toBe(1)
      expect(await releaseSupersededProfileCopies(copies, bounded)).toBe(1)
      expect(sessionStore.readSessionStoreSnapshot()["work:copy-b"]).toBeUndefined()
      expect((await runGc([], options)).deleted).toBe(1)
      expect(deleted.map(entry => entry.sessionId).sort()).toEqual(["old-copy-a", "old-copy-b"])
      expect(Object.keys(sessionStore.readSessionStoreSnapshot()).sort()).toEqual(["copy-a", "copy-b"])
    } finally {
      time.mockRestore()
    }
  })

  it("refuses a new priority publication at the protected cap, then admits it after legacy enrollment", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    storeMapping("unrelated", locator("priority-protected-legacy"))
    const target = await registerLiveTranscript(locator("priority-new"), options)
    const before = mapping("unrelated")
    const initialMapping = sessionStore.lookupSharedSessionResult("work:priority")
    const initialRoute = sessionStore.lookupPriorityAssignmentResult("priority-route")
    if (initialMapping.status === "error") throw initialMapping.error
    if (initialRoute.status === "error") throw initialRoute.error
    if (!initialMapping.generation) throw new Error("fixture absence lacks mapping generation")
    const publicationOptions = {
      key: "work:priority", claudeSessionId: target.sessionId,
      messageCount: 1, lineageHash: "priority-fixture", messageHashes: ["message"], messageBlockHashes: [["block"]],
      currentTranscript: target,
      expectedMappingGeneration: initialMapping.generation,
      priority: { routeKey: "priority-route", profileId: "work", lastHumanTurnDigest: "A".repeat(43),
        lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: initialRoute.generation },
    }
    expect(sessionStore.storeSharedSessionAndPriorityAssignment(publicationOptions)).toBe(false)
    expect(mapping("unrelated")).toEqual(before)
    expect(sessionStore.readSessionStoreSnapshot()["work:priority"]).toBeUndefined()
    expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
    const refreshedMapping = sessionStore.lookupSharedSessionResult("work:priority")
    const refreshedRoute = sessionStore.lookupPriorityAssignmentResult("priority-route")
    if (refreshedMapping.status === "error") throw refreshedMapping.error
    if (refreshedRoute.status === "error") throw refreshedRoute.error
    if (!refreshedMapping.generation) throw new Error("fixture absence lacks mapping generation")
    const publication = sessionStore.storeSharedSessionAndPriorityAssignment({
      ...publicationOptions,
      expectedMappingGeneration: refreshedMapping.generation,
      priority: { ...publicationOptions.priority, expectedAssignmentGeneration: refreshedRoute.generation },
    })
    expect(publication).not.toBe(false)
    if (!publication) throw new Error("enrolled priority publication unexpectedly rejected")
    expect(sessionStore.finalizeSharedSessionAndPriorityAssignment({
      key: "work:priority", routeKey: "priority-route",
      expectedMappingGeneration: publication.mappingGeneration,
      expectedAssignmentGeneration: publication.assignmentGeneration,
    })).toBe(true)
    expect(sessionStore.readSessionStoreSnapshot()["unrelated"]).toBeUndefined()
    expect(Object.keys(sessionStore.readSessionStoreSnapshot())).toHaveLength(1)
    expect((await runGc([], options)).deleted).toBe(1)
    expect(deleted.map(entry => entry.sessionId)).toEqual(["priority-protected-legacy"])
  })

  for (const mode of ["ordinary", "priority"] as const) {
    const publish = mode === "ordinary" ? publishMapping : publishPriorityMapping

    it(`${mode} publication retains an unenrolled predecessor until ownership enrollment succeeds`, async () => {
      const key = "work:protected-predecessor"
      const current = locator("guard-current")
      const previous = locator("guard-previous")
      const target = await registerLiveTranscript(locator("guard-new-target"), options)
      storePair(key, current, previous)
      expect(publishPriorityMapping(key, current)).not.toBe(false)
      const before = readFileSync(join(storeDir, "sessions.json"), "utf8")
      const beforeSidecar = readSidecar()

      expect(publish(key, target, 17)).toBe(false)
      expect(readFileSync(join(storeDir, "sessions.json"), "utf8")).toBe(before)
      expect(mapping(key).previousTranscript).toEqual(previous)
      expect(readSidecar()).toEqual(beforeSidecar)

      expect(await enrollLegacyMappedTranscripts(options)).toBe(1)
      const enrolled = mapping(key)
      expect(enrolled.currentTranscript?.lifecycleGeneration).toMatch(/^r:/)
      expect(enrolled.previousTranscript?.lifecycleGeneration).toMatch(/^r:/)
      expect(publish(key, target, 17)).not.toBe(false)
      expect(mapping(key).claudeSessionId).toBe(target.sessionId)
      expect(mapping(key).messageCount).toBe(17)
      expect(mapping(key).previousTranscript).toEqual(enrolled.currentTranscript)
      const route = sessionStore.lookupPriorityAssignmentResult(`${key}-route`)
      expect(route.status).toBe("found")
      if (route.status !== "found") throw new Error("fixture priority route disappeared")
      expect(route.assignment.mappingGeneration).toBe(sessionStore.getStoredSessionGeneration(mapping(key), key))
      expect((await runGc([], options)).deleted).toBe(1)
      expect(deleted.map(entry => entry.sessionId)).toEqual([previous.sessionId])
    })

    it(`${mode} publication still retains the predecessor after enrollment loses its exact mapping CAS`, async () => {
      const key = "work:cas-lost-predecessor"
      const current = locator("cas-guard-current")
      const previous = locator("cas-guard-previous")
      storePair(key, current, previous)
      expect(publishPriorityMapping(key, current)).not.toBe(false)
      const before = readFileSync(join(storeDir, "sessions.json"), "utf8")
      const beforeSidecar = readSidecar()
      const cas = spyOn(sessionStore, "attachLegacyTranscriptGenerations").mockImplementation(() => false)
      try {
        expect(await enrollLegacyMappedTranscripts(options)).toBe(0)
        expect(publish(key, locator("cas-guard-new-target"), 17)).toBe(false)
        expect(readFileSync(join(storeDir, "sessions.json"), "utf8")).toBe(before)
        expect(readSidecar()).toEqual(beforeSidecar)
        expect(mapping(key).previousTranscript).toEqual(previous)
        expect(deleted).toEqual([])
      } finally {
        cas.mockRestore()
      }
    })

    it(`${mode} same-ID metadata publication preserves an unenrolled predecessor`, () => {
      const key = "work:same-id-predecessor"
      const current = locator("same-id-current")
      const previous = locator("same-id-previous")
      storePair(key, current, previous)
      expect(publishPriorityMapping(key, current)).not.toBe(false)
      const before = mapping(key)

      expect(publish(key, current, 17)).not.toBe(false)
      expect(mapping(key).claudeSessionId).toBe(current.sessionId)
      expect(mapping(key).previousClaudeSessionId).toBe(previous.sessionId)
      expect(mapping(key).previousTranscript).toEqual(before.previousTranscript)
      expect(mapping(key).previousTranscript?.lifecycleGeneration).toBeUndefined()
      expect(mapping(key).messageCount).toBe(17)
      expect(readSidecar().resources).toEqual({})
    })
  }
})
