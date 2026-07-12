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
- Fetch planning reuses complete persisted DLsite family metadata and cached
  source availability. If the requested work lacks a DLsite snapshot or edition
  relationship, preparation performs one bounded targeted family sync.
- Fetch, remote playback cache, and cache/local location deletion run as durable
  recoverable jobs with lease heartbeats and restart checkpoints.
- A single cache/local deletion and a mixed batch deletion use the same queued
  workflow. Deleting a local location preserves work progress and listening
  marks.
- Database contention is reported as a retryable service error and is not
  mistaken for an expired mobile login.
- Workflow runs preserve structured status and error context.

## Current Limits

- Activity download progress remains coarser than per-byte transfer progress.
- Failed or cancelled Fetch staging manifests do not yet have retention-based
  garbage collection.

## Operational Guidance

Keep runtime data backed up, avoid committing mounted directories, and treat
remote source health as advisory. Local and cached locations should remain the
most reliable playback paths.

## Related Docs

- [Sources](../product/sources.md)
- [Workflows](../architecture/workflows.md)
- [Troubleshooting](troubleshooting.md)
