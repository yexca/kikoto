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
