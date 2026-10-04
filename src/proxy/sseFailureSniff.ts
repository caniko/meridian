import { isAccountFailoverError } from "./errors"
import { parseRetryAfterMs } from "./retryAfter"

// Internal classification limits, not public proxy configuration. A response
// larger than this is never sufficient evidence to replay another account.
const CLASSIFICATION_MAX_BYTES = 64 * 1024

/**
 * SSE prelude scanning and transport for priority account failover.
 * Content-free comments and ping events do not decide an account verdict.
 * The first error or content frame does; callers never replay exposed content.
 * Frames end at an empty line with CRLF, LF or CR terminators and may span chunks.
 *
 * Framing/classification is pure. The relay owns its response reader,
 * not server, routing or session state.
 */

/** Length of the line terminator at `at`, or 0 when there is none. */
function lineBreakLength(text: string, at: number): number {
  if (text[at] === "\r") return text[at + 1] === "\n" ? 2 : 1
  if (text[at] === "\n") return 1
  return 0
}

function frameLines(frame: string): string[] {
  return frame.split(/\r\n|\n|\r/)
}

/** The SSE field value: everything after the colon, one leading space stripped. */
function fieldValue(line: string, colonAt: number): string {
  let value = line.slice(colonAt + 1)
  if (value.startsWith(" ")) value = value.slice(1)
  return value
}

/**
 * Find the next complete SSE frame in `text` at or after `from`.
 * Returns the frame without its terminator and the index just past the
 * terminator, or null while the buffered text ends inside a frame.
 */
export function nextSseFrame(text: string, from: number): { frame: string; next: number } | null {
  let lineStart = from
  let i = from
  let lastBreakLen = 0
  while (i < text.length) {
    const breakLen = lineBreakLength(text, i)
    if (breakLen === 0) {
      i += 1
      continue
    }
    // A line that starts at a line break is empty: the frame ends here,
    // without its fields' own line terminators.
    if (i === lineStart) {
      return { frame: text.slice(from, i - lastBreakLen), next: i + breakLen }
    }
    lastBreakLen = breakLen
    lineStart = i + breakLen
    i = lineStart
  }
  return null
}

/**
 * What one complete frame means for the sniffer's verdict:
 *
 * - `keepalive` — comment-only (e.g. `: ping`) or empty frames, and `event:
 *   ping` frames. None of them carry content, so none of them may end the
 *   pre-content sniff.
 * - `error` — an `event: error` frame. `errorType` is the parsed
 *   `error.type` (null when the data is absent or not that JSON shape); the
 *   caller's failover policy (`isAccountFailoverError`) decides whether this
 *   type is worth another account. The frame still decides: a non-account
 *   error is this account's honest answer.
 * - `content` — any other real frame (`message_start`, a data frame, ...).
 *   The stream has begun; whatever follows passes through untouched.
 */
export type SseFrameClass =
  | { kind: "keepalive" }
  | { kind: "error"; errorType: string | null; payload: unknown }
  | { kind: "content" }

export function classifySseFrame(frame: string): SseFrameClass {
  let eventType: string | null = null
  let sawField = false
  let dataJoined: string | null = null
  for (const line of frameLines(frame)) {
    if (line === "" || line.startsWith(":")) continue
    sawField = true
    const colonAt = line.indexOf(":")
    // A colonless line names a field with no value and is ignored per spec.
    if (colonAt === -1) continue
    const field = line.slice(0, colonAt)
    if (field === "event") {
      // Last `event` field wins, per spec.
      eventType = fieldValue(line, colonAt)
    } else if (field === "data") {
      dataJoined = dataJoined === null ? fieldValue(line, colonAt) : `${dataJoined}\n${fieldValue(line, colonAt)}`
    }
  }
  if (!sawField) return { kind: "keepalive" }
  if (eventType === "ping") return { kind: "keepalive" }
  if (eventType === "error") {
    let payload: unknown = null
    let errorType: string | null = null
    if (dataJoined !== null) {
      try {
        payload = JSON.parse(dataJoined)
        const error = payload !== null && typeof payload === "object" && "error" in payload ? payload.error : null
        const type = error !== null && typeof error === "object" && "type" in error ? error.type : null
        errorType = typeof type === "string" ? type : null
      } catch {
        // Not the expected JSON shape: the error frame still decides, with
        // no failover-qualifying type.
        payload = null
      }
    }
    return { kind: "error", errorType, payload }
  }
  return { kind: "content" }
}

/**
 * Incremental prelude scanner. Feed each decoded chunk with `push`, drain
 * complete frames with `next`, then `trim` to drop the consumed text — the
 * retained tail is only the incomplete frame.
 */
export class SsePreludeScanner {
  private text = ""
  private from = 0
  private atStart = true

  /** Characters held back because their frame is not complete yet. */
  get pendingChars(): number {
    return this.text.length - this.from
  }

  push(decoded: string): void {
    if (decoded.length === 0) return
    // SSE ignores one leading BOM. Some runtimes' streaming TextDecoder
    // preserves it when its bytes cross chunks, unlike one-shot decoding.
    if (this.atStart) {
      decoded = decoded.replace(/^\uFEFF/, "")
      this.atStart = false
    }
    this.text += decoded
  }

  /** The next complete frame's classification, or null while the tail is
   *  an incomplete frame. Advances the scan position per frame returned. */
  next(): SseFrameClass | null {
    const next = nextSseFrame(this.text, this.from)
    if (!next) return null
    this.from = next.next
    return classifySseFrame(next.frame)
  }

  /** Drop consumed text. Call after `next` returns null. */
  trim(): void {
    if (this.from === 0) return
    this.text = this.text.slice(this.from)
    this.from = 0
  }
}

export type StreamAttemptVerdict =
  | {
      kind: "suppressed"
      errorPayload: unknown
      errorType: string
      held: Uint8Array[]
      discard: () => Promise<void>
    }
  | { kind: "relayed"; terminalError?: true; cleanupFailure?: { error: unknown } }

export type SseRelaySink = {
  enqueue: (chunk: Uint8Array) => Promise<boolean>
  isCancelled: () => boolean
  registerCancel: (cancel: (reason: unknown) => void) => void
  onMeaningfulForwarded: () => void
}

/** Whether the raw tail ends inside a UTF-8 code point. Looking at bytes
 * avoids re-encoding replacement characters (which can change byte counts).
 * At most four bytes matter, even when the prefix spans several chunks. */
export function hasIncompleteUtf8Tail(chunks: readonly Uint8Array[]): boolean {
  let bytes = 0
  for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
    const chunk = chunks[chunkIndex]!
    for (let i = chunk.length - 1; i >= 0 && bytes < 4; i--) {
      const byte = chunk[i]!
      bytes++
      if (byte >= 0x80 && byte <= 0xbf) continue
      const length = byte >= 0xc2 && byte <= 0xdf ? 2
        : byte >= 0xe0 && byte <= 0xef ? 3
          : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1
      return bytes < length
    }
    if (bytes === 4) return false
  }
  return false
}

/** Start without awaiting the pump: an async ReadableStream.start would
 * prevent pull from running until the pump ends, deadlocking backpressure.
 * Bound our own queue to 64 KiB and one 16-KiB write. The inner producer's
 * existing buffering is independent of this relay's queue. */
export function createSseRelayStream(
  pump: (sink: SseRelaySink) => Promise<void>,
  onCancel: (reason: unknown) => void,
  heartbeatMs = 15_000,
): ReadableStream<Uint8Array> {
  let cancelled = false
  let cancelReason: unknown
  let activeCancel: ((reason: unknown) => void) | null = null
  let wake: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let meaningful = false
      let writing = false
      const enqueue = async (chunk: Uint8Array): Promise<boolean> => {
        writing = true
        try {
          for (let offset = 0; offset < chunk.length; offset += 16 * 1024) {
            while (!cancelled && (controller.desiredSize ?? 0) <= 0) {
              await new Promise<void>(resolve => { wake = resolve })
            }
            if (cancelled) return false
            controller.enqueue(chunk.subarray(offset, offset + 16 * 1024))
          }
          return !cancelled
        } finally {
          writing = false
        }
      }
      heartbeat = setInterval(() => {
        // A non-reading client needs no queued keepalives; do not accumulate
        // timer writes behind a slow content write or a held partial frame.
        if (!cancelled && !meaningful && !writing && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"))
        }
      }, heartbeatMs)
      void pump({
        enqueue,
        isCancelled: () => cancelled,
        registerCancel(cancel) {
          activeCancel = cancel
          if (cancelled) cancel(cancelReason)
        },
        onMeaningfulForwarded() { meaningful = true },
      }).then(() => {
        clearInterval(heartbeat)
        if (!cancelled) controller.close()
      }, error => {
        clearInterval(heartbeat)
        if (!cancelled) controller.error(error)
      })
    },
    pull() { const resolve = wake; wake = null; resolve?.() },
    cancel(reason) {
      cancelled = true
      cancelReason = reason
      // Cancellation may be waiting on an uncooperative upstream. That must
      // not leave this keepalive timer retaining the disconnected response.
      clearInterval(heartbeat)
      onCancel(reason)
      activeCancel?.(reason)
      const resolve = wake
      wake = null
      resolve?.()
    },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk?.byteLength ?? 0 })
}

/** Raw bytes remain held until their entire chunk is classified. In particular,
 * an empty decoded tail is not proof that TextDecoder holds no UTF-8 bytes. */
export async function relayStreamAttempt(
  inner: Response,
  opts: SseRelaySink,
): Promise<StreamAttemptVerdict> {
  const reader = inner.body?.getReader()
  if (!reader) return { kind: "relayed" }
  let transferred = false
  let terminalErrorForwarded = false
  let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
  const cancelReader = (reason?: unknown) => {
    // A second reader.cancel() on a closed stream resolves immediately even
    // while the FIRST underlying cancellation is still pending. Join that
    // exact operation; otherwise cancellation can falsely finish cleanup.
    cancellation ??= reader.cancel(reason).then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    return cancellation
  }
  let discardCompletion: Promise<void> | undefined
  const discard = (): Promise<void> => {
    discardCompletion ??= (async () => {
      try {
        const result = await cancelReader()
        if (!result.ok) throw result.error
      } finally {
        reader.releaseLock()
        opts.registerCancel(() => {})
      }
    })()
    return discardCompletion
  }
  opts.registerCancel(reason => { void cancelReader(reason) })
  try {
    const copyRest = async (enqueue: (chunk: Uint8Array) => Promise<boolean>): Promise<void> => {
      while (!opts.isCancelled()) {
        const { done, value } = await reader.read()
        if (done) return
        if (value && !await enqueue(value)) { await discard(); return }
      }
    }
    const contentType = inner.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      // Allocate only the bounded diagnostic buffer. In particular, do not
      // decode, Blob-copy or retain an oversized incoming chunk before checking
      // its length. The upstream transport owns its own incoming allocation.
      const bytes = new Uint8Array(CLASSIFICATION_MAX_BYTES)
      let byteLength = 0
      while (!opts.isCancelled()) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        if (value.byteLength > CLASSIFICATION_MAX_BYTES - byteLength) {
          opts.onMeaningfulForwarded()
          terminalErrorForwarded = true
          await opts.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({
            type: "error", error: { type: "api_error", message: `Expected an SSE response; upstream body exceeded ${CLASSIFICATION_MAX_BYTES} bytes` },
          })}\n\n`))
          // Deliver the terminal frame before joining cancellation. A broken
          // underlying cancel may delay EOF/cleanup, but never authorize a new
          // account or release the caller's request/turn authority early.
          return { kind: "relayed", terminalError: true }
        }
        bytes.set(value, byteLength)
        byteLength += value.byteLength
      }
      if (opts.isCancelled()) return { kind: "relayed" }
      let payload: unknown = null
      try { payload = JSON.parse(new TextDecoder().decode(bytes.subarray(0, byteLength))) }
      catch { payload = null }
      const error = payload !== null && typeof payload === "object" && "error" in payload
        ? payload.error : null
      const parsedType = error !== null && typeof error === "object" && "type" in error ? error.type : null
      const errorType = typeof parsedType === "string" ? parsedType : null
      // HTTP headers are already out. Preserve a real header hint in the SSE
      // envelope, but never invent retry_after=0 from Number(null).
      const waitMs = parseRetryAfterMs(inner.headers.get("retry-after"))
      if (!inner.ok && waitMs !== null && error !== null && typeof error === "object") {
        Object.assign(error, { retry_after: Math.max(1, Math.ceil(waitMs / 1000)) })
      }
      if (inner.ok || error === null) {
        payload = { type: "error", error: { type: "api_error", message: `Expected an SSE response; upstream returned status ${inner.status}` } }
      }
      const frame = new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
      if (!inner.ok && isAccountFailoverError(errorType)) {
        transferred = true
        return { kind: "suppressed", errorPayload: payload, errorType, held: [frame], discard }
      }
      opts.onMeaningfulForwarded()
      terminalErrorForwarded = true
      await opts.enqueue(frame)
      return { kind: "relayed", terminalError: true }
    }

    const scanner = new SsePreludeScanner()
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
    const held: Uint8Array[] = []
    let heldBytes = 0
    const forwardHeld = async (): Promise<void> => {
      for (const chunk of held) {
        if (!await opts.enqueue(chunk)) break
      }
      held.length = 0
      heldBytes = 0
    }
    while (!opts.isCancelled()) {
      const { done, value } = await reader.read()
      if (done) {
        // EOF is not permission to lose a partial frame or undecoded UTF-8.
        await forwardHeld()
        return { kind: "relayed" }
      }
      if (!value) continue
      if (value.byteLength > CLASSIFICATION_MAX_BYTES - heldBytes) {
        // Check BEFORE decoding or holding the incoming chunk. Oversized
        // frames are not reliable replay evidence; preserve their exact bytes
        // and stand down, even when their leading text names an account error.
        opts.onMeaningfulForwarded()
        await forwardHeld()
        if (await opts.enqueue(value)) await copyRest(opts.enqueue)
        return { kind: "relayed" }
      }
      held.push(value)
      heldBytes += value.byteLength
      const decoded = decoder.decode(value, { stream: true })
      scanner.push(decoded)
      while (true) {
        const frame = scanner.next()
        if (!frame) break
        if (frame.kind === "keepalive") continue
        if (frame.kind === "error" && isAccountFailoverError(frame.errorType)) {
          transferred = true
          return { kind: "suppressed", errorPayload: frame.payload, errorType: frame.errorType, held, discard }
        }
        opts.onMeaningfulForwarded()
        await forwardHeld()
        await copyRest(opts.enqueue)
        return { kind: "relayed" }
      }
      scanner.trim()
      if (scanner.pendingChars === 0 && !hasIncompleteUtf8Tail(held)) await forwardHeld()
      // An incomplete/malformed frame is not bounded by protocol. Stand down
      // conservatively at 64 KiB rather than allocating indefinitely. Once
      // bytes are exposed, later errors cannot be retried on another account.
      if (heldBytes >= CLASSIFICATION_MAX_BYTES) {
        opts.onMeaningfulForwarded()
        await forwardHeld()
        await copyRest(opts.enqueue)
        return { kind: "relayed" }
      }
    }
    return { kind: "relayed" }
  } catch (error) {
    if (!opts.isCancelled()) throw error
    return { kind: "relayed" }
  } finally {
    // A suppressed attempt transfers cleanup to its caller, which must join
    // cancellation before consulting the final no-replay exposure barrier.
    if (!transferred) {
      try { await discard() }
      catch (error) {
        // The converted terminal frame already reached the client. Report the
        // failed retirement to the authority owner without emitting a second
        // conflicting frame or describing this attempt as a served answer.
        if (terminalErrorForwarded) return { kind: "relayed", terminalError: true, cleanupFailure: { error } }
        throw error
      }
    }
  }
}
