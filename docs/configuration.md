# Configuration

Kikoto is configured through environment variables and administrator settings.
Environment variables provide startup defaults. Settings exposes local scan
depth, cache options, and file source configuration in the UI.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIKOTO_HTTP_ADDR` | `127.0.0.1:7659` | Backend listen address. |
| `KIKOTO_DB_PATH` | `../config/kikoto.db` | SQLite database path. |
| `KIKOTO_DATA_ROOT` | `../data` | Local media library root. |
| `KIKOTO_CACHE_ROOT` | `../cache` | Runtime cache root, including cover images. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `4` | Maximum folder depth used by local scan code detection. |
| `KIKOTO_DEV_MODE` | `false` | When enabled, every request is authenticated as the configured root super administrator. |
| `KIKOTO_ROOT_USERNAME` | `root` | Root super administrator username created or updated at startup. |
| `KIKOTO_ROOT_PASSWORD` | `change-me` | Root super administrator password created or updated at startup. |
| `KIKOTO_REMOTE_SOURCES_ENABLED` | `false` | Enables first-run seeding of compatible remote sources from a mounted config file. |
| `KIKOTO_REMOTE_SOURCES_FILE` | `../config/remote-sources.yaml` | Path to the remote source seed file used only when seeding is enabled. |

## Docker Defaults

`docker-compose.yml` uses:

```text
KIKOTO_HTTP_ADDR=0.0.0.0:7659
KIKOTO_DB_PATH=/config/kikoto.db
KIKOTO_DATA_ROOT=/data
KIKOTO_CACHE_ROOT=/cache
KIKOTO_LOCAL_SCAN_DEPTH=4
KIKOTO_DEV_MODE=true
KIKOTO_ROOT_USERNAME=root
KIKOTO_ROOT_PASSWORD=change-me
KIKOTO_REMOTE_SOURCES_ENABLED=false
KIKOTO_REMOTE_SOURCES_FILE=/config/remote-sources.yml
```

Copy `.env.example` to `.env` for local overrides. `.env` is intentionally ignored by git.

In dev mode, the frontend opens as the root super administrator without a login step. With dev mode disabled, sign in with the configured root username and password.

## Administrator Settings

The Settings page currently manages:

- Local scan depth.
- Remote auto sync on user interest.
- Remote auto cache on play.
- Cache size limit.
- Remote fetch path template.
- Local and compatible remote file sources.

When automatic remote cache is enabled, automatic remote sync is also enabled
because caching requires stable local work and media item records first.

Remote sources can be seeded on first startup for container deployments. Keep
real source details in a mounted config file, not in `.env`. The repository
includes `config/remote-sources.example.yml` as a placeholder template:

```yaml
sources:
  - display_name: Example Source
    source_type: kikoeru_compatible
    enabled: true
    priority: 30
    api_url: https://example.invalid/api
    base_url: https://example.invalid
    fallback_url: ""
```

The seed is skipped when the database already has at least one compatible
remote source, so Settings remains the authority after first startup.

## Source Control Boundary

Do not commit runtime data:

- SQLite databases.
- Cached cover images.
- Local media files.
- Secrets or credentials.

Only examples, placeholders, source code, and public documentation belong in the repository.
