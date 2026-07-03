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
| `KIKOTO_CACHE_ROOT` | `../config/cached` | Runtime cache root, including cover images. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `2` | Maximum folder depth used by local scan code detection. |
| `KIKOTO_DEV_MODE` | `false` | When enabled, every request is authenticated as the configured root super administrator. |
| `KIKOTO_ROOT_USERNAME` | `root` | Root super administrator username created or updated at startup. |
| `KIKOTO_ROOT_PASSWORD` | `change-me` | Root super administrator password created or updated at startup. |

## Docker Defaults

`docker-compose.yml` uses:

```text
KIKOTO_HTTP_ADDR=0.0.0.0:7659
KIKOTO_DB_PATH=/config/kikoto.db
KIKOTO_DATA_ROOT=/data
KIKOTO_CACHE_ROOT=/config/cached
KIKOTO_LOCAL_SCAN_DEPTH=2
KIKOTO_DEV_MODE=true
KIKOTO_ROOT_USERNAME=root
KIKOTO_ROOT_PASSWORD=change-me
```

Copy `.env.example` to `.env` for local overrides. `.env` is intentionally ignored by git.

In dev mode, the frontend opens as the root super administrator without a login step. With dev mode disabled, sign in with the configured root username and password.

## Administrator Settings

The Settings page currently manages:

- Local scan depth.
- Cache enabled state.
- Cache size limit.
- Local and Kikoeru-compatible file sources.

## Source Control Boundary

Do not commit runtime data:

- SQLite databases.
- Cached cover images.
- Local media files.
- Secrets or credentials.

Only examples, placeholders, source code, and public documentation belong in the repository.
