# Tapboard Repository Instructions

## Coordinator and subagent orchestration

The primary coordinator uses the model and reasoning setting currently selected by the user and is the architect, orchestrator, integrator, verifier, and final quality-control owner.

Use subagents whenever the approved work decomposes into bounded, non-overlapping tasks. Keep assignments focused and use resources efficiently:

- Use `gpt-6.1-sol` with low reasoning for every worker. Spawn workers with explicit arguments `model: "gpt-6.1-sol"`, `reasoning_effort: "low"`, and `fork_turns: "none"`. Provide a compact, self-contained assignment containing only the necessary repository context, constraints, exact file ownership, deliverable, and verification command.
- Delegate repository inventories, reference tracing, fixture construction, isolated implementation, focused tests, documentation, and read-only diff review when the tasks are bounded.
- Keep worker reports concise and evidence-based. Workers stop after their assigned deliverable and do not expand scope.
- Use at most three workers concurrently so the primary coordinator remains active.

The primary coordinator must personally:

1. Read all applicable repository instructions, skills, handoffs, and issue requirements completely before delegating.
2. Inspect the repository, establish the baseline, own the architecture and plan, and resolve cross-cutting decisions.
3. Define explicit, non-overlapping file ownership before worker edits.
4. Sequence all work that touches shared integration surfaces. Prefer sequential ownership over concurrent edits to the same file.
5. Review every worker report and every changed line; never accept a worker success claim without inspection.
6. Integrate the complete result, resolve conflicts, run focused and full verification, inspect the final diff, and perform final security/reliability QC.
7. Decide whether the task's acceptance criteria are actually satisfied and produce the final completion report.

Subagents must not:

- Commit, push, merge, change branches, mutate issues/PRs, or otherwise modify external GitHub state.
- Read or modify `.env`, expose credentials, call live external services, mutate Home Assistant, restart Home Assistant, or touch live production data unless the user has explicitly authorized that exact action and the coordinator has assigned it.
- Rebuild or restart the local Compose service unless the coordinator explicitly assigns that exact verification after any required approval.
- Edit files outside their assigned ownership or undo another worker's changes.
- Make cross-cutting architecture decisions, weaken tests, broaden scope, or treat a focused test as final acceptance.

After implementation, assign a fresh `gpt-6.1-sol` worker with low reasoning a read-only final diff review focused on security, privacy, transaction ordering, failure handling, migration safety, compatibility, and missing tests. The primary coordinator must independently validate every reported concern, implement or reject it with evidence, rerun verification, and retain sole authority for final QC.

Task-specific handoff prompts may define a more detailed worker split. Those assignments supplement this policy but may not weaken the coordinator, file-ownership, safety, or final-QC requirements above.

## GitHub CLI authentication checks in WSL

Do not report that GitHub authentication is expired or ask the user to reauthenticate based only on `gh auth status`. In this repository's WSL environment, that command can return a stale/cache/config false negative even while the usable GitHub CLI credentials and Git credential flow are valid.

Before declaring an authentication blocker:

1. Identify the CLI actually being invoked with `type -a gh` and `gh --version`.
2. Test a real, read-only authenticated CLI operation, such as `gh api user --jq .login`.
3. Test repository access with a read-only command such as `gh repo view --json nameWithOwner,defaultBranchRef` or the exact `gh pr` read needed for the task.
4. If WSL exposes more than one `gh` executable/config context, test the usable CLI context before concluding the credentials are invalid. Distinguish a WSL cache/config-path problem from an actual GitHub authentication rejection.
5. Distinguish authentication errors from sandbox, DNS, proxy, network, and GitHub-service failures. Retry an important command with the required sandbox escalation when the failure may be environmental.
6. Never run a command that prints an authentication token, and never expose credential/config contents while diagnosing the CLI.
7. Report expired/invalid authentication only after the real authenticated CLI operation and repository access both fail with an authentication-specific response. Include the commands tested and sanitized error category.

A failing `gh auth status` alone is diagnostic noise, not a blocker. Continue with the verified working CLI or Git credential path when authenticated repository operations succeed.

## v2 implementation handoff workflow

After each completed and merged v2 implementation issue, the operator updates main, rebuilds and recreates the development container without deleting its volume, verifies /healthz, and manually exercises the delivered behavior. Every future implementation handoff must include a short issue-specific heading MANUAL DEV TEST describing what the operator should test after the rebuild.
