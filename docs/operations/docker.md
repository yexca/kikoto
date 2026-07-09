# Docker

Kikoto is designed to run locally with Docker Compose.

## Default Stack

```sh
docker compose up -d --build
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
needs development-oriented bind mounts or commands.

## Runtime Data

Docker mounts may contain private media, SQLite databases, cached covers, and
source configuration. Keep them out of source control.

## Related Docs

- [Getting started](../getting-started.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
