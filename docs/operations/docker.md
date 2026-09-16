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
docker compose up -d --pull always
```

The production service uses `restart: unless-stopped`, so Docker restarts it
after process failures and host or daemon restarts unless it was explicitly
stopped. These automatic restarts and `docker compose restart` reuse the current
container image. The stack leaves `pull_policy` unset, so `docker compose up -d`
uses Compose's default `missing` policy: it pulls images absent from the local
cache, and the `latest` tag is always pulled.
Run `docker compose up -d --pull always` to refresh a fixed tag as well.

It defaults to `yexca/kikoto:latest`, which is updated by the public release
workflow. The explicit install and upgrade command above therefore selects the
latest public release. Override `KIKOTO_IMAGE` with a reviewed version or digest
when reproducible deployment is required:

```sh
KIKOTO_IMAGE=yexca/kikoto:0.1.1 docker compose up -d --pull always
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

Default ports:

- Frontend: `7655`
- Backend: `7659`

The default Compose mapping publishes `7655` on every host interface. For a
host-only instance, change it to `127.0.0.1:7655:7659`. Otherwise protect the
port with a host firewall, trusted VPN, or reverse proxy. Production requires
sign-in by default; enabling anonymous access under Maintenance intentionally
exposes Library and media reads to every client that can reach the port.

Default mounts:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

## Configure with `.env`

Copy [`.env.example`](../../.env.example) to `.env` beside `docker-compose.yml`,
or add only the settings you need to the password-only file above. Run Compose
from that directory. Every variable in the production service's `environment`
section supports substitution from `.env`; an exported shell variable takes
precedence. Unset or empty optional values use the Compose defaults, while an
unset or empty `KIKOTO_ROOT_PASSWORD` stops Compose with an error.

For example:

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
KIKOTO_ROOT_USERNAME=admin
KIKOTO_LOCAL_SCAN_DEPTH=5
KIKOTO_DB_PATH=/config/library.db
```

The [configuration reference](configuration.md#environment-variables) describes
runtime settings. The production stack uses these deployment defaults:

| Variable | Production Compose default |
| --- | --- |
| `KIKOTO_IMAGE` | `yexca/kikoto:latest` |
| `KIKOTO_HTTP_ADDR` | `0.0.0.0:7659` |
| `KIKOTO_DB_PATH` | `/config/kikoto.db` |
| `KIKOTO_DATA_ROOT` | `/data` |
| `KIKOTO_CACHE_ROOT` | `/cache` |
| `KIKOTO_STATIC_DIR` | `/app/static` |

Path variables refer to paths **inside the container** and do not change host
bind mounts. Keep the database under `/config`, durable media and Fetch
staging/backup/trash under `/data`, and disposable cache under `/cache`. Keep
`KIKOTO_STATIC_DIR=/app/static` to use the bundled frontend; a custom directory
must contain its replacement assets. If you change a container mount path or
the HTTP listen port, update `volumes` or `ports` in Compose to match. Changing a
path does not move existing data.

After editing `.env`, validate and apply the configuration:

```sh
docker compose config --quiet
docker compose up -d
```

`docker compose restart` does not apply changed environment variables. To apply
configuration while reusing an already installed image, use
`docker compose up -d --pull never`.

## Upgrade

Back up `config/` and `data/` before upgrading. For a live SQLite database,
follow the consistent backup guidance in [Database](database.md#backups).
Then refresh the configured image and recreate the service:

```sh
docker compose up -d --pull always
```

For tags other than `latest`, an ordinary `up` reuses a cached image. To pull and
recreate as separate steps:

```sh
docker compose pull
docker compose up -d
```

## Development Stack

Use `deploy/compose/dev.yml` when working on local development behavior that
needs local builds. Run this command from the repository root, or use
`make docker-up`:

```sh
docker compose --project-directory . -f deploy/compose/dev.yml up -d --build
```

Keep `--project-directory .` in direct Compose commands. It preserves the root
`.env` lookup, build contexts, default project name, and relative host mounts
even though the Compose file lives under `deploy/compose/`. The Makefile's
development and smoke targets set the project directory automatically.

## Demo Stack

Use `deploy/compose/demo.yml` for a public, read-only Demo deployment. It
pulls `yexca/kikoto:latest` by default. Run these commands from the repository root:

```sh
docker compose --project-directory . -f deploy/compose/demo.yml pull
docker compose --project-directory . -f deploy/compose/demo.yml up -d
```

Set `KIKOTO_DEMO_IMAGE` to a reviewed version or digest when reproducibility is
required.

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
permanently free. It also collects provider-declared language-edition metadata
only after each edition independently passes the same policy; a language
sibling reached from another folder remains metadata-only, and only a
discovered local folder receives local media records. The workflow never
follows origin or base-product links and never recurses through a sibling
response. Adult, paid, temporary-free, unknown, duplicate, and
metadata-fetch-failed candidates or language editions are not admitted or
indexed. Restart the container after changing `./demo/data`; live filesystem
watching remains disabled.

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
docker compose --project-directory . -f deploy/compose/demo.yml down
```

## Runtime Data

Docker mounts may contain private media, SQLite databases, cached covers, and
source configuration. Keep them out of source control.

## Related Docs

- [Getting started](../user/en/getting-started.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
