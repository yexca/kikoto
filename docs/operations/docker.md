# Docker

Kikoto is designed to run locally with Docker Compose.

## Default Stack

The production Compose file uses the published Docker Hub image and does not
require the source tree or a local image build:

Create a `.env` file beside `docker-compose.yml` with an explicit root
password:

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose pull
docker compose up -d
```

The production service uses `restart: unless-stopped`, so Docker restarts it
after process failures and host or daemon restarts unless it was explicitly
stopped.

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

## Demo Stack

Use `docker-compose.demo.yaml` for a public, read-only Demo deployment built
from the current source tree:

```sh
docker compose -f docker-compose.demo.yaml up -d --build
```

It listens on `http://127.0.0.1:7655` by default. Override the host port with
`KIKOTO_DEMO_PORT`. Set `KIKOTO_DEMO_REMOTE_SOURCES_ENABLED=true` only when the
isolated Demo configuration includes a sanitized `remote-sources.yml`.

The stack deliberately uses separate mounts:

- `./demo/config:/config`
- `./demo/cache:/cache`
- `./demo/data:/data:ro`

Put candidate folders containing a supported work code under `./demo/data`.
On every container start, the synchronous `demo_library_scan` workflow reuses
the local folder scanner, fetches current DLsite metadata, best-effort caches
the accepted covers, and indexes only works that are both all-ages and
permanently free. It never follows related editions or origin products during
this admission path. Adult, paid, temporary-free, unknown, duplicate, and
metadata-fetch-failed candidates are not admitted or indexed. Restart the
container after changing `./demo/data`; live filesystem watching remains
disabled.

`./demo/config` contains the isolated Demo SQLite database and optional source
seed file. `./demo/cache` contains only isolated or sanitized assets; startup
may add covers after the provider eligibility check. Never point a public Demo
deployment at production or personal runtime directories. The
service creates a reserved passwordless `__demo__` identity in the Demo
database and ignores supplied login sessions. That identity still reports only
library-read and playback permissions, but Demo GET/HEAD/OPTIONS requests may
read every administration, workflow, activity, source, and user surface so the
deployment can be demonstrated. Every non-read HTTP method is rejected before
the handler runs. The frontend exposes workflow editing and Fetch selection as
local previews; Save, Delete, Publish Fetch, health checks, and other writes
never reach the backend.

Stop it with:

```sh
docker compose -f docker-compose.demo.yaml down
```

## Runtime Data

Docker mounts may contain private media, SQLite databases, cached covers, and
source configuration. Keep them out of source control.

## Related Docs

- [Getting started](../getting-started.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
