# Native Sonnet context review — #1213 / #1212

**Prepared, not accepted:** local code proof is complete; actual Linux /
OpenCode 2.0.16 / Sonnet 5.5 before-and-after generation remains a gate. No
model call has been made for this review. Required final-head CI and owner
acceptance remain open.

Source head: `553fd5c386de5e18e531a1d0101d64ef3a3b1792`. Contributor
`robertn702`'s two commits (`179257b9`, `553fd5c3`) were cherry-picked with
original Author/AuthorDate preserved. Maintainer corrections are separate.
Initial exact unchanged-main control:
`f299fe06e72411b786380b5212edea79cd13966a`.

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

The real 2.0.16 supported API accepted a synthetic transcript through
`POST /api/experimental/session/import` with HTTP 200, with no model query.
This permits the full fixture to be seeded without preparatory giant calls.
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

Focused checks: 112 pure model/replay tests, 121 catalog/conversion tests,
41 actual HTTP replay tests and 12 health/catalog-route tests pass. Standalone
typecheck passes. Final current-main full `npm test`, typecheck/build and
exact-head CI must be recorded before landing; live acceptance is still open.
