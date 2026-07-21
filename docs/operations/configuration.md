# Configuration

Kikoto is configured through environment variables and administrator settings.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIKOTO_HTTP_ADDR` | `127.0.0.1:7659` | Backend listen address. |
| `KIKOTO_DB_PATH` | `../config/kikoto.db` | SQLite database path. |
| `KIKOTO_DATA_ROOT` | `../data` | Local media library root. |
| `KIKOTO_CACHE_ROOT` | `../cache` | Runtime cache root. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `4` | Maximum local scan folder depth. |
| `KIKOTO_MODE` | `production` | Runtime mode: `development` authenticates as root, `production` uses normal authentication, and `demo` exposes a read-only root session with all-ages permanently-free content filtering. |
| `KIKOTO_SESSION_COOKIE_SECURE` | `false` | Add the Secure attribute to session cookies. |
| `KIKOTO_ROOT_USERNAME` | `root` | Root administrator username. |
| `KIKOTO_ROOT_PASSWORD` | `change-me` | Root administrator password. |
| `KIKOTO_REMOTE_SOURCES_ENABLED` | `false` | Enable first-run remote source seeding. |
| `KIKOTO_REMOTE_SOURCES_FILE` | `../config/remote-sources.yaml` | Remote source seed file. |

## Administrator Settings

The Settings page manages local scan depth, cache behavior, remote request
pacing, DLsite metadata language, file sources, and circle auto-refresh.

See [Settings](../product/settings.md) for user-visible behavior.

## Remote Source Seeds

Remote sources can be seeded on first startup from a mounted file when
`KIKOTO_REMOTE_SOURCES_ENABLED=true`. Keep real source details in the mounted
configuration file, not in the repository.

After first startup, Settings is the source of truth for configured sources.

Demo mode does not recover or dispatch workflow jobs, and its HTTP API rejects
all non-read methods. The frontend keeps administrative data inspectable while
disabling settings, workflow, schedule, run, and review mutations.

## Source Control Boundary

Do not commit runtime databases, cached covers, local media, real source URLs,
credentials, or personal data.

## Related Docs

- [Docker](docker.md)
- [Security](security.md)
- [Sources](../product/sources.md)
