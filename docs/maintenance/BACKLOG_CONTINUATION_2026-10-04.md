# Managed backlog continuation — 2026-10-04

## Scope and authority

This follows the [merged initial checkpoint](BACKLOG_REVIEW_2026-10-04.md).
Root remains the sole queue owner. This documentation branch starts from
`0369441786b082aadeb31689dcbce41d7e8574d9`; the user's dirty checkout and
other delivery worktrees are preserved. The controller supplied the current
GitHub decisions below; active branch records were read locally. This is a
bounded continuation snapshot, not a new complete queue refresh or acceptance
of every open item. Earlier records remain historical wherever superseded here.
No release or community-comment authorization is inferred.

## Delivered checkpoint and current decisions

- [Checkpoint #1269](https://github.com/rynfar/meridian/pull/1269) merged as
  `0369441786b082aadeb31689dcbce41d7e8574d9` from validated head
  `65b7793001e9982296459a7e33b85813bc2e8509`. Both trees are
  `e6ea7edcea9a81aeba9dd7b13cfed32f60eef4a2`; required
  [test run 37238890010](https://github.com/rynfar/meridian/actions/runs/37238890010)
  passed. Its earlier CI-pending statement is superseded.
- [Source #1228](https://github.com/rynfar/meridian/pull/1228), unchanged at
  `cee10174bb1fa500cd85d5937ec0c99339e8374d`, was declined and closed at
  22:45 UTC. Private SDK transcript mutation conflicts with Meridian's
  supported-API history boundary. Closing that implementation does not resolve
  the original history/rollback symptom. Revisit through a supported SDK
  operation with the actual affected Pi/model/platform and rollback/tool/undo/
  cancellation evidence.
- The owner approved [#1270](https://github.com/rynfar/meridian/issues/1270):
  authenticated `/profiles/list` may add exactly `refreshTokenExpiresAt`,
  `daysUntilRenewal`, `renewalRequiredSoon` and `accessTokenExpiresAt`, with shared
  current-expiry UI. This is advisory current metadata, not an authentication
  verdict or universal provider lifetime. [Source #1260](https://github.com/rynfar/meridian/pull/1260)
  remains open at `99b8f0c46fbf8ce0b7f28cb14d2bdce4929948ef`; its five history
  fields, lifecycle storage/listeners and auth-category logging remain excluded
  and deferred. Earlier blanket approval-pending wording is superseded only for
  these four fields and their approved UI/persistence scope.
- [#1219](https://github.com/rynfar/meridian/pull/1219) now has a complete extracted
  source diff. The [durable bounded SQLite review](evidence/1219-sqlite-scope-review.md)
  supersedes the HTTP-406 extraction blocker, while whole-stack semantic review,
  SQL public/operator contract approval and affected-flow acceptance remain open.
  No new approval issue was opened by this checkpoint. #1244's asynchronous
  cleanup contract was already approved; do not request that approval again.

## Active deliveries and open gates

Heads below identify the observed committed state, not final acceptance.
Use each delivery's applicable local checks, independent final review and fresh
final-head CI. Product behavior acceptance still requires actual affected-client/
model/SDK/platform proof; an internal harness correction does not resolve the
original product evidence gate by itself.
Root will update changes in these active paths before proposing this checkpoint.

| Path | Exact observed head | Evidence and remaining work |
| --- | --- | --- |
| [Draft durability #1271](https://github.com/rynfar/meridian/pull/1271), partial #1223 | `7de8cf5ff511110ab20dbfeffeb5b21a92c8c10e` | Safe ownership fsync/publication only; uncertain owners remain fail closed. Full suite at pre-rebase correction `f6df52be`: 5,349 pass / 35 skips / 0 failures, typecheck/build and independent review pass. Documentation-base rebase preserves executable/test blobs; two corrected comments are non-executable. Affected-flow/native durability and final-head CI remain open. Original torn-lock symptom and excluded ownerless recovery remain unresolved; #1223 stays open. |
| [SSE #1214](https://github.com/rynfar/meridian/pull/1214) | Frozen `bb33d26d7757e34deb6645bf66d0c14d77658c0f` | Bounded JSON/SSE classification, exact cancellation joining and retained turn fences have discriminating controls and independent approval after corrections. Full suite is running in the controller's exclusive slot. Actual implicated client/model keepalive/refusal/failover/cancellation/continuation and final-head CI remain open. |
| E41 thinking fidelity for [#1245](https://github.com/rynfar/meridian/pull/1245) / [#1220](https://github.com/rynfar/meridian/pull/1220) | `b49defeccf2be9dcae30863689b35b3a6e0d42fd` | Internal harness correction preserves signed/redacted thinking through JSON and streaming replay. Offline controls and independent review pass; full suite is queued. It does not explain the original 200-token canonical-prefix deficit or establish live E41 acceptance. |
| Approved expiry #1270 / partial #1260 | `5ae59a16f9e31415fe7d4c7ef61d8b631461ca06` | Four-field route and shared exchange controls pass with synthetic stores/provider responses; source/current fields and history exclusions are preserved. Full suite is queued. Actual narrow/wide browser focus/layout, positive native/provider login and re-authentication, supported-client receipt/package proof and final-head CI remain open. |
| Recorded transcript enrollment / [#1261](https://github.com/rynfar/meridian/pull/1261) | Committed baseline `4d645c7faea42539d86f694758dbcaef37d92008`, with further local corrections | Exact recorded-locator enrollment fixes a bounded metadata gap; no contributor source hunks were retained. Enrollment/CAS, capacity/victim and predecessor-discard corrections are still being finalized and reviewed. Full/native/client/Windows gates remain open. Unknown or already-forgotten shared-root sessions, including the reported untracked backlog, remain outside this correction. Source stays open. |
| [Draft Sonnet #1267](https://github.com/rynfar/meridian/pull/1267) / #1213/#1212 | Local rebase `dac34820653253da8a69fe81cad5cb2d7e5dc0ab` | Prior selected default-native snapshot stopped at read-only 401 before any SDK query; installed-client rehearsal had zero generations. A fresh explicitly selected personal fixture now returned read-only usage 200; T3 round-two Linux/OpenCode 2.0.16/SDK 0.2.141/Sonnet 5.5 before/after gate is ongoing. Readiness is not generation proof. Preserve native assertions and resume evidence, then refresh local/base/head/CI gates; source and issue remain open. |

## Source preservation and evidence locators

Durability preserves Nowaker's source `537ccad864336a4f4dc25f925e92177cd12fe6b2`
as authored `0007beb9837415c8c385f19bf2864ba985975406`, with separate correction
`90aa8ab173e85cd95f9d292d0eb95463621df240`. Its committed
[delivery record](https://github.com/rynfar/meridian/blob/7de8cf5ff511110ab20dbfeffeb5b21a92c8c10e/docs/maintenance/evidence/1223-turn-lock-durability.md)
retains the original author/date and discriminating durability/refusal controls.

Expiry preserves source `99b8f0c4` as authored
`dbcdb01507899d36c058c86ccd3d61e8b955109b`, with separate scope/correction
`c48e838d5dfdaca6cc9854610c5cda0ad848f3b8`. SSE maps authored sources
`d4e36fa90a3ecfbcb48c91c8c4023224b1386f32` and
`1c8f17099ad62dbd2a511f69c12e5b4e15d9da7f` to
`4c4abdbd8ba649a69f4aaf5b01ffacc522a6b0d8` and
`928c9f319a59469ecc5210f126fe6d55f2745fd7`; maintainer corrections are separate.
Sonnet's current contributor mappings are
`179257b96c1e1d591d0c5d2ed28ccff1af1ae85e` →
`c6991b05f48a96401d1df9e35a1c5ef1d540bef8` and
`553fd5c386de5e18e531a1d0101d64ef3a3b1792` →
`390c45d593e5189e84bfd9a2225abc8bc2353f88`.
Final squash credit remains an integration check.

For an unpublished active branch, use the exact local head above and its
repository-relative record below; working drafts may contain newer uncommitted
facts and must be frozen before final review. These records are in isolated
`/Users/rynfar/repos/` worktrees:

| Worktree | Repository-relative record |
| --- | --- |
| `meridian-sse-priority-incorporation-1214-20261004` | `docs/maintenance/evidence/1214-sse-priority-failover.md` |
| `meridian-e41-thinking-fidelity-20261004` | `docs/maintenance/evidence/e41-thinking-fidelity.md` |
| `meridian-login-deadline-1260-20261004` | `docs/maintenance/evidence/1270-profile-expiry.md` |
| `meridian-transcript-retention-correction-1261-20261004` | `docs/maintenance/evidence/1261-legacy-enrollment.md` (currently a working draft) |
| `meridian-sonnet-context-1213-20261004` | `docs/maintenance/evidence/1213-native-sonnet-context.md` and sanitized acceptance record (currently being updated) |

No model/browser/code validation ran for this documentation change. Content,
links and diff validation are its local gates; required final-head CI remains a
separate gate for its own PR. No item is accepted merely because another branch
passed tests, and no release is authorized.
