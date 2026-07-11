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

## Concurrency

SQLite connections use an immediate lock for explicit write transactions. A
writer therefore waits before establishing a read snapshot, avoiding failed
snapshot-to-write upgrades under concurrent workflow, heartbeat, and request
traffic.

Keep network requests and other slow I/O outside database transactions. Read
endpoints should not reconcile metadata on every request; required indexing or
sync writes belong at an explicit ingestion boundary. Busy timeouts are a
fallback, not a substitute for short and intentional write transactions.

## Backups

Prefer SQLite's backup mechanism for a live database. If copying the database
file directly, stop the application first so that the database and any WAL
state form a consistent snapshot. Back up the cache and data directories
separately if they are important for your deployment.

## Related Docs

- [Data model](../architecture/data-model.md)
- [Migrations](../development/migrations.md)
- [Configuration](configuration.md)
