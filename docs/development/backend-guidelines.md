# Backend Guidelines

## Principles

- Keep metadata sources and file sources separate, and create one work identity
  per work rather than per source ([Core boundaries](../architecture/core-boundaries.md)).
- Prefer idempotent workflow steps.
- Preserve local and cached state when remote sources fail.
- Keep HTTP transport, domain transitions, persistence, and filesystem effects
  separable as features grow.
- Never drop the error of a workflow state write, a database write, or a JSON
  decode. An executor that carries on past a failed write logs it through the
  helpers in `internal/httpapi/workflow_write_failures.go`. An optional JSON
  request body goes through `decodeOptionalJSONBody`, which answers 400 for a
  malformed body. A stored JSON read that tolerates an unreadable value says
  why in a comment and has an entry in `scripts/check-go-dropped-errors.go`.
- Treat source-returned URLs and redirects as untrusted even when an
  administrator configured the source endpoint
  ([Outbound HTTP](security.md#outbound-http)), and sanitize user-facing source
  errors ([Errors, Logs, and Diagnostics](security.md#errors-logs-and-diagnostics)).
- Reuse a helper that already exists: the built-in `min` and `max`, the
  standard library, or a shared package such as `internal/sqlutil`. A copy that
  differs on purpose is named for the difference. `make duplicate-helper-check`
  reports an unexported function name that a second package defines.

## Validation

Backend commands are in [Testing](testing.md#backend).

## Documentation

Update architecture docs for boundary or persistence changes. Update product
docs for user-visible behavior changes.
