# #1214: SSE keepalive account failover

## Disposition and authority

2026-10-04: accept the purpose with maintainer corrections. Final local gates and
independent review passed on `bb33d26d`; final-head CI and actual affected-client
E2E remain acceptance gates.
Source [#1214](https://github.com/rynfar/meridian/pull/1214) was refreshed read-only
and remained open at `1c8f17099ad62dbd2a511f69c12e5b4e15d9da7f`, with two
commits and no PR discussion or reviews. Its linked discussions were empty.

The authorized backlog pass covers an internal repair of existing Messages
failover and cancellation. It adds no proxy config, endpoint, profile/session
header or exported plugin interface. An existing `api_error` envelope is the
conservative terminal answer when a post-header non-SSE response cannot be
classified safely. HTTP refusals received before any SSE response preserve their
status; content/tool exposure still prohibits another account. This follows the
current [API contract](../../../.agents/references/api-contract.md),
[architecture](../../../ARCHITECTURE.md) and
[affected-flow requirements](../../../E2E.md).

Worktree: `/Users/rynfar/repos/meridian-sse-priority-incorporation-1214-20261004`.
Branch: `codex/sse-priority-incorporation-1214-20261004`.
Fresh fetched base: `3afca1f5a0d51d74f8c7437b90f43d5686cf4163`.
Rebased before final gates onto documentation-only main
`0369441786b082aadeb31689dcbce41d7e8574d9`; no conflicts or product changes.
The user's dirty checkout was preserved. Root owns the queue, PR and integration.

## Authorship

Both actual source commits were cherry-picked, with no conflict, before any
maintainer correction. Author remains Aleksey Proshutinskiy
`<alexey.prosh@fluence.one>` (`justprosh`), with the exact original AuthorDate.

| Source | Incorporation | AuthorDate |
| --- | --- | --- |
| `d4e36fa90a3ecfbcb48c91c8c4023224b1386f32` | `4c4abdbd8ba649a69f4aaf5b01ffacc522a6b0d8` | `2026-10-01T20:46:35+04:00` |
| `1c8f17099ad62dbd2a511f69c12e5b4e15d9da7f` | `928c9f319a59469ecc5210f126fe6d55f2745fd7` | `2026-10-02T03:06:02+04:00` |

Initial pre-rebase cherry identities were `7d9dce174edd9db684212e7d1fbc3dcb737b96a8`
and `512f89907b8fec191e611cea6700a37e09de1f85`. Maintainer correction
`0419bc73` rebased as `dcd2833da8c928a669bceebd332b04f0586d7348`, containing
only corrections, additional controls and evidence. Squash credit must retain the verified human contributor
identity above. No source branch was pushed or rewritten.

## Findings and final behavior

The complete source diff, current priority dispatch, request abort ownership,
SDK writer joining, durable terminal publication and relevant tests were read.
The purpose fits the product: downstream headers/keepalives must remain visible
while an account verdict is pending, and a content-free heartbeat cannot make an
account refusal final. Suppressed attempts are canceled and joined before
consulting their final exposure state or starting another account. SDK transport
pings remain non-progress for the existing upstream idle guard.

The corrections address these concrete findings:

1. The source's post-header non-SSE fallback collected chunks to EOF and made a
   Blob/text copy without a byte cap. It now uses one fixed 65,536-byte diagnostic
   buffer, checks each incoming chunk before copying/decoding, and rejects the
   first byte beyond the budget. A complete JSON error at exactly the limit can
   still qualify for account failover. Overflow cannot qualify, even if its
   prefix mentions billing/quota; one terminal `api_error` is delivered before
   reader cancellation joins.
2. SSE scanning checked the bound after decoding an entire incoming chunk. A
   multi-megabyte chunk could therefore allocate and qualify for suppression
   before the advertised ceiling applied. A chunk exceeding the remaining
   classification budget now ends sniffing before decoding; raw bytes relay
   unchanged, with no account replay. An incomplete prelude reaching 64 KiB
   likewise stands down.
3. Registered cancellation called `reader.cancel()` and cleanup called it again.
   The second call resolved while the first underlying cancellation was pending,
   falsely reporting cleanup complete. Cleanup now caches and awaits the exact
   first cancellation. EOF/request/turn completion remains pending if that
   cancellation does not settle; no timeout releases authority without proof.
   The outer keepalive timer stops immediately on client cancellation.
4. Converted terminal JSON errors flowed through successful-answer bookkeeping.
   They now have an internal terminal verdict: no legacy affinity assignment or
   successful-failover event; settlement follows joined cleanup and final
   exposure. Rejected reader retirement retains the authority/session fence and
   reports one terminal frame. Rejected response-completion joins are logged and
   fenced instead of swallowed; those defensive rejection branches are reviewed
   statically because normal production stream completions currently resolve.
5. SSE JSON `error.type` is validated as a string at runtime. New cancellation
   and completion catches record/propagate their concrete failure. The packaged
   harness attempts all owned resource cleanup on startup/assertion failures,
   removes its isolated config/session root, and starts the answer fixture only
   in fixture mode. Malformed data lines fail the harness rather than disappear.

The bounds apply to relay classification and the outer queue (64 KiB plus at
most one 16-KiB write), not to an incoming transport allocation or the existing
inner SDK producer's buffering. A small non-SSE body that never ends still awaits
EOF or the existing request cancellation/deadline; this change introduces no
new wall-clock policy. Existing pre-stream JSON sniffing is unchanged.

## Discriminating deterministic evidence

The [maintained transport tests](../../../src/__tests__/sse-failure-sniff.test.ts)
and [isolated priority HTTP tests](../../../src/__tests__/priority-routing-integration.test.ts)
are runnable without credentials or model generation. The latter retains the
real dispatch and real relay; its narrow module seam injects malformed provider
Response boundaries or delays suppressed retirement. It is already isolated by
`npm test`, so this process-global seam does not affect another test stage.

Before correction, on authored incorporation `512f8990`, five new transport
controls failed and the 36 inherited controls passed. The failures identify:
never-ending JSON produced no terminal frame, over-limit complete JSON still
suppressed, an oversized SSE error decoded/suppressed, cancellation completed
before its original operation settled, and stalled cancellation hid the
bounded-body error. The [complete failed control log](1214-sse-priority-failover/bounded-before-revised-fixture.log)
is retained. The source HTTP overflow controls also failed the same terminal
frame assertion (empty output), for both joined and rejected cancellation;
see [the failed HTTP log](1214-sse-priority-failover/http-overflow-before.log).

The initial source-only infinite synchronous producer was interrupted because
its hot microtask loop starved the test deadline. The maintained fixture now
emits six 16-KiB chunks and stalls without EOF: the source cannot accumulate
unbounded test memory, while the exact terminal-frame assertion still fails
before and passes after. An initial HTTP guard aborted only the request signal,
which did not cancel its independent injected body; the maintained guard cancels
the actual downstream reader. These are bounded fixture corrections, not a
product pass inferred from an unexplained rerun.

Controls include 65,535/65,536/65,537-byte JSON boundaries, one 2-MiB incoming
chunk, decoder input-size observation, no EOF, exact-byte Unicode/CRLF/lone-CR
fragmentation and incomplete UTF-8, slow-subscriber backpressure, cancellation
before reader installation, reader release after EOF/failure, stalled/rejected
retirement, cancellation during suppression, no third account/no success event
for malformed fallback, pre-stream 400 preservation including compat routes,
no replay after text/tools/structured output, pool exhaustion and durable turn
claim retirement. Source tests also use a real loopback HTTP socket to observe
headers within 100 ms and a keepalive before the 16-second refusal. This is
mocked SDK evidence, not real model/client evidence.

Environment: macOS arm64, Node `22.22.3`, Bun `1.3.14`. Iteration typecheck found
an added test's decoder override had used unavailable DOM type names; the test
now derives the signature from `TextDecoder`, with the required `override`.
No ignored type errors were added.

Current focused results: transport + idle guard 56 pass / 0 fail (252 assertions),
complete priority suite 87 pass / 0 fail (443 assertions), and the three added
HTTP controls 3 pass / 0 fail (24 assertions).
The [transport/idle log](1214-sse-priority-failover/focused-transport-idle.log) and
[HTTP log](1214-sse-priority-failover/http-negative-controls.log) and
[complete priority log](1214-sse-priority-failover/focused-priority.log) are durable.
Standalone build passed; the final local gate results are recorded below.
These earlier results are not claimed as validation of a later changed head.

## Remaining acceptance gates

No models, live SDK/CLI generation, credentials or browser calls were used in
this incorporation. The contributor's PR claims Node 22 / SDK 0.2.141 / CLI
2.1.287 packaged fixture success; that claim has not been independently run here
and explicitly does not establish a live subscription or actual client.

The maintained [packaged HTTP gate](../../../scripts/e2e-sse-quota-failover-heartbeat.mjs)
is syntax-checked, but has not been executed. Run it on independently installed
baseline/delivery packages with the implicated Fable 5.1 and Opus 5.5 models,
recording SDK/CLI/platform versions, flags, statuses, telemetry identities,
header/first-keepalive timing and cancellation/cleanup. Fixture mode is transport
proof only. Root must also preserve exact affected-client failover, cancellation
and continuation evidence; synthetic Messages HTTP or another model/client
cannot satisfy that gate. Required final-head CI remains before landing;
independent review has passed as recorded below. This candidate is not yet a
completed fix.

## Independent review and additional corrections

An independent agent reviewed complete frozen head `1a1060f0` and found three
actionable gaps. The in-progress `npm test` was stopped with exit 130 before any
product edit; this is an interrupted gate, not a test-failure or full-pass claim.
The [provenance record](1214-sse-priority-failover/interrupted-full-run.json) and
[complete compressed log](1214-sse-priority-failover/npm-test-1a1060f0-interrupted.log.gz)
are retained.

- Rejected retirement of a suppressed/nonterminal SSE reader could still release
  a trusted turn claim after a resolving SDK completion. The relay now brands
  actual cancellation failure with an internal `SseReaderRetirementError`, and
  dispatch retains authority/session fences for it. A body that already reached
  EOF or errored needs no fresh cancellation: canceling an errored stream merely
  rejects with its stored read error. Any already-started cancellation still
  joins its original promise. The [trusted HTTP control before correction](1214-sse-priority-failover/rejected-sse-retirement-before.log)
  observes the exact attempt owner missing after the original mocked SDK refusal
  completes; after correction the owner, pending turn digest and issue time
  persist, with one terminal frame and one account attempt. The fixture drains
  the original SDK response before injecting the retirement failure, so this
  assertion distinguishes retirement from aborted pre-launch preparation.
- SSE recognized colonless fields have an empty value. A bare final `event` now
  resets a preceding ping/error to the default message event. Otherwise a real
  data frame could be mislabeled as keepalive and a later account error replayed.
  [Both classification and actual-relay controls failed before](1214-sse-priority-failover/colonless-before.log);
  the corrected relay preserves all bytes and does not suppress the later error.
- The packaged harness now requires its unique receipt in the answering text and
  one successful complete stream envelope (`message_stop`, `end_turn`), rather
  than accepting any nonempty answer. It remains unexecuted; syntax validation
  does not establish receipt/model/client behavior.

Post-review focused checks: [59 transport/idle tests, 264 assertions](1214-sse-priority-failover/transport-review-fixed.log)
and [four HTTP controls, 31 assertions](1214-sse-priority-failover/http-negative-controls-review-fixed.log)
pass. Typecheck passes. Final full local gates used frozen corrected head
`bb33d26d7757e34deb6645bf66d0c14d77658c0f`.

The reviewer also identified quadratic scanning when a single incomplete frame
is supplied one byte at a time (up to roughly 2.15 billion character visits at
64 KiB). Current Messages inner producers enqueue complete encoded SSE frames
in-process; network/SDK fragmentation does not feed this relay directly, and no
current production path establishing that regression was found. This remains
CPU hardening, not an observed affected-client defect or a bounded-CPU claim.
Revisit if a provider begins passing fragmented/raw SSE into this helper or a
current inner producer is observed emitting prolonged partial frames. Correct
fragment framing and memory limits do not constitute a CPU performance bound.

## Final local gates and reviewed scope

The independent reviewer approved the complete corrected product and packaged
harness at `bb33d26d7757e34deb6645bf66d0c14d77658c0f`, with no remaining material
findings. On that exact head, `npm test` exited 0: **5,406 pass / 35 skip / 0
fail**, across 19 isolated stages and 26,912 assertions, including its initial
typecheck. Standalone `npm run typecheck` and `npm run build` both exited 0; the
latter certified local build 3. The [gate record and artifact hashes](1214-sse-priority-failover/local-gates.json)
and [complete compressed suite log](1214-sse-priority-failover/npm-test-bb33d26d.log.gz)
are durable. These results identify the exact tested head, rather than claiming
that a later evidence commit was itself fully tested.

One earlier standalone build failed with `BuildProvenanceError: inputs-changed`
because the maintainer committed while its certification snapshot was running.
The [failed build log](1214-sse-priority-failover/build-review-fixed.log) is kept.
Freezing `bb33d26d` before the fresh passing build removes the concrete snapshot
change; this is not an unexplained green rerun or a product regression claim.

The final trusted-retirement test replaces a fixed 50-ms sleep with bounded
polling of the direct Claude server's `getInFlightCount()`. It must reach zero
before inspecting the durable attempt. Body EOF can precede SDK/fork cleanup;
the observable zero proves `finishRequest` ran and prevents a slow cleanup from
making a subsequently released claim appear retained. The two-second deadline
fails explicitly if cleanup does not settle. The independent reviewer approved
this test-only synchronization and its failure semantics.

With that stronger assertion, [pre-review product `1a1060f0` fails](1214-sse-priority-failover/retirement-settled-before.log)
at the missing exact owner token after observing request completion; the
[corrected product passes all eight assertions](1214-sse-priority-failover/retirement-settled-after.log).
All [four added HTTP controls pass, with 32 assertions](1214-sse-priority-failover/http-controls-settled-final.log),
and the changed test typechecks. Product code, packaged harness and pure relay
tests are unchanged from the fully tested and reviewed `bb33d26d` blobs listed in
the gate record. Only test synchronization and durable evidence changed, so the
full local suite was not repeated; required final-head CI including `test`
remains a merge gate. There were **zero live model generations** in this work.
