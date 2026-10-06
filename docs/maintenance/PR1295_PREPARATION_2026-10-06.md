# #1295 authored incorporation preparation

Status: prepared for further review and required gates; no acceptance, merge,
publication or affected-production proof is claimed. This record covers only
[#1295](https://github.com/rynfar/meridian/pull/1295).

## Source and author custody

Worktree: `/Users/rynfar/repos/meridian-pr1295-publication-stall-20261006`.
Branch: `codex/pr1295-publication-stall-20261006`.
Fresh `origin/main` at preparation: `ca6a5c0a4eddb87da52d83993f8f9e105712f0f6`.
Refreshed contributor head: `9d932c846afbb19b92d1a8f516772b3cd2552491`.

| Actual contributor commit | Authored incorporation |
| --- | --- |
| `31dfea0b09bbc5ad851ac9dd2e5d6de035584746` | `1d76be40355ddac7aabebfa2f2d9cc5b92637d87` |
| `9d932c846afbb19b92d1a8f516772b3cd2552491` | `b2ec72c763f82283ff6fb5e3ec96e564bc939f17` |

Both actual cherry-picks preserve Nowaker `<spam@nowaker.net>` and AuthorDates
2026-09-28T08:18:11Z / 2026-09-29T20:54:22Z. They were made with `git cherry-pick
-S` using the repository's SSH signing setup. Local signature trust verification
remains unavailable because `gpg.ssh.allowedSignersFile` is not configured; no
trust configuration was changed. Maintainer corrections are separate in
`ee40d8484b2ab1507302a021952482ae63aee1dd`.

The dirty owner checkout and #1290 worktree were preserved. Existing dependency
files are shared through a `node_modules` symlink; no install or dependency
modification occurred.

## Corrections and scope review

- P2: a holder gets at most one additional full window when its first deadline
  runs late. The second callback rejects queued and new callers even when it is
  late again. The active holder retains ownership until its real completion;
  work never overlaps. A frozen event loop still cannot execute a timer, so this
  bounds extensions once callbacks run rather than promising a wall-clock
  deadline while JavaScript is suspended.
- P3: the existing process-wide operational stderr policy moved from server
  orchestration into `operationalLog.ts`. The server and queue import that leaf;
  `silent: true` suppresses the late-deadline operational line while diagnostic
  entries remain. Nonsilent hosts retain the operational line. This preserves
  the existing process-wide policy and changes no public configuration or route.
- Publication assertions now inspect SDK identity/options and exact replay
  history. After deferral, the next target differs from both the original source
  and abandoned target, has no resume/resume-at/fork options, and receives all
  supplied earlier user and assistant turns plus the live user turn.
- Both JSON and SSE have controls for healthy publication/resume, fresh and
  headerless deferral, a concurrent CAS winner, durable invalidation throwing,
  cancellation, forced shutdown, and durable priority publication. Priority
  assignment and mapping generation retain their existing atomic authority.
- Actual queue-capacity and external-acquisition rejections are exercised before
  the publication callback enters. The latter invokes the real lifecycle
  acquisition with a current isolated lock fixture and zero wait budget; the
  callback sentinel stays false. These are bookkeeping tests with a mocked SDK,
  not evidence from an actual model or Linux deployment.

The production pre-entry guarantee, durable mapping CAS, priority exclusion,
cancellation/revocation checks and cleanup ownership are unchanged. Alternate
captured-tool and silent-recovery publication barriers remain separate; the new
fallback is not a claim about those paths. No general recovery guardian, public
interface or test platform was added.

## Focused reproducible evidence

Runtime: Bun 1.3.11 (`af24e281`), supplied isolated Darwin arm64 executable at
`/Users/rynfar/repos/meridian-review-evidence-20261006/pr1290/tooling/bun-1.3.11/package/bin/bun`.
The SDK and model responses are mocked; the requested model string in the HTTP
fixtures is `claude-sonnet-4-6`, not a tested actual model ID.

```sh
bun test src/__tests__/lifecycle-lock-queue.test.ts \
  src/__tests__/lifecycle-publication-degrade.test.ts \
  --test-name-pattern 'recurrently|late-deadline diagnostics' --timeout 10000
```

Before the correction, the nonsilent control passed and two assertions failed:
the second `clock.advance(111)` left the waiter unrejected, and a silent proxy
still emitted one operational stderr line. Result: 1 pass / 2 fail, exit 1.
The corrected assertions pass: 3 pass / 0 fail, 11 assertions, exit 0.

The final tests were additionally run against a reversible two-line mutation of
`lifecycleLockQueue.ts`: remove `&& !graceUsed` from the late-deadline condition
and replace `plog` in `logQueueEvent` with `console.error`. This restores the two
authored defects without altering fixtures or removing the new logging leaf.
It produced the same 1 pass / 2 fail result. The queue file was byte-restored
(SHA256 `8bb032057b0f8b1e9381efa6146f67bc92fc6a30ea53f1f7d30f47129314f1de`),
and the same focused command then passed 3 / 0.

```sh
bun test src/__tests__/lifecycle-lock-queue.test.ts \
  src/__tests__/lifecycle-publication-degrade.test.ts --timeout 10000
npm run typecheck
git diff --check
```

Final focused files together: 37 pass / 0 fail, 262 assertions, 6.63 seconds.
Typecheck and diff checks pass. Broad `npm test` and build were intentionally not
run while the authorized owner was running #1290 live gates.

## Narrow live fault-harness proposal — not implemented or executed

Proposed repository gate: `scripts/e2e-publication-lock-fallback.mjs`, following
the isolated ports, configuration, sessions, fixture workdir and supported SDK
history inspection of `scripts/e2e-publication-lifetime.mjs`. The owner selects
and records the actual affected provider, Linux architecture, client/plugin,
model, SDK/CLI and runtime tuple before implementation or execution. Actual
OpenCode runs require the generation-matching Meridian client plugin and its
preflight/runtime route witnesses from E2E.md. The canonical Linux OpenCode gate
also requires the scrub plugin and retains both plugins' runtime witnesses.

Keep the probe to terminal publication after one real SDK answer, in JSON and
SSE. A harness-local scheduling hook should first establish that the real SDK
writer has joined, then hold the actual lifecycle FIFO ahead of terminal
publication or hold its isolated canonical external lock with a bounded helper
process. Do not manually manufacture a lock exception from inside a durable
callback. Record a callback-entry sentinel so a failure proves acquisition was
rejected before the session-store CAS. The fault must leave the original holder
owned until explicit completion; cleanup may remove only its exact owned lock.

For the timer arm, delay the first real deadline beyond the existing tolerance,
allow its single grace window, and delay the second deadline again. Require
eventual waiter rejection after the second callback, no overlapping operation,
and recovery only after actual holder completion. Pair this with a one-delay
control whose holder completes within grace and serves its waiters. This does
not require generating additional model turns for each timer waiter.

For response/replay arms, require complete JSON or one complete SSE terminal,
exact invalidation of the old mapping, a distinct fresh follow-up target with no
old resume, and complete client history including tool call/result identity.
Inspect actual SDK history only through supported APIs. Include healthy
publication, concurrent-winner, failed-invalidation, priority and cancellation
controls; preserve sanitized before/after logs and head/build/harness hashes.
Run unchanged main and the final corrected head with the same assertions.

This document is a proposal, not an escrowed executable harness. Committing the
narrow runnable gate and capturing actual failure/pass artifacts remain explicit
acceptance gates; mocked success cannot substitute for them.

## Required next gates

1. Independent final-diff review, required local `npm test` / typecheck / build,
   including process-global mock isolation, and final corrected-head CI with
   `test`. No branch push, PR creation, merge or external comment occurred.
2. Implement and run the proposed affected-flow fault gate on the actual tuple;
   the author's production Linux client/model/version tuple is still unknown.
3. Run E2E.md's concurrent transcript publication gate in both modes with the
   implicated model explicitly selected, all four E41 sequential/parallel ×
   JSON/SSE arms, and actual affected-client continuation with its required
   plugin witnesses. No SDK, model, auth, provider, package, Docker or live
   client operation was performed during this preparation.
4. Refresh source head and current main before delivery and immediately before
   any exact-head merge. Preserve contributor credit on the eventual squash.
   Release authorization remains separate.
