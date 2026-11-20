# Backend Guidelines

## Principles

- Keep metadata sources and file sources separate, and create one work identity
  per work rather than per source ([Core boundaries](../architecture/core-boundaries.md)).
- Prefer idempotent workflow steps.
- Preserve local and cached state when remote sources fail.
- Keep HTTP transport, domain transitions, persistence, and filesystem effects
  separable as features grow.
- Treat source-returned URLs and redirects as untrusted even when an
  administrator configured the source endpoint
  ([Outbound HTTP](security.md#outbound-http)), and sanitize user-facing source
  errors ([Errors, Logs, and Diagnostics](security.md#errors-logs-and-diagnostics)).

## Validation

Backend commands are in [Testing](testing.md#backend).

## Documentation

Update architecture docs for boundary or persistence changes. Update product
docs for user-visible behavior changes.
