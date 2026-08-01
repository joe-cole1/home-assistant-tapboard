# New Codex Task Prompt — Batch 1

Work on **Batch 1 — Pour detector correctness and deterministic tests** for Tapboard.

Repository context:

- Read `architecture.md` completely.
- Read `docs/AUDIT-2026-08-01.md` completely, especially the Evidence Baseline, P0 findings, Batch 1 scope, acceptance criteria, and Verification Policy.
- Inspect the current working tree and relevant code. Preserve unrelated user changes.
- Treat the audit document as the canonical handoff; do not rely on missing prior-chat context.

## Phase 1 — Plan only

Do not edit files, deploy, restart containers, mutate Home Assistant, or spawn subagents yet.

Investigate enough to produce a concrete implementation plan that includes:

1. The proposed detector/state-machine design.
2. How short-window robustness and cross-tap arbitration will work.
3. How meaningful flow, quiet time, settled completion, volume calculation, unit conversion, and large-change rebaselining will work.
4. Exact files expected to change or be added.
5. Deterministic test fixtures and cases, including representative reproductions of the 20:35 and 20:46 Tap 2 tests and later idle false positives.
6. Compatibility risks and rollback strategy.
7. Explicit assumptions or decisions that require my approval.
8. A proposed subagent breakdown for Phase 2 with non-overlapping ownership.

Use Home Assistant MCP only for read-only evidence if it materially improves the plan. Keep returned evidence summarized; do not paste large raw histories.

End Phase 1 with the plan and wait for my explicit approval. Do not treat silence or a general acknowledgement as approval.

## Phase 2 — Only after I approve the plan

After explicit approval, orchestrate the implementation through bounded subagents and then independently verify their work.

Subagent policy:

- Use subagents only for concrete, independent work described in the approved plan.
- Prefer the lowest-cost capable model available. When available, prefer `gpt-5.6-terra` with low reasoning for mechanical tests, fixtures, or narrow reviews. Use medium reasoning only for the detector algorithm or subtle concurrency work. Escalate to a more expensive frontier model only when a cheaper agent has failed or the risk clearly warrants it, and state why.
- When supported, use a context-light fork (`none` or only the few necessary turns) instead of copying the full chat history. Give each agent a compact task brief and direct it to the relevant Batch 1, evidence, and verification sections rather than making every agent ingest unrelated audit sections.
- Start with at most two worker subagents in parallel; more agents are not automatically better.
- Give every agent a strict scope, file ownership, acceptance criteria, and concise return format.
- Do not let two agents edit the same file concurrently.
- Avoid redundant implementations. A good division is implementation versus fixtures/tests, followed by one targeted review—not multiple agents solving the same problem.
- Ask agents to return conclusions, changed files, tests run, and residual concerns rather than full logs.

Orchestrator responsibilities:

1. Maintain and update the approved plan.
2. Inspect every subagent diff and reconcile integration issues personally.
3. Verify the implementation against every Batch 1 acceptance criterion.
4. Run focused tests and the full available suite.
5. Replay deterministic traces with a fake/injectable clock; do not use real sleeps where avoidable.
6. Confirm continuous 0.2-second flat telemetry no longer prevents completion.
7. Confirm representative Tap 2 traces do not emit Tap 1 pour events.
8. Confirm volume is based on robust net loss rather than summed negative jitter.
9. Confirm declared-unit conversion and safe large-change rebaselining.
10. Review `git diff` for unrelated or accidental changes.
11. Update `docs/AUDIT-2026-08-01.md` only with verified results and a Decision Log entry.

Do not deploy, restart the production container, or change live ESPHome/Home Assistant configuration without a separate explicit approval.

When complete, report:

- Outcome first.
- Files changed.
- Tests and trace replays run, with concise results.
- Acceptance criteria satisfied or still open.
- Important design decisions.
- Residual risks and the safest next step.
