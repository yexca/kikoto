# Database

Kikoto uses SQLite for the current product stage.

## Migration Model

The current schema is stored under `backend/migrations/`. During early product
shaping, the initial schema may represent the full first-version database.

## Runtime Location

The default database path is:

```text
config/kikoto.db
```

In Docker, it is mounted at:

```text
/config/kikoto.db
```

## Backups

Stop the application or ensure no writes are in progress before copying the
SQLite database. Back up the cache and data directories separately if they are
important for your deployment.

## Related Docs

- [Data model](../architecture/data-model.md)
- [Migrations](../development/migrations.md)
- [Configuration](configuration.md)
