# New Codex Task Prompt — Batch 4

Work on **Batch 4 — ESPHome and Home Assistant telemetry hygiene** for Tapboard.

Repository context:

- Read `architecture.md` completely.
- Read `docs/AUDIT-2026-08-01.md` completely, especially the physical-pour evidence, fast-sensor recorder finding, Batch 4 acceptance criteria, Verification Policy, and Decision Log.
- Read `docs/prompts/BATCH-01-POUR-DETECTOR.md`, `docs/prompts/BATCH-02-SSE-PERFORMANCE-PRIVACY.md`, and `docs/prompts/BATCH-03-WEB-API-SECURITY.md`, then inspect the completed implementations and tests.
- Inspect the current working tree, recent history, `../config/configuration.yaml`, `../config/packages/tapboard.yaml`, and relevant Home Assistant/ESPHome configuration. Preserve unrelated user changes.
- Confirm Batches 1–3 are committed, deployed, and healthy before planning overlapping work. The minimum application baseline is 53 passing tests.
- Do not regress the deterministic single-active-tap detector, declared-unit conversion, schema-v2 `tapStates` projection, compact/coalesced SSE deltas, priority pour delivery, targeted card updates, SVG preservation, backpressure behavior, `/healthz`, or Batch 3 security controls.
- Treat the audit document as the canonical handoff; do not rely on missing prior-chat context.

Known evidence and current configuration:

- Tap 1 showed approximately 1.20 oz of transient loss while Tap 2 showed approximately 6.32 oz during the first recorded physical Tap 2 test.
- During the second test, Tap 1 crossed the old threshold roughly 339 ms before Tap 2, with later Tap 1 impulses around 2.16 oz and 1.71 oz while Tap 2 remained dominant.
- Batches 1 and 2 deliberately keep backend detector ingestion immediate and isolate volume tracking to declared-volume sensors.
- Tapboard currently searches, in order, for `sensor.brewery_brewery_taps_tap_N_fast`, `sensor.brewery_taps_tap_N_fast`, `sensor.tap_N_fast`, then `sensor.tap_N_fl_oz`.
- Home Assistant recorder keeps 365 days and currently excludes the stable raw entities `sensor.brewery_taps_tap_1_raw_value` and `sensor.brewery_taps_tap_2_raw_value`, but the high-rate fast entities were not excluded at audit time.
- The ESPHome source configuration is not currently present in this repository. Locate its authoritative source before proposing edits; do not reconstruct or overwrite it from assumptions.

## Phase 1 — Plan only

Do not edit files, install or flash ESPHome firmware, reload/restart Home Assistant, restart Tapboard, purge recorder history, calibrate a scale, mutate entity state, or spawn subagents yet.

Use read-only Home Assistant/ESPHome diagnostics only when they materially improve the plan. Limit state/history queries to the exact tap-scale entities and narrow time windows. Summarize measurements; do not print credentials, secrets, full HA snapshots, unrelated household state, complete device configuration containing secrets, or large raw histories.

Investigate enough to produce a concrete implementation plan covering:

1. The authoritative ESPHome device(s), configuration source, include/substitution structure, board type, HX711 component configuration, sampling/update rate, filters, calibration, units, and every published raw/stable/fast entity for Taps 1 and 2.
2. An exact entity-flow map from HX711 samples through ESPHome sensors, Home Assistant state events/recorder, Tapboard primary-sensor selection, unit normalization, the deterministic detector, SSE projection, and UI display.
3. Read-only measurements of current fast-event cadence, unavailable/reconnect behavior, representative noise amplitude, cross-tap impulses, and recorder growth. Prefer already saved audit traces; capture only the minimum additional relevant evidence.
4. At least two offline filter candidates, including a small median or equivalently robust filter, compared with the unfiltered baseline. Specify window size, send/update cadence, added group delay, impulse attenuation, slow-pour preservation, quantization, and startup behavior.
5. A recommendation that preserves near-sub-second pour feedback. Do not stack a slow ESPHome filter on top of the Batch 1 detector without measuring the combined latency and missed-pour risk.
6. Whether raw, stable/display, fast/detector, and optional diagnostic sensors should remain separate. Every detector input must retain an explicit supported volume unit; percentage and volume sensors must never share a filter/detector state machine.
7. The exact recorder exclusion entries for every high-rate entity, including entity-ID aliases that actually exist. Confirm exclusion affects persistence only and does not stop live `state_changed` events.
8. Whether a low-rate diagnostic/history sensor is genuinely needed. Recommend omitting it unless it answers a defined operational question; if retained, propose its unit, update interval, filter, retention purpose, and estimated recorder cost.
9. A non-destructive recorder policy. Do not purge existing history in this batch unless the user separately approves a measured purge plan and backup/restore procedure.
10. A user-led physical inspection checklist for load-cell mounting and isolation, keg/platform contact, beer-line strain relief, cable routing, shield/ground strategy, HX711 power decoupling, connector integrity, moisture, supply stability, and actual HX711 sample-rate selection. Clearly separate observations from software assumptions.
11. Deterministic/offline evaluation using saved traces. Feed candidate-filter output into the existing Batch 1 detector and prove the two representative Tap 2 traces still select Tap 2, idle/startup traces remain negative, slow pours complete, and poured volume is not materially biased.
12. Home Assistant and ESPHome validation commands, compile checks, backup locations, rollback artifacts, and exact service/device restart boundaries.
13. A staged live rollout: configuration backup, offline validation, one-device canary, explicit flash approval, hydration/reconnect verification, user-observed physical pour, then the second device. Do not choose a canary device without explaining the risk.
14. Post-rollout checks proving fast sensors still update live while recorder rows stop growing, Tapboard stays healthy, detector samples remain immediate, and no unrelated entity/configuration changed.
15. Exact files expected to change or be added. If the ESPHome source is external to this workspace, identify the owning system and do not invent a local path.
16. Compatibility risks, migration behavior, rollback steps, and every decision requiring explicit approval.

Walk through each material decision with the user **one at a time**. Present the recommended option first, explain the tradeoff, then present the viable alternatives. Wait for an explicit answer before moving to the next decision. At minimum, obtain decisions for:

- filter type/window and acceptable added latency;
- recorder exclusions and whether existing history is retained;
- whether to create a low-rate diagnostic sensor;
- canary device and physical-test procedure;
- whether and when to flash/restart live systems.

End Phase 1 with the complete plan and wait for explicit implementation approval. Silence, a general acknowledgement, approval of one design decision, or approval to edit source does not authorize a live ESPHome flash, Home Assistant restart, recorder purge, or physical recalibration.

## Phase 2 — Only after explicit approval

Implement the approved offline/configuration work first. Use bounded subagents only for concrete, non-overlapping work in the approved plan.

Subagent policy:

- Prefer `gpt-5.6-terra` with low reasoning for trace fixtures, mechanical comparison scripts, recorder-growth calculations, and documentation. Use medium reasoning for ESPHome filter semantics, HA recorder configuration, and detector integration analysis.
- Use context-light forks and provide only the relevant Batch 4 evidence, files, and acceptance criteria.
- Start with at most two workers in parallel.
- Give each worker strict file ownership and require concise returns: conclusions, changed files, tests/commands, measurements, migration concerns, and residual risks.
- Do not let two agents edit the same ESPHome YAML, `../config/configuration.yaml`, `src/haClient.js`, detector files, or shared fixture files concurrently.
- A preferred split is offline trace/filter evaluation versus HA recorder/configuration preparation. Keep live rollout, shared integration, and audit updates with the main orchestrator.
- Use at most one targeted read-only review agent after implementation if it adds meaningful safety value.

Orchestrator responsibilities:

1. Maintain the approved plan and enforce file ownership.
2. Back up every configuration file before editing and preserve unrelated user changes.
3. Inspect every worker diff and personally reconcile integration issues.
4. Keep ESPHome secrets/substitutions intact and out of logs, diffs, fixtures, and reports.
5. Verify candidate filters offline against both physical-pour traces and negative traces before proposing a flash.
6. Run all 53 Tapboard tests and any new telemetry tests; confirm the Batch 1 detector behavior is unchanged unless a separately approved threshold change is justified by evidence.
7. Validate Home Assistant configuration before any restart and compile ESPHome firmware before any upload.
8. Confirm recorder exclusions name the actual fast entities and do not exclude Tapboard pour logs or required low-rate sensors.
9. Do not purge recorder data, recalibrate load cells, change HX711 gain/rate, flash a device, or restart Home Assistant merely because source validation passed.
10. Stop at a live-change gate and request separate authorization stating the exact device/service, expected interruption, rollback artifact, and verification procedure.
11. If authorized, roll out one device at a time. Confirm reconnection, units, cadence, stable hydration, and Tapboard health before touching the next device.
12. Require user participation for physical pours and hardware inspection; do not simulate those observations or infer success from entity availability alone.
13. Verify that detector input remains live at the required cadence while new recorder rows for excluded high-rate entities cease after the configuration takes effect.
14. Review the complete diff, run `git diff --check`, and confirm no unrelated HA/ESPHome/Tapboard changes.
15. Update `docs/AUDIT-2026-08-01.md` only with measured results, genuinely satisfied acceptance checkboxes, and a Batch 4 Decision Log entry.

## Minimum verification targets

The approved plan may make these stricter but must not weaken them without explaining why:

- Candidate filters are evaluated against identical timestamped input, with numerical before/after noise, impulse attenuation, signal bias, event cadence, and latency results.
- Filtered versions of the representative 20:35 and 20:46 traces still select Tap 2 and never emit a Tap 1 completed pour.
- Idle/startup, rebound, slow-pour, flat-telemetry, large-plateau, cooldown, and safety-timeout detector tests remain green.
- Added filter delay is measured end-to-end and remains within the explicitly approved near-sub-second feedback budget.
- Volume values retain explicit supported units and no percentage entity can become a detector input.
- Every actual high-rate Tap 1/Tap 2 entity is excluded from recorder while remaining available in live HA state events.
- Recorder verification compares row growth or statistics before/after without dumping unrelated recorder contents. Existing history remains intact unless separately approved.
- Any optional diagnostic sensor publishes at a documented low rate and has a defined operational purpose.
- `ha core check` or the environment-equivalent configuration validation passes before restart.
- ESPHome configuration validation and compilation pass before any flash.
- After an approved canary flash, the device reconnects, sensors avoid `unknown`/`unavailable` churn, Tapboard rehydrates safely, and port `3005` remains healthy.
- User-observed physical tests confirm normal pours still start promptly, the correct tap is selected, completion occurs after quiet, and measured volume remains credible.
- All 53 pre-Batch-4 Tapboard tests remain green.

## Live-change gates

Treat these as separate approvals; one does not imply another:

1. Edit tracked HA/ESPHome configuration and add offline tests only.
2. Restart/reload Home Assistant so recorder exclusions take effect.
3. Flash/restart the canary ESPHome device.
4. Perform the user-assisted physical test.
5. Flash/restart the second device.
6. Purge old recorder data or recalibrate hardware, if ever proposed.

When complete, report:

- Outcome first.
- Files and external configurations changed.
- Backups and rollback paths.
- Filter comparison measurements and selected design.
- Recorder exclusions, estimated reduction, and observed post-change behavior.
- ESPHome validation/compile/flash results per device.
- Tapboard detector regression and complete-suite results.
- Physical inspection and user-observed pour results, clearly distinguishing completed checks from pending ones.
- Batch 4 acceptance criteria satisfied or still open.
- Important decisions, compatibility changes, and residual risks.
- Current Home Assistant, ESPHome, and port-3005 health.
- The safest next step.
