# Replay-budget test isolation — #1240

Source [#1240](https://github.com/rynfar/meridian/pull/1240) at
`d868637455387e0359f1b3f4975caaf5fb1399ac`, authored by robertn702
<8119609+robertn702@users.noreply.github.com> on 2026-10-02T15:15:12Z,
is incorporated as `cbdd5d174c0566a283fc6b9c36cb775b624308b3` from main
`d57388724a242116f123ff75b88fd2be2846abe3`, preserving Author/AuthorDate.

## Findings

The reported process-global models mock still affects the real replay-budget
module when profile-switch test modules load first. The ordinary three-file
command on this host selected a harmless load order (28 pass). A disposable
ordered import fixture loaded profile-switch-inflight, then
profile-switch-integration, then replay-budget; filtering to `replay budget`
avoided running unrelated profile tests under the combined mock environment.
It reproduced exactly the two reported failures: `opus[1m]` received a 200k
window and a 20k reserve (11 pass, 2 fail). Running the original replay-budget
file alone passed all 13 assertions. Bun was 1.3.14, Node 22.22.3, macOS arm64.

The change excludes `**/*replay-budget*` from the shared stage and explicitly
runs `src/__tests__/replay-budget.test.ts` after models.test.ts. File inventory
confirms the exclusion currently matches exactly that test. It does not alter
application behavior, budget assertions, timeouts or model routing. It fixes
the supported npm test runner, not arbitrary combined bare-Bun invocations.
Other models mocks remain a broader follow-up; this does not resolve all CI
flakiness reports (#933/#917).

## Reproduction

In a disposable `ordered.test.ts` (absolute paths target the reviewed checkout):

```ts
await import("/path/to/checkout/src/__tests__/profile-switch-inflight.test.ts")
await import("/path/to/checkout/src/__tests__/profile-switch-integration.test.ts")
await import("/path/to/checkout/src/__tests__/replay-budget.test.ts")
```

```sh
bun test --timeout 30000 --test-name-pattern 'replay budget' /path/to/ordered.test.ts
bun test --timeout 30000 src/__tests__/replay-budget.test.ts
npm test
npm run typecheck
npm run build
```

No model call is implicated by this test-runner-only change. Final full-suite
and exact-head CI results are recorded in the integration PR before merge.
