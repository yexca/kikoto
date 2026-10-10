# Configuration

Kikoto is configured through environment variables and administrator settings.

## Environment Variables

The defaults below apply to direct backend runs. The production Compose stack
accepts these variables from a `.env` file beside `docker-compose.yml` and uses
container-specific address and path defaults, including `/app/static` for the
bundled frontend. See [Configure with `.env`](docker.md#configure-with-env) and
[`.env.example`](../../.env.example). After changes, run `docker compose up -d`
to recreate the service with the new values; `docker compose restart` alone
does not update its environment.

| Variable | Default | Description |
| --- | --- | --- |
| `KIKOTO_HTTP_ADDR` | `127.0.0.1:7659` | Backend listen address. |
| `KIKOTO_DB_PATH` | `../config/kikoto.db` | SQLite database path. |
| `KIKOTO_DB_BACKUP_DIR` | `backups` beside the database | Verified database backups; see [Database backups](database.md#backups). Direct backend runs only: the Compose stacks do not pass it, so the container always uses `/config/backups`. |
| `KIKOTO_DATA_ROOT` | `../data` | Local media library root. |
| `KIKOTO_CACHE_ROOT` | `../cache` | Runtime cache root. It also holds [temporary files](#temporary-files). |
| `KIKOTO_STATIC_DIR` | Empty | Frontend asset directory; empty disables static file serving. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `3` | Maximum local scan folder depth. |
| `KIKOTO_MODE` | `production` | Runtime mode: `development` authenticates as root and creates a fresh database from the development baseline in `backend/migrations/compat/` when one is packaged (see [Migrations](../development/migrations.md)), `production` uses normal authentication, and `demo` uses a restricted passwordless Demo identity with content filtering. |
| `KIKOTO_SESSION_COOKIE_SECURE` | `false` | Add the Secure attribute to session cookies. |
| `KIKOTO_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins allowed to call a separately hosted API. Same-origin deployments should leave this empty. |
| `KIKOTO_TRUSTED_PROXIES` | Empty | Comma-separated reverse-proxy IP addresses or CIDR prefixes whose `X-Forwarded-For` header identifies the client for sign-in throttling. Empty uses the direct peer address. An invalid entry stops startup. |
| `KIKOTO_HOST_PROXY_HOST` | Detected | Hostname or IP address a **Local machine** outbound proxy connects to. Empty uses `host.docker.internal` inside a container, which the Compose files map to the Docker host gateway, and `127.0.0.1` otherwise. The settings page shows this address but cannot change it. An invalid value stops startup. |
| `KIKOTO_LOGIN_CONCURRENCY` | `8` | Maximum concurrent password checks for sign-ins, password changes, and new passwords. Each check uses about 19 MiB of memory; a missing, invalid, or non-positive value uses the default. |
| `KIKOTO_SHUTDOWN_TIMEOUT_SECONDS` | `20` | Seconds a stop may spend draining in-flight requests and releasing running workflow jobs. Streaming playback and live transcoding are cancelled after half of this time. Keep it below the container stop grace period; a missing, invalid, or non-positive value uses the default. |
| `KIKOTO_ROOT_ACCOUNT_MODE` | `setup` | `setup` creates the first administrator in the web app with a setup token. `environment` makes `KIKOTO_ROOT_USERNAME` and `KIKOTO_ROOT_PASSWORD` define the root account on every start and locks it in the app. Any other value stops startup. See [Administrator setup and recovery](security.md#administrator-setup-and-recovery). |
| `KIKOTO_ROOT_USERNAME` | Empty | Root account username (`root` when empty) for environment mode and the account development mode authenticates as. In setup mode it selects the account an environment password reset targets; empty uses the initial administrator, and startup stops when none is recorded. Only `root` is created when missing. |
| `KIKOTO_ROOT_PASSWORD` | Empty | Required in environment mode, where it is the root password. In setup mode it is used only by `KIKOTO_ROOT_PASSWORD_RESET`. |
| `KIKOTO_ROOT_PASSWORD_RESET` | `false` | Setup mode only: apply `KIKOTO_ROOT_PASSWORD` to the administrator on startup, once per username and password. Ignored with a warning in environment mode. An unrecognized value stops startup. |
| `KIKOTO_REMOTE_SOURCES_ENABLED` | `false` | Enable first-run remote source seeding. |

## Temporary Files

Large temporary files live in `.kikoto-tmp` inside the cache root, not in the
system temporary directory:

- An uploaded Kikoeru database, for the duration of its import request.
- The working files SQLite writes while it compacts the database, builds an
  index, or sorts more than its page cache holds. Compaction needs free space
  on the cache volume of about the database size.

Startup empties `.kikoto-tmp`, so a file left by an interrupted run does not
outlive the next start. When the cache root cannot hold the directory, startup
logs a warning and these files use the system temporary directory, which the
Compose stacks bound to a 64 MiB in-memory `/tmp`.

## Administrator Settings

Administrators manage the instance from the administration tabs in Settings:

- **Library**: library storage, local scan depth, creator catalog freshness,
  Kikoeru import address policy, and remote file sources with their fallback
  languages. A saved scan depth (1–8) overrides `KIKOTO_LOCAL_SCAN_DEPTH`,
  which is only the default.
- **Cache & Fetch**: playback and transcode cache limits, the remote per-file
  download limit, failed Fetch staging retention, and remote download pacing.
- **Proxy**: outbound proxies and their scopes.
- **Cleanup**: cache cleanup and database backups.
- **Users**: accounts and production instance access.

There is no instance-wide metadata language.

Each signed-in user may choose an own preferred metadata language in the
header account menu. Users who do not, anonymous visitors, stored titles and
tag names, and background work use each work's original language. A request
to a remote source on behalf of a user with a preferred language sends
`Accept-Language` with that user's languages first and the source's fallback
language (`request_language` in a source seed, default `ja-JP`) last; users
without a preference, anonymous visitors, and background jobs send the fallback
language alone. It is a hint only; the upstream service may ignore it, fall
back, or return mixed-language metadata.

Production anonymous access is an SQLite-backed instance setting rather than an
environment variable. It defaults to disabled. A super administrator can
enable read-only Library browsing and playback under
`Settings -> Users -> Instance access`;
the change applies immediately in production and is audited. Development shows
and saves the same option so its automatic root identity can inspect every
production administration surface, but all development requests remain
authenticated as root. Demo mode does not expose or use the option.

See [Settings](../user/en/settings.md) for user-visible behavior.

## Remote Source Seeds

Remote sources can be seeded on first startup from
`config/remote-sources.yml` when `KIKOTO_REMOTE_SOURCES_ENABLED=true`. Compose
mounts that file at `/config/remote-sources.yml`; direct backend runs also check
`../config/remote-sources.yml` and the legacy `.yaml` extension. Keep real
source details in the mounted configuration file, not in the repository. Demo
mode ignores the seed file and simulates its only remote source from admitted
local works; see [Demo Stack](docker.md#demo-stack).

Set `api_url` to the upstream service base URL, such as
`https://example.invalid`. The client appends paths such as `/api/health` and
`/api/works`, so including a trailing `/api` would produce `/api/api/...`.

After first startup, Settings is the source of truth for configured sources.

Demo mode does not bootstrap or expose the root identity, recover or dispatch
workflow jobs, or accept supplied sessions. Its HTTP API rejects mutation
requests, and the Demo identity has only library-read and playback permissions.
The read-only remote recommendation POST uses
[simulated scores](../architecture/data-model.md#recommendation-catalog-and-generations).
Read requests are nevertheless allowed through administration, workflow,
activity, source, and user surfaces so the isolated deployment can be shown;
the frontend keeps those controls read-only and all writes are rejected before
handlers run. Startup initializes the current system workflow definitions for
read-only inspection, but synchronously runs only the dedicated
`demo_library_scan` workflow. That workflow scans the Demo data root, verifies each
candidate against DLsite, and stores local works and media only when the
provider reports both all-ages and permanently free metadata. Unknown, failed,
adult, paid, and temporary-free candidates are discarded. Provider-declared
language editions are fetched with their own locale and are stored only after
passing that policy independently; they do not receive local media unless their
own folder is discovered. The Demo workflow does not follow origin/base links
or recurse through language-edition responses. Compatible remote sources are
authoritative for the mandatory
`$age:general$ $-price:1$` query contract.

## Source Control Boundary

Do not commit runtime databases, cached covers, local media, real source URLs,
credentials, or personal data.

## Related Docs

- [Docker](docker.md)
- [Security](security.md)
- [Sources](../user/en/sources.md)
