# Docker

Kikoto is designed to run locally with Docker Compose.

## Default Stack

The production Compose file uses the published Docker Hub image and does not
require the source tree or a local image build:

```sh
docker compose pull
docker compose up -d
```

It defaults to `yexca/kikoto:latest`. Override `KIKOTO_IMAGE` to use a pinned
release or GitHub Container Registry:

```sh
KIKOTO_IMAGE=yexca/kikoto:0.1.1 docker compose up -d
KIKOTO_IMAGE=ghcr.io/yexca/kikoto:latest docker compose up -d
```

Default ports:

- Frontend: `7655`
- Backend: `7659`

Default mounts:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

## Development Stack

Use `docker-compose.dev.yml` when working on local development behavior that
needs local builds:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

## Runtime Data

Docker mounts may contain private media, SQLite databases, cached covers, and
source configuration. Keep them out of source control.

## Related Docs

- [Getting started](../getting-started.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
