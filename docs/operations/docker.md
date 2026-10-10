# Docker

Kikoto is designed to run locally with Docker Compose.

## Default Stack

The production Compose file uses the published Docker Hub image and does not
require the source tree or a local image build:

No `.env` file or password is required to start:

```sh
docker compose up -d
```

On first start, open the web app and create the administrator with the
one-time setup token from `docker compose logs kikoto` or
`config/setup-token`. See
[Administrator setup and recovery](security.md#administrator-setup-and-recovery),
which also covers resetting a forgotten password and defining the root account
in `.env` with `KIKOTO_ROOT_ACCOUNT_MODE=environment` instead.

The production service uses `restart: unless-stopped`, so Docker restarts it
after process failures and host or daemon restarts unless it was explicitly
stopped. These automatic restarts and `docker compose restart` reuse the current
container image. The stack leaves `pull_policy` unset, so `docker compose up -d`
uses Compose's default `missing` policy: it pulls images absent from the local
cache, and the `latest` tag is always pulled.
To upgrade a fixed version, change `KIKOTO_IMAGE` to the new tag or digest,
then run `docker compose up -d`.

It defaults to `yexca/kikoto:latest`, which is updated by the public release
workflow. The install and upgrade command above therefore selects the
latest public release. Override `KIKOTO_IMAGE` with a reviewed version or digest
when reproducible deployment is required:

```sh
KIKOTO_IMAGE=yexca/kikoto:0.1.1 docker compose up -d
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d
```

The container serves the web app and API together on port `7659`, and the
default Compose mapping publishes it as host port `7655` on every host
interface. For a
host-only instance, change it to `127.0.0.1:7655:7659`. Otherwise protect the
port with a host firewall, trusted VPN, or reverse proxy. Production requires
sign-in by default; enabling anonymous access under Settings -> Users intentionally
exposes Library and media reads to every client that can reach the port.

Default mounts:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

## Container Isolation

The production image runs as the container root user. Production and Demo
Compose drop all Linux capabilities, enable `no-new-privileges`, and use a
read-only root filesystem with a bounded writable `/tmp`.

Production Compose adds back `DAC_OVERRIDE` alone. Without it the container's
root user follows ordinary permission bits, so on a Linux host a mounted folder
that belongs to another user, such as an existing media library, is read-only
or unreadable, and deleting, Fetch, and scans of it fail with a permission
error. Demo adds no capability: give the root user (uid 0) write access to its
config and cache folders and read access to its data folder.

`/config`, `/cache`, and the production `/data` mount remain writable; durable
Fetch transaction directories stay on the target storage filesystem, and large
[temporary files](configuration.md#temporary-files) go to `/cache` rather than
`/tmp`. Demo keeps its data mount read-only. Limit host access to the
dedicated runtime mounts described above.

## Configure with `.env`

Copy [`.env.example`](../../.env.example) to `.env` beside `docker-compose.yml`,
or create one with only the settings you need. Run Compose from that directory.
Every variable in the production service's `environment` section supports
substitution from `.env`; an exported shell variable takes precedence. Unset or
empty values use the Compose defaults.

For example:

```dotenv
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
bind mounts. Keep the database and its backups under `/config`, durable media
and Fetch staging/backup/trash under `/data`, and disposable cache under
`/cache`. In storage pool mode, mount each disk or cloud drive at its own
first-level folder such as `/data/disk1`; Fetch then keeps its staging, backup,
and trash inside that pool, so a pool must be one filesystem that supports
renames. See [Storage pools](../user/en/getting-started.md#storage-pools). Keep
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

Back up `config/` before upgrading. Keep the existing `data/` mount in place;
the version upgrade does not require copying it. For a live SQLite database,
follow the consistent backup guidance in [Database](database.md#backups).
Then refresh the configured image and recreate the service:

```sh
docker compose up -d
```

For a fixed version, update `KIKOTO_IMAGE` before running `up`. If you
intentionally reuse a mutable non-`latest` tag, pull and recreate as separate
steps:

```sh
docker compose pull
docker compose up -d
```

Recreating or stopping the container sends `SIGTERM`. Kikoto then drains
requests and returns running workflow jobs to the queue before it exits. The
Compose files set `stop_grace_period: 30s`, longer than the default
`KIKOTO_SHUTDOWN_TIMEOUT_SECONDS=20`; keep that order if you change either value
or run the image under another orchestrator. Docker's default 10-second grace
period can kill the process before the drain finishes, and the interrupted work
is then recovered at the next start.

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

It publishes host port `7655` on every host interface by default, so open
`http://127.0.0.1:7655` locally. Override the host port with
`KIKOTO_DEMO_PORT`. Demo never seeds or contacts a real remote source:
`KIKOTO_REMOTE_SOURCES_ENABLED` and `remote-sources.yml` are ignored in Demo
mode.

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
Provider eligibility is verified at startup; a continuously running Demo does
not automatically revalidate a provider's later age or price changes.

After that scan, Demo replaces any remote source in its database with one
simulated Kikoeru-compatible source named Remote Kikoeru at the reserved
`https://remote-kikoeru.invalid` endpoint. On every start it randomly selects
half of the admitted local works, up to 24, as that source's catalog, and up to
four of those for the Library's Tracked tab. The remaining admitted works are
recorded as not found on the source. Browsing, work details, directory trees,
and playback for Remote Kikoeru run through the normal remote-source code path,
but an in-process transport answers them from the admitted local files and
refuses every other destination, so no request leaves the container. The
Library shows a notice above the source stating that it is simulated and not a
real server. Demo also refreshes a completed example
for each workflow, plus one running and three attention-needed examples with
illustrative jobs. These Activity details are synthetic; no example job is
executed. The running example has no live elapsed-time clock or job event
stream, so it can remain visible during a long-lived Demo deployment. Actual
`demo_library_scan` runs stay in the isolated database
but are not exposed through the public workflow-run API. Repeated starts replace
the examples and remove Tracked examples that no longer pass admission.

`./demo/config` contains the isolated Demo SQLite database. `./demo/cache` contains only isolated or sanitized assets; startup
may add covers after the provider eligibility check. Never point a public Demo
deployment at production or personal runtime directories. The
service creates a reserved passwordless `__demo__` identity in the Demo
database and ignores supplied login sessions. That identity still reports only
library-read and playback permissions, but Demo GET/HEAD/OPTIONS requests may
read every administration, workflow, activity, source, and user surface so the
deployment can be demonstrated. Mutation requests are rejected before the
handler runs; the remote recommendation POST only computes read-only
[simulated scores](../architecture/data-model.md#recommendation-catalog-and-generations).
The frontend exposes workflow editing and Fetch selection as
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
