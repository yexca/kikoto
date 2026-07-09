# Kikoto

Kikoto is a local-first personal audio library for DLsite-style works, local
folders, and Kikoeru-compatible remote file sources.

The project is in early implementation. It already includes a Go backend,
SQLite storage, a React frontend, local library scanning, DLsite metadata sync,
remote source browsing, source availability checks, remote fetch workflows, and
a browser-based audio player.

## Quick Start

Run the Docker stack from the repository root:

```sh
docker compose up -d --build
```

Open:

- Frontend: `http://127.0.0.1:7655`
- Backend: `http://127.0.0.1:7659`

Runtime data is stored in mounted local directories:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

These directories may contain databases, cached covers, and media files. Do not
commit runtime data.

## Documentation

- [Documentation index](docs/README.md)
- [Overview](docs/overview.md)
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture/index.md)
- [Product specs](docs/product/index.md)
- [Operations](docs/operations/configuration.md)
- [Development](docs/development/local-dev.md)
- [Contributing](CONTRIBUTING.md)

## Core Boundary

Kikoto uses one unified work identity. Local folders, remote sources, cached
files, tracked state, and source catalogs describe where a work exists or can be
played; they do not create separate work identities.

## Repository Layout

```text
backend/    Go HTTP API, domain modules, and SQLite migrations
frontend/   React + TypeScript frontend
docs/       Public project documentation
scripts/    Utility scripts
config/     Runtime configuration and SQLite database mount
cache/      Runtime cache mount
data/       Runtime media library mount
```

## Validation

Backend:

```sh
cd backend
go test ./...
```

Frontend:

```sh
cd frontend
npm install
npm run build
```

Smoke validation:

```sh
make smoke
```
