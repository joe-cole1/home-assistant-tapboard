# ADR-0006: Authentication, CSRF, API keys, encrypted secrets, and degraded operation

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

Tapboard has one administrator, machine telemetry clients, optional integration secrets, and trusted-kiosk use. These trust boundaries require distinct credentials and honest behavior when a deployment key or integration is unavailable.

## Decision

The Admin PIN contract is exactly `[0-9]{4}`: four ASCII digits, no trimming or normalization, all 10,000 values valid, and no default. Verification uses versioned `scrypt` plus persistent atomic SQLite login throttling. Opaque random sessions are stored hashed in SQLite and sent only in `HttpOnly` cookies with appropriate SameSite, Secure, expiry, rotation, and revocation behavior. Admin cookie mutations require strict Origin validation and a server-issued CSRF token. PIN changes and the local operator-only reset revoke all sessions.

The PIN protects online/local Admin access. Throttling, sessions, and `scrypt` protect that online path, but the 10,000-value space does not provide strong offline resistance if an attacker obtains the SQLite verifier. The PIN never derives, encrypts, or protects `TAPBOARD_SECRET_KEY`.

Telemetry API keys use strong randomness, are shown once, and are stored only as verification hashes. Recoverable integration credentials are encrypted centrally with versioned authenticated encryption using Node cryptography and fresh nonces. `TAPBOARD_SECRET_KEY` is supplied outside SQLite. Rotation is an explicit local verify-before-commit operation that never prints plaintext.

A missing or incorrect master key preserves encrypted values and starts Tapboard in degraded mode with affected integrations disabled. It does not disable local authentication or domain operation. External outages similarly preserve last-known safe local state. Logs, errors, Activity, HTTP responses, screenshots, and event payloads never expose PINs, session/API tokens, Authorization headers, or decrypted credentials.

## Consequences

- Browser bearer/sessionStorage authentication is not reproduced.
- Human sessions, telemetry keys, and recoverable integration secrets have separate storage and threat models.
- Public DTOs and errors fail closed without leaking internal or integration data.
- Infrastructure-only trust settings and the master key remain deployment configuration; normal settings and encrypted credentials live in typed SQLite ownership.
