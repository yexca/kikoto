# Backend

The backend is a Go HTTP API with SQLite persistence.

## Stack

- Go standard `net/http`.
- SQLite.
- SQL migrations in `backend/migrations/`.
- Docker-first runtime.

## Main Packages

- `backend/internal/httpapi`: HTTP handlers and feature orchestration.
- `backend/internal/localfs`: local folder discovery.
- `backend/internal/dlsite`: DLsite client and parsing.
- `backend/internal/kikoeru`: Kikoeru-compatible client.
- `backend/internal/metasync`: metadata sync.
- `backend/internal/storage`: database opening and migrations.
- `backend/internal/workflow`: workflow persistence helpers.

## Runtime Responsibilities

- Authenticate users and enforce permissions.
- Scan local libraries.
- Sync metadata snapshots.
- Serve library and detail APIs.
- Browse and sync remote sources.
- Stream local media with range support.
- Record workflow runs and activity state.
- Claim durable workflow jobs by priority and serialize jobs that share a
  resource lane.
- Coalesce concurrent local-media indexing for the same work, keep duration
  probes serialized per server, and expose slow index phase timings in logs.

## Code Organization

HTTP handlers own transport concerns: authentication context, request decoding,
response encoding, and status mapping. Reusable domain state transitions,
filesystem transactions, source adapters, and workflow persistence should move
behind focused packages or services as they become independently testable.

Avoid adding unrelated orchestration to already broad handler files. Extract by
cohesive behavior rather than moving a large file mechanically, and keep
dependencies directed from HTTP composition toward domain and storage code.

## API Shape

The backend owns aggregate source availability checks, workflow recording, and
state transitions that should not be spread across the frontend. The frontend
should not fan out directly to every source when one aggregate endpoint can own
the result and diagnostic trail.

Work summary and media APIs remain separate. The media endpoint resolves the
media-bearing edition and loads media items directly; it does not repeat the
complete metadata, credit, tag, and manual-override detail projection.

Public errors use a stable code and retryability decision without returning raw
database, upstream, endpoint, or filesystem details. Logs and workflow Activity
may retain protected diagnostics when they are necessary to operate the
instance.

## Outbound Requests

An administrator-configured source endpoint may intentionally be on a private
LAN. Source-returned media, cover, and redirect destinations remain untrusted
input. New or changed clients must define their permitted origin boundary,
revalidate allowed redirects, prevent DNS-rebinding time-of-check/time-of-use
gaps, remove credentials on origin changes, and bound time, response size,
stream size, concurrency, and retries.

Current media and cover file-writing paths enforce streamed destination-size
limits. The clients do not yet implement the complete origin, redirect,
address, and DNS-pinning transport contract. See [Secure development](../development/security.md)
and [Runtime security](../operations/security.md) before extending an outbound
request path.

## Current Limits

- Some operations remain synchronous even though the major Fetch, cache,
  cleanup, scan, metadata, and custom workflow paths use persisted jobs.
- The embedded job runner is single-instance and SQLite-backed; it is not a
  distributed worker system.
- Retry, cancellation, and restart recovery are defined per job family rather
  than by one universal guarantee.
- Outbound URL validation does not yet enforce the complete origin, redirect,
  address, and DNS-pinning contract described above.

## Related Docs

- [Workflows](workflows.md)
- [Data model](data-model.md)
- [Backend guidelines](../development/backend-guidelines.md)
