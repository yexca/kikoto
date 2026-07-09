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

## API Shape

The backend owns aggregate source availability checks, workflow recording, and
state transitions that should not be spread across the frontend. The frontend
should not fan out directly to every source when one aggregate endpoint can own
the result and diagnostic trail.

## Current Limits

- Long-running actions are still mostly synchronous-first.
- Retry and restart recovery are not complete.
- Remote fetch/cache flows are workflow-backed but not yet backed by a durable
  async download queue.

## Related Docs

- [Workflows](workflows.md)
- [Data model](data-model.md)
- [Backend guidelines](../development/backend-guidelines.md)
