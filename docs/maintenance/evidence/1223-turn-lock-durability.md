# Turn-lock durability: safe subset of #1223

[Source PR #1223](https://github.com/rynfar/meridian/pull/1223) proposes recovering
unreadable owner records by age or a boot-time estimate. A stopped live holder
can satisfy those conditions. Incorporate its ownership-write durability
improvement while keeping uncertain ownership locked until the holder's death
is established. The original crash/self-healing report remains unresolved;
this partial delivery does not close the source PR.

## Source and final behavior

Initial base: `3afca1f5a0d51d74f8c7437b90f43d5686cf4163`.
Reviewed source: `537ccad864336a4f4dc25f925e92177cd12fe6b2`, Nowaker
`<spam@nowaker.net>`, authored `2026-09-30T02:50:36-05:00`.
Actual authored cherry-pick: `236e35fd981560855f047ae2e93313423c8db855`.
Separate correction: `f6df52beae0f4f20ed65a974ac3c600cee19e68c`.
Author and AuthorDate are preserved; maintainer corrections remove speculative
ownerless recovery rather than silently incorporating that behavior.

Owner bytes are written, fsynced and closed, then the candidate directory is
fsynced before atomic publication. The parent directory is fsynced before a
lease is returned or its heartbeat timer starts. A failed publication fsync
releases only this attempt's exact ownership token. If that cleanup also fails,
an AggregateError preserves both failures. Existing same-host confirmed-PID-death
recovery remains. Unreadable owners and cross-host uncertainty fail closed;
elapsed time alone does not establish death. Windows retains the existing
explicit directory-fsync exception, while owner-file fsync still applies.

No public interface, SDK transcript operation, model option or client-specific
behavior changes. The coordinator remains responsible for filesystem I/O;
pure lineage and downward dependency boundaries are unchanged.

## Reproducible controls

[`turn-lock-durability.test.ts`](../../../src/__tests__/turn-lock-durability.test.ts)
uses fresh Bun worker processes and actual owned filesystem handles. It records
write/fsync/close/publication/return order, and injects EIO independently at the
owner, candidate and parent fsync stages. Each failure returns no lease, leaves
no lock residue and permits a later acquire. Existing live-owner and dead-PID
controls remain in the adjacent coordinator suite.

```sh
bun test src/__tests__/turn-lock-durability.test.ts src/__tests__/cross-process-turn-coordinator.test.ts
E2E_TURN_COORDINATOR_MODULE=/absolute/path/to/baseline/src/proxy/session/crossProcessTurnCoordinator.ts bun test src/__tests__/turn-lock-durability.test.ts
```

The unchanged `3afca1f5` baseline fails all four new durability assertions
(0 pass / 4 fail, exit 1). The corrected focused suites pass 10 tests,
66 assertions, 0 failures. The three fsync failures are discriminating: the
unchanged baseline neither fsyncs nor observes the injected fault. On Windows,
directory-specific injection controls explicitly skip instead of claiming
POSIX directory durability.

[`e2e-turn-lock-ownerless-review.mjs`](../../../scripts/e2e-turn-lock-ownerless-review.mjs)
holds a real synthetic lease, confirms SIGSTOP through the kernel, corrupts only
its owned owner record and ages its owned heartbeat. The holder is still alive
when a contender tries to acquire. The same script runs with module selection:

```sh
E2E_TURN_COORDINATOR_MODULE=/absolute/path/to/source/src/proxy/session/crossProcessTurnCoordinator.ts bun scripts/e2e-turn-lock-ownerless-review.mjs --expect-acquisition
bun scripts/e2e-turn-lock-ownerless-review.mjs --expect-refusal
```

| Arm | Live stopped holder | Contender result |
| --- | --- | --- |
| Authored source `236e35fd` | Kernel-confirmed, unreadable owner, stale heartbeat | Acquired while holder remained alive: unsafe source behavior reproduced |
| Corrected `f6df52be` | Same assertions and owned fault | Refused with CrossProcessTurnAcquireTimeoutError |

Both scripts join their owned child and remove only their synthetic state.
They make no network/model calls and never inspect private SDK transcripts.
These controls establish filesystem protocol facts and prevent the rejected
recovery policy; they do not simulate actual power loss.

## Verification and review

macOS arm64, Bun 1.3.14. At `f6df52be`, `npm test` passed **5,349 tests,
35 existing skips, 0 failures**, across 19 isolated stages, including its
pretest typecheck. Standalone `npm run typecheck`, `npm run build` and focused
controls passed. Logs supplement this durable result in the local review
artifact directory; a temporary log alone is not the acceptance record.

An independent reviewer inspected the production diff and fault controls:
owner/candidate/publication ordering, pre-heartbeat parent fsync, exact-token
cleanup, retained AggregateError failures, alive/dead/unknown owner boundaries,
Windows limitations and cleanup of test processes. No material production
finding remained. Two old comments incorrectly described age-based ownerless
recovery; they now describe the existing fail-closed behavior. Those comment
corrections do not change the tested executable behavior.

## Open gates

This is a focused durability improvement, not proof that the original torn-lock
incident was caused by missing fsync or that an unreadable lock can safely
self-heal. Actual power-loss behavior, Linux filesystem durability and Windows
native behavior remain unverified. Required affected-client/model/SDK live
verification and exact final-head CI remain acceptance gates. Keep the delivery
draft until those gates are satisfied; keep #1223 open for its excluded recovery
proposal and unresolved original symptom. No release is authorized.
