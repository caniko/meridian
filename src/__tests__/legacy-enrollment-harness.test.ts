import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

// The real harness stops at a synthetic module import, before executable
// resolution or any query. Only a generated credential-shaped fixture is read.
describe("legacy enrollment native harness authority", () => {
  let directory: string
  let source: string
  let checkout: string
  let auditPath: string
  let runtime: string | undefined
  const harness = resolve(import.meta.dir, "../../scripts/e2e-legacy-transcript-enrollment.mjs")
  const bytes = Buffer.from('{"syntheticGrant":"fixture-only-no-auth"}\n')

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "legacy-enrollment-harness-authority-"))
    source = join(directory, "immutable-grant")
    checkout = join(directory, "synthetic-checkout")
    auditPath = join(directory, "audit.json")
    mkdirSync(source)
    mkdirSync(join(checkout, "src/proxy"), { recursive: true })
    writeFileSync(join(source, ".credentials.json"), bytes, { mode: 0o400 })
    writeFileSync(join(checkout, "src/proxy/server.ts"), `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const runtime = process.env.CLAUDE_CONFIG_DIR;
      const source = process.env.E2E_CLAUDE_CONFIG_DIR;
      writeFileSync(process.env.E2E_HARNESS_AUDIT_PATH, JSON.stringify({
        runtime, distinct: runtime !== source,
        readonly: process.env.MERIDIAN_CREDENTIALS_READONLY,
        sourceUnchanged: readFileSync(join(source, '.credentials.json')).equals(
          Buffer.from(${JSON.stringify(bytes.toString())})),
        copied: readFileSync(join(runtime, '.credentials.json')).equals(
          readFileSync(join(source, '.credentials.json'))),
        authOverridesAbsent: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE']
          .every(key => process.env[key] === undefined),
      }));
      throw new Error('synthetic initialization stop before CLI/query');
    `)
  })

  afterEach(() => {
    if (runtime && existsSync(runtime)) {
      const ownedRoot = dirname(runtime)
      if (dirname(ownedRoot) === realpathSync(tmpdir()) && basename(ownedRoot).startsWith("meridian-legacy-transcript-e2e-")) {
        rmSync(ownedRoot, { recursive: true, force: true })
      }
    }
    runtime = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  it("uses an owned copy, forces readonly, clears auth overrides and removes safe initialization residue", () => {
    const result = spawnSync(process.execPath, [harness], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, E2E_CLAUDE_CONFIG_DIR: source, E2E_MERIDIAN_ROOT: checkout,
        E2E_HARNESS_AUDIT_PATH: auditPath, MERIDIAN_CREDENTIALS_READONLY: "0",
        CLAUDE_CONFIG_DIR: "/unused-inherited-account", ANTHROPIC_API_KEY: "synthetic-override",
        ANTHROPIC_AUTH_TOKEN: "synthetic-override", ANTHROPIC_BASE_URL: "http://unused.invalid",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-override", CLAUDECODE: "synthetic-override" },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("synthetic initialization stop before CLI/query")
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as { runtime: string; [key: string]: unknown }
    runtime = audit.runtime
    expect(audit).toMatchObject({ distinct: true, readonly: "1", sourceUnchanged: true,
      copied: true, authOverridesAbsent: true })
    expect(existsSync(runtime)).toBe(false)
    expect(readFileSync(join(source, ".credentials.json"))).toEqual(bytes)
    expect(result.stdout).not.toContain(bytes.toString())
    expect(result.stderr).not.toContain(bytes.toString())
  })

  it("requires a selected immutable snapshot before importing a proxy or looking up native auth", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_MERIDIAN_ROOT: checkout, E2E_HARNESS_AUDIT_PATH: auditPath }
    delete env.E2E_CLAUDE_CONFIG_DIR
    const result = spawnSync(process.execPath, [harness], { env, encoding: "utf8", timeout: 10_000 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("no native-account fallback")
    expect(existsSync(auditPath)).toBe(false)
    expect(readFileSync(join(source, ".credentials.json"))).toEqual(bytes)
  })
})
