# Getting Started

## Requirements

- Docker and Docker Compose.
- Optional for local development:
  - Go 1.26.6.
  - Node.js 24.19.0 with npm 11.17.0.

## Run With Docker

Download `docker-compose.yml` into an empty directory, then pull and start the
published Docker Hub image:

Create a `.env` file in that directory before startup:

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose pull
docker compose up -d
```

The default image is `yexca/kikoto:latest`, which the release workflow updates
for each public release. For a reproducible deployment, override it with a
reviewed version or digest:

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d
```

Open:

- Frontend: `http://127.0.0.1:7655`
- Backend: `http://127.0.0.1:7659`

The default runtime mounts are:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

For a public read-only instance, use `docker-compose.demo.yaml`. It pulls the
published image and uses separate `./demo` mounts. Put candidate work folders
under `./demo/data`; the dedicated startup workflow verifies and indexes only
all-ages, permanently free works. See [Docker](operations/docker.md#demo-stack).

## Android Client

Signed Android APKs are attached to the project [GitHub Releases](https://github.com/yexca/kikoto/releases).
The client compares its version with the connected server. An older client
offers the matching Release, while a newer client identifies the server as the
component to update. Network failures retain a separate Reconnect action.

Kikoto does not silently install Android packages. Opening a Release and
installing its APK remains an explicit user-confirmed Android system flow.

## First Library Scan

1. Put supported audio work folders under `data/`.
2. Start the Docker stack.
3. Open the frontend.
4. Run the local library scan from Workflows; it discovers local works and
   updates local source presence without waiting for provider metadata.
5. Optionally run metadata sync as its own workflow to enrich detected works,
   or enable the scan's disabled-by-default `Follow-up run` option to queue it
   after the scan completes.

## Validate The Build

Backend:

```sh
cd backend
go test ./...
```

Frontend:

```sh
cd frontend
npm ci --strict-allow-scripts
npm run build
```

## Next Reading

- [Configuration](operations/configuration.md)
- [Docker](operations/docker.md)
- [Library](product/library.md)
- [Sources](product/sources.md)
