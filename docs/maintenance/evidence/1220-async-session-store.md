# Asynchronous session-store writes (#1220)

Disposition: draft integration with maintainer corrections. Owner contract
decision [#1244](https://github.com/rynfar/meridian/issues/1244), unexplained
E41 cache-prefix evidence and final-head CI remain acceptance gates. Source
#1220 stays open. No merge, release or production outage-rate claim.

Base `d57388724a242116f123ff75b88fd2be2846abe3`; refreshed source
`c159bf9befc49c823a94f48c8d554236115e827e`, Nowaker
`spam@nowaker.net`, authored 2026-09-30T13:05:46Z, preserved through authored
cherry `2278ddb88053c91732424937c07256c00f3ff500`. Separate maintainer correction
`a58e9871` owns queued inputs and rechecks publication authority after disk
waits. The source now incorporates current-main profile-copy pruning correctly;
the previous `edf29520` disposition is superseded.

Normal lock acquisition, contention waits, temp-file writes/fsync, rename,
directory flush and release are asynchronous. Per-store mutations remain in
call order; the cross-process lock still protects the durable transaction.
Lifecycle publication/pruning retain their locks and turn leases while awaiting
the store. Arrival snapshots wait for already-started same-process mutations.
Synchronous reads, parsing/serialization and exceptional dead-owner recovery
remain; this does not remove every possible event-loop stall.

The package exports `clearSessionCache()`. Its proposed signature changes from
synchronous completion to `Promise<void>`, requiring callers to await cleanup.
No fire-and-forget compatibility shim is claimed. #1244 records the concrete
choice; creating that issue does not supply owner approval. All in-repository
callers are migrated. HTTP shapes, profile/session headers and file format are
unchanged.

## Adversarial findings

- Async queueing exposed caller-owned arrays/locators after validation. The
  reproduced test changed them immediately after calling a mutation and the
  source stored those changes, including an invalid relative locator. Snapshot
  inputs before yielding for ordinary/priority writes, claims, finalization,
  rollback, attachment and pruning. Source: 9 pass/1 fail; corrected: 10 pass/0
  fail in `store-mutation-loop-lag.test.ts`.
- Cancellation during fsync could rename a revoked mapping before its
  compensating eviction. Another process could observe that intermediate
  authority. The reproduced HTTP integration test counted two store renames.
  The correction checks request/shutdown revocation immediately before
  dispatching publication rename, across ordinary/priority/recovery publication,
  attachment and terminal finalization. Request cancellation and forced shutdown
  now each produce zero publication renames. A rename already dispatched while
  authorized retains the existing ordered cleanup behavior.
- Reviewed false/stale CAS, corrupt-store refusal, initialized mode-0600 owner
  publication, live/dead/remote owner handling, real concurrent writer processes,
  process death between file fsync and rename, cancellation joins, turn arrival,
  lifecycle pruning and protected priority mappings. The locking and pruning
  tests exercise real child processes, rather than treating a PID-shaped mock
  as a cross-process proof.

## Maintained real-client proof

`scripts/e2e-session-store-client.mjs` runs actual OpenCode 1.18.34, Opus 5.5,
SDK 0.2.141, Claude Code 2.1.284 and independently installed scrub 0.2.3. Only
Meridian's own temporary session-store fsync receives the controlled 400 ms
delay; SDK messages/model calls are observed without fabrication. Fixture
credentials/configs, workdirs, sessions and ports are isolated. Supported SDK
session APIs remain the only way to inspect Claude history.

| Platform | Unchanged main | Asynchronous write |
| --- | --- | --- |
| macOS arm64 / Bun 1.3.14 | 406.1 ms due-timer delay; 0 probes during disk waits | 213 concurrent liveness answers; no synchronous fsync delay |
| Linux arm64 / Bun 1.4.2 | 409.3 ms due-timer delay; 0 probes during disk waits | 208 concurrent liveness answers; no synchronous fsync delay |

All four runs complete the real read-tool receipt and same-session continuation
with exit 0, four real SDK queries, owned-account affinity, upstream Opus 5.5
IDs and resume. Each holds six store publications. This is controlled disk-wait
causality, not reproduction of the reported natural 106-second outage.

```sh
npm run build
E2E_PROFILE_CLAUDE_DIR=/owned/native-credential-directory \
E2E_PLUGIN_PATH=/owned/consumer/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/index.js \
E2E_OPENCODE_BIN=/owned/opencode bun scripts/e2e-session-store-client.mjs
# Run the same script from a built unchanged-main checkout:
E2E_EXPECT_RESPONSIVE=0 E2E_PROFILE_CLAUDE_DIR=/owned/native-credential-directory \
E2E_PLUGIN_PATH=/owned/scrub/dist/index.js E2E_OPENCODE_BIN=/owned/opencode \
  bun scripts/e2e-session-store-client.mjs
```

`E2E_CANCEL_DURING_WRITE=1` additionally kills only the fixture's third client
while its store fsync waits, joins HTTP-turn cleanup and requires zero canceled
publication renames. Earlier turns must join before arming this fault: client
exit alone does not prove proxy cleanup completion. An initial macOS probe
omitted that barrier and counted two renames; its failed log is retained. The
initial join probe also used a nonexistent `/inflight` field; the maintained
probe now uses the documented `total` and asserts the join. These probe fixes
do not establish that the earlier real-client failure is resolved without a
passing corrected run.

## Session-history and remaining cache evidence

`scripts/e2e-session-store-turns.mjs` composes the existing real E41 harness with
200 ms asynchronous waits on every store publication, observes native account
affinity and actual served model IDs, and asserts timer progress during writes.
The original E41 executable keeps its exit behavior; importing it exposes its
verdict so this wrapper can finish its own assertions.

All four sequential/parallel × JSON/streaming modes passed after the publication
correction: sequential modes 9 held writes/5 SDK queries, parallel modes 5 held
writes/3 SDK queries. Exact tool-call/result pairing, distinct durable forks,
active history through `getSessionMessages` and cached prefixes pass.

One earlier sequential nonstream run failed the 95% cache-prefix assertion:
its thinking/tool turn reported cache read 3,132 and creation 3,461, then the
next turn read 3,132 versus a required 6,263.35. Its tool batching, receipts,
fork chain and active history passed. Two unchanged-main sequential controls
passed, and later source/corrected runs passed, but this does not explain the
failure. **Keep this acceptance gate open.** No weakened assertion, nearby
model substitution or green-rerun resolution is claimed.

```sh
E2E_PROFILE_CLAUDE_DIR=/owned/native-credential-directory \
PROBE_PORT=3531 bun scripts/e2e-session-store-turns.mjs
# Repeat with --stream, PROBE_PARALLEL=1, and both together on owned ports.
```

Sanitized before/after facts: [verdicts](1220-session-store-verdicts.json).
Private raw logs are retained under the owned persistent verification fixture
`session-store-1220`; they supplement this committed record. Full local gate
results and exact-head CI are recorded in the draft integration/handoff once
complete. The initial full suite passed 5,132 tests with 0 failures/4 skips;
typecheck/build passed. A final full suite is required after the publication
correction. Linux focused locking/pruning/input/cancellation checks passed
42 tests, 0 failures.
