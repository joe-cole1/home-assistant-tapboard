# New Codex Task Prompt — Batch 3

Work on **Batch 3 — Web/API security hardening** for Tapboard.

Repository context:

- Read `architecture.md` completely.
- Read `docs/AUDIT-2026-08-01.md` completely, especially the security/privacy findings, Batch 3 scope and acceptance criteria, Verification Policy, and Decision Log.
- Read `docs/prompts/BATCH-02-SSE-PERFORMANCE-PRIVACY.md` and inspect the completed Batch 2 implementation and tests before planning changes.
- Inspect the current working tree, recent history, and relevant code. Preserve unrelated user changes.
- Confirm Batches 1 and 2 are complete and integrated. Do not regress the deterministic pour detector, schema-v2 `tapStates` projection, compact/coalesced SSE deltas, priority pour delivery, targeted card updates, SVG preservation, backpressure behavior, or `/healthz` endpoint.
- Treat the audit document as the canonical handoff; do not rely on missing prior-chat context.

## Phase 1 — Plan only

Do not edit files, deploy, restart containers, mutate Home Assistant, or spawn subagents yet.

Investigate enough to produce a concrete implementation plan that includes:

1. A complete inventory of untrusted-content rendering paths in `public/app.js`, including tap cards, recipe details, batch/select options, descriptions, catalog/on-deck content, overrides, and toast text. Distinguish static application markup from untrusted interpolated values.
2. The proposed safe DOM construction strategy using `createElement`, `textContent`, and attribute/property assignment. Identify any location where HTML is intentionally required and justify a narrowly configured sanitizer before proposing one.
3. Whether `/api/taps/:id/simulate-pour` will be removed or retained behind both admin authorization and an explicit development-only feature flag. Production must fail closed.
4. A shared JSON request-body policy covering accepted content types, a concrete byte limit, malformed JSON, empty bodies, connection errors, and consistent `400`, `413`, and `415` responses.
5. A same-origin or explicit-origin CORS policy, including OPTIONS behavior and how local port `3005` or a reverse proxy affects origin matching.
6. The exact security headers to add, with a Content Security Policy compatible with the current module scripts, inline styles, SVG rendering, and Google Fonts. Separate headers suitable for direct HTTP from HTTPS/HSTS expectations that require a reverse proxy.
7. A deliberate first-run/default-PIN design and safe migration behavior for an existing database that may still contain the `0000` hash. Do not lock out the existing installation without an approved migration path.
8. Session lifecycle changes: revoke every existing session when the PIN changes, prune expired sessions, preserve 24-hour expiry behavior unless justified otherwise, and avoid logging bearer tokens or PINs.
9. Shared validation for tap IDs, enums, numeric ranges, string lengths, catalog fields, and route bodies. Include end-batch, end-keg, and simulation routes. Unknown fields should be ignored or rejected according to an explicit policy.
10. A safe public-error policy that logs useful internal details server-side while returning stable, non-sensitive messages to clients.
11. Static asset containment using `path.resolve`/`path.relative` or an equivalent boundary-safe method, including encoded traversal and prefix-collision cases.
12. Automated security tests for stored XSS, body limits/content types, CORS, headers, default-PIN initialization, PIN-change revocation, expired-session pruning, route validation, safe errors, production simulation behavior, and static traversal.
13. Exact files expected to change or be added.
14. Compatibility risks, migration behavior, rollback strategy, and any decisions requiring explicit approval.
15. A proposed Phase 2 subagent breakdown with non-overlapping file ownership.

Use Home Assistant MCP or container diagnostics only for read-only evidence if they materially improve the plan. Do not print credentials, PIN hashes, bearer tokens, unredacted HA state, or large logs.

If Batch 2 is uncommitted, incomplete, not deployed, or under review, call that out and define a safe sequencing gate. Batch 3 may be implemented and tested against source without deploying Batch 2, but do not overwrite or redesign its approved event schemas.

End Phase 1 with the plan and wait for explicit approval. Do not treat silence or a general acknowledgement as approval.

## Phase 2 — Only after explicit approval

After approval, orchestrate implementation through bounded subagents and independently verify every change.

Subagent policy:

- Use subagents only for concrete, independent work in the approved plan.
- Prefer `gpt-5.6-terra` with low reasoning for mechanical DOM conversion, fixtures, and narrow validation tests. Use medium reasoning for authentication/session migration, CSP, request parsing, and integration work.
- Use context-light forks and give each worker only the relevant Batch 3 requirements and files.
- Start with at most two workers in parallel.
- Give each worker strict file ownership, acceptance criteria, and a concise return format.
- Do not let two agents edit `src/server.js`, `src/db.js`, or `public/app.js` concurrently.
- A preferred split is frontend untrusted-DOM remediation versus backend HTTP/auth/validation hardening. Keep shared integration and package/deployment files with the main orchestrator.
- Use at most one targeted read-only review agent after implementation when it adds meaningful security value.
- Require workers to return conclusions, changed files, tests run, measurements, migration concerns, and residual risks rather than full logs.

Orchestrator responsibilities:

1. Maintain the approved plan and enforce file ownership.
2. Protect all verified Batch 1 and Batch 2 behavior.
3. Inspect every worker diff and personally reconcile integration issues.
4. Verify every Batch 3 acceptance criterion with automated evidence.
5. Run focused security tests, the complete test suite, syntax checks, and a production-image build.
6. Confirm no user-controlled HA, Brewfather, override, catalog, batch-option, recipe, or description value reaches an unsafe HTML sink.
7. Confirm simulation cannot mutate production data without both authorization and the approved feature flag, or confirm the endpoint is absent.
8. Confirm oversized or incorrectly typed request bodies fail before JSON parsing or database mutation.
9. Confirm foreign origins do not receive permissive CORS authorization while legitimate same-origin use continues working.
10. Confirm CSP and other headers are present without breaking module loading, SVG graphics, themes, or fonts.
11. Confirm PIN changes revoke existing sessions, expired sessions are pruned, and existing installations follow the approved default-PIN migration.
12. Confirm invalid route IDs/values and internal failures return safe public errors without secrets or stack details.
13. Confirm static traversal cannot escape `public/`, including URL-encoded variants and sibling-prefix paths.
14. Review `git diff` for unrelated changes and run `git diff --check`.
15. Update `docs/AUDIT-2026-08-01.md` only with verified results, acceptance checkboxes, and a Batch 3 Decision Log entry.

## Minimum verification targets

The approved plan may make these stricter, but must not weaken them without explaining why:

- Stored-XSS fixtures containing tags, event handlers, entity encodings, and SVG/script payloads render as inert text in tap cards, recipe details, settings options, and the on-deck ticker.
- No dynamic untrusted value is interpolated into `innerHTML`; remaining `innerHTML` assignments are proven static or sanitized for an explicitly documented reason.
- Production simulation requests cannot broadcast events or insert `pour_logs` records.
- JSON bodies over the approved limit return `413`; unsupported content types return `415`; malformed JSON returns `400`; valid existing requests continue to work.
- Responses do not use `Access-Control-Allow-Origin: *`; same-origin behavior works and unapproved origins receive no permissive CORS headers.
- Security-header tests cover CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame protection through CSP or `X-Frame-Options`, and any other approved headers.
- A PIN change invalidates all prior bearer sessions, and expired sessions are removed deterministically.
- Invalid tap IDs, enums, numeric ranges, oversized strings, traversal paths, and malformed URL encodings are rejected without mutation.
- Public error bodies do not contain internal exception messages, filesystem paths, SQL details, tokens, PINs, or stack traces.
- All 32 tests recorded at Batch 2 remain green.

Do not deploy, restart the production container, initialize or change the live admin PIN, or change live Home Assistant/ESPHome configuration without separate explicit approval.

When complete, report:

- Outcome first.
- Files changed.
- Tests and production-build verification.
- XSS and unsafe-sink results.
- API/auth/session/CORS/header/traversal results.
- Migration behavior for existing installations.
- Batch 3 acceptance criteria satisfied or still open.
- Important design decisions and residual risks.
- The safest next step.
