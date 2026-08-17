# Migrations

Database migrations live in `backend/migrations/`. The backend packages this
directory into the executable, so a production container does not need a
separate `/app/migrations` mount.

## Numbered Chain

`001_initial.sql` is the immutable v0.1.0 schema. Changes released in v0.1.1
are consolidated in `002_v0_1_1.sql`; a v0.1.0 database upgrades by running
that migration against its existing data. Every numbered file after that is
also immutable once released.

The catalog must contain exactly one three-digit, contiguous chain:

```text
001_initial.sql
002_v0_1_1.sql
003_*.sql
...
```

The manager rejects gaps, duplicate versions, empty files, unknown history
records, and a database whose recorded schema is newer than the running
binary. A schema change is therefore resolved by adding the next numbered
migration, not by editing two competing files or trying to guess which branch
won. The migration ledger stores the filename, version, SHA-256 checksum,
application version, duration, and commit time. On subsequent starts the
checksum is checked before any new SQL runs. Checksum input normalizes CRLF and
LF line endings so moving a database between Windows and Linux does not look
like a migration edit.

The current release boundary is migration `027_voice_catalog.sql` (tag
`v0.4.1`). Migrations `028` through `031` are present in the current working
tree after that tag and are part of the next unreleased chain; they must not be
described as part of v0.4.1 until a release explicitly includes them.
The working-tree baseline is consequently `030_current.sql`; its presence is
not a claim that v0.4.1 shipped migrations 028-030.

## Fresh Installs And Upgrades

The manager keeps a single-row `schema_state` table with the current schema
version, optional baseline version and checksum, dirty version, last migration
application version, and last successfully started application version.

Startup follows two different paths:

| Database state | Action |
| --- | --- |
| Empty SQLite database | Apply `baseline/<version>_current.sql`, then any numbered migrations after that version. |
| Existing database with migration history | Validate the ledger and apply only the next numbered migrations. User data is never reconstructed from the baseline. |
| Application tables without migration history | Stop and require an operator decision; the manager never infers a version. |
| Dirty migration from an interrupted/failed start | Retry that exact version after the SQL or environment is repaired. |
| Future schema version | Stop and ask for a compatible/newer binary. |

Every migration's SQL, ledger row, and schema-state advance are committed in
one SQLite transaction. Before the transaction the state is marked dirty. A
failed statement rolls back the schema and ledger but deliberately leaves the
dirty marker, making recovery observable and retryable. A foreign-key check is
performed after a successful migration batch.

`schema_state.last_successful_app_version` is written only after the rest of
application startup and bootstrap gates have completed. This distinguishes a
database migration that ran from an application version that actually started
successfully.

## Baseline Generation

The baseline is a generated fresh-install optimization, not an upgrade
migration. Generate it from a clean checkout after the numbered chain changes:

```sh
cd backend
go generate ./migrations
```

The generator applies the complete numbered chain in a temporary SQLite
database and writes the final tables, indexes, views, triggers, and
migration-provided reference rows to `migrations/baseline/<version>_current.sql`.
Timestamp defaults remain defaults rather than being frozen to the generator's
clock. The generated file is reviewed and checksummed like any other packaged
asset. It may be regenerated or retained at an earlier version; when it is
earlier than the catalog head, a fresh install applies the remaining numbered
migrations after the baseline.

Once a released binary can create databases from a baseline, keep that
baseline filename available in later catalogs (or provide an explicit,
reviewed replacement path). Removing it strands those databases because their
ledger contains the baseline record rather than every skipped numbered file.

Do not use a baseline to upgrade an existing database: data transformations,
backfills, and conflict-resolution logic in numbered migrations are intentionally
not represented by a schema snapshot.

## Guidelines

- Keep schema changes aligned with the unified work model and preserve source
  and metadata boundaries.
- Add the next numbered file for each released schema change; never rewrite an
  applied file to resolve a merge conflict.
- Treat a released baseline file as immutable for the same reason; publish a
  new baseline version instead of changing its contents in place.
- Keep migration SQL deterministic and make data backfills idempotent where a
  retry can reach them.
- Update [Data model](../architecture/data-model.md) when schema meaning
  changes, and add a storage regression test for user-visible behavior or a
  recovery invariant.
- Before release, run the complete numbered chain and the baseline-equivalence
  test so a fresh install and an upgraded database converge on the same
  structure.
