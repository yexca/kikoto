# Database

Kikoto uses SQLite for the current product stage.

## Migration Model

The current schema is stored under `backend/migrations/`. Numbered migrations
are immutable after release and are applied in a contiguous order. The backend
embeds the numbered catalog and the optional generated baseline into the
executable; production containers do not depend on a migrations directory
being mounted beside the binary.

On an empty database, startup uses the generated
`migrations/baseline/<schema-version>_v<release>.sql` snapshot and then applies
any newer numbered files. On an existing database, startup validates
`schema_migration` and applies only the next numbered files so user data and
backfills are preserved. The `schema_state` row records the schema version
separately from the application version. It also records a SHA-256 baseline
checksum, a dirty migration after an interrupted attempt, and the last
application version that completed startup.

The manager refuses to continue when an applied migration's checksum differs,
when the database contains a future schema, or when application tables exist
without migration history. A failed migration leaves a dirty marker and is
retryable after the underlying SQL or environment is repaired. See
[Migrations](../development/migrations.md) for the chain and release rules.

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

Before upgrading a production instance, make a consistent SQLite backup and
keep the previous application image available. If startup reports a dirty or
checksum-mismatch state, do not delete `schema_migration` or `schema_state` to
force progress: restore the backup or use the compatible binary, then inspect
the protected logs and retry the recorded migration.

## Related Docs

- [Data model](../architecture/data-model.md)
- [Migrations](../development/migrations.md)
- [Configuration](configuration.md)
