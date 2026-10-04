/**
 * Unit tests for the SSE prelude scanner behind priority routing's
 * account-failure sniffer.
 *
 * The shipped sniffer decided on the first complete frame of any kind, so
 * the service's own `: ping\n\n` heartbeat (every 15s) — or a forwarded
 * `event: ping` keepalive — ahead of a quota refusal turned the refusal into
 * a client-visible rate_limit_error with the pool untouched. These tests pin
 * the pure decision semantics: keepalive frames never decide, the first
 * meaningful frame does, and framing survives chunk fragmentation and CRLF
 * terminators.
 */
import { describe, it, expect } from "bun:test"
import { nextSseFrame, classifySseFrame, SsePreludeScanner, relayStreamAttempt, createSseRelayStream, hasIncompleteUtf8Tail, type SseRelaySink } from "../proxy/sseFailureSniff"

const RATE_LIMIT = 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}\n\n'
const BILLING = 'event: error\ndata: {"type":"error","error":{"type":"billing_error","message":"inactive"}}\n\n'
const OVERLOADED = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n'
const PING = 'event: ping\ndata: {"type":"ping"}\n\n'
const HEARTBEAT = ": ping\n\n"
const MESSAGE_START = 'event: message_start\ndata: {"type":"message_start"}\n\n'

/** Emulates the server loop's decision timeline: feed chunks, scan complete
 *  frames from the last position, stop at the first meaningful one. */
function decide(chunks: string[]): "pending" | "keepalive-only" | "failover" | "passthrough" {
  let text = ""
  let scanFrom = 0
  for (const chunk of chunks) {
    text += chunk
    for (let next = nextSseFrame(text, scanFrom); next !== null; next = nextSseFrame(text, scanFrom)) {
      scanFrom = next.next
      const frame = classifySseFrame(next.frame)
      if (frame.kind === "keepalive") continue
      if (frame.kind === "error" && (frame.errorType === "rate_limit_error" || frame.errorType === "billing_error")) {
        return "failover"
      }
      return "passthrough"
    }
  }
  return "pending"
}

describe("nextSseFrame framing", () => {
  it("returns the first complete frame and the position past its terminator", () => {
    const text = `${HEARTBEAT}${RATE_LIMIT}`
    const first = nextSseFrame(text, 0)
    expect(first).toEqual({ frame: ": ping", next: HEARTBEAT.length })
    const second = nextSseFrame(text, first!.next)
    expect(second!.frame).toStartWith("event: error")
    expect(second!.next).toBe(text.length)
  })

  it("returns null while a frame is incomplete", () => {
    expect(nextSseFrame(": pi", 0)).toBeNull()
    expect(nextSseFrame(": ping\n", 0)).toBeNull()
    expect(nextSseFrame("event: error", 0)).toBeNull()
    expect(nextSseFrame("event: error\ndata: {}", 0)).toBeNull()
  })

  it("handles CRLF frame terminators", () => {
    const text = "event: error\r\ndata: {\"type\":\"error\"}\r\n\r\n tail"
    const frame = nextSseFrame(text, 0)
    expect(frame!.frame).toBe("event: error\r\ndata: {\"type\":\"error\"}")
    expect(frame!.next).toBe(text.indexOf(" tail"))
  })

  it("handles a CRLF terminator split across chunks (lone CR stays open)", () => {
    expect(nextSseFrame("event: error\r", 0)).toBeNull()
    // Once the rest arrives, the frame completes with the CRLF intact.
    const completed = nextSseFrame("event: error\r\n\r\nmore", 0)
    expect(completed!.frame).toBe("event: error")
    expect(completed!.next).toBe(16)
  })

  it("treats a lone CR as a line terminator (SSE spec)", () => {
    const frame = nextSseFrame("event: error\rdata: x\r\rz", 0)
    expect(frame!.frame).toBe("event: error\rdata: x")
  })

  it("yields consecutive zero-content frames without looping", () => {
    let scanFrom = 0
    const text = "\n\n\n: a\n\n: b\n\n"
    const frames: string[] = []
    for (let next = nextSseFrame(text, scanFrom); next !== null; next = nextSseFrame(text, scanFrom)) {
      frames.push(next.frame)
      scanFrom = next.next
    }
    expect(frames).toEqual(["", "", "", ": a", ": b"])
  })
})

describe("classifySseFrame verdicts", () => {
  it("heartbeat comments and empty frames are keepalive", () => {
    expect(classifySseFrame(": ping")).toEqual({ kind: "keepalive" })
    expect(classifySseFrame(": ping\n: keepalive")).toEqual({ kind: "keepalive" })
    expect(classifySseFrame("")).toEqual({ kind: "keepalive" })
  })

  it("a forwarded ping event is keepalive, not content", () => {
    expect(classifySseFrame('event: ping\ndata: {"type":"ping"}')).toEqual({ kind: "keepalive" })
  })

  it("error frames expose the parsed type and payload", () => {
    const verdict = classifySseFrame('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}')
    expect(verdict).toEqual({
      kind: "error",
      errorType: "rate_limit_error",
      payload: { type: "error", error: { type: "rate_limit_error" } },
    })
  })

  it("an error frame with unparseable data still decides, without a type", () => {
    expect(classifySseFrame("event: error\ndata: {oops")).toEqual({ kind: "error", errorType: null, payload: null })
    expect(classifySseFrame("event: error")).toEqual({ kind: "error", errorType: null, payload: null })
  })

  it("does not treat non-string JSON error types as account verdicts", () => {
    for (const payload of [null, 1, [], { error: null }, { error: { type: 429 } }, { error: { type: { value: "billing_error" } } }]) {
      expect(classifySseFrame(`event: error\ndata: ${JSON.stringify(payload)}`)).toEqual({ kind: "error", errorType: null, payload })
    }
  })

  it("parses spec-legal data fields without a space after the colon", () => {
    const verdict = classifySseFrame('event: error\ndata:{"error":{"type":"billing_error"}}')
    expect(verdict).toEqual({
      kind: "error",
      errorType: "billing_error",
      payload: { error: { type: "billing_error" } },
    })
  })

  it("any other real frame means content has begun", () => {
    expect(classifySseFrame('event: message_start\ndata: {"type":"message_start"}')).toEqual({ kind: "content" })
    expect(classifySseFrame('data: {"type":"ping"}')).toEqual({ kind: "content" })
  })
})

describe("prelude decision timeline across heartbeats", () => {
  it("a heartbeat comment never decides; the quota refusal behind it fails over", () => {
    expect(decide([HEARTBEAT])).toBe("pending")
    expect(decide([HEARTBEAT, RATE_LIMIT])).toBe("failover")
    expect(decide([`${HEARTBEAT}${RATE_LIMIT}`])).toBe("failover")
  })

  it("repeated comments before a billing refusal fail over too", () => {
    expect(decide([HEARTBEAT, HEARTBEAT, HEARTBEAT, BILLING])).toBe("failover")
  })

  it("an error-first stream fails over with no prelude", () => {
    expect(decide([RATE_LIMIT])).toBe("failover")
  })

  it("a refusal split across chunk boundaries anywhere still fails over", () => {
    const combined = `${HEARTBEAT}${HEARTBEAT}${RATE_LIMIT}`
    for (let split = 1; split < combined.length; split += 7) {
      expect(decide([combined.slice(0, split), combined.slice(split)])).toBe("failover")
    }
  })

  it("a ping keepalive before the refusal does not mask it", () => {
    expect(decide([PING])).toBe("pending")
    expect(decide([PING, RATE_LIMIT])).toBe("failover")
  })

  it("content decides passthrough even when a refusal follows it", () => {
    expect(decide([HEARTBEAT, MESSAGE_START, RATE_LIMIT])).toBe("passthrough")
    expect(decide([MESSAGE_START])).toBe("passthrough")
  })

  it("a non-account error frame decides passthrough", () => {
    expect(decide([HEARTBEAT, OVERLOADED])).toBe("passthrough")
  })

  it("comments-only until EOF stay pending for the caller's pass-through", () => {
    expect(decide([HEARTBEAT, HEARTBEAT])).toBe("pending")
  })
})

describe("SsePreludeScanner (incremental relay)", () => {
  /** Mirrors the streaming dispatcher's per-chunk contract: push, drain
   *  frames, trim, and forward held bytes once nothing is pending. */
  function scan(chunks: string[]): { verdicts: string[]; pendingHolds: number[] } {
    const scanner = new SsePreludeScanner()
    const verdicts: string[] = []
    const pendingHolds: number[] = []
    for (const chunk of chunks) {
      scanner.push(chunk)
      while (true) {
        const frame = scanner.next()
        if (!frame) break
        verdicts.push(frame.kind === "error" ? `error:${frame.errorType}` : frame.kind)
      }
      scanner.trim()
      if (scanner.pendingChars === 0) pendingHolds.push(0)
      else pendingHolds.push(scanner.pendingChars)
    }
    return { verdicts, pendingHolds }
  }

  it("classifies frames across push boundaries and trims to the incomplete tail", () => {
    const { verdicts, pendingHolds } = scan([
      HEARTBEAT.slice(0, 4),          // ": pi" — incomplete
      HEARTBEAT.slice(4) + RATE_LIMIT.slice(0, 12), // comment done + partial error
      RATE_LIMIT.slice(12),           // error completes
    ])
    expect(verdicts).toEqual(["keepalive", "error:rate_limit_error"])
    expect(pendingHolds).toEqual([4, 12, 0])
  })

  it("surfaces every keepalive between decisions and keeps the tail bounded", () => {
    const { verdicts, pendingHolds } = scan([HEARTBEAT, PING, HEARTBEAT])
    expect(verdicts).toEqual(["keepalive", "keepalive", "keepalive"])
    expect(pendingHolds.every(h => h === 0)).toBe(true)
  })

  it("keeps the deciding error frame's type for the caller's exposure policy", () => {
    const scanner = new SsePreludeScanner()
    scanner.push(`${HEARTBEAT}${BILLING}`)
    expect(scanner.next()).toEqual({ kind: "keepalive" })
    const verdict = scanner.next()
    expect(verdict).toEqual({ kind: "error", errorType: "billing_error", payload: { type: "error", error: { type: "billing_error", message: "inactive" } } })
    expect(scanner.next()).toBeNull()
    scanner.trim()
    expect(scanner.pendingChars).toBe(0)
  })
})

describe("stream transport (actual relay, not a duplicate scan loop)", () => {
  const encoder = new TextEncoder()
  function sink(output: Uint8Array[]): SseRelaySink {
    return {
      enqueue: async chunk => { output.push(chunk); return true },
      isCancelled: () => false,
      registerCancel: () => {},
      onMeaningfulForwarded: () => {},
    }
  }
  function response(chunks: Uint8Array[]): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close() },
    }), { headers: { "content-type": "text/event-stream" } })
  }
  const text = (chunks: Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(chunks))

  it("preserves a partial EOF frame and undecoded EOF bytes", async () => {
    for (const input of [encoder.encode(`${HEARTBEAT}: partial`), Uint8Array.of(0xef)]) {
      const output: Uint8Array[] = []
      await relayStreamAttempt(response([input]), sink(output))
      expect(Buffer.concat(output)).toEqual(Buffer.from(input))
    }
  })

  it("does not expose a chunk containing undecoded UTF-8 before classifying it", async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const output: Uint8Array[] = []
    const inner = new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(Uint8Array.of(0xef))
        await gate
        c.enqueue(Buffer.concat([Uint8Array.of(0xbb, 0xbf), encoder.encode(BILLING)]))
        c.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
    const task = relayStreamAttempt(inner, sink(output))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(output).toHaveLength(0)
    release()
    const verdict = await task
    expect(verdict.kind).toBe("suppressed")
    if (verdict.kind === "suppressed") await verdict.discard()
    expect(output).toHaveLength(0)
  })

  it("preserves byte-exact fragmented CRLF, lone CR and Unicode success", async () => {
    const input = encoder.encode(`${HEARTBEAT.replaceAll("\n", "\r\n")}${MESSAGE_START.replaceAll("\n", "\r")}data: 🧪\n\n`)
    for (let split = 1; split < input.length; split++) {
      const output: Uint8Array[] = []
      await relayStreamAttempt(response([input.slice(0, split), input.slice(split)]), sink(output))
      expect(Buffer.concat(output)).toEqual(Buffer.from(input))
    }
  })

  it("bounds an incomplete prelude, then stands down without losing bytes", async () => {
    const input = encoder.encode(`: ${"x".repeat(128 * 1024)}`)
    const output: Uint8Array[] = []
    let exposed = false
    const opts = sink(output)
    opts.onMeaningfulForwarded = () => { exposed = true }
    const verdict = await relayStreamAttempt(response([input, encoder.encode(BILLING)]), opts)
    expect(verdict.kind).toBe("relayed")
    expect(exposed).toBe(true)
    expect(text(output)).toBe(new TextDecoder().decode(input) + BILLING)
  })

  it("stands down exactly at the incomplete prelude byte ceiling", async () => {
    for (const bytes of [65535, 65536, 65537]) {
      let close = (): void => {}
      let exposed = false
      const output: Uint8Array[] = []
      const inner = new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encoder.encode(`: ${"x".repeat(bytes - 2)}`)); close = () => c.close() },
      }), { headers: { "content-type": "text/event-stream" } })
      const opts = sink(output)
      opts.onMeaningfulForwarded = () => { exposed = true }
      const task = relayStreamAttempt(inner, opts)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(exposed).toBe(bytes >= 65536)
      close()
      await task
      expect(Buffer.concat(output).length).toBe(bytes)
    }
  })

  it("tracks incomplete UTF-8 across chunks without counting replacement bytes", () => {
    expect(hasIncompleteUtf8Tail([Uint8Array.of(0xef)])).toBe(true)
    expect(hasIncompleteUtf8Tail([Uint8Array.of(0xef), Uint8Array.of(0xbb)])).toBe(true)
    expect(hasIncompleteUtf8Tail([Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf)])).toBe(false)
    expect(hasIncompleteUtf8Tail([Uint8Array.of(0xff, 0x0a, 0xef, 0xbb)])).toBe(true)
    expect(hasIncompleteUtf8Tail([encoder.encode("🧪")])).toBe(false)
  })

  it("cancels a reader installed AFTER outer cancellation", async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let innerCancelled = 0
    let requestCancelled = 0
    let resolveFinished = (): void => {}
    const finished = new Promise<void>(resolve => { resolveFinished = resolve })
    const stream = createSseRelayStream(async opts => {
      await gate // handleMessages has not returned its response yet.
      const inner = new Response(new ReadableStream<Uint8Array>({
        cancel() { innerCancelled++ },
      }), { headers: { "content-type": "text/event-stream" } })
      await relayStreamAttempt(inner, opts)
      resolveFinished()
    }, () => { requestCancelled++ })
    await stream.cancel("before inner response")
    expect(requestCancelled).toBe(1)
    release()
    await finished
    expect(innerCancelled).toBe(1)
  })

  it("bounds the slow subscriber's queue and unblocks backpressure on cancel", async () => {
    let writes = 0
    let finished = false
    let resolveFinished = (): void => {}
    const done = new Promise<void>(resolve => { resolveFinished = resolve })
    const stream = createSseRelayStream(async opts => {
      opts.onMeaningfulForwarded()
      for (let i = 0; i < 1000; i++) {
        if (!await opts.enqueue(new Uint8Array(4096))) break
        writes++
      }
      finished = true
      resolveFinished()
    }, () => {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(finished).toBe(false)
    expect(writes).toBeLessThanOrEqual(16)
    const reader = stream.getReader()
    expect((await reader.read()).value?.length).toBe(4096)
    await reader.cancel()
    await done
    expect(finished).toBe(true)
  })

  it("keeps heartbeat delivery live while selection is pending", async () => {
    let finish = (): void => {}
    const gate = new Promise<void>(resolve => { finish = resolve })
    const stream = createSseRelayStream(async () => { await gate }, () => { finish() }, 10)
    const reader = stream.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(HEARTBEAT)
    await reader.cancel()
  })

  it("discard unblocks completion that depends on reader cancellation", async () => {
    let resolveCompleted = (): void => {}
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode(BILLING)) },
      cancel() { resolveCompleted() },
    }), { headers: { "content-type": "text/event-stream" } })
    const verdict = await relayStreamAttempt(inner, sink([]))
    expect(verdict.kind).toBe("suppressed")
    if (verdict.kind !== "suppressed") throw new Error("expected suppression")
    await verdict.discard()
    await completed
    expect(inner.body!.locked).toBe(false)
  })

  it("releases response readers after EOF and transport failure", async () => {
    const inner = response([encoder.encode(MESSAGE_START)])
    await relayStreamAttempt(inner, sink([]))
    expect(inner.body!.locked).toBe(false)
    const failed = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("transport failed")) },
    }), { headers: { "content-type": "text/event-stream" } })
    await expect(relayStreamAttempt(failed, sink([]))).rejects.toThrow("transport failed")
    expect(failed.body!.locked).toBe(false)
  })

  it("does not invent a zero wait when a JSON error has no Retry-After header", async () => {
    const output: Uint8Array[] = []
    await relayStreamAttempt(new Response(JSON.stringify({ error: { type: "invalid_request_error", retry_after: 17 } }), { status: 400 }), sink(output))
    expect(text(output)).toContain('"retry_after":17')
    expect(text(output)).not.toContain('"retry_after":0')
  })

  it("retains JSON account failures' valid header hint through suppression", async () => {
    const verdict = await relayStreamAttempt(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
      status: 429, headers: { "retry-after": "30" },
    }), sink([]))
    expect(verdict.kind).toBe("suppressed")
    if (verdict.kind !== "suppressed") throw new Error("expected suppression")
    expect(verdict.errorPayload).toEqual({ error: { type: "rate_limit_error", retry_after: 30 } })
    await verdict.discard()
  })

  it("bounds fallback JSON before EOF and cancels rather than guessing an account refusal", async () => {
    let cancelled = 0
    let pulls = 0
    const output: Uint8Array[] = []
    const inner = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        // Never closes. A cap must make progress independently of EOF.
        // Stall after six chunks so even the broken implementation cannot
        // starve the test deadline with an endless synchronous microtask loop.
        if (pulls <= 6) controller.enqueue(encoder.encode("x".repeat(16 * 1024)))
      },
      cancel() { cancelled++ },
    }), { status: 429, headers: { "content-type": "application/json" } })
    // Bound the broken control's run too, without turning timeout into a pass.
    let stop = (): void => {}
    const guard = setTimeout(() => stop(), 100)
    const opts = sink(output)
    let stopped = false
    opts.isCancelled = () => stopped
    opts.registerCancel = cancel => { stop = () => { stopped = true; cancel("test deadline") } }
    try {
      const verdict = await relayStreamAttempt(inner, opts)
      expect(verdict.kind).toBe("relayed")
      expect(text(output)).toContain('"type":"api_error"')
      expect(text(output)).toContain("exceeded 65536 bytes")
      expect(text(output).split("event: error").length - 1).toBe(1)
      expect(pulls).toBeLessThanOrEqual(6)
      expect(cancelled).toBe(1)
      expect(inner.body!.locked).toBe(false)
    } finally { clearTimeout(guard) }
  })

  it("accepts complete JSON at the byte limit but rejects one byte more, even in one oversized chunk", async () => {
    for (const bytes of [65535, 65536, 65537, 2 * 1024 * 1024]) {
      const prefix = '{"error":{"type":"billing_error","message":"'
      const suffix = '"}}'
      const body = encoder.encode(prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix)
      let cancelled = 0
      const output: Uint8Array[] = []
      const inner = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(body); controller.close() },
        cancel() { cancelled++ },
      }), { status: 402 })
      const verdict = await relayStreamAttempt(inner, sink(output))
      if (bytes <= 65536) {
        expect(verdict.kind).toBe("suppressed")
        if (verdict.kind === "suppressed") await verdict.discard()
        expect(output).toHaveLength(0)
      } else {
        expect(verdict.kind).toBe("relayed")
        expect(text(output)).toContain('"type":"api_error"')
        expect(text(output)).not.toContain("billing_error")
        expect(text(output).length).toBeLessThan(1024)
      }
      expect(inner.body!.locked).toBe(false)
      // A closed stream needs no underlying cancel callback.
      expect(cancelled).toBeLessThanOrEqual(1)
    }
  })

  it("does not decode an oversized SSE deciding chunk or retry it", async () => {
    const input = encoder.encode(BILLING.replace("inactive", "x".repeat(2 * 1024 * 1024)))
    const output: Uint8Array[] = []
    let exposed = 0
    const opts = sink(output)
    opts.onMeaningfulForwarded = () => { exposed++ }
    const OriginalDecoder = globalThis.TextDecoder
    const decodedByteLengths: number[] = []
    globalThis.TextDecoder = class extends OriginalDecoder {
      override decode(...args: Parameters<TextDecoder["decode"]>): string {
        const [input] = args
        if (input) decodedByteLengths.push(input.byteLength)
        return super.decode(...args)
      }
    }
    let verdict: Awaited<ReturnType<typeof relayStreamAttempt>>
    try { verdict = await relayStreamAttempt(response([input]), opts) }
    finally { globalThis.TextDecoder = OriginalDecoder }
    expect(decodedByteLengths.every(bytes => bytes <= 65536)).toBe(true)
    expect(verdict.kind).toBe("relayed")
    expect(exposed).toBe(1)
    expect(Buffer.concat(output)).toEqual(Buffer.from(input))
  })

  it("joins the exact cancellation registered before cleanup, including delayed cancellation", async () => {
    let finishCancel = (): void => {}
    const gate = new Promise<void>(resolve => { finishCancel = resolve })
    let cancelRegistered = (_reason: unknown): void => {}
    let cancelCalls = 0
    let stopped = false
    let completed = false
    const inner = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelCalls++; return gate },
    }), { headers: { "content-type": "text/event-stream" } })
    const opts = sink([])
    opts.isCancelled = () => stopped
    opts.registerCancel = cancel => { cancelRegistered = cancel }
    const task = relayStreamAttempt(inner, opts).then(() => { completed = true })
    await Bun.sleep(5)
    stopped = true
    cancelRegistered("client disconnected")
    await Bun.sleep(5)
    try {
      expect(cancelCalls).toBe(1)
      expect(completed).toBe(false)
    } finally { finishCancel(); await task }
    expect(inner.body!.locked).toBe(false)
  })

  it("delivers the bounded JSON error while stalled cancellation keeps completion fenced", async () => {
    let finishCancel = (): void => {}
    const cancelled = new Promise<void>(resolve => { finishCancel = resolve })
    let completed = false
    const output: Uint8Array[] = []
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65537)) },
      cancel() { return cancelled },
    }), { status: 429 })
    const opts = sink(output)
    let stop = (_reason: unknown): void => {}
    let stopped = false
    opts.registerCancel = cancel => { stop = cancel }
    opts.isCancelled = () => stopped
    const task = relayStreamAttempt(inner, opts).then(() => { completed = true })
    await Bun.sleep(10)
    try {
      expect(text(output)).toContain('"type":"api_error"')
      expect(completed).toBe(false)
    } finally { stopped = true; stop("test cleanup"); finishCancel(); await task }
    expect(inner.body!.locked).toBe(false)
  })

  it("reports rejected retirement to the caller after one terminal frame, without declaring success", async () => {
    const output: Uint8Array[] = []
    const failure = new Error("underlying cancellation rejected")
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65537)) },
      cancel() { return Promise.reject(failure) },
    }), { status: 429 })
    const verdict = await relayStreamAttempt(inner, sink(output))
    expect(verdict).toEqual({ kind: "relayed", terminalError: true, cleanupFailure: { error: failure } })
    expect(text(output).split("event: error").length - 1).toBe(1)
    expect(inner.body!.locked).toBe(false)
  })
})
