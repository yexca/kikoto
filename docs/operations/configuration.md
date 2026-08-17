# Configuration

Kikoto is configured through environment variables and administrator settings.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIKOTO_HTTP_ADDR` | `127.0.0.1:7659` | Backend listen address. |
| `KIKOTO_DB_PATH` | `../config/kikoto.db` | SQLite database path. |
| `KIKOTO_DATA_ROOT` | `../data` | Local media library root. |
| `KIKOTO_CACHE_ROOT` | `../cache` | Runtime cache root. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `3` | Maximum local scan folder depth. |
| `KIKOTO_MODE` | `production` | Runtime mode: `development` authenticates as root, `production` uses normal authentication, and `demo` uses a restricted passwordless Demo identity with content filtering. |
| `KIKOTO_SESSION_COOKIE_SECURE` | `false` | Add the Secure attribute to session cookies. |
| `KIKOTO_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins allowed to call a separately hosted API. Same-origin deployments should leave this empty. |
| `KIKOTO_ROOT_USERNAME` | `root` | Root administrator username. |
| `KIKOTO_ROOT_PASSWORD` | Required in production | Authoritative root administrator password. A changed value is applied on service startup and revokes existing root sessions. |
| `KIKOTO_REMOTE_SOURCES_ENABLED` | `false` | Enable first-run remote source seeding. |
| `KIKOTO_REMOTE_SOURCES_FILE` | `../config/remote-sources.yaml` | Remote source seed file. |

## Administrator Settings

Maintenance manages local scan depth, cache behavior, the remote per-file
download limit, failed Fetch staging retention, remote request pacing, DLsite
metadata language priority, file sources and their request-language hints,
creator catalog freshness, and production instance access. A remote source
request language is sent as a hint only; the upstream service may ignore it,
fall back, or return mixed-language metadata.

Production anonymous access is an SQLite-backed instance setting rather than an
environment variable. It defaults to disabled. A super administrator can
enable read-only Library browsing and playback under `Maintenance -> Access`;
the change applies immediately in production and is audited. Development shows
and saves the same option so its automatic root identity can inspect every
production administration surface, but all development requests remain
authenticated as root. Demo mode does not expose or use the option.

See [Settings](../product/settings.md) for user-visible behavior.

## Remote Source Seeds

Remote sources can be seeded on first startup from a mounted file when
`KIKOTO_REMOTE_SOURCES_ENABLED=true`. Keep real source details in the mounted
configuration file, not in the repository.

After first startup, Settings is the source of truth for configured sources.

Demo mode does not bootstrap or expose the root identity, recover or dispatch
workflow jobs, or accept supplied sessions. Its HTTP API rejects all non-read
methods, and the Demo identity has only library-read and playback permissions.
Read requests are nevertheless allowed through administration, workflow,
activity, source, and user surfaces so the isolated deployment can be shown;
the frontend keeps those controls read-only and all writes are rejected before
handlers run. It synchronously runs only the dedicated `demo_library_scan`
workflow at startup. That workflow scans the Demo data root, verifies each
candidate against DLsite, and stores local works and media only when the
provider reports both all-ages and permanently free metadata. Unknown, failed,
adult, paid, and temporary-free candidates are discarded. Compatible remote
sources are authoritative for the mandatory
`$age:general$ $-price:1$` query contract.

## Source Control Boundary

Do not commit runtime databases, cached covers, local media, real source URLs,
credentials, or personal data.

## Related Docs

- [Docker](docker.md)
- [Security](security.md)
- [Sources](../product/sources.md)
