# Tapboard Repository Instructions

The global Sol High / Luna Max policy applies.

This file contains only Tapboard-specific requirements.

## Coordinator

Primary coordinator: **`gpt-5.6-sol` with high reasoning**.

Only permitted subagent: **`luna_max`** (`gpt-5.6-luna`, max reasoning).

Prefer Luna for recon, bounded implementation, testing, local tooling, Git/GitHub mechanics, documentation, and CI evidence. Sol owns architecture, integration, and final QC.

## Task Start

Before write-capable work:

- inspect branch and `git status`
- fetch current remote state when branch/PR state matters
- read applicable issues, handoffs, and design docs
- have Sol produce the authoritative plan

If unexplained worktree changes exist:

`BLOCKED — PRE-EXISTING WORKTREE CHANGES`

Do not stash, discard, reset, clean, restore away, or absorb them without Sol's decision.

## Parallel Work

Read-only Luna workers may share the primary worktree.

Concurrent write-capable Luna workers must use isolated Git worktrees with explicit, preferably non-overlapping scope.

Sol owns integration.

## Scope and Dependencies

Luna must not broaden scope, fix unrelated defects, make cross-cutting architecture decisions, weaken tests, or add/change dependencies without Sol approval.

If more scope is required:

`BLOCKED — SCOPE EXPANSION REQUIRED`

Useful unrelated findings may become Sol-approved follow-on GitHub issues.

Unexpected lockfile changes must be explained.

## Environment Safety

### Local Development

Tapboard local development/test infrastructure is disposable unless repository documentation says otherwise.

When delegated, Luna may rebuild/restart/recreate local containers, destroy/recreate local dev volumes, inspect logs/networking, exec into containers, run existing migrations, and reset disposable local state.

### Live Home Assistant / Production

Live Home Assistant and other production systems are non-disposable.

Without explicit user authorization for the exact live action, do not:

- mutate or restart Home Assistant
- change live configuration
- modify production data
- mutate live external services/infrastructure

Git `"ship it"` does not authorize live-system mutation.

## Secrets

Never expose `.env`, credentials, API keys, tokens, authorization headers, private config, or production secrets.

Redact likely secrets and report exposure to Sol.

## Canonical Commands and Validation

If Tapboard defines canonical bootstrap, validation, preflight, local-CI, shipping, or release scripts, they are authoritative.

Targeted commands are fine for debugging but do not replace a required canonical gate.

If a documented local gate materially differs from CI:

`BLOCKED — LOCAL/CI VALIDATION DRIFT`

Validation waivers and `"ship it"` are separate gates. Never report a waived check as passing.

## Final QC

Sol reviews the complete diff for plan/scope compliance, architecture, security/privacy, failure handling, migration/data safety where applicable, tests/regressions, dependency/lockfile drift, generated artifacts, docs drift, and secret exposure.

Respect documented known limitations and intentional design choices.

## GitHub CLI Authentication in WSL

Do not declare GitHub authentication broken based only on:

`gh auth status`

Before reporting an auth blocker:

1. `type -a gh`
2. `gh --version`
3. `gh api user --jq .login`
4. test the required read-only repo/PR operation
5. distinguish auth failure from sandbox, DNS, proxy, network, GitHub service, or stale-config problems
6. never print tokens or credential/config contents

Only ask the user to repair auth after real authenticated identity and repository reads fail with authentication-specific responses.

## Shipping

The global `"ship it"` policy applies.

Before push, a Luna SHIP worker freshly verifies repo/branch, reviewed diff, fetched remote/tracking state, current PR state, base branch, checks/review state when relevant, and conflicts/divergence.

If the associated PR is MERGED or CLOSED:

`BLOCKED — EXISTING PR IS NOT OPEN`

If an appropriate PR remains OPEN, the current `"ship it"` permits updating it.

If push unexpectedly indicates a new remote branch for one expected to exist, stop and re-check remote/PR history.

Never merge, enable auto-merge, force-push, rewrite shared history, push directly to `main`/`master`, or delete remote branches.

After shipping, Luna may monitor CI. On failure, gather evidence and stop for Sol triage; do not auto-fix.

## Post-Merge

After merge, return the primary clone to a clean/current default-branch resting state before unrelated new write work.

Do not destructively delete branches or discard user work.
