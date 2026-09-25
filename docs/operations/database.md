# Database

Kikoto uses SQLite for the current product stage.

## Migration Model

The current schema is stored under `backend/migrations/`. Numbered migrations
are immutable after release and are applied in a contiguous order. The backend
embeds the numbered catalog and the optional generated baseline into the
executable; production containers do not depend on a migrations directory
being mounted beside the binary.

On an empty database, startup uses the highest-version packaged baseline (the
release suffix may belong to an earlier application release when no numbered
SQL changed) and then applies any newer numbered files. On an existing
database, startup validates
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

## Connection Settings

The file-backed pool opens at most four connections. Every connection applies:

| Pragma | Value | Purpose |
| --- | --- | --- |
| `foreign_keys` | `1` | Enforce declared references. |
| `journal_mode` | `WAL` | Let readers continue while one writer commits. |
| `busy_timeout` | `5000` ms | Wait briefly for a competing writer. |
| `synchronous` | `NORMAL` | Sync at WAL checkpoints rather than every commit. |
| `cache_size` | `-16000` (about 16 MiB) | Page cache per connection, about 64 MiB in total. |
| `mmap_size` | 256 MiB | Memory-mapped reads per connection; address space, not resident memory. |

With WAL, `synchronous=NORMAL` keeps the database consistent after an
application or operating-system crash. A power loss can roll back only the most
recently committed transactions. An in-memory database uses one connection and
the same settings where they apply.

## Maintenance

Settings -> Cleanup lists the record types that the database cleanup can
remove. Manual cleanup runs after confirmation and writes a `database.cleanup`
audit entry.

Two of those tasks also run automatically: expired sessions and old workflow
runs. The workflow coordinator runs them two minutes after startup and then
every 24 hours, with the same retention rules as the manual task. An old run is
kept while a Fetch record, review candidate, metadata issue, or cleanup
provenance still refers to it, and the latest run of each workflow is always
kept. Automatic cleanup writes its results to the server log instead of the
audit log. Sessions are also rejected and removed when an expired one is
presented.

**Compact database** queues a `database_optimize` workflow run and returns
`202 Accepted` with its run ID. Only one optimization can be queued or running;
a repeated request returns the active run. The workflow executor then runs
`VACUUM`, `PRAGMA optimize`, and a truncating WAL checkpoint. The run appears in
Activity. On completion, the run summary and a `database.optimize` audit entry
record the database size before and after compaction.

`VACUUM` still holds the write lock while it rewrites the file. Other writes
wait for the busy timeout and may fail during a long compaction, so run it
when the instance is quiet. The job is not resumed after a restart: an
interrupted optimization fails and can be started again.

## Backups

Kikoto writes verified database backups to `KIKOTO_DB_BACKUP_DIR`, which
defaults to a `backups` directory beside the database (`/config/backups` in
Docker). Backups stay on the durable configuration volume, never in the
disposable cache or the media library. Each backup is written with
`VACUUM INTO` from one consistent snapshot, checked with `PRAGMA quick_check`,
restricted to its owner, and only then renamed to its final name, so a listed
backup is always complete.

| Kind | When | Kept |
| --- | --- | --- |
| `pre-migration` | At startup, before the first pending numbered migration of an existing database | 3 |
| `scheduled` | By the workflow coordinator when the newest routine backup is older than 24 hours, checked hourly | 7 |
| `manual` | **Back up now** in Settings -> Cleanup (`POST /api/maintenance/database/backups`) | 5 |

A fresh install and an up-to-date database start without a pre-migration
backup. Because numbered migrations cannot be reverted, startup stops without
changing the schema when the pre-migration backup fails; free space or point
`KIKOTO_DB_BACKUP_DIR` at a writable directory and start again. Routine
backups run as `database_backup` workflow runs and appear in Activity; a
manual backup also writes a `database.backup` audit entry. Only one backup can
be queued or running. Settings lists backup names, kinds, sizes, and times
without revealing the backup directory. An in-memory or URI-configured
database has no backup directory and is not backed up.

Backups contain password hashes and sessions; protect them like the database.
They share the database's disk, so copy them to another disk or host to
survive a drive failure.

To restore, stop Kikoto, move `kikoto.db`, `kikoto.db-wal`, and
`kikoto.db-shm` aside, copy the chosen backup to `kikoto.db`, and start the
application image whose schema matches it. A pre-migration backup matches the
release before the upgrade named in its file name (`v038-to-v039`, for
example). Back up the cache and data directories separately if they are
important for your deployment.

If startup reports a dirty or checksum-mismatch state, do not delete
`schema_migration` or `schema_state` to force progress: restore the backup or
use the compatible binary, then inspect the protected logs and retry the
recorded migration.

## Related Docs

- [Data model](../architecture/data-model.md)
- [Migrations](../development/migrations.md)
- [Configuration](configuration.md)
