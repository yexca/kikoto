# Kikoto

Kikoto is a local-first personal audio library for DLsite-style works, local
folders, and Kikoeru-compatible remote file sources.

The project is in early implementation. It already includes a Go backend,
SQLite storage, a React frontend, local library scanning, DLsite metadata sync,
remote source browsing, source availability checks, remote fetch workflows, and
a browser-based audio player.

## Quick Start

Download `docker-compose.yml`, then run the production image directly from
Docker Hub:

```sh
docker compose pull
docker compose up -d
```

To use GitHub Container Registry instead:

```sh
KIKOTO_IMAGE=ghcr.io/yexca/kikoto:latest docker compose up -d
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

## Acknowledgements

The workflow canvas interaction design was informed by
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). Kikoto does not include
or adapt ComfyUI source code; its canvas is an independent React implementation
built with the MIT-licensed `@xyflow/react` library.

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

## License

Copyright (C) 2026 yexca. Kikoto is free software licensed under the
[GNU Affero General Public License v3.0](LICENSE) and comes without warranty.
