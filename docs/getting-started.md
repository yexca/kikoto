# Getting Started

## Requirements

- Docker and Docker Compose.
- Optional for local development:
  - Go 1.22 or newer.
  - Node.js 22 or newer.

## Run With Docker

Download `docker-compose.yml` into an empty directory, then pull and start the
published Docker Hub image:

```sh
docker compose pull
docker compose up -d
```

The default image is `yexca/kikoto:latest`. To pull the same release from
GitHub Container Registry, set the image when starting the stack:

```sh
KIKOTO_IMAGE=ghcr.io/yexca/kikoto:latest docker compose up -d
```

Open:

- Frontend: `http://127.0.0.1:7655`
- Backend: `http://127.0.0.1:7659`

The default runtime mounts are:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

## First Library Scan

1. Put supported audio work folders under `data/`.
2. Start the Docker stack.
3. Open the frontend.
4. Run a local scan from the Workflows or Activity surface.
5. Optionally run DLsite metadata sync to enrich detected works.

## Validate The Build

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

## Next Reading

- [Configuration](operations/configuration.md)
- [Docker](operations/docker.md)
- [Library](product/library.md)
- [Sources](product/sources.md)
