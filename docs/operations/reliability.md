# Reliability

## Current Guarantees

- Local and cached media remain inspectable when a remote source is offline.
- Source outages are scoped to the affected source.
- Batch source availability checks probe source health before per-work checks.
- Remote downloads use configurable delay and backoff.
- Remote media is downloaded before opening the database transaction that
  records it, keeping SQLite write-lock time bounded.
- Idle workflow polling does not acquire a write transaction unless a queued or
  expired job was first observed.
- DLsite metadata sync uses configured request delay and backoff for provider
  requests.
- Fetch planning reads persisted DLsite metadata and cached source availability;
  it does not trigger an implicit provider refresh.
- Database contention is reported as a retryable service error and is not
  mistaken for an expired mobile login.
- Workflow runs preserve structured status and error context.

## Current Limits

- Long-running remote fetches are not yet backed by a durable async queue.
- Running job restart recovery is not complete.
- Retry controls are limited.

## Operational Guidance

Keep runtime data backed up, avoid committing mounted directories, and treat
remote source health as advisory. Local and cached locations should remain the
most reliable playback paths.

## Related Docs

- [Sources](../product/sources.md)
- [Workflows](../architecture/workflows.md)
- [Troubleshooting](troubleshooting.md)
