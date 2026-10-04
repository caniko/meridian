# Hostname consent incorporation (#1233 / #1259)

## Owner decision and scope

On 2026-10-04 the owner explicitly approved the public contract tracked by
[#1259](https://github.com/rynfar/meridian/issues/1259) in the review
conversation: `GET`/`PUT /settings/api/header` behind the existing settings
authentication gate; a persisted, default-off `showHostname` option; and an
optional OS `hostname` on unauthenticated `/health` only while enabled. This
is a paraphrase of the approved scope, not an invented transcript quotation.
The approval covers the shared product header, including standalone
Antigravity. The existing optional `MERIDIAN_API_KEY` semantics are preserved.

The owner separately approved the bounded reverse-proxy correction: allow
exact request Origin, or HTTPS Origin with the same normalized public Host/
port while the internal request uses HTTP. Explicit public 443 and omitted
HTTPS 443 are equivalent. No forwarding header establishes trust, no public
configuration field was added, and a proxy that rewrites Host must preserve
the public Host for this route. This is an authority-preserving TLS bridge,
not detection or authentication of a proxy.

## Source and credit

Source [#1233](https://github.com/rynfar/meridian/pull/1233) was refreshed on
2026-10-04 at head `322d3af68691eb41552b53c010d1996e9474c130`, base
`f299fe06e72411b786380b5212edea79cd13966a`. The complete commit, file diff,
PR body, comments and reviews were inspected; comments and reviews were
empty. The earlier `c609e8d1` checkpoint is obsolete. The current source is
one actual authored commit with responsive-header rebasing, and contains no
changes from adjacent #1232.

| Source commit | Initial authored cherry-pick | Author / AuthorDate |
| --- | --- | --- |
| `322d3af68691eb41552b53c010d1996e9474c130` | `9939c6d585fbaf22e7b50f8a7e0a612571fe88c3` | Nowaker `<spam@nowaker.net>` / `2026-10-01T22:40:02Z` |

The contributor commit was cherry-picked without conflict from then-current
main. Maintainer corrections remain separate. Final rebased commit mapping,
local final-head checks and browser evidence are recorded below before
handoff to the queue owner. No push, PR creation, merge, closure, community
comment or release is performed by this implementation agent.

## Adversarial findings and corrections

- The source captures consent before an asynchronous Claude auth probe. A
  delayed enabled probe still disclosed hostname after a completed disable.
  Health now reads consent immediately before response assembly, after all
  auth/account/body awaits. Health and settings bypass caches.
- The source's permissive CORS permits a foreign-origin PUT to opt an unkeyed
  instance into public disclosure. The shared handler rejects foreign,
  opaque, malformed and different-port origins with 403, with and without a
  valid key. Same-origin and origin-less authenticated CLI controls pass.
  Independent review rejected a strict internal-origin comparison because
  Node sees HTTP behind a TLS terminator; the bounded public-HTTPS bridge
  above has implicit/explicit 443 and preserved 8443 controls.
- Standalone Antigravity uses the shared header but source settings routes
  return 404 and its health omits hostname. It now uses the same validation
  and persisted consent behind its existing API-key boundary. Healthy,
  draining and error health bodies/statuses are preserved; only the optional
  hostname and `no-store` policy are added. `/livez`, `/readyz` and unrelated
  settings traffic retain their prior behavior.
- Older browser health polls can restore a name after a newer disabled
  refresh. Refresh generations now discard superseded responses, and a
  failed current poll removes the label and tooltip.
- Concurrent checkbox saves could persist an older enable after a later
  disable. The UI disables the control through save/reload and restores it
  after failure. The input now has the accessible name “Show hostname.”
- Persisted null/malformed documents and invalid truthy values fail closed
  for this feature. Invalid request bodies preserve consent, missing fields
  are no-ops, and null removes the stored field without affecting unrelated
  settings. DNS/IP labels use `textContent`, retain full-name tooltips and
  reuse existing responsive-header fitting and tokens.

The independent review inspected source and maintainer changes in settings,
Claude and Antigravity dispatch, shared helper, profile bar, settings UI,
tests, architecture and API references. No injection, dependency-cycle or
use of credentials/model generation is needed by this behavior.

## Reproducible controls and evidence

The durable [source control record](1233-hostname-source-controls.json)
preserves the unchanged-contributor result: 7 pass / 17 fail, 101 assertions,
exit 1, using the expanded maintained HTTP test in the contributor tree.
Observed failures include foreign PUT 200 instead of 403, delayed Claude
hostname after disable, null persisted settings returning 500, missing
standalone routes, and cacheable consent. These are discriminating tests,
not a green rerun of the contributor's original coverage.

Reproduce with an isolated detached checkout of the source commit, copy
`src/__tests__/header-settings-routes.test.ts` from the delivery tree, supply
dependencies, and run `bun test --timeout 30000
src/__tests__/header-settings-routes.test.ts`. The file controls model auth
and provider account checks and is isolated in the npm test script because
Bun module mocks are process-global.

After correction, the focused HTTP plus pure-label command passed 28 tests,
249 assertions, exit 0. Standalone `npm run typecheck` and `npm run build`
passed on darwin/arm64, Bun 1.3.14, Node v22.22.3 before rebasing. The final
rebased full `npm test`, typecheck and build gates remain pending until
recorded on the final code tree.

The maintained [HTTP/browser fixture](../../../scripts/e2e-hostname-header.mjs)
serves actual app pages, routes and settings writes in isolated configuration;
auth/account probes are controlled and SDK/model requests are fenced. Use
`E2E_BASELINE_ROOT=<unchanged main> E2E_PORT=42233 bun
scripts/e2e-hostname-header.mjs`, then open `/fixture/frame?width=375&path=/settings`
in the native collaborative browser and evaluate the complete
[browser probe](../../../scripts/e2e-hostname-header-browser.js) in the owned
frame. Repeat at 320/375/414/768/1280px, on `path=/fixture/provider`, and on
`path=/fixture/before/settings` for baseline comparison. The probe exercises
the real click/save path, blocked concurrent save, reversed-response and
failed-poll controls, DNS/IP tooltips, clipping and intact update notices.
Long/IP labels and update payloads are explicitly synthetic stress controls;
ordinary settings and health use the actual OS name. It restores consent off.

The visual baseline fixture is exact main
`9d77d8e282cb9c58d99b8962b900777e9f4b0803`. Browser assertions, before/after
media, final source mapping, full local gates and required final-head CI are
pending from the queue owner. No live model E2E is implicated: this feature
changes header/settings/health only. Do not describe the visual acceptance
or integration as complete until those evidence fields are supplied.
