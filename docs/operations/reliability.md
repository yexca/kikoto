# Reliability

## Current Guarantees

- Local and cached media remain inspectable when a remote source is offline.
- Source outages are scoped to the affected source.
- Batch source availability checks probe source health before per-work checks.
- Remote downloads use configurable delay and backoff. Media streams into a
  temporary destination under a configurable per-file limit; covers use a
  fixed 20 MiB limit. A target is published only after the complete bounded
  response passes its declared or expected-size checks.
- A remote rate-limit or temporary-unavailable response pauses requests to that
  origin for its `Retry-After` value, bounded by the configured maximum
  backoff. A request that meets a longer pause fails fast instead of waiting in
  place, and a workflow job that has not reached the source is rescheduled for
  the end of the pause without using a retry. Other sources' queued jobs keep
  running meanwhile.
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
- Fetch staging, backup, and trash live at the root of the pool that holds the
  target (`/data` in standard mode, `/data/<pool>` in storage pool mode), so
  publication, rollback, and archiving stay same-filesystem renames. Planning
  refuses to write into an unconfigured library, a missing Fetch pool, or an
  offline pool, and the free-space reserve is measured on the target pool.
- Failed or cancelled Fetch staging is retained for seven days by default,
  then reconciled at startup and every six hours. Cleanup computes only
  `.kikoto-staging/<run-id>` at the data root or a pool root, refuses symbolic links, junctions,
  reparse points, and unexpected file types. A safe cleanup resets the manifest
  so a later retry can rebuild staging; an unsafe tree remains claimed for
  operator review and cannot be retried over a partial cleanup.
- A Fetch retry or restart first settles an interrupted publication from the
  target, staging, and backup roots, so it never restages over a published
  root. Publication refuses to replace an existing backup. The manifest
  completes in the same transaction that retires the work's `remote_stream`
  rows, so registration can always be repeated. A Fetch that startup recovery
  cannot finish is logged and recorded in Activity without stopping startup.
- A single cache/local deletion and a mixed batch deletion use the same queued
  workflow. Deleting a local location preserves work progress and listening
  marks.
- Database contention is reported as a retryable service error and is not
  mistaken for an expired mobile login.
- Workflow runs preserve structured status and error context.
- The local folder watcher performs one registration walk, then relies on native
  filesystem events instead of recurring full-tree traversal. It watches through
  the configured discovery depth and all descendants below recognized work
  roots, so Linux deployments must leave enough `inotify` watches for those
  directories. It starts its scan five seconds after the most recent observed
  event and retains only one pending follow-up while an automatic scan is active.
  This quiet period does not prove that an open copy has closed; strict importers
  should publish with a same-filesystem rename from an excluded staging tree.
  Incremental mode is the default, with automatic full fallback after watcher
  errors, event overflow, root invalidation, or duplicate roots. Fetch registers
  publication directly, while Startup, interval, and manual scans continue to
  inspect the complete data tree.
- A scan changes only what it can observe. Every pool root carries a
  `.kikoto-pool` marker. A standard data root without one is adopted only when
  it visibly holds media or the library has no local works yet; an empty root
  of a library with works is an unmounted volume, so the scan fails without
  marking anything missing. In pool mode an unmarked or foreign-marked pool is
  offline: its works keep their state, the scan finishes as partial, and the
  watcher ignores unregistered first-level folders. Works deeper than the scan
  depth are never marked missing either, and scans always reach at least the
  deepest Fetch folder level. Disk-verified database cleanup confirms absence
  only inside online pools.
- Local scan completion is independent of metadata-provider latency or failure.
  Its optional, disabled-by-default metadata follow-up creates a separate run
  after scan completion, with its own retry and review state.

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

- [Sources](../user/en/sources.md)
- [Workflows](../architecture/workflows.md)
- [Troubleshooting](troubleshooting.md)
