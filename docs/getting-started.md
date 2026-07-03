# Getting Started

## Requirements

- Docker and Docker Compose.
- Optional for local development:
  - Go 1.22 or newer.
  - Node.js 22 or newer.

## Run With Docker

From the repository root:

```sh
docker compose up -d --build
```

Open:

- Frontend: `http://127.0.0.1:7655`
- Backend: `http://127.0.0.1:7659`

The default Docker mounts are:

- `./config:/config`
- `./data:/data`

Runtime database files, cached covers, and media files are intentionally not source controlled.

## Validate The Build

Backend tests:

```sh
docker run --rm -v "${PWD}/backend:/src" -w /src golang:1.22 go test ./...
```

Frontend build:

```sh
docker run --rm -v "${PWD}/frontend:/src" -w /src node:22 sh -c "npm install && npm run build"
```

## First Local Library Scan

1. Place audio work folders under `data/`.
2. Start the Docker stack.
3. Trigger the local scan workflow from the UI or API:

```sh
curl -X POST http://127.0.0.1:7659/api/workflow-runs/local-scan
```

4. Optional: sync DLsite metadata:

```sh
curl -X POST http://127.0.0.1:7659/api/workflow-runs/dlsite-sync
```
