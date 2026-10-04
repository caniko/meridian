import { expect, it } from "bun:test"
import { dirname, join } from "node:path"

it("the shared synthetic token exchange persists deadlines and retains write/isolation boundaries", async () => {
  const sourceRoot = join(dirname(import.meta.dir), "..")
  const child = Bun.spawn([process.execPath, join(sourceRoot, "scripts/e2e-login-deadline-persistence.mjs")], {
    env: { ...process.env, E2E_SOURCE_ROOT: sourceRoot }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ result: "PASS", controls: 11, nativeCalls: 0, sdkCalls: 0,
      backend: "emulated-file", actualProvider: false })
  } finally { clearTimeout(timer) }
}, 25_000)
