# Reliability

## Current Guarantees

- Local and cached media remain inspectable when a remote source is offline.
- Source outages are scoped to the affected source.
- Batch source availability checks probe source health before per-work checks.
- Remote downloads use configurable delay and backoff. Media streams into a
  temporary destination under a configurable per-file limit; covers use a
  fixed 20 MiB limit. A target is published only after the complete bounded
  response passes its declared or expected-size checks.
- Remote media is downloaded before opening the database transaction that
  records it, keeping SQLite write-lock time bounded.
- Idle workflow polling does not acquire a write transaction unless a queued or
  expired job was first observed.
- Interrupted SQLite connections are validated before pool reuse, and
  file-backed connection lifetimes are bounded so a contaminated idle
  connection cannot retain a writer lock indefinitely.
- Settings reads do not write to SQLite. The deployment-owned local source is
  initialized before the HTTP server starts, and write transactions do not
  re-enter the database connection pool for supporting reads.
- Request-detached remote enqueue operations have finite deadlines.
- DLsite metadata sync uses configured request delay and backoff for provider
  requests.
- Fetch planning reuses complete persisted DLsite family metadata and cached
  source availability. If the requested work lacks a DLsite snapshot or edition
  relationship, preparation performs one bounded targeted family sync.
- Fetch enqueueing checks for an active run before remote preflight and again in
  the immediate SQLite enqueue transaction. Concurrent requests for the same
  canonical work reuse one queued or running run.
- Fetch, remote playback cache, and cache/local location deletion run as durable
  recoverable jobs with lease heartbeats and restart checkpoints.
- Fetch Activity records transferred bytes, the known byte total, and the
  count of selected downloads whose size is still unknown. It shows a
  percentage only when every remaining transfer has a known total.
- Failed or cancelled Fetch staging is retained for seven days by default,
  then reconciled at startup and every six hours. Cleanup computes only
  `.kikoto-staging/<run-id>` below `/data`, refuses symbolic links, junctions,
  reparse points, and unexpected file types. A safe cleanup resets the manifest
  so a later retry can rebuild staging; an unsafe tree remains claimed for
  operator review and cannot be retried over a partial cleanup.
- A single cache/local deletion and a mixed batch deletion use the same queued
  workflow. Deleting a local location preserves work progress and listening
  marks.
- Database contention is reported as a retryable service error and is not
  mistaken for an expired mobile login.
- Workflow runs preserve structured status and error context.
- The local folder watcher performs one bounded registration walk, then relies
  on native filesystem events instead of recurring disk traversal. It debounces
  changes for five seconds, ignores Fetch transaction directories, and retains
  only one pending follow-up while its automatic scan is active. The default
  Startup scan covers changes made while the service is stopped.

## Current Limits

- Fetch byte progress describes remote transfer into cache. Local staging copy,
  hashing, publication, and location registration remain visible as workflow
  phases rather than being folded into the transfer percentage.
- Download-size enforcement is complete for the current file-writing paths,
  but the broader outbound URL, redirect, address, and DNS-pinning contract is
  still being hardened.

## Operational Guidance

Keep runtime data backed up, avoid committing mounted directories, and treat
remote source health as advisory. Local and cached locations should remain the
most reliable playback paths.

## Related Docs

- [Sources](../product/sources.md)
- [Workflows](../architecture/workflows.md)
- [Troubleshooting](troubleshooting.md)
