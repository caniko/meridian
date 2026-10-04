/**
 * Credentialless HTTP gate for the four profile-expiry fields approved in
 * #1270. Credential stores and native/SDK/network boundaries are injected;
 * this does not prove real Keychain, file-store, provider or client operation.
 * E2E_SOURCE_ROOT selects an unchanged checkout for the same before assertion.
 */
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mock, spyOn } from "bun:test"

const script = fileURLToPath(import.meta.url)
const sourceRoot = resolve(process.env.E2E_SOURCE_ROOT || join(dirname(script), ".."))
const scenarios = ["stores", "isolation", "presence", "timestamps", "warning", "replacement", "single-snapshot", "provenance"]
const scenario = process.argv[2]
if (!scenario) {
  const controls = []
  for (const name of scenarios) {
    const child = Bun.spawn([process.execPath, script, name], {
      env: { ...process.env, E2E_SOURCE_ROOT: sourceRoot }, stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      const result = stdout.trim() ? JSON.parse(stdout) : undefined
      controls.push({ scenario: name, exit, ...(result ? { result } : {}) })
      if (exit !== 0 || stderr !== "") {
        console.log(JSON.stringify({ result: "FAIL", controls }))
        process.stderr.write(stderr || "Profile expiry worker did not complete cleanly\n")
        process.exitCode = 1
        break
      }
    } finally { clearTimeout(timer) }
  }
  if (!process.exitCode) {
    console.log(JSON.stringify({ result: "PASS", controls,
      assertions: controls.reduce((total, control) => total + control.result.assertions, 0),
      actualNative: false, actualProvider: false }))
  }
} else {
  assert(scenarios.includes(scenario), "Unknown profile expiry scenario")
  const root = mkdtempSync(join(tmpdir(), "meridian-profile-expiry-"))
  const originalFetch = globalThis.fetch
  const restores = []
  let assertions = 0
  let requests = 0
  let nativeCalls = 0
  let sdkCalls = 0
  let networkCalls = 0
  const check = (condition, message) => { assertions++; assert(condition, message) }
  const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message) }
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
    }
    Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"),
      MERIDIAN_SESSION_DIR: join(root, "sessions"), MERIDIAN_TELEMETRY_PERSIST: "0",
      MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_CREDENTIALS_READONLY: "1" })
    // No platform emulation: the selected source loads its ordinary host binary.
    const refuseNative = () => { nativeCalls++; throw new Error("Unexpected native command in mock-store HTTP gate") }
    mock.module("node:child_process", () => ({ ...childProcess, exec: refuseNative, execSync: refuseNative,
      execFile: refuseNative, execFileSync: refuseNative, fork: refuseNative,
      spawn: refuseNative, spawnSync: refuseNative }))
    globalThis.fetch = () => { networkCalls++; throw new Error("Unexpected external request in mock-store HTTP gate") }
    const load = relative => import(pathToFileURL(join(sourceRoot, relative)).href)
    // Source build provenance normally probes git during import. That unrelated
    // boundary is a fixed fixture here so the native-command trap stays strict.
    mock.module(pathToFileURL(join(sourceRoot, "src/proxy/buildRuntime.ts")).href, () => ({
      buildRuntime: { local: false, info: () => ({ version: "synthetic", source: "npm" }), status: () => ({ state: "unknown" }) },
    }))
    const { setLoggerMock } = await load("src/__tests__/loggerMock.ts")
    setLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context, fn) => fn() }))
    const { setSdkMock } = await load("src/__tests__/sdkMock.ts")
    setSdkMock(() => ({ query: () => { sdkCalls++; throw new Error("Profile metadata must not query a model") },
      createSdkMcpServer: () => ({}), tool: () => ({}) }), "profile-expiry-fields-gate")
    const models = await load("src/proxy/models.ts")
    const tokens = await load("src/proxy/tokenRefresh.ts")
    const organizations = await load("src/proxy/organizationName.ts")
    const clock = Date.UTC(2026, 9, 4, 12)
    const DAY = 86_400_000
    const HOUR = 3_600_000
    const clockSpy = spyOn(Date, "now").mockReturnValue(clock)
    restores.push(() => clockSpy.mockRestore())
    const statusById = new Map()
    const cacheById = new Map()
    const stores = new Map()
    const requestedStores = []
    const authSpy = spyOn(models, "getClaudeAuthStatusAsync").mockImplementation(async id =>
      statusById.has(id ?? "default") ? statusById.get(id ?? "default") : { loggedIn: true })
    const cacheSpy = spyOn(models, "getAuthCacheInfo").mockImplementation(id =>
      cacheById.get(id ?? "default") ?? { lastCheckedAt: clock - 1000, lastSuccessAt: clock - 1000, isFailure: false })
    const storeSpy = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options => {
      const dir = options?.claudeConfigDir ?? "default"
      requestedStores.push(dir)
      check(stores.has(dir), "Profile selected an unregistered credential store")
      return stores.get(dir).store
    })
    const organizationSpy = spyOn(organizations, "refreshOrganizationNameSoon").mockImplementation(() => {})
    restores.push(() => authSpy.mockRestore(), () => cacheSpy.mockRestore(),
      () => storeSpy.mockRestore(), () => organizationSpy.mockRestore())
    const { createProxyServer } = await load("src/proxy/server.ts")
    const { resetActiveProfile } = await load("src/proxy/profiles.ts")
    const expiryFields = ["refreshTokenExpiresAt", "daysUntilRenewal", "renewalRequiredSoon", "accessTokenExpiresAt"]
    const historyFields = ["authObtainedAt", "authObtainedVia", "lastRefreshAt", "firstUnauthedAt", "unauthedReason"]
    const baseFields = ["id", "type", "isActive", "email", "subscriptionType", "organizationName", "rateLimitTier",
      "seatTier", "allowance", "allowanceWeight", "planLabel", "accountType", "planName", "loggedIn",
      "lastCheckedAt", "lastSuccessAt", "authProvenance", "credentialDir"]
    const credential = (deadline = clock + 2 * DAY, accessExpiry = clock + HOUR, accessToken = "synthetic-access") => ({
      claudeAiOauth: { accessToken, refreshToken: "synthetic-refresh", expiresAt: accessExpiry,
        ...(deadline !== undefined ? { refreshTokenExpiresAt: deadline } : {}),
        subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
    })
    const fixture = (name, value = credential()) => {
      const dir = name === "default" ? "default" : join(root, name)
      const state = { value, reads: 0, throws: false, reader: undefined }
      state.store = { refreshKey: `mock-store:${dir}`,
        read: async () => { state.reads++; if (state.throws) throw new Error("Synthetic store unavailable")
          return state.reader ? state.reader(state.reads) : state.value },
        write: async () => { throw new Error("Profile metadata must not write credentials") } }
      stores.set(dir, state)
      return { dir, state }
    }
    const profile = (id, dir, extras = {}) => ({ id, type: "claude-max", ...(dir !== "default" ? { claudeConfigDir: dir } : {}), ...extras })
    const open = profiles => {
      resetActiveProfile()
      return createProxyServer({ profiles, defaultProfile: profiles[0].id, silent: true }).app
    }
    const list = async (app, profiles) => {
      requests++
      const response = await app.fetch(new Request("http://localhost/profiles/list"))
      equal(response.status, 200, "Profile list route failed")
      const raw = await response.text()
      check(!/synthetic-access|synthetic-refresh/.test(raw), "Profile response leaked credential values")
      const body = JSON.parse(raw)
      equal(body.profiles.map(item => item.id), profiles.map(item => item.id), "Profile identity/order changed")
      equal(body.activeProfile, profiles[0].id, "Active profile identity changed")
      for (let i = 0; i < profiles.length; i++) {
        const item = body.profiles[i]
        const input = profiles[i]
        for (const field of expiryFields) check(Object.hasOwn(item, field), `Four-field expiry contract missing ${field}`)
        for (const field of historyFields) check(!Object.hasOwn(item, field), `Unapproved history field ${field} appeared`)
        equal(Object.keys(item).sort(), [...baseFields, ...expiryFields, ...(input.aliases ? ["aliases"] : [])].sort(),
          "Profile response changed fields beyond the four approved additions")
        equal(item.type, input.type ?? "claude-max", "Existing profile type changed")
        equal(item.isActive, i === 0, "Existing active-profile flag changed")
        if (input.aliases) equal(item.aliases, input.aliases, "Existing aliases changed")
      }
      check(!existsSync(join(root, "config", "auth-lifecycle.json")), "Profile polling persisted unapproved lifetime history")
      return body.profiles
    }
    const facts = (item, deadline, accessExpiry, warnDays = 3) => {
      const known = typeof deadline === "number" && Number.isFinite(deadline) && deadline > 0 && deadline <= 8.64e15
      const accessKnown = typeof accessExpiry === "number" && Number.isFinite(accessExpiry) && accessExpiry > 0 && accessExpiry <= 8.64e15
      // JSON serializes the ceil of a sub-day past expiry (-0) as ordinary 0.
      const rounded = known ? Math.ceil((deadline - clock) / DAY) : null
      const days = Object.is(rounded, -0) ? 0 : rounded
      equal(expiryFields.map(field => item[field]), [known ? deadline : null, days,
        known && days <= warnDays, accessKnown ? accessExpiry : null], "Current stored expiry facts were not reported together")
    }

    if (scenario === "stores") {
      const own = fixture("own", credential(clock + 9 * DAY, clock + HOUR))
      const shared = fixture("shared", credential(clock + 2 * DAY, clock + 2 * HOUR))
      const defaultStore = fixture("default", credential(clock + 5 * DAY, clock + 3 * HOUR))
      const profiles = [profile("own", own.dir, { aliases: ["former-own"] }), profile("shared-a", shared.dir),
        profile("shared-b", shared.dir), profile("default", defaultStore.dir)]
      const items = await list(open(profiles), profiles)
      facts(items[0], clock + 9 * DAY, clock + HOUR)
      facts(items[1], clock + 2 * DAY, clock + 2 * HOUR)
      facts(items[2], clock + 2 * DAY, clock + 2 * HOUR)
      facts(items[3], clock + 5 * DAY, clock + 3 * HOUR)
      equal(requestedStores, [own.dir, shared.dir, shared.dir, "default"], "Profiles did not resolve their own/shared/default store")
      for (const item of items) equal([item.loggedIn, item.authProvenance], [true, "live"], "Expiry metadata changed existing authentication")
      equal(items.map(item => item.credentialDir), [own.dir, shared.dir, shared.dir, null], "Credential-sharing identity changed")
    } else if (scenario === "isolation") {
      const profiles = [{ id: "api", type: "api", apiKey: "synthetic-api-key" },
        { id: "setup", type: "oauth-token", oauthToken: "synthetic-setup-token" },
        { id: "inferred-setup", oauthToken: "synthetic-setup-token" }]
      const items = await list(open(profiles), profiles)
      for (const item of items) { facts(item, undefined, undefined); equal(item.loggedIn, true, "Unrelated stored grant demoted supplied credentials")
        equal(item.credentialDir, null, "Supplied credential became shareable native state") }
      equal(requestedStores, [], "API/setup-token metadata accessed a native credential store")
      statusById.set("api", { loggedIn: false })
      const second = await list(open(profiles), profiles)
      equal(second[0].loggedIn, false, "Absent expiry facts made an unauthenticated API profile healthy")
      equal(requestedStores, [], "API/setup-token negative control accessed a native store")
    } else if (scenario === "presence") {
      for (const [name, value, throws, expected] of [["null", null, false, true], ["throws", null, true, true],
        ["empty", { claudeAiOauth: { accessToken: "", refreshToken: "synthetic-refresh", expiresAt: 0 } }, false, false],
        ["no-oauth", {}, false, false]]) {
        const { dir, state } = fixture(name, value)
        state.throws = throws
        const profiles = [profile(name, dir)]
        const [item] = await list(open(profiles), profiles)
        equal(item.loggedIn, expected, "Unknown stored state was confused with a successfully empty credential")
        equal(item.authProvenance, "live", "Store observation changed auth-status provenance")
        facts(item, undefined, undefined)
      }
    } else if (scenario === "timestamps") {
      const { dir, state } = fixture("timestamps")
      const profiles = [profile("timestamps", dir)]
      const app = open(profiles)
      for (const value of [undefined, null, "1791115200000", NaN, Infinity, -Infinity, 1e100, 8.64e15 + 1, 0, -1,
        clock - HOUR, clock + HOUR, clock + HOUR + 0.25, 8.64e15]) {
        state.value = credential(value, value)
        if (value === undefined) {
          delete state.value.claudeAiOauth.refreshTokenExpiresAt
          delete state.value.claudeAiOauth.expiresAt
        }
        const [item] = await list(app, profiles)
        facts(item, value, value)
        equal(item.loggedIn, true, "Timestamp metadata changed usable-token presence")
        equal(item.authProvenance, "live", "Timestamp metadata changed auth provenance")
      }
    } else if (scenario === "warning") {
      const { dir, state } = fixture("warning")
      const profiles = [profile("warning", dir)]
      const app = open(profiles)
      for (const [days, warnDays] of [[3, 3], [3 + 1 / DAY, 3], [2.5, 2.5], [2, 2.5], [0.5, 0],
        [0, 0], [-0.5, 0], [-1, 0], [1, 1.5], [1.5, 1.5]]) {
        process.env.MERIDIAN_AUTH_RENEWAL_WARN_DAYS = String(warnDays)
        state.value = credential(clock + days * DAY, clock + HOUR)
        const [item] = await list(app, profiles)
        facts(item, clock + days * DAY, clock + HOUR, warnDays)
        equal(item.loggedIn, true, "Expired renewal metadata marked a serving account logged out")
      }
    } else if (scenario === "replacement") {
      const { dir, state } = fixture("replacement", credential(clock + 29 * DAY))
      const profiles = [profile("stable", dir, { aliases: ["stable-old-name"] })]
      const app = open(profiles)
      for (const days of [29, 28, 28, 30, undefined]) {
        state.value = credential(days === undefined ? undefined : clock + days * DAY, clock + 2 * HOUR)
        if (days === undefined) delete state.value.claudeAiOauth.refreshTokenExpiresAt
        const [item] = await list(app, profiles)
        facts(item, days === undefined ? undefined : clock + days * DAY, clock + 2 * HOUR)
        equal([item.loggedIn, item.authProvenance, item.credentialDir], [true, "live", dir],
          "Credential replacement changed authentication or stable profile identity")
      }
    } else if (scenario === "single-snapshot") {
      const { dir, state } = fixture("snapshot", credential(clock + 29 * DAY))
      const profiles = [profile("snapshot", dir)]
      await tokens.getStoredPlanFields(state.store)
      state.reads = 0
      state.reader = count => count === 1 ? credential(clock + 2 * DAY, clock + HOUR)
        : credential(clock + 30 * DAY, clock + 2 * HOUR, "")
      const [item] = await list(open(profiles), profiles)
      equal(state.reads, 1, "Presence and the two expiries were read from different stored snapshots")
      facts(item, clock + 2 * DAY, clock + HOUR)
      equal(item.loggedIn, true, "A second store read demoted the first available snapshot")
    } else if (scenario === "provenance") {
      for (const [name, auth, cache, loggedIn, provenance] of [
        ["live-out", { loggedIn: false }, { lastCheckedAt: clock, lastSuccessAt: 0, isFailure: false }, false, "live"],
        ["cached", { loggedIn: true }, { lastCheckedAt: clock, lastSuccessAt: clock - HOUR, isFailure: true }, true, "cached"],
        ["never", null, { lastCheckedAt: clock, lastSuccessAt: 0, isFailure: true }, false, "never"],
      ]) {
        const { dir } = fixture(name, credential(clock - HOUR, clock + HOUR))
        statusById.set(name, auth)
        cacheById.set(name, cache)
        const profiles = [profile(name, dir)]
        const [item] = await list(open(profiles), profiles)
        equal([item.loggedIn, item.authProvenance], [loggedIn, provenance], "Expiry fields replaced existing auth evidence")
        equal([item.lastCheckedAt, item.lastSuccessAt], [cache.lastCheckedAt, cache.lastSuccessAt || null],
          "Existing auth check timestamps changed")
        facts(item, clock - HOUR, clock + HOUR)
      }
    }
    equal(nativeCalls, 0, "Mock-store HTTP gate executed a native command")
    equal(sdkCalls, 0, "Profile metadata reached the SDK/model")
    equal(networkCalls, 0, "Mock-store HTTP gate made an external request")
    console.log(JSON.stringify({ result: "PASS", scenario, requests, assertions, nativeCalls, sdkCalls, networkCalls,
      storeReads: [...stores.values()].reduce((total, state) => total + state.reads, 0),
      backend: "mock-store", actualNative: false, actualProvider: false }))
  } finally {
    for (const restore of restores.reverse()) restore()
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}
