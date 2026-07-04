# Architecture

Kikoto is organized around one central rule:

```text
Metadata sources and file sources are separate.
```

Metadata sources answer what a work is. File sources answer where playable files are.

## Runtime Topology

```text
Browser
  -> React frontend
  -> Go HTTP API
  -> SQLite
  -> local filesystem and metadata adapters
```

## Backend

Current backend implementation:

- Go standard `net/http`.
- A single current SQLite init schema in `backend/migrations/001_initial.sql`.
- RBAC auth, dev-mode root login, and admin user management in `backend/internal/httpapi`.
- Local folder scanner in `backend/internal/localfs`.
- DLsite metadata client in `backend/internal/dlsite`.
- Metadata sync workflow in `backend/internal/metasync`.
- Circle catalog and source matching handlers in `backend/internal/httpapi`.
- Compatible remote source browsing, sync, cache, and save handlers in
  `backend/internal/httpapi`.
- HTTP API in `backend/internal/httpapi`.

## Frontend

Current frontend implementation:

- React.
- TypeScript.
- Vite.
- Tailwind CSS.
- Local shadcn-style UI primitives.
- lucide-react icons.
- A custom global player provider backed by a native `<audio>` element.

## Persistence

SQLite stores:

- Works.
- Metadata providers and snapshots.
- File sources.
- Media items.
- Media file locations.
- Workflow definitions, triggers, runs, node runs, jobs, and candidates.
- Users, sessions, quick work marks, favorite/tag foundations, and media progress.
- Party, party catalog, and per-user party state for circle or maker pages.

Runtime files live under mounted `config/` and `data/` directories.

## Current Limitations

- Workflow execution is still synchronous-first.
- Remote file source sync, cache, and save actions are synchronous-first rather
  than queued worker jobs.
- Retry and restart recovery are not implemented.
- Queue restore is not implemented.
- Favorite-list and custom-tag UI is not implemented yet.
- Review/maintenance triage for stale catalog rows and ambiguous scan results is
  not implemented yet.
