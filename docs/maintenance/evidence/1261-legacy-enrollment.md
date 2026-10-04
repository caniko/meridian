# Recorded legacy transcript enrollment — partial response to #1261

## Scope and provenance

Contributor PR [#1261](https://github.com/rynfar/meridian/pull/1261) remains open and
unincorporated at `7475d08c652332aa1b9b23cbc525024bef83ab28`, authored by
Nowaker `<spam@nowaker.net>` on `2026-10-04T03:36:26-05:00`, with source base
`f299fe06e72411b786380b5212edea79cd13966a`. Live GitHub was rechecked on
2026-10-04 at delivery preparation: source head unchanged, state OPEN. Its purpose is accepted: bound disk growth without destroying native
resume history. The original CLI age-sweep implementation remains deferred for
ownership, admission, pin and process-lifetime reasons recorded in the
[source review](1261-transcript-sweep-review.md).

This is an independent maintainer correction, prompted by that assessment.
**No contributor source hunks were retained or cherry-picked.** It does not
claim to incorporate or fully resolve #1261. Implementation started from
`3afca1f5a0d51d74f8c7437b90f43d5686cf4163` and rebased onto
`0369441786b082aadeb31689dcbce41d7e8574d9`; that base update changes only four
maintenance documents, so source/harness proof is unaffected. The initial
implementation commit is `4d645c7faea42539d86f694758dbcaef37d92008`; the
final safety correction is `c62fe69151793532711f0936e1090c1d95651d4a`.
It contains the protected-key index, predecessor guards, conservative uncertain
publication handling and isolated-grant harness authority tests.
The final harness setup/target-SDK correction is
`d8bd970684bc49042cf641120e0da2412473c123`; its three files change the native
harness, its authority tests and E2E instructions. At that checkpoint, product
source/test blobs outside that authority test remain identical to `c62fe691`.
The modern store fixture correction is
`3424de9f492f5e8ce7fe14faa472fe26c3312722`; product source and both harnesses
remain unchanged.

The owner authorized this internal correction for exact locators already
recorded by Meridian. It adds no public plugin/configuration/route interface,
settings switch, shared-root enumeration or native credential operation.

## Reproduced gap and controls

On unchanged main, a durable mapping can contain exact `currentTranscript` and
`previousTranscript` locators without lifecycle generations. GC has no ownership
resource to collect when that mapping is evicted. A fresh HTTP turn can replace
the predecessor before periodic maintenance enrolls it, permanently losing that
recorded location. Modern pre-journaled targets already collect correctly.

The committed credentialless
[ownership probe](../../../scripts/probe-legacy-transcript-enrollment.mjs)
creates only disposable Meridian metadata and injects a recording deleter. It
uses no SDK transcript, CLI, credentials or model calls. The exact baseline
command exited **0**, asserting all four arms:

```sh
E2E_MERIDIAN_ROOT=/absolute/path/to/unchanged-3afca1f5 \
  bun scripts/probe-legacy-transcript-enrollment.mjs
```

| Arm | Baseline observation |
| --- | --- |
| Unjournaled legacy mapping | Pinned deletion count 0; eviction deletion count 0; ownership remains absent. |
| Modern journaled mapping | Pinned deletion count 0; eviction deletes exactly its owned target. |
| Existing enrollment/CAS primitive | Exact mapping remains pinned, then eviction deletes exactly its target. |
| Stale enrollment CAS | Attachment returns false; new ownership rolls back; deletion count stays 0. |

The probe's `PASS` means it reproduced these distinctions, including the gap.
It does not mean the baseline is fixed. The third arm establishes existing
internal enrollment authority; the new regression suite exercises the actual
bounded coordinator.

For an independently falsifiable HTTP failure, copy the corrected
[admission test](../../../src/__tests__/proxy-retirement-admission.test.ts) into a
new detached baseline worktree and run the same three original new assertions
with the SDK mocked. Source remained unchanged at exact `3afca1f5`:

```sh
git worktree add --detach /absolute/path/to/baseline \
  3afca1f5a0d51d74f8c7437b90f43d5686cf4163
cd /absolute/path/to/baseline
# Install the unchanged lockfile's dependencies without postinstall side effects.
bun install --frozen-lockfile --ignore-scripts
cp /absolute/path/to/correction/src/__tests__/proxy-retirement-admission.test.ts \
  /absolute/path/to/baseline/src/__tests__/proxy-retirement-admission.test.ts
bun test src/__tests__/proxy-retirement-admission.test.ts \
  --test-name-pattern 'journals the recorded predecessor|refuses unsafe enrollment'
```

Observed baseline result: **0 pass / 3 fail / 8 filtered** (exit **1**). The
streaming and nonstreaming cases expected the predecessor resource's session ID
`legacy-previous` and received `undefined`. The corrupt-sidecar case expected
503 and received 500. The test file has since gained capacity and two-profile
controls; the narrowed pattern above still selects those same three assertions.
The corresponding corrected HTTP cases pass with their assertions preserved.
The observed baseline reused the same locked dependencies through a read-only
node_modules symlink; the commands above reproduce it with an independent
postinstall-free install. It exercised the metadata loss through real proxy HTTP
admission and mocked SDK queries; it is not a reproduction of the reported 35 GiB Linux host.

## Correction and safety boundaries

`sessionLifecycle.ts` takes a bounded batch of current/predecessor locators from
existing durable mappings. Under the existing lifecycle lock it journals only
the exact recorded session/root/project tuple and attaches both generations
through one exact mapping CAS. An exact CAS rejection restores newly added resources and fence counters.
A throwing publication conservatively retains issued resources/fences because
its store rename may already be visible. Canonical physical identities share resources,
while durable locators retain their recorded aliases.

Existing prepared/retired ownership states, writer leases, publication leases,
process-incarnation fencing and SDK deletion authority remain intact. In-flight
`deleting` targets are skipped so normal executor recovery can run; `deleted`
tombstones fail closed. Fenced mappings with missing ownership are not recreated.
There is no best-guess adoption of native sessions from a shared root.

The first prototype exposed a priority rollback hazard: advancing a pending
route's mapping generation would invalidate the request's finalizer. The
correction excludes both rollback source mappings and pending route mappings in
the initial snapshot and again in the locked CAS. The negative control proves
that the pending request still finalizes with its captured mapping/assignment
CAS, unchanged pins stay protected, and both mappings enroll afterward.
Protected route keys are indexed once per snapshot, avoiding a mapping × route
scan before the bounded batch.

Identity-bearing HTTP admission joins only a bounded pass for that identity's
selected mappings before capturing arrival generations. It does not await
completion of global metadata enrollment. Remaining eligible identity mappings
produce a bounded retry before SDK launch. Both ordinary and priority durable
publication independently refuse to replace an unfenced predecessor; a lost
enrollment CAS cannot bypass this guard. Cancellation stops queued/external
lock admission, never an already-running durable transaction. Unsafe enrollment
returns the existing structured 503/`Retry-After: 5` contract (499 if cancelled).

Independent review found three additional progress hazards and they were fixed:

- A 16-mapping enrollment batch could be followed by eviction of a later legacy
  mapping. Count-cap victim selection now retains mappings containing an exact
  unfenced current or predecessor locator. Ordinary/new priority publication
  rejects through its existing false-CAS authority when no safe victim exists.
  An already-pending finalizer can retain preexisting protected overflow without
  invalidating its exact authority. Profile-copy pruning checks each released
  locator against a safe, matching sidecar resource under the lifecycle lock;
  unenrolled later victims remain pinned until a later pass can enroll them.
- Enrollment capacity failure could prevent GC from freeing capacity forever.
  Maintenance now skips pruning on enrollment failure, still runs supported GC
  for already-owned garbage, and records the enrollment deferral. The next sweep
  can enroll the legacy locator. A process-local scheduling cursor advances even
  on skipped or CAS-losing mappings so those cannot starve later candidates. The
  cursor is not an ownership/deletion fence and resets on restart.

- A one-item identity batch with two profile mappings could leave the selected
  second profile unenrolled and discard its predecessor during in-place
  replacement. Admission now checks its bounded pass's postcondition and returns
  503 before querying while enrollment remains pending. Both store publication
  paths also return false if a new ID would discard an unfenced predecessor.
  Same-ID updates remain allowed. The two-profile/one-item HTTP control requires
  no initial SDK query, preserved predecessor authority and a successful retry
  after maintenance; direct tests cover stale enrollment CAS and both publication
  paths.

At a full mapping cap, retaining the only remaining ownership proof can briefly
refuse a new publication until bounded maintenance progresses. No unlimited
admission wait, guard bypass or silent deletion of that proof was introduced.
Explicit mapping deletion can still discard proof; sessions whose locator was
already forgotten, mappings containing only IDs, and unknown shared-root
sessions remain outside this correction. It does not collect the contributor's
reported 49,436 already-untracked sessions / 35 GiB.

## Publication uncertainty fault proof

Root review found that a throwing store publication can already have made a new
mapping visible. Rolling back ownership on every throw could leave that mapping
fenced to a missing resource and reuse an issued generation. Current baseline
`fsyncParentDirectory` swallows parent-flush errors; this correction does not
change that separate store durability contract. The discriminating control
executes the actual `sessions.json` rename, then injects a publication error at
that visibility boundary. It checks both persisted authorities, not a mocked
successful result.

On the initial correction `4d645c7f`, copying the current direct test into an
isolated worktree and running the same assertion failed **0 pass / 1 fail /
37 filtered**, exit **1**: the mapping carried `r:<resource-key>:1` while the
corresponding sidecar resource was absent. The corrected suite passes it.

```sh
bun test src/__tests__/session-legacy-enrollment.test.ts \
  --test-name-pattern 'successful mapping rename reports failure'
```

Unknown throwing publication now retains the issued ownership and original
error; no cleanup attempt can mask it. An exact false CAS still rolls back. A
separate rollback-failure control proves one cleanup attempt, preserved error
cause, retained safe ownership if cleanup fails, and no deletion of its still
pinned target.

The two-profile/one-item admission assertion also failed on `4d645c7f` (expected
503, received 200; **0 pass / 1 fail / 12 filtered**, exit **1**) and passes with
the corrected postcondition and independent store guards:

```sh
bun test src/__tests__/proxy-retirement-admission.test.ts \
  --test-name-pattern 'one-item enrollment leaves a second profile'
```

## SDK authority

Installed SDK **0.2.141**, Claude Code **2.1.284**. Existing production GC uses
supported `deleteSession(sessionId, { dir })` in an owned, joined Node child with
an exact per-child config root. Its lifecycle publication/writer/executor fence
remains the deletion authority. Supported `listSessions` metadata has no immutable
creator, writer incarnation or ownership generation; it cannot authorize
adopting forgotten sessions. `persistSession: false` prevents durable resume.

The existing CLI cleanup mechanism cannot accept Meridian pins or publication
leases. With an enabled real settings source, omitting a retention override
cannot prove cleanup is disabled; `cleanupPeriodDays: 0` is invalid in the
installed supported schema. The correction does not change settings sources or
age cleanup. See the installed SDK's public declarations and official
[session storage documentation](https://code.claude.com/docs/en/agent-sdk/session-storage)
and [automatic cleanup documentation](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically).

## Final harness authority review

Independent reviewer `preload_cleanup` found two material gaps in the harness at
`80d1a482064aa6c8cd8bc2be9908c6cd89ea3646`: setup could leave a private runtime
credential copy if a write or work-directory creation failed before entering the
cleanup block, and the observer imported the harness checkout's SDK rather than
the target checkout's separately installed SDK. Neither gap changes the product
source at `c62fe691`; both needed correction before using the native gate.

The corrected [authority test](../../../src/__tests__/legacy-enrollment-harness.test.ts)
uses an independently installed synthetic target SDK and a generated, non-auth
credential-shaped grant. It stops at a deliberate proxy import failure before
CLI resolution or any query. Two real filesystem fault controls fail after the
runtime credential copy becomes visible: one after its successful write, the
other during work-directory setup. Assertions require the selected source to
remain unchanged, the owned runtime copy to be removed, no synthetic grant bytes
in output, and the observer to be attached to the exact target SDK.

Copying only that corrected test into an isolated worktree at unchanged `80d1a482`
and running the following control produced **0 pass / 3 fail / 1 filtered**,
exit **1**, with 11 assertions reached:

```sh
bun test src/__tests__/legacy-enrollment-harness.test.ts \
  --test-name-pattern 'uses an owned copy|injected'
```

The SDK identity assertion received `false`; both fault arms found their runtime
copy still present. Test teardown removed only generated roots under the owned
temporary prefix. With the correction, all four authority cases pass. The
harness resolves the supported public SDK entry with `createRequire` rooted at
the selected checkout's `package.json`, checks it against the proxy's resolution,
and imports that exact entry. All runtime-copy/setup/import operations after
private-root creation now share initialization cleanup. The reviewer statically
approved the corrected harness and discriminating controls with no surviving
material finding. These are credentialless authority checks, not native proof.
The passing harness is committed at `d8bd970684bc49042cf641120e0da2412473c123`.

## Verification and open gates

Host: macOS arm64, Bun **1.3.14**, Node **22.22.3**. Focused checks used isolated
temporary Meridian stores and mocked SDK/custom recording deleters.

The first full `npm test` ran without any source/document edits on frozen
`ab9bb9aeccabe312d1339c15343415445d625cb8` and exited **1**. Its main batch
completed **5047 pass / 35 skip / 0 fail**; the isolated async-operations batch
completed **3 pass / 0 fail**. The next isolated store batch stopped the chain at
**23 pass / 1 fail**, 103 assertions. The failed existing test, "moves the exact
transcript locator when the Claude session ID changes", published two raw
locators and attempted a third replacement without journaled ownership. That
would discard the unfenced original predecessor; the new store guard returned
false, so its assertion expecting the current locator to disappear failed.
Later isolated batches did not run. This failure is preserved rather than
counted as a completed passing full suite.

Root independently confirmed the missing modern-publication precondition and
approved correcting the fixture without weakening the guard or its assertions.
Actual managed HTTP callers pre-journal fresh/fork targets before publication;
the new bounded legacy coordinator, predecessor rejection and HTTP retry tests
cover unfenced callers. The existing movement test now obtains its original and
replacement locators from real `registerLiveTranscript` transactions in its
isolated metadata store. Every original immediate-source, fallback, same-ID and
non-immediate-locator assertion is preserved. These transactions do not create
SDK transcripts or make native/model calls.

The unchanged test on `ab9bb9ae` independently reproduced **0 pass / 1 fail /
23 filtered**, exit **1**, with 3 assertions reached. The corrected fixture
passed **1 pass / 0 fail / 23 filtered**, 5 assertions, using this exact command:

```sh
bun test src/__tests__/proxy-session-store.test.ts \
  --test-name-pattern 'moves the exact transcript locator'
```

The complete isolated store suite then passed **24 pass / 0 fail**, 105
assertions. No production source or native harness changed for this correction.

| Check | Result |
| --- | --- |
| New direct enrollment/ownership suite | **38 pass / 0 fail**, 362 assertions. |
| Harness authority with synthetic grants, stopped before CLI/query | **4 pass / 0 fail**, 25 assertions. No real credentials or model calls. |
| HTTP admission + existing profile-copy pruning | **25 pass / 0 fail**, 121 assertions, including both streaming modes, corrupt metadata, capacity progress and the two-profile/one-item gate. |
| Combined final focused run of the three rows above | **67 pass / 0 fail**, 508 assertions across four files. |
| Existing store suite with real modern ownership fixtures | **24 pass / 0 fail**, 105 assertions; all original movement assertions retained. |
| Existing lifecycle/publication/contention/process/Windows-GC suites before the final victim-selection correction | **69 pass / 1 skip / 0 fail**, 374 assertions. The skip requires native Windows PID-reuse behavior. |
| `npm run typecheck` | Exit 0 after the final harness setup/target-SDK and modern store fixture corrections. |
| `npm run build` | Exit 0 after the final harness setup/target-SDK corrections; Node entrypoint bundling completed (certified local build 5). |
| `git diff --check`; syntax checks for both committed harnesses | Exit 0. |
| Full `npm test` | First frozen `ab9bb9ae` run exited 1 on the causal fixture precondition above. A necessary rerun on the corrected committed fixture is pending in the parent's exclusive slot. |
| Native before/after fixture | Escrowed; not run. Model slot is reserved by another authorized gate. |
| E41 chain/parallel × streaming/nonstreaming | Not run for this correction. |
| Actual reported Linux/OpenCode host; native Windows | Not run. No cross-platform/model success claim. |
| Exact final-head required CI and independent final diff | Root independently reviewed corrected ownership uncertainty, isolated-grant semantics and exact `ab9bb9ae` metadata/harness/test diff with no surviving material finding, then approved the causal fixture correction. Independent reviewer `preload_cleanup` approved the final setup/target-SDK corrections and their discriminating controls. Exact final-head CI remains pending. |

The committed
[native harness](../../../scripts/e2e-legacy-transcript-enrollment.mjs) costs
three real HTTP/SDK model turns per arm and is documented in
[E2E.md](../../../E2E.md#legacy-recorded-transcript-enrollment). It uses supported
SDK history/list/delete APIs only, proves pinned history unchanged, and contrasts
exact recorded collection with an unknown shared-root control. It requires an explicit immutable read-only `.credentials.json` grant,
forces `MERIDIAN_CREDENTIALS_READONLY=1` and clears inherited auth overrides before
SDK/proxy imports. Only that selected file is copied into a distinct, private
runtime account; SDK writes/refresh may affect that owned copy. Assertions verify
all real queries use the runtime root, the served model matches, and the source
bytes, file identity and permissions remain unchanged. No credential bytes,
tokens or hashes are printed. The observer uses the exact target-installed
public SDK entry; setup faults remove only its owned runtime copy. Cleanup joins all requests, runs fenced GC for
failed targets not yet published, deletes only exact fixture-created IDs, and
retains its isolated lifecycle authority if cleanup cannot complete. Retained
ownership/leases stop cleanup before direct deletion; safe initialization
failure removes only its owned runtime residue. Syntax
validation is not native proof.

Disposition: **accept this bounded internal purpose and correction subject to
remaining verification; keep source #1261 open/deferred for the broader unowned
backlog.** Root integration authority owns final CI, affected-flow evidence,
PR/merge decisions and external communication. This child has not changed
GitHub, searched credentials, run model calls or published a release.
