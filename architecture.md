# Tapboard architecture

## Implemented state

This rebuild branch currently contains no application runtime. It is an intentionally clean construction site: the v1 application has been removed, and Foundation has not started.

No v2 HTTP server, schema, domain module, template, browser application, telemetry endpoint, authentication system, integration adapter, deployment image, or runtime dependency has been implemented. Descriptions of those future components belong in the frozen rebuild documents and ADRs, not in this implemented-state record.

The implemented repository surface is limited to:

- the four authoritative rebuild documents under `docs/rebuild/`;
- concise frozen ADRs under `docs/adr/`;
- the machine-readable v1 reuse manifest pinned to frozen commit `429cf07e451b64ca1713655a34ffa5ebd376efae`;
- rebuild status and architecture-guardrail policy;
- a dependency-free guardrail script and its minimal CI workflow.

## Historical v1

The complete v1 implementation and its tests remain recoverable from `main` at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. The rebuild must not import it, maintain a shadow runtime tree, or introduce compatibility shims by default.

## Next architecture boundary

Foundation is the next planned implementation phase, but it has not been approved in this branch state. Foundation must establish the runtime and target source topology before pending executable checks for repository-only SQL, domain/integration imports, and browser/server imports can be finalized.
