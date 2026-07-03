# Kikoto

Kikoto is a personal audio media library for local and remote audio works.

The project is now moving from design harness to implementation skeleton.

## Repository Layout

```text
frontend/   React PWA frontend
backend/    Go HTTP API, domain modules, SQLite migrations
config/     User-mounted configuration and SQLite database location
data/       User-mounted media library root
docs/       Product, architecture, and execution planning docs
harness/    Original design harness snapshot
scripts/    Utility scripts
```

## Local Development

Run the backend:

```sh
make backend-run
```

Run the frontend:

```sh
make frontend-dev
```

Run the Docker-first stack:

```sh
make docker-up
```

Run smoke validation:

```sh
make smoke
```

On Windows without `make`, run the same checks directly:

```powershell
cd frontend; npm install; npm run build; cd ..
docker run --rm -v "${PWD}\backend:/src" -w /src golang:1.22 go test ./...
docker compose build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-api.ps1
```

The default Docker mounts are:

- `./config:/config`
- `./data:/data`

`config/` and `data/` are intentionally ignored except for examples/placeholders.
