import { expect, it } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

it("the four profile expiry fields preserve HTTP identity, auth and credential boundaries", async () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
  const child = Bun.spawn([process.execPath, join(sourceRoot, "scripts/e2e-profile-expiry-fields.mjs")], {
    env: { ...process.env, E2E_SOURCE_ROOT: sourceRoot }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 35_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    const result = JSON.parse(stdout) as { result: string; actualNative: boolean; actualProvider: boolean;
      assertions: number; controls: Array<{ exit: number; result: { nativeCalls: number; sdkCalls: number; networkCalls: number } }> }
    expect(result).toMatchObject({ result: "PASS", actualNative: false, actualProvider: false })
    expect(result.controls).toHaveLength(8)
    expect(result.assertions).toBeGreaterThan(100)
    expect(result.controls.every(control => control.exit === 0 && control.result.nativeCalls === 0
      && control.result.sdkCalls === 0 && control.result.networkCalls === 0)).toBe(true)
  } finally { clearTimeout(timer) }
}, 40_000)
