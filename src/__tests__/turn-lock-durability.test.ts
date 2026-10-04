import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const roots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()
afterEach(async () => {
  for (const child of children) {
    child.kill()
    await child.exited
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const worker = String.raw`
import { mock } from "bun:test"
import * as fs from "node:fs/promises"
const original = { ...fs }
const root = process.env.LOCK_ROOT
const trace = []
let injected = false
mock.module("node:fs/promises", () => ({
  ...original,
  async open(path, ...args) {
    const handle = await original.open(path, ...args)
    const kind = String(path) === root ? "root"
      : String(path).endsWith("/owner.json") ? "owner"
      : String(path).includes(".candidate-") ? "candidate" : "other"
    return new Proxy(handle, { get(target, key) {
      if (key === "sync") return async () => {
        trace.push(kind + "-sync")
        if (!injected && process.env.FAIL_SYNC === kind) {
          injected = true
          throw Object.assign(new Error("Injected durability failure"), { code: "EIO" })
        }
        return target.sync()
      }
      if (key === "writeFile") return async (...data) => {
        trace.push(kind + "-write")
        return target.writeFile(...data)
      }
      if (key === "close") return async () => {
        trace.push(kind + "-close")
        return target.close()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
  },
  async rename(from, to) {
    await original.rename(from, to)
    if (String(from).includes(".candidate-") && String(to).endsWith(".lock")) trace.push("published")
  },
}))
const { CrossProcessTurnCoordinator } = await import(process.env.COORDINATOR_MODULE)
const coordinator = new CrossProcessTurnCoordinator(root, { acquireTimeoutMs: 200 })
let acquired = false, errorCode = null, errorName = null
try {
  const lease = await coordinator.acquire("durability-control")
  acquired = true
  trace.push("returned")
  await lease.release()
} catch (error) {
  errorCode = error.code ?? null
  errorName = error.name
}
const residueAfterAttempt = await original.readdir(root)
let acquiredAfterFailure = false
if (process.env.FAIL_SYNC) {
  const next = await coordinator.acquire("durability-control")
  acquiredAfterFailure = true
  await next.release()
}
console.log(JSON.stringify({ trace, acquired, errorCode, errorName, injected, residueAfterAttempt, acquiredAfterFailure }))
`

interface Result {
  trace: string[]
  acquired: boolean
  errorCode: string | null
  errorName: string | null
  injected: boolean
  residueAfterAttempt: string[]
  acquiredAfterFailure: boolean
}

async function runControl(failSync?: string): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "meridian-turn-durability-"))
  roots.push(root)
  const file = join(root, "worker.mjs")
  const locks = join(root, "locks")
  await writeFile(file, worker)
  const child = Bun.spawn([process.execPath, file], {
    env: { ...process.env, LOCK_ROOT: locks, FAIL_SYNC: failSync ?? "",
      COORDINATOR_MODULE: pathToFileURL(resolve(process.env.E2E_TURN_COORDINATOR_MODULE
        ?? "src/proxy/session/crossProcessTurnCoordinator.ts")).href },
    stdout: "pipe", stderr: "pipe",
  })
  children.add(child)
  const timer = setTimeout(() => child.kill(), 5_000)
  try {
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(error).toBe("")
    expect(code).toBe(0)
    const result: Result = JSON.parse(output)
    expect(await readdir(locks)).toEqual([])
    return result
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
    children.delete(child)
  }
}

test("flushes owner and candidate before publication, parent before returning a lease", async () => {
  const result = await runControl()
  expect(result.acquired).toBe(true)
  expect(result.errorName).toBeNull()
  const position = (event: string) => {
    const at = result.trace.indexOf(event)
    expect(at).toBeGreaterThanOrEqual(0)
    return at
  }
  expect(position("owner-write")).toBeLessThan(position("owner-sync"))
  expect(position("owner-sync")).toBeLessThan(position("owner-close"))
  expect(position("owner-close")).toBeLessThan(position("published"))
  if (process.platform !== "win32") {
    expect(position("candidate-sync")).toBeLessThan(position("published"))
    expect(position("published")).toBeLessThan(position("root-sync"))
    expect(position("root-sync")).toBeLessThan(position("returned"))
  }
  expect(result.residueAfterAttempt).toEqual([])
})

for (const phase of ["owner", "candidate", "root"]) {
  test.skipIf(process.platform === "win32" && phase !== "owner")(`fails closed and permits a later acquire after ${phase} fsync fails`, async () => {
    const result = await runControl(phase)
    expect(result.injected).toBe(true)
    expect(result.acquired).toBe(false)
    expect(result.errorCode).toBe("EIO")
    expect(result.residueAfterAttempt).toEqual([])
    expect(result.acquiredAfterFailure).toBe(true)
    if (phase !== "root") expect(result.trace.indexOf("returned")).toBe(-1)
  })
}
