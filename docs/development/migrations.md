# Migrations

Database migrations live in `backend/migrations/`. The backend embeds the
numbered files, `baseline/`, and `compat/` into the executable, so a production
container needs no separate migrations mount. Runtime location, backups, and restore are
in [Database](../operations/database.md).

## Numbered Chain

The numbered files form one contiguous, three-digit chain:

```text
001_initial.sql
002_v0_1_1.sql
003_*.sql
...
```

Filenames match `NNN_<lowercase_words>.sql`. The highest numbered file is the
current schema version. The root `VERSION` file is the application release;
the two are independent, and a release that adds no numbered SQL keeps the
previous schema version.

- A numbered file is immutable once released. A schema change adds the next
  number after the highest file present. A collision between unreleased
  branches is resolved by renumbering the unreleased file, never by editing a
  released one.
- The catalog is rejected at startup when it has a gap, two files with the
  same version, an empty file, or a filename that does not match the pattern.
- A checksum is the SHA-256 of the file after CRLF and lone CR are normalized
  to LF, so a checkout's line endings never change it.

The `schema_migration` ledger holds one row per applied file: filename,
version, checksum, the application version that applied it, duration in
milliseconds, and commit time. On every start, before any new SQL runs, the
ledger must satisfy all of these:

- Every filename is known to the running catalog: a packaged numbered file, a
  baseline the mode reads, or a retained checksum-only baseline entry (see
  [Accepted And Refused Ledgers](#accepted-and-refused-ledgers)).
- Every recorded checksum matches the catalog's checksum for that filename.
- Each version appears once, and at most one row is a baseline.
- Rows are contiguous from the baseline row, or from `001` when the ledger has
  no baseline.

A ledger row without a version or checksum is filled in from the catalog and
its application version is recorded as `legacy`.

### Adding A Migration

1. Inspect `VERSION`, the highest numbered file, and the files in
   `backend/migrations/baseline/` and `backend/migrations/compat/`.
2. Add `NNN_<description>.sql` with the next number. The manager runs the file
   inside its own transaction, so the file contains no transaction control
   statements. Keep the SQL deterministic and make data backfills idempotent
   where a retry can reach them.
3. Keep the change aligned with the unified work model and the source and
   metadata boundaries, and update [Data model](../architecture/data-model.md)
   when schema meaning changes.
4. Regenerate the development baseline with `go generate ./migrations` (see
   [Baseline Generation](#baseline-generation)).
5. Add a storage regression test for user-visible behavior or a recovery
   invariant. `TestMigrateBaselineMatchesCompleteIncrementalChain` must pass:
   in production and in development mode, the selected baseline and the
   complete numbered chain produce the same schema and seed rows.

## Fresh Installs And Upgrades

The single-row `schema_state` table records the current schema version, the
baseline version and checksum (if the database started from one), a dirty
version, the application version of the last migration, and the last
application version that completed startup.

| Database state | Action |
| --- | --- |
| Empty SQLite database | Apply the highest-version baseline the mode reads (see [Selection And Retention](#selection-and-retention)), then any numbered migrations after that version. |
| Existing database with migration history | Validate the ledger and apply only the next numbered migrations. User data is never reconstructed from the baseline. |
| Application tables without migration history | Stop and require an operator decision; the manager never infers a version. |
| Dirty migration from an interrupted/failed start | Retry that exact version after the SQL or environment is repaired. |
| Future schema version | Stop and ask for a compatible/newer binary. |

Before the first numbered migration runs on an existing database, startup runs
an upgrade hook. It writes a pre-migration backup when the database has a
backup directory (see [Database](../operations/database.md)) and, for a
database below schema 035, preserves user-authored workflow definitions for
review (see [Preset Workflows](../architecture/workflows.md#preset-workflows)).
A hook failure stops startup before the schema changes. The hook does not run
for an empty database.

Each migration's SQL, a foreign-key check, the ledger row, and the
schema-state advance commit in one SQLite transaction. The state is marked
dirty before the transaction starts. A failed statement rolls back the schema
and ledger but leaves the dirty marker, so the failure is visible and the same
version is retried on the next start. Another
foreign-key check runs after a batch that applied anything.

`schema_state.last_successful_app_version` is written only after the rest of
startup and the bootstrap gates complete, which distinguishes a migration that
ran from an application version that started successfully.

Some migrations only queue existing rows for derived state such as search
documents, tag and title projections, or card summaries. The server drains
those queues in bounded background batches after startup;
[Data model](../architecture/data-model.md) describes each queue and how reads
behave while it drains.

## Baselines

A baseline is a fresh-install snapshot of the complete numbered chain, never an
upgrade path. Data transformations, backfills, and conflict resolution in
numbered migrations are not represented by a schema snapshot, so an existing
database always continues through the numbered files.

Two directories hold baselines:

| Directory | Filename | Contents | Read by |
| --- | --- | --- | --- |
| `baseline/` | `<schema>_v<major>.<minor>.<patch>.sql` | Released baselines | Every mode |
| `compat/` | `<schema>_dev.sql` | Development baselines of the unreleased chain | `KIKOTO_MODE=development` only |

A `.sql` file in `baseline/` with any other name, a baseline above the highest
numbered file, or two baselines with the same schema version rejects the
catalog. Development mode applies the same checks to `compat/`, where files
other than `.sql`, such as its README, are ignored.

### Development Baselines

A development baseline lets a development database start at the unreleased
chain head without publishing a released baseline for a schema no release has
shipped.

- Production and demo modes never read `compat/`. A database whose ledger
  records a `compat/` baseline stops at startup with an error that names the
  file and asks for `KIKOTO_MODE=development` or a new database.
- In development mode, every `compat/` baseline must be above the highest
  released baseline; otherwise the catalog is rejected until the stale file is
  removed.
- A development database whose `compat/` baseline is not packaged stops in
  every mode and is recreated. Release mode of the generator removes every
  development baseline, so development databases created from one are
  recreated after a release.

### Baseline Generation

```sh
cd backend
go generate ./migrations
go run ./cmd/schema-baseline -migrations ./migrations -version-file ../VERSION -release
```

The generator (`backend/cmd/schema-baseline`) applies the complete numbered
chain to an in-memory SQLite database with foreign keys enabled, verifies
foreign keys, and dumps the result. The file contains the tables, the rows the
migrations insert, and the indexes, views, and triggers, each group sorted by
name. It omits `schema_migration`, `schema_state`, FTS5 shadow tables, and
virtual-table rows, because `CREATE VIRTUAL TABLE` recreates them. Columns with
a `CURRENT_TIMESTAMP` default are left out of the seed rows, so timestamps are
evaluated on the target database rather than frozen to the generator's clock.
The generated file is reviewed and checksummed like any other packaged asset.

| Mode | Command | Result |
| --- | --- | --- |
| Development (default) | `go generate ./migrations` | Writes `compat/<schema>_dev.sql` for the highest numbered file, replacing a file of the same name. Older development baselines stay, because development databases created from them validate their ledger against them. Writes nothing when the highest numbered file already has a released baseline. |
| Release | `-release` | Reads the root `VERSION`, which must have the form `v<major>.<minor>.<patch>`. Writes `baseline/<schema>_<VERSION>.sql` only when the highest numbered file is above the highest released baseline, then deletes every `compat/*.sql`. |

A release whose numbered chain is unchanged therefore reuses the previous
released baseline, and no second released baseline exists for one schema
version.

### Selection And Retention

An empty database applies the highest-version baseline the mode reads: the
newest file in `baseline/` in production and demo modes, and the newest file
across `baseline/` and `compat/` in development mode. It records that file as
the first ledger row and in `schema_state`, and then applies any numbered files
after it. Every other packaged baseline exists only to validate the ledger of a
database that was created from it.

A released baseline's suffix is the release that generated it; later releases
with the same numbered chain reuse it. The packaged baselines and the releases
that shipped them are listed in
[Accepted And Refused Ledgers](#accepted-and-refused-ledgers) and
[Release To Schema Map](#release-to-schema-map).

A database created from a baseline records that file rather than the numbered
files it replaced. Removing a released baseline from the catalog makes those
databases refuse to start, so a released baseline is immutable and stays
packaged. A filename may leave the catalog only through a checksum-only ledger
entry for the same filename, version, and checksum.

## Accepted And Refused Ledgers

The first ledger row identifies how a database was created. Startup accepts
these first rows and continues through the numbered chain:

| First ledger row | Created by | Catalog entry |
| --- | --- | --- |
| `001_initial.sql` | The complete numbered chain, including every fresh install before v0.5.0 | Numbered file |
| `baseline/031_current.sql`, `baseline/032_current.sql` | Pre-release snapshots | Checksum-only |
| `baseline/032_v0.5.0.sql` | v0.5.0 through v0.5.5 | Packaged |
| `baseline/033_v0.5.5.sql` | Development builds between v0.5.5 and v0.6.0 | Packaged |
| `baseline/034_v0.5.5.sql` | The original v0.6.0 publication, before the baseline was renamed (see [v0.6.0](../history/v0.6.0.md)) | Checksum-only |
| `baseline/034_v0.6.0.sql` | v0.6.0 and v0.6.1 | Packaged |
| `baseline/044_v0.7.0.sql` | v0.7.0 | Packaged |
| `baseline/047_v0.7.1.sql` | v0.7.1 | Packaged |
| `baseline/059_v0.8.0.sql` | v0.8.0 | Packaged |
| `baseline/060_v0.8.0.sql`, `baseline/061_v0.8.0.sql`, `baseline/062_v0.8.0.sql` | Development builds after v0.8.0 | Checksum-only |
| `compat/<schema>_dev.sql` | Development builds of the unreleased chain | Development baseline; development mode only |

A checksum-only entry validates a recorded ledger row in every mode and is
never a fresh-install input. It applies only when no packaged file has the same
filename.

A `compat/<schema>_dev.sql` row stops startup in production and demo modes, and
in development mode when the file is not packaged (see
[Development Baselines](#development-baselines)).

Any other ledger filename stops startup with an unknown-migration-record error,
or with a newer-than-supported error when its version is above the current
schema. This refuses databases that only unreleased development builds could
create:

- baselines 035–044 with a `_v0.6.1` suffix;
- baselines 045 and 047 with a `_v0.7.0` suffix;
- baselines above 047 with a `_v0.7.1` suffix;
- the alternative metadata-branch records
  `051_metadata_tag_projection_queue.sql`, `052_language_scoped_titles.sql`,
  and `053_favorite_list_icon.sql`, including their `compat/metadata/` copies.

Such a database is recreated, or restored from a backup taken on a released
version.

## Release To Schema Map

Pre-migration backup filenames record schema versions (`v047-to-v059`, for
example). The first number identifies the release row below whose schema
matches the backup.

| Release | Highest numbered migration | Fresh-install baseline |
| --- | --- | --- |
| v0.1.0 | `001` | None; the numbered chain |
| v0.1.1 | `002` | None |
| v0.1.2, v0.1.3 | `004` | None |
| v0.2.0 | `006` | None |
| v0.2.1 | `007` | None |
| v0.2.2 | `010` | None |
| v0.3.0 | `022` | None |
| v0.3.1, v0.4.0 | `025` | None |
| v0.4.1 | `027` | None |
| v0.5.0 through v0.5.5 | `032` | `032_v0.5.0.sql` |
| v0.6.0, v0.6.1 | `034` | `034_v0.6.0.sql` |
| v0.7.0 | `044` | `044_v0.7.0.sql` |
| v0.7.1 | `047` | `047_v0.7.1.sql` |
| v0.8.0 | `059` | `059_v0.8.0.sql` |
| Unreleased (`main`) | `063` | `059_v0.8.0.sql`; `compat/063_dev.sql` in development mode |

Per-release upgrade steps are in the [release notes](../history/index.md).
