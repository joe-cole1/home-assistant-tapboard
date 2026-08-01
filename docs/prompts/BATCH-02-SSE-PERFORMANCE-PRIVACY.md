# New Codex Task Prompt — Batch 2

Work on **Batch 2 — SSE performance, data minimization, and UI latency** for Tapboard.

Repository context:

- Read `architecture.md` completely.
- Read `docs/AUDIT-2026-08-01.md` completely, especially the Evidence Baseline, event-stream P0 findings, Batch 2 scope, acceptance criteria, and Verification Policy.
- Inspect the current working tree, recent history, and relevant code. Preserve unrelated user changes.
- Confirm whether Batch 1 is complete and integrated before planning edits. Batch 1 and Batch 2 both touch `src/haClient.js`; do not overwrite, revert, or redesign approved Batch 1 detector work.
- Treat the audit document as the canonical handoff; do not rely on missing prior-chat context.

## Phase 1 — Plan only

Do not edit files, deploy, restart containers, mutate Home Assistant, or spawn subagents yet.

Investigate enough to produce a concrete implementation plan that includes:

1. The proposed Tapboard-specific HA entity allowlist or projection model.
2. The exact public snapshot schema and incremental SSE event schemas.
3. How high-rate detector telemetry remains immediate inside the backend while display-only telemetry is throttled or coalesced.
4. How `pour_start` and `pour_complete` avoid being queued behind ordinary display updates.
5. How the frontend will update only affected cards while preserving live SVG nodes and their animations.
6. How SSE backpressure, disconnected clients, heartbeat behavior, and slow consumers will be handled.
7. A lightweight health endpoint and Docker healthcheck change.
8. Privacy tests proving unrelated HA entities cannot appear in public snapshots or SSE events.
9. Performance tests or deterministic benchmarks for payload size, event rate, render count, and delivery ordering.
10. Exact files expected to change or be added.
11. Compatibility risks, migration behavior, and rollback strategy.
12. Explicit assumptions or decisions that require my approval.
13. A proposed subagent breakdown for Phase 2 with non-overlapping file ownership.

Use Home Assistant MCP and container diagnostics only for read-only evidence if they materially improve the plan. Summarize measurements; do not paste complete HA snapshots, large histories, or raw container logs.

If Batch 1 is still uncommitted, incomplete, or under review, call that out in the plan and propose a safe sequencing gate. Do not modify overlapping files until I approve that sequencing.

End Phase 1 with the plan and wait for my explicit approval. Do not treat silence or a general acknowledgement as approval.

## Phase 2 — Only after I approve the plan

After explicit approval, orchestrate the implementation through bounded subagents and then independently verify their work.

Subagent policy:

- Use subagents only for concrete, independent work described in the approved plan.
- Prefer the lowest-cost capable model available. When available, prefer `gpt-5.6-terra` with low reasoning for fixtures, schema tests, frontend mechanical work, benchmarks, or narrow reviews. Use medium reasoning only for subtle event ordering, backpressure, or integration work. Escalate to a more expensive frontier model only after a cheaper agent fails or the risk clearly warrants it, and state why.
- When supported, use a context-light fork (`none` or only the few necessary turns) instead of copying the full chat history. Give each agent a compact brief and direct it to only the relevant Batch 2, evidence, and verification sections.
- Start with at most two worker subagents in parallel.
- Give every agent a strict scope, file ownership, acceptance criteria, and concise return format.
- Do not let two agents edit the same file concurrently.
- A preferred split is backend projection/SSE behavior versus frontend targeted updates and UI tests. If both require a shared file, keep that integration work with the main orchestrator.
- After implementation, use at most one targeted read-only review agent when it adds meaningful value; do not commission duplicate reviews.
- Ask agents to return conclusions, changed files, tests run, measurements, and residual concerns rather than full logs.

Orchestrator responsibilities:

1. Maintain and update the approved plan.
2. Establish file ownership and protect completed Batch 1 behavior.
3. Inspect every subagent diff and reconcile integration issues personally.
4. Verify the implementation against every Batch 2 acceptance criterion.
5. Run focused tests and the full available suite.
6. Confirm public state and SSE output contain only allowlisted Tapboard data.
7. Confirm ordinary `state_changed` events do not contain a full HA snapshot.
8. Confirm pour events retain their names, arrive in correct order, and are not delayed behind display telemetry under synthetic load.
9. Confirm the detector still receives every required fast sample even when browser-facing updates are throttled.
10. Confirm the frontend coalesces renders and updates only affected cards without replacing persistent SVG nodes.
11. Confirm slow or disconnected SSE consumers cannot cause unbounded buffering or destabilize other clients.
12. Measure and record before/after snapshot size, incremental-event size, event rate, and representative render count.
13. Confirm the new health endpoint is cheap and does not expose application state.
14. Review `git diff` for unrelated or accidental changes.
15. Update `docs/AUDIT-2026-08-01.md` only with verified results, measurements, acceptance criteria, and a Decision Log entry.

## Minimum verification targets

The approved plan may make these stricter, but it should not weaken them without explaining why:

- Public snapshot size is reduced substantially from the measured 265,257-byte baseline and contains no unrelated HA entities.
- Ordinary incremental state events are small deltas, not snapshots; target under 2 KB for typical events.
- Synthetic 10 Hz fast telemetry plus unrelated HA events does not delay pour-event delivery or create unbounded SSE output.
- Browser rendering is coalesced to a bounded rate and does not call the full application renderer once per raw telemetry sample.
- At least one automated negative test inserts a sensitive-looking unrelated HA entity and proves it is absent from all public output.
- Existing Batch 1 detector tests remain green.

Do not deploy, restart the production container, or change live ESPHome/Home Assistant configuration without a separate explicit approval.

When complete, report:

- Outcome first.
- Files changed.
- Tests and benchmarks run, with concise before/after results.
- Privacy assertions and event-ordering results.
- Batch 2 acceptance criteria satisfied or still open.
- Important design decisions.
- Residual risks and the safest next step.
