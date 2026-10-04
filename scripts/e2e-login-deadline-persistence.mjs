/** Credentialless before/after gate; emulates the file backend, not native login. */
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mock } from "bun:test"

const script = fileURLToPath(import.meta.url)
const sourceRoot = resolve(process.env.E2E_SOURCE_ROOT || join(dirname(script), ".."))
if (process.argv[2] !== "worker") {
  const child = Bun.spawn([process.execPath, script, "worker"], {
    env: { ...process.env, E2E_SOURCE_ROOT: sourceRoot }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    process.exitCode = exit
  } finally { clearTimeout(timer) }
} else {
  const root = mkdtempSync(join(os.tmpdir(), "meridian-login-deadline-"))
  for (const key of Object.keys(process.env)) {
    if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
  }
  Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_NO_UPDATE_CHECK: "1" })
  mock.module("node:os", () => ({ ...os, platform: () => "linux" }))
  let nativeCalls = 0
  const refuseNative = () => { nativeCalls++; throw new Error("Unexpected native command in synthetic exchange gate") }
  mock.module("node:child_process", () => ({ ...childProcess,
    exec: refuseNative, execSync: refuseNative, execFile: refuseNative, execFileSync: refuseNative,
    spawn: refuseNative, spawnSync: refuseNative, fork: refuseNative,
  }))
  const load = relative => import(pathToFileURL(join(sourceRoot, relative)).href)
  const { setLoggerMock } = await load("src/__tests__/loggerMock.ts")
  setLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context, fn) => fn() }))
  let sdkCalls = 0
  const { setSdkMock } = await load("src/__tests__/sdkMock.ts")
  setSdkMock(() => ({ query: () => { sdkCalls++; throw new Error("Unexpected SDK query") } }), "login-deadline-gate")
  const { exchangeAuthorizationCodeForCredentials } = await load("src/proxy/profileCli.ts")
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error("Unexpected network request outside injected exchange") }
  const originalWarn = console.warn
  const originalError = console.error
  const diagnostics = []
  console.warn = (...values) => diagnostics.push(values.join(" "))
  console.error = (...values) => diagnostics.push(values.join(" "))
  const dir = join(root, "profile")
  mkdirSync(dir)
  const file = join(dir, ".credentials.json")
  const base = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
    scope: "user:profile user:inference" }
  let tokenRequests = 0
  const exchange = (metadata, claudeConfigDir = dir) => {
    const fetchFn = Object.assign(async input => {
      if (String(input) === "https://platform.claude.com/v1/oauth/token") {
        tokenRequests++
        return Response.json({ ...base, ...metadata })
      }
      assert.equal(String(input), "https://api.anthropic.com/api/oauth/profile", "Unexpected upstream URL")
      return Response.json({ organization: { organization_type: "claude_team", seat_tier: "team_tier_1" } })
    }, { preconnect: originalFetch.preconnect })
    return exchangeAuthorizationCodeForCredentials({ code: "synthetic-code", returnedState: "synthetic-state",
      sessionState: "synthetic-state", codeVerifier: "synthetic-verifier", claudeConfigDir, fetchFn })
  }
  const stored = () => JSON.parse(readFileSync(file, "utf8")).claudeAiOauth
  let assertions = 0
  try {
    const before = Date.now()
    assert.deepEqual(await exchange({ refresh_token_expires_in: 29 * 86400 }), { ok: true })
    const relative = stored()
    assert(relative.refreshTokenExpiresAt >= before + 29 * 86400 * 1000
      && relative.refreshTokenExpiresAt <= Date.now() + 29 * 86400 * 1000,
    "Token exchange dropped the provider refresh deadline")
    assert.equal(relative.accessToken, base.access_token)
    assert.equal(relative.refreshToken, base.refresh_token)
    assert.deepEqual(relative.scopes, ["user:profile", "user:inference"])
    assert.equal(relative.subscriptionType, "team")
    assert.equal(relative.seatTier, "team_tier_1")
    assert(!readFileSync(file, "utf8").includes("\n"), "Credential format stopped being compact")
    assertions += 8

    const absolute = Date.now() + 28 * 86400 * 1000
    assert.deepEqual(await exchange({ refresh_token_expires_at: absolute, refresh_token_expires_in: 29 * 86400 }), { ok: true })
    assert.equal(stored().refreshTokenExpiresAt, absolute, "Absolute refresh deadline lost precedence")
    assertions += 2

    // Reusing the same profile/store with absent or malformed new metadata must
    // replace the old credential without reviving its old login deadline.
    for (const metadata of [{}, { refresh_token_expires_in: "3600" }, { refresh_token_expires_in: 0 },
      { refresh_token_expires_in: -1 }, { refresh_token_expires_in: 1e100 },
      { refresh_token_expires_at: Date.now() / 1000, refresh_token_expires_in: 3600 },
      { refresh_token_expires_at: 1e100 }]) {
      assert.deepEqual(await exchange({ refresh_token_expires_at: absolute }), { ok: true })
      assert.equal(stored().refreshTokenExpiresAt, absolute, "Replacement control did not start from a known prior deadline")
      assert.deepEqual(await exchange(metadata), { ok: true })
      assert(!("refreshTokenExpiresAt" in stored()), "Invalid/absent metadata retained a previous login deadline")
      assertions += 4
    }

    const unchanged = readFileSync(file, "utf8")
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    assert.deepEqual(await exchange({ refresh_token_expires_in: 86400 }), { ok: false, reason: "write_failed" })
    assert.equal(readFileSync(file, "utf8"), unchanged, "Read-only exchange wrote credentials")
    assert(diagnostics.some(text => text.includes("REFUSED credential write")), "Read-only refusal lost its existing diagnostic")
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    const blocked = join(root, "blocked")
    writeFileSync(blocked, "foreign sentinel")
    assert.deepEqual(await exchange({ refresh_token_expires_in: 86400 }, join(blocked, "profile")),
      { ok: false, reason: "write_failed" })
    assert.equal(readFileSync(blocked, "utf8"), "foreign sentinel")
    assert(!diagnostics.some(text => /synthetic-access|synthetic-refresh|synthetic-code|synthetic-verifier/.test(text)),
      "Credential values reached diagnostics")
    assert(!existsSync(join(root, "config", "auth-lifecycle.json")), "Exchange added unapproved auth history")
    assert.equal(nativeCalls, 0)
    assert.equal(sdkCalls, 0)
    assertions += 9
    console.log(JSON.stringify({ result: "PASS", controls: 11, assertions, tokenRequests, nativeCalls, sdkCalls,
      backend: "emulated-file", actualProvider: false }))
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    console.error = originalError
    rmSync(root, { recursive: true, force: true })
  }
}
