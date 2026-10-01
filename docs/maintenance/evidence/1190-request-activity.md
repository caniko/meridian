# Request-activity incorporation (#1190)

Source: `be7ad199b7614378b3499d20b16dab1021e5caed` by Nowaker,
AuthorDate 2026-09-28T10:59:22Z. Authored cherry `f89bfe0c` preserves identity
and date on base `e3fa58208`. Public contract tracked in #1216. User explicitly
prioritized this contribution. No release or external comments authorized.

Product fit: a count-only, loopback-only endpoint exposes admitted HTTP work
and queue activity to local supervisors without disclosing account/session data.
The authored safe-restart claim was too strong: background Responses jobs,
pending client-tool processes and post-probe arrivals can outlive that count.
The correction exposes `scope: client-http` and documents those exclusions and
the required graceful-shutdown lifecycle. It does not invent an atomic barrier.

Meaningful negative control: an actual combined HTTP application creates a
background Responses job against the existing deterministic CLI fixture. After
its POST is consumed, `/inflight` reports HTTP zero while retrieval still reports
queued/in-progress work. The test cancels that job and verifies cancelled status.
This is protocol-fixture evidence, not a live Antigravity model claim. Ten focused
request/response/peer/queue tests pass, including live-body delivery and cancellation.

Actual headless gate: maintained `scripts/e2e-inflight-client.mjs`, two independent
OpenCode 1.18.32 clients, real Opus 5.5, SDK 0.2.141, Claude Code 2.1.284,
Bun 1.3.11, Linux arm64. Independently installed OpenCode scrub 0.2.3. Both
clients and the same-session follow-up exit 0 and return the actual model marker.
Across 1,219 HTTP observations: maximum total 4; active streams and queued work
both observed; every snapshot's buckets sum exactly to total; final total zero.
Forwarded peer request receives 403. All five real SDK queries use the isolated
read-only OAuth-token profile; at least one query resumes. No mocked SDK/model
response is used in this gate. Raw private client output is not published.

First container attempt failed before serving requests because the reused image
had the stock Docker entrypoint and no machine ID. The corrected invocation uses
the repository's `e2e-container-entry.cjs` with `E2E_CONTAINER=1` to generate a
machine ID inside the disposable container. It keeps production boot-identity
fencing; `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY` was never used. This explains the
rerun. The access-only private snapshot was removed when the container exited;
no refresh token was copied and host credentials were not changed.

Commands: build Meridian; provide a mode-0600 access-only `E2E_AUTH_FILE` and
independently installed `E2E_PLUGIN_PATH`; run `bun scripts/e2e-inflight-client.mjs`.
For the Linux disposable image, use `node scripts/e2e-container-entry.cjs` as the
entrypoint and set `E2E_CONTAINER=1`; source/scripts and auth mounts are read-only.
Do not put tokens in arguments, environment logs, media or this evidence record.

Final local suite, standalone typecheck/build and exact-head CI are recorded in
the integration PR before merge. No account tracking or Antigravity restart safety
is inferred from the HTTP count. The standalone Antigravity backend does not serve
this endpoint; combined mode counts its POST responses only. Windows receives the
required smoke CI; no separate live Windows model test is claimed.
