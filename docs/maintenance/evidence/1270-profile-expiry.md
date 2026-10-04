# Approved current profile expiry: partial incorporation of #1260

## Scope and source

Owner approval is recorded in [issue #1270](https://github.com/rynfar/meridian/issues/1270).
This delivery incorporates current expiry metadata and token-exchange deadline
persistence from [source PR #1260](https://github.com/rynfar/meridian/pull/1260).
The source remains **open**: its five history fields, lifecycle storage,
listeners and auth-category logging are excluded, so this is partial integration.
The [original bounded review](1260-login-lifetime-review.md) records the rejected
history/authentication claims and reproduced defects.

| Identity | Exact value |
| --- | --- |
| Reviewed source | `99b8f0c46fbf8ce0b7f28cb14d2bdce4929948ef` |
| Source author/date | Nowaker `<spam@nowaker.net>`, `2026-10-03T19:11:08-05:00` |
| Initial isolated baseline | `3afca1f5a0d51d74f8c7437b90f43d5686cf4163` |
| Current integration base | `0369441786b082aadeb31689dcbce41d7e8574d9` |
| Authored cherry-pick before/after rebase | `ce5967ff1c1b55d1cbc45029177ee2b3aa2f07f0` / `dbcdb01507899d36c058c86ccd3d61e8b955109b` |
| Separate scope/correction before/after rebase | `5636ea4fbea90b269a413860bea4e200bbbbfd9f` / `c48e838d5dfdaca6cc9854610c5cda0ad848f3b8` |
| Tested product/harness head | `c48e838d5dfdaca6cc9854610c5cda0ad848f3b8` |

The source Author and AuthorDate survive the authored cherry-pick. The separate
maintainer correction removes the unapproved history implementation and fixes
metadata validation, auth qualification and focus behavior. The base advancement
from `3afca1f5` to `03694417` is a backlog-documentation checkpoint; product,
tests, harnesses, `E2E.md` and `docs/profiles.md` are byte-identical across this
rebase. Intermediate source commit prose is not evidence for provider lifetime
or logout behavior.

## Contract and regression boundaries

Authenticated `GET /profiles/list` adds exactly four fields:

| Field | Semantics |
| --- | --- |
| `refreshTokenExpiresAt` | Current stored refresh deadline, epoch milliseconds or `null` |
| `daysUntilRenewal` | `Math.ceil((deadline - response observation time) / 86400000)`, or `null`; JSON zero includes a deadline less than one day past |
| `renewalRequiredSoon` | Rounded days at or below the existing configured warning window; `false` when unknown/not applicable |
| `accessTokenExpiresAt` | Current stored access expiry, epoch milliseconds or `null`; may be estimated by the existing exchange fallback |

Expiry and presence come from the same uncached read of each profile's resolved
stored-Claude credential. Shared stores expose the same current deadlines and
retain independent existing profile identities. Existing cached plan metadata
may cause its own read; the one-read assertion concerns presence and expiry,
not all existing enrichment. API keys and supplied setup tokens perform no
native-store read for these facts and return `null`/`false`.

Stored timestamps must be numeric, finite, positive and within JavaScript's
Date range (`<= 8.64e15`). Missing, malformed or unreadable metadata is unknown;
no unit guessing occurs. A current deadline moved earlier or later, or removed,
replaces the displayed value without manufacturing a new login. An empty
successfully read grant retains the existing authentication-demotion behavior;
an unavailable read retains the existing authentication/provenance behavior.
The existing `/health` fields and cached read path retain their contract. The
warning window remains finite and nonnegative, including fractional values,
with default 3 days and the existing rounded-day comparison.

The shared CLI/browser token exchange persists a valid provider refresh
deadline immediately, before refresh. Absolute metadata has precedence over a
relative lifetime; malformed absolute metadata does not fall back to a valid
relative value. Accepted exchange deadlines must also be in the future.
Replacement credentials with absent/malformed metadata do not retain an old
grant's deadline. Access expiry, scopes, plan fields, read-only refusal and
credential write-failure policy remain unchanged.

Profiles and home use the same facts builder. Current refresh/access expiry is
advisory, separate from observed authentication. Passed refresh metadata never
creates logout or suppresses future access expiry. Cached authentication is
visibly qualified on both pages. Exact times and uncertainty text appear on
hover and visibly on keyboard focus, using existing theme colors. Polls cannot
replace focused facts, including a request that completes or fails after focus
was acquired. Polling resumes through the existing interval after focus leaves.

No `auth-lifecycle.json`, five history fields (`authObtainedAt`,
`authObtainedVia`, `lastRefreshAt`, `firstUnauthedAt`, `unauthedReason`), history
listeners, auth-history writes or auth-category logs occur in the final diff.
Deadline facts do not prove revocation, provider refresh acceptance, a fixed
30-day lifetime, availability or a new grant. Credentials, codes, verifier
material and raw provider payloads are not exported or logged by this change.

## Maintained before/after proof

Both gates run with Bun, owned temporary state, synthetic credentials and
native-command/SDK/network fences. They do not use a model or real login.
`E2E_SOURCE_ROOT` selects source under test, while the harness stays unchanged.
Prepare a detached baseline with the same installed dependencies, then run:

```sh
E2E_SOURCE_ROOT=/absolute/path/to/baseline-3afca1f5 bun scripts/e2e-login-deadline-persistence.mjs
E2E_SOURCE_ROOT=/absolute/path/to/baseline-3afca1f5 bun scripts/e2e-profile-expiry-fields.mjs
bun scripts/e2e-login-deadline-persistence.mjs
bun scripts/e2e-profile-expiry-fields.mjs
```

| Gate | Baseline `3afca1f5` | Corrected product |
| --- | --- | --- |
| [Shared token exchange](../../../scripts/e2e-login-deadline-persistence.mjs) | Exit 1: `Token exchange dropped the provider refresh deadline` | Exit 0: PASS, 11 controls, 47 assertions, 18 synthetic token requests, native/SDK calls 0 |
| [Actual route with mock stores](../../../scripts/e2e-profile-expiry-fields.mjs) | Exit 1: `Four-field expiry contract missing refreshTokenExpiresAt` | Exit 0: PASS, eight groups, 40 HTTP requests, 953 assertions; native/SDK/external-network calls 0 in every group |

The first gate uses the actual shared exchange and file credential backend,
with platform selection emulated in a fresh process. It proves compact writes,
provider absolute/relative precedence, plan/scopes/access preservation, removal
of old deadlines for every malformed replacement, read-only and failed writes,
unchanged sentinel bytes, absence of history files, and sanitized captured
diagnostics after all failure paths. Before each malformed replacement it
reseeds and verifies a valid old deadline, so clearing is discriminating.
This is **emulated file exchange**, not macOS Keychain or provider proof.

The second gate uses the real Hono route, snapshot and renewal helpers with
isolated mock stores/auth data. Its groups cover store identity/sharing,
API/setup-token isolation, absent versus unknown reads, invalid/positive/past/
future/fractional/date-limit timestamps, configured warning/rounding, current
replacement/removal, exactly one fresh presence+expiry snapshot, and existing
cached/never/live authentication provenance. It checks the exact four-field
schema and absence of all five history fields. This is **mocked-store HTTP**,
not actual native storage. Fresh-process wrappers are committed in
[`login-deadline-persistence.test.ts`](../../../src/__tests__/login-deadline-persistence.test.ts)
and [`profile-expiry-fields.test.ts`](../../../src/__tests__/profile-expiry-fields.test.ts).

Direct builder assertions also failed on the unchanged source: 26 passed, two
failed because the deadline was missing. The corrected builder suite passes
28 tests, covering malformed relative/absolute metadata, precedence and
unchanged existing credential fields.

## Verification and adversarial correction

Environment: macOS arm64, Bun `1.3.14` (`0d9b296a`), Node `22.22.3`.
Credentialless focused checks on the byte-identical product later rebased to
`c48e838d` passed **203 tests, 21 existing macOS login skips, 0 failures**
(578 test expectations; 224 tests across eight files). The skipped login
success paths do not prove native writes. `npm run typecheck`, `npm run build`
and `git diff --check` passed. The two standalone gates passed separately with
the totals above. Full `npm test` is queued with the root agent; final-head CI
and affected-flow live evidence remain required.

After the rebase, two additional focus-recovery controls proved that polling
resumes after blur on each page: the final facts suite passes 33 tests (85
expectations), and typecheck passes again. These tests and this durable record
do not alter the tested product or harness blobs.

Focused command:

```sh
bun test src/__tests__/profile-expiry-fields.test.ts src/__tests__/login-deadline-persistence.test.ts src/__tests__/profile-facts.test.ts src/__tests__/profile-login-plan-fields.test.ts src/__tests__/profile-login-unit.test.ts src/__tests__/profile-login-route.test.ts src/__tests__/profile-credential-isolation.test.ts src/__tests__/token-refresh.test.ts
npm run typecheck
npm run build
```

An independent adversarial review found no surviving route/persistence contract
defect in the approved scope, but found reviewability and focus gaps. Corrected:
keyboard title text was not visibly disclosed; profile polls could destroy
focus; in-flight home updates could replace an open details popover; malformed
replacement controls needed an old deadline for every case; diagnostics had to
be checked after failed writes; command fences omitted synchronous/fork APIs.
The corrected UI evaluates actual emitted render/refresh functions in direct
tests, including start-of-poll focus, focus gained during success/failure and
an unfocused positive control and resumed polling after blur for both pages. Escaping, cached labels and
visible focus descriptions are asserted. All seven Node command APIs are
fenced in both harnesses. A final independent pass over these corrections and
actual browser focus/layout proof remain gates; source-level tests do not
establish browser appearance or screen-reader behavior.

## Remaining acceptance gates

Root owns live verification using its selected ready owned Claude profile; no
credential search, browser/native operation or actual provider call was made by
this implementation agent. Existing read-only usage success is not proof of a
new login's metadata.

- Fresh Meridian-managed OAuth login whose actual provider response supplies
  a positive refresh deadline; sanitized native file/Keychain readback and
  matching `/health` deadline before the first refresh. Absence of provider
  metadata cannot establish this positive path.
- Re-authentication replaces old metadata or leaves it unknown when absent,
  with profile identity and observed authentication intact.
- Actual Profiles/home browser checks at narrow and wide widths: future/past
  refresh and access metadata, unknown data, cached authentication, hover and
  keyboard exact-time disclosure, focus retained across polling, warning color
  and reversible fitting. Capture sanitized evidence when timing matters.
- Supported-client receipt using the actual implicated model/SDK/platform,
  independently installed package proof, full local suite and final-head CI.

Do not close #1260 as fully incorporated, close #1270 as validated, merge or
release on these synthetic results alone. Preserve the excluded history scope
and missing positive native/provider evidence explicitly.
