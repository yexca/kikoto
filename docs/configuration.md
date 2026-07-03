# Configuration

Kikoto is configured through environment variables in the current implementation. `config/app.example.yaml` documents the equivalent intended shape for file-based configuration.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIKOTO_HTTP_ADDR` | `127.0.0.1:7659` | Backend listen address. |
| `KIKOTO_DB_PATH` | `../config/kikoto.db` | SQLite database path. |
| `KIKOTO_DATA_ROOT` | `../data` | Local media library root. |
| `KIKOTO_CACHE_ROOT` | `../config/cached` | Runtime cache root, including cover images. |
| `KIKOTO_LOCAL_SCAN_DEPTH` | `2` | Maximum folder depth used by local scan code detection. |

## Docker Defaults

`docker-compose.yml` uses:

```text
KIKOTO_HTTP_ADDR=0.0.0.0:7659
KIKOTO_DB_PATH=/config/kikoto.db
KIKOTO_DATA_ROOT=/data
KIKOTO_CACHE_ROOT=/config/cached
KIKOTO_LOCAL_SCAN_DEPTH=2
```

## Source Control Boundary

Do not commit runtime data:

- SQLite databases.
- Cached cover images.
- Local media files.
- Secrets or credentials.

Only examples, placeholders, source code, and public documentation belong in the repository.
