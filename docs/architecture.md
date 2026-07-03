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
- SQLite migrations in `backend/migrations`.
- Local folder scanner in `backend/internal/localfs`.
- DLsite metadata client in `backend/internal/dlsite`.
- Metadata sync workflow in `backend/internal/metasync`.
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
- Workflow templates, runs, and jobs.

Runtime files live under mounted `config/` and `data/` directories.

## Current Limitations

- Workflow execution is still synchronous-first.
- Remote file source sync is not implemented.
- Download/cache workflows are not implemented.
- Playback progress is not persisted.
- There is no multi-user permission model.
