# Native Sonnet context review — #1213 / #1212

**Prepared, not accepted:** local code proof is complete; actual Linux /
OpenCode 2.0.16 / Sonnet 5.5 before-and-after generation remains a gate. No
valid native Sonnet completion has been observed: two SDK query attempts
across the retained rounds ended in synthetic provider refusals. Final-head CI and
affected-flow acceptance remain open.

Source head: `553fd5c386de5e18e531a1d0101d64ef3a3b1792`. Contributor
`robertn702`'s two commits (`179257b9`, `553fd5c3`) were cherry-picked with
original Author/AuthorDate preserved. Maintainer corrections are separate.
Initial exact unchanged-main control:
`f299fe06e72411b786380b5212edea79cd13966a`.
Current integration base is fetched main
`0369441786b082aadeb31689dcbce41d7e8574d9`; rebased contributor mappings
are `179257b9` → `c6991b05` and `553fd5c3` → `390c45d5`. Both rebases
were conflict-free and retained the contributor's Author/AuthorDate.

## Product fit and adversarial corrections

The official [Claude Code model configuration](https://code.claude.com/docs/en/model-config#extended-context)
documents native 1M context for concrete Sonnet 5/5.5 on every plan without
the `[1m]` tier or usage credits. The [model overview](https://platform.claude.com/docs/en/models/overview)
also lists Sonnet 5.5's 1M window. Checked 2026-10-04. Meridian's 200k
catalog and replay assumption therefore prematurely discard supported
Sonnet history. Source updates both the catalog and all seven server replay
budget/fallback call sites using the exact effective SDK Sonnet pin.

Two material findings were corrected:

- Source inferred 1M from every numeric Sonnet generation >=5, including
  hypothetical `claude-sonnet-6-0` and malformed/unknown 5.x ids. The helper
  now recognizes the supported exact `claude-sonnet-5` and
  `claude-sonnet-5-5` ids, conservatively retaining 200k for unknown versions.
- The inherited `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` reaches the real SDK and,
  per the official documentation, budgets every model at 200k. Catalog and
  every replay path now honor it. Sonnet 4.6 and unrelated tiers retain their
  existing rules. Documentation clarifies that Meridian's optional `[1m]`
  tier opt-out alone cannot shrink native Sonnet, including subagents.

HTTP tests cover streaming/nonstreaming replay, inherited 4.6/unknown ids,
explicit versioned request precedence in both directions and the CLI disable
flag. Pure negative controls cover unknown/malformed ids and all explicitly
disabled extended tiers; the actual `/v1/models` route has a disable control.
No new route, public configuration field or plugin hook is introduced.

## Reproducible local before/after

The escrowed [fixture](../../../scripts/e2e-sonnet-context-fixture.mjs) contains
six deterministic synthetic code-history groups. The
[local harness](../../../scripts/e2e-sonnet-context-local.mjs) runs the same
ancient-marker/no-trim assertion on either source tree:

```sh
E2E_MERIDIAN_ROOT=/path/to/unchanged-main bun scripts/e2e-sonnet-context-local.mjs
E2E_MERIDIAN_ROOT=/path/to/fixed-tree bun scripts/e2e-sonnet-context-local.mjs
```

| Exact assertion | Unchanged main | Fixed source |
| --- | --- | --- |
| Estimated synthetic history | 261,350 tokens | 261,350 tokens |
| Plain Sonnet 5.5 replay budget | 160,000 | 836,000 |
| Advertised Sonnet 5.5 window (non-Max) | 200,000 | 1,000,000 |
| Ancient history retained | false | true |
| Omitted messages | 7 | 0 |
| Current coding request retained | true | true |
| Same no-trim assertion / exit | FAIL / 1 | PASS / 0 |
| 4.6 / unknown / explicit-disable window | 200k each | 200k each |

These are estimates and local structural assertions. They do not establish
real native input capacity, token usage or affected-client acceptance.
Sanitized durable facts are in
[1213-native-sonnet-context-results.json](1213-native-sonnet-context-results.json).

## Actual affected-flow gate and credential blocker

The fresh, separately isolated Linux x86_64 container has Node 24.21.0,
Bun 1.3.14 and the actual released OpenCode 2.0.16 binary. The previously
owned Linux fixture was mounted read-only; only a disposable private copy
was used for readiness. Native `auth status` reported logged in, but access
expiry was past and the read-only OAuth usage request returned **401**.
No generation followed. The specifically authorized owned custom macOS
directory was also checked only via `createPlatformCredentialStore` with
its explicit directory: credential present=false, future expiry=false,
scopes present=false. No default/global Keychain service was consulted.
No grant, identity, authorization URL, raw client log or private SDK
transcript was displayed or retained as proof.

The final credentialless real 2.0.16 rehearsal passes the complete installed
plugin/config/catalog/import path: client and proxy both report 1,000,000,
the plugin makes one `/v1/models` discovery request, and supported import
retains all 15 projected messages (931,634 serialized characters).
Model requests are fenced; wire/model-query counts are zero. Cleanup observes
zero owned residual processes, joins the public proxy/child lifecycle and
removes the private credential-copy directory. This permits the full fixture
to be seeded without preparatory giant calls. The first fresh-image startup
refused a missing machine-id; the failed result is retained. Generating a
machine-id only inside the new disposable container resolved that prerequisite;
no admission guard or assertion was bypassed.
The escrowed [live/rehearsal harness](../../../scripts/e2e-sonnet-context-v2-live.mjs)
isolates HOME/XDG, package-installed plugin/config, ports, projects and
sessions. It uses supported V2 import/prompt/wait APIs, observes public SDK
arguments/results without substituting them, and never reads SDK files.

After building the intended source/package on Linux:

```sh
E2E_MERIDIAN_ROOT=/path/to/built-tree \
E2E_OPENCODE_BIN=/path/to/opencode-2.0.16 \
E2E_IMPORT_ONLY=1 E2E_PROOF_DIR=/path/to/rehearsal-proof \
bun scripts/e2e-sonnet-context-v2-live.mjs

E2E_MERIDIAN_ROOT=/path/to/built-tree \
E2E_OPENCODE_BIN=/path/to/opencode-2.0.16 \
E2E_PROFILE_CLAUDE_DIR=/owned/read-only/native-fixture \
E2E_PROOF_DIR=/path/to/before-or-after-proof \
bun scripts/e2e-sonnet-context-v2-live.mjs
```

Actual acceptance requires a usable specifically owned native fixture,
SDK 0.2.141 and native CLI supporting Sonnet 5.5 (2.1.284+). The installed
V2 client must adopt the advertised catalog through its real plugin/config
path; the harness never hardcodes a model window. Unchanged main must fail
the same ancient-marker/no-trim assertion. Fixed source must retain all
history, serve native `claude-sonnet-5-5`, observe actual input >200k,
deliver the current coding receipt and pass a minimal same-session resume.
One baseline generation and one fixed generation plus one small resumed
turn are sufficient; an unrelated model/platform or import-only pass is
not acceptance. Credentials are copied only privately, never changed in
their source store and deleted from the disposable runtime in `finally`.

## Local validation

The 2026-10-04 test-agent preparation targets
`dac34820653253da8a69fe81cad5cb2d7e5dc0ab` against the exact current main
above. The source archives were built on Linux x86_64 and independently
installed as tarballs; all 409 installed `dist` files match each arm's built
source. Both arms resolve SDK 0.2.141 and the actual CLI reports
`2.1.284 (Claude Code)`. Released OpenCode 2.0.16 adopts each installed
plugin's discovered catalog (200k before, 1M after), and supported import
retains all 15 messages with zero generations in both rehearsals.

The controller's explicitly authorized `default-native` snapshot initially
passed read-only readiness with HTTP 200. The baseline attempt subsequently
stopped before generation with HTTP 401 despite future expiry and scopes.
The exact same snapshot returned 401 on the host and Linux; its sanitized
response classification was `invalid-or-expired-token`. Both snapshots
remained unchanged, the source mount was read-only, and runtime cleanup
joined with zero owned residual processes. This is an authentication blocker,
not a failed native Sonnet generation or a completed affected-flow test.
The [current sanitized attempt record](1213-native-sonnet-context-acceptance-20261004.json)
retains the exact heads, author maps, package hashes, assertions and missing
gates. No credential, identity, authorization URL or SDK transcript is included.

### Bounded personal-profile attempt (round 2)

The controller selected the configured `personal` profile under the owner's
explicit authorization. Its immutable snapshot passed read-only OAuth usage
readiness on the host and Linux with **HTTP 200**; the grant was present,
future-dated and scoped. A separate mode-0700 directory/mode-0600 Linux copy
retained the supported credential-store shape with an empty refresh token.
`MERIDIAN_CREDENTIALS_READONLY=1` was set before imports and proxy startup.
Neither source store nor the controller's immutable copy was written, and no
refresh, login, other-store search or private SDK transcript access occurred.

The unchanged-main installed arm made **one SDK query attempt** and exited
**1**. The actual released OpenCode primary request carried the ancient marker,
current receipt marker and signed identity. Main advertised/adopted 200,000,
then passed only 7 of the 14 synthetic user/assistant history messages to the
SDK (15 records were imported including the idle event): prompt characters
458,019, ancient marker absent and omission notice present. The same no-trim
fact is false. However, the SDK emitted only model **`<synthetic>`**, observed
input tokens **0**, result subtype `success`, one native turn and no coding
receipt; the iterator had not completed when the client reported its error.
The harness therefore failed the earlier native account/model/completion
assertion, not its expected live ancient-marker assertion.

Recovery used only supported OpenCode session-message GET requests, with zero
additional model queries. The current assistant entry had `finish=error` and
the sanitized message **“Claude Max subscription issue. Check your subscription
status at [redacted].”** This is Meridian's `billing_error` normalization in
`src/proxy/errors.ts`; the supported client error object carried status 200,
which is not proof of a successful model response. The underlying upstream
billing/entitlement detail was not retained, so its precise cause remains
unproven. OAuth readiness alone did not establish generation entitlement.

The attempt stopped for this unexpected failure. **The fixed generation and
tiny same-session resume were not run.** There were no giant preparatory calls,
no fallback profile and no unexplained rerun. The bounded gate remains **OPEN**:
one SDK query attempt, zero observed valid `claude-sonnet-5-5` completions,
and no actual before/after acceptance. The earlier default-native 401 failures
remain retained separately; this round does not replace or explain them.

All 534 files under each frozen arm's `src` match its exact source head; all
409 installed `dist` files still match the corresponding built source. The
sanitized JSON record retains source/tree/archive/tarball/distribution,
SDK module, actual native executable and OpenCode binary hashes, exact command,
assertions, failure, query counts and cleanup. Exact tarballs were also exported
locally for the controller; no upload or PR mutation occurred.

The proxy/client/native children and supported-history readers joined with
zero owned residual processes. Runtime auth, both rounds' disposable scoped
copies, this round's fixture/session directories, the specifically owned
container and its exclusive temporary image were removed. The controller's
private snapshot remained unchanged and available for its subsequent gates.

### Bounded WORK entitlement control (round 3)

This new round was explicitly authorized to distinguish OAuth readiness
from inference entitlement. The controller selected its configured `work`
profile and supplied a new immutable snapshot, reporting a different access
grant from `personal`. This agent read only that exact snapshot. The grant
was present, future-dated and included `user:inference`; read-only Linux OAuth
usage readiness returned **200**, and native health reported logged in.
The source mount was read-only. One isolated mode-0700/mode-0600 scoped copy
had an empty refresh token; read-only mode was set before imports/proxy.

The new control uses `E2E_ENTITLEMENT_ONLY=1 E2E_MAX_GENERATIONS=1` on the
committed live harness. It creates a fresh disposable session through the
actual OpenCode V2 API, imports no history, and sends a **105-character SDK
coding prompt**. Success requires the actual `claude-sonnet-5-5` model,
correct credential directory/native executable, a completed stream and
successful result with `is_error=false`, one native turn without tool calls,
an assistant-only coding receipt and exactly one SDK query.

```sh
docker exec -w /owned/fixed-install \
  -e MERIDIAN_CREDENTIALS_READONLY=1 -e TMPDIR=/owned/tmp \
  -e E2E_MERIDIAN_ROOT=/owned/fixed-install/node_modules/@rynfar/meridian \
  -e E2E_OPENCODE_BIN=/opt/e2e/node_modules/.bin/opencode \
  -e E2E_PROFILE_CLAUDE_DIR=/owned/work-native-source \
  -e E2E_ENTITLEMENT_ONLY=1 -e E2E_MAX_GENERATIONS=1 \
  -e E2E_PROOF_DIR=/owned/proof/round3-entitlement \
  meridian-sonnet-round3-1267-20261004 \
  bun /harness/e2e-sonnet-context-v2-live.mjs
```

**Control: FAIL / exit 1 / exactly one SDK query.** The signed primary V2
request reached the selected installed SDK/account path, but its assistant
model was **`<synthetic>`**, error classification `unknown`, input tokens **0**,
tool-use blocks **0** and coding receipt absent. The result subtype was
`success` while **`is_error=true`**; the iterator propagated the refusal before
normal completion. OpenCode's assistant finished with an error normalized
to `billing_error` and status **200**. Neither that status nor the SDK subtype
establishes a successful native generation.

The harness now preserves original provider facts **before normalization**.
The original synthetic assistant text was 128 characters; the fixed diagnostic
allowlist retained **“API Error”**, **400**, and **“extra usage”** from it and
the error result/propagated iterator error. No arbitrary provider wording,
identity, token or URL was retained. These facts establish an upstream refusal
mentioning extra usage; **the precise entitlement restriction remains
unproven**. They do not retroactively explain round 2's unretained original
provider detail or round 1's invalid/expired-token 401 failures.

The control stopped this round. **Baseline, fixed large-history generation
and resumed turn: NOT RUN**, zero queries each. No fallback, refresh, login,
other-store search or unexplained rerun followed. Across the retained rounds
there are two SDK query attempts and zero valid required-model completions;
the original large-history before/after gate remains **OPEN**.

Preparation reused both exact exported Linux tarballs in a new owned container
on pinned amd64 image
`sha256:94a3ec562dee261c739fc724f0bd866aafe11ab59ea4b8d6406ecae6ad650301`.
Each arm was independently installed with SDK **0.2.141** / native CLI
**2.1.284** and the actual OpenCode **2.0.16**. All 409 installed distribution
files equal the exact previously built tarball; the SDK, executable and client
hashes also match the prior independent installations. All 534 frozen source
files match exact main `03694417` or candidate `cabc390f`, whose production
source/dependencies equal previously tested `dac34820`. The unchanged fixture
hash remains `2f3be87d311acda8dfc559fb8db035a8707aea8c7a92dec1f799fada3d9706b9`.
The current real-client credentialless rehearsal retains 15 messages and
931,634 serialized characters with zero model queries. It proves prerequisites,
not native capacity or fix acceptance.

The durable JSON `liveRounds.round3` contains commands, both tarball/source/
dependency/tool hashes, exact source verification, control assertions/errors/
exit/query count, prior failure provenance, privacy validation and cleanup.
Syntax, diagnostic privacy checks and diff validation pass. Prior 286 focused
tests/typecheck/build proofs apply to unchanged production sources; this agent
did not take the controller's full-suite slot. Independent review of the new
harness mode and final-head CI remain controller gates.

Cleanup joined proxy/client/native children with **zero owned residuals**,
removed runtime auth, the scoped copy, all fixture runtimes and only the owned
round-3 container. The shared pinned image was preserved. Before/after digest
comparison proves the controller's immutable WORK copy unchanged; it remains
available to its owner. The user's root checkout and other worktrees were not
written. No push, PR
mutation, merge, issue/source closure, external comment or release occurred.

Preparatory adversarial findings strengthened the escrowed gate: it now
observes retention of every fixture message, compares public native session
IDs without storing them, requires the resumed credential/executable and a
small prompt delta, enforces one baseline/two fixed queries, records native
tool turns, asserts Linux x64 and bounds readiness/catalog/setup/startup.
The original ancient-marker/no-trim assertion remains unchanged.

Focused checks: 112 pure model/replay tests, 121 catalog/conversion tests,
41 actual HTTP replay tests and 12 health/catalog-route tests pass. Standalone
typecheck and native Node bundle builds pass on macOS and Linux.
Full `npm test` at `74e50774fba47a7540f5b1c8c9f24e8d2db35bb8` passes
**5,321 tests, 35 skips, zero failures across 18 isolated stages**. Its pretest
typechecks. Later changes affect only the escrow harness/evidence; final
standalone typecheck, syntax check and actual credentialless rehearsal pass.
That full-suite result predates the latest base. The current test-agent run
passes all 286 focused tests on Linux and macOS, plus standalone typecheck
and builds on both platforms. The root controller coordinates the remaining
full suite, independent final review and final-head CI; this agent did not
push, mutate the PR, merge, close #1212/#1213 or publish a release.

Prior independent adversarial review left no material production or harness
findings at its reviewed head. It corrected receipt checks that could match user prompts, SDK
observation from the wrong dependency tree, inherited HOME/global plugin
loading, unbounded/private-copy cleanup and lost descendant ownership after
reparenting. The final harness uses assistant-only receipts, the selected
tree's exact SDK 0.2.141, isolated parent/client HOME/XDG/plugin paths,
bounded shutdown and tracked Linux PID/start-time identities with zero owned
residuals. Native generation is fenced in rehearsal and bounded to at most
two queries per history arm or one entitlement-control query. The round-3
harness additions still require the controller's independent final review.
Exact final-head CI and the real affected-flow
before/after remain required before acceptance; no merge, closure or release
is authorized by these local results.
