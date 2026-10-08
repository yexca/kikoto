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

The current schema boundary is the highest numbered migration present in
`backend/migrations/`. Inspect that directory before adding a change and append
the next contiguous number; do not hard-code a migration number from an older
release or rewrite an existing numbered file. The application release is read
from the root `VERSION` file.

## Fresh Installs And Upgrades

The manager keeps a single-row `schema_state` table with the current schema
version, optional baseline version and checksum, dirty version, last migration
application version, and last successfully started application version.

Startup follows two different paths:

| Database state | Action |
| --- | --- |
| Empty SQLite database | Apply the highest-version packaged baseline, then any numbered migrations after that version. Its release suffix may be older than the running application when the numbered SQL chain did not change. |
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

Baselines are generated fresh-install optimizations, not upgrade migrations.
The catalog may retain released snapshots for ledger validation while using the
highest-version baseline for an empty database. Generate a new snapshot only
when the numbered SQL chain changes. Updating `VERSION` by itself does not
require a new baseline; a release with no new SQL reuses the latest packaged
snapshot:

```sh
cd backend
go generate ./migrations
```

When a new baseline is needed, the generator reads the root `VERSION`, applies
the complete numbered chain in a temporary SQLite database, and writes the
final tables, indexes, views, triggers, and migration-provided reference rows
to `migrations/baseline/<schema-version>_v<release>.sql`. For example, v0.5.0
packages `migrations/baseline/032_v0.5.0.sql`. The current schema chain ends at
`061_media_lyrics_assignment.sql`, with the development baseline
`061_v0.8.0.sql` generated from the current `VERSION` file; the next release
regenerates it under its own suffix. Released migrations and baselines,
including `047_v0.7.1.sql` and `059_v0.8.0.sql`, remain immutable and available
for ledger validation.

Migration 048 removes only all-language title overrides that exactly match a
trimmed DLsite title from the same family or work; circle, series, and voice
overrides remain untouched. Migration 049 adds shared tag concepts, manual
locale names, per-work original bases and projection markers, a merge-resolution
view, and per-work add/remove overrides, creates concepts for already
known genre ids, and queues search. Its full work projection runs after startup
core workflows in independent background Go batches, with a completion marker
and interrupted-pass recovery. Snapshot-only DLsite tags are normalized too.
Migration 048 guards JSON inspection with `json_valid`; malformed stored
overrides are retained and cannot abort migration.
Migration 050 adds independent manual/provider circle names, aliases with
search invalidation, and protected merge-review records for reversible relation
transfers. Migration 051 adds the `favorite_list.icon` presentation key with
an empty default, preserving existing list data. Migration 052 adds the durable shared-tag projection queue, per-work
retry counters and backoff deadlines, and
snapshot-writer
triggers, queues existing works, and requests one new startup backfill to repair
older projections and locale-name precedence. Hidden/merged states now commit
before batched work projection. Existing databases apply 048–060 through the
numbered chain; empty databases use the schema-060 baseline.
Migration 053 preserves existing all-language authored overrides while adding
language-scoped titles and rebuilding indexes/search triggers. It never changes
released/applied numbered SQL or reconstructs existing data from a baseline.
Migration 054 adds `work_metadata_field_source` for remote-filled value
provenance and `metadata_tag_provider_name` for remote tag localizations with
search invalidation triggers. It writes no provenance itself: it queues every
existing work with a remote snapshot for background reconciliation, which
applies the deterministic source order without rewriting DLsite-backed works.
Migration 055 adds `dlsite_genre_name_request` and `dlsite_genre_name_gap`, the
resumable state of background genre name learning. It changes no existing rows.
Migration 056 adds the nullable `user_preference.metadata_languages` personal
priority, the `work_title_language` sort titles with their family-wide
`work_title_language_dirty` queue and triggers, and queues every work for the
background title build. It also queues the canonical works of families with
another DLsite edition for shared-tag reprojection, because their tags now
come from the original edition. It changes no existing rows directly.
Migration 057 adds the bounded `remote_metadata_title_variant` projection and
its title-sort/search invalidation triggers. Existing remote snapshots are
queued for the normal background projection; no work, edition or provider
request is created by the migration.
Migration 058 adds `work_purchase_bonus`, the link from a purchase bonus work to
its parent product's family by code, with its parent-code and foreign-key
indexes. It creates no rows: existing bonuses are detected by the next metadata
sync.
Migration 059 adds a `file_version` observation to local media items and
locations. Size and nanosecond modification time invalidate derived duration
and audio metadata when rescanning, while media ids and personal state stay
unchanged. Legacy observations remain empty until a scan or bounded probe
establishes their version; probes validate both disk observations and the stored
version before committing. No media files are read by the migration.
Migration 060 adds weighted affinity and creator diversity to recommendation
snapshots and stores a frozen entity/name profile per generation for transient
remote results. Name and alias changes advance the input revision for new
sessions. Existing generations retain their records; the algorithm version
change rebuilds an old client binding when it is next used. No catalog or work
records are created by the migration.
Migration 061 adds `media_lyrics_assignment`, the library-level lyrics file of
an audio media item, with indexes on its lyrics and assigning-user foreign keys.
It creates no rows; existing personal lyrics preferences are unchanged.
v0.7.1 shipped schema 047. Snapshot triggers queue only existing works, preserve
committed projection markers, and permit snapshots to outlive a deleted work.
Startup moves old flat
covers to the
nested cache once and never replaces an existing provider cover.
Startup cover migration, shared-tag backfill and orphan manual-asset cleanup
record durable status separately; failed cover files do not stop migration of
the remaining files, and incomplete repairs retry next startup.

Migration 047 adds `work_dlsite_genre` and
`dlsite_genre_name`, backfills them from each work's latest DLsite snapshot
(genres with a positive integer id only, newest name first), adds triggers that
queue affected works for the search index, and queues every work that has a
genre. Migration 046 adds triggers that queue a work when its
`dlsite_metadata_variant` row changes and queues every work that has a variant,
so the search index picks up variant titles. Neither changes existing rows.
Migration 045 adds `work_metadata_link`, a
user-declared DLsite product whose metadata is stored on the linked work; it
changes no existing rows. Migration 044 stores the
preserved legacy workflow snapshot and durable library-layout migration state.
Before migration 035 removes user definitions, the application's upgrade hook
copies their definitions and triggers into the snapshot. An instance that
already passed 035 needs a pre-035 database backup to recover deleted definitions.
Migration 043 adds account-owned listening sessions, UTC daily totals, imported
per-work totals and an account generation for clearing history. It preserves remaining play
events and playback cursor timestamps without inferring historical durations.
Recommendation retention continues to clean only its own event data.
Migration 042 adds `WHEN` conditions to the recommendation revision triggers on
`work_tag`, `tag`, `work_credit`, `work_party`, and `user_work_state` updates,
so an update that changes no scored value no longer advances a revision. It
adds `work_snapshot_projection` and the triggers that drop a work's record when
a projected credit, circle relation, or imported catalog row changes, and it
prunes `party_metadata_snapshot` to the two latest rows per circle and
provider. The table starts empty, so the first start after the upgrade
projects every work once in the background.
Migration 041 adds only indexes: case-insensitive creator lookup expressions
and the missing foreign-key child indexes used by cleanup cascades.
Migration 040 changes no schema. `user_session.id` now holds the SHA-256 digest
of a session token rather than the token, so the migration deletes every
existing session and each client signs in again once.
Migration 039 changes no schema. It disables every follow preset trigger
(`circle_follow`, `series_follow`, `voice_follow`) saved with the retired
follow inputs, clears its next run, and records a reconfiguration message; the
stored inputs are kept so the Workflows page can prefill what still applies.
Migration 038 adds the derived `metadata_snapshot_card_summary` cache and its
`metadata_snapshot_card_summary_dirty` queue, queues every existing snapshot,
and adds triggers that queue inserted or changed snapshots. Summaries are
written by the application in small background batches; list queries fall
back to the raw snapshot until a row has a current summary.
Migration 037 adds only indexes: Library created and release-date order, and
work, favorite-item, and session lookups by their owning row.
Migration 036 creates the `work_search` FTS5 trigram index and the
`work_search_dirty` queue, queues
every existing work, and adds triggers that queue works whose searchable text
changes. Its documents are written by the application, so an upgraded server
builds the index in the background after startup. The baseline generator omits
FTS5 shadow tables and virtual-table rows because `CREATE VIRTUAL TABLE`
recreates them.
Migration 035 deletes user-authored workflow definitions and their triggers
because custom workflow editing was removed; runs keep their code and name
snapshots. Upgrades that pass through this migration with the current
application first preserve the removed definitions and triggers for review.
Migration 033 preserves structured `not_found` observations as pending metadata
issues. Historical free-text workflow errors are not reinterpreted or copied
into the shared list. Existing installations apply 033 through the numbered
chain; their works, metadata, workflow histories, and reviews are retained.
Timestamp defaults remain
defaults rather than being frozen to the generator's clock. The generated file
is reviewed and checksummed like any other packaged asset. A later application
release that does not add numbered SQL keeps using that file; do not create a
second baseline with the same schema version only to change the release suffix.
When a newer schema baseline is added, a fresh install uses it and historical
released baselines remain available solely to validate and upgrade databases
whose ledgers reference them.

Do not create or retain a `<schema-version>_current.sql` baseline file. A
generated baseline's filename includes both the schema version and the Kikoto
release that produced it; application releases without SQL changes may reuse
an earlier filename.
The manager retains checksum-only descriptors for the removed pre-release
`031_current.sql` and `032_current.sql` snapshots so an existing development
database can validate its ledger and continue through the numbered chain; those
descriptors never become fresh-install inputs. Once a released binary can
create databases from a release-named baseline, keep that filename available in
later catalogs (or provide an explicit, reviewed replacement path). Removing it
strands those databases because their ledger contains the baseline record rather
than every skipped numbered file.

Do not use a baseline to upgrade an existing database: data transformations,
backfills, and conflict-resolution logic in numbered migrations are intentionally
not represented by a schema snapshot.

## Guidelines

- Keep schema changes aligned with the unified work model and preserve source
  and metadata boundaries.
- Add the next numbered file for each released schema change; never rewrite an
  applied file to resolve a merge conflict.
- Treat a released baseline file as immutable for the same reason; publish a
  new baseline only when the numbered schema chain advances, instead of
  changing its contents or duplicating its schema version for an app-only
  release.
- Keep migration SQL deterministic and make data backfills idempotent where a
  retry can reach them.
- Update [Data model](../architecture/data-model.md) when schema meaning
  changes, and add a storage regression test for user-visible behavior or a
  recovery invariant.
- Before a schema-changing release, run the complete numbered chain and the
  baseline-equivalence test so a fresh install and an upgraded database
  converge on the same structure. For an app-only release, verify that the
  existing packaged baseline remains selected and its ledger is still accepted.

## v0.6.0 Upgrade

Released v0.5.0 through v0.5.5 databases are on schema 032. v0.6.0 applies
`033_metadata_sync_issues.sql` and `034_user_preferences.sql` through the
numbered chain. Migration 033 records metadata recovery state; migration 034
adds account-owned playback-folder and recommendation preferences. Existing
`app_setting` values remain the fallback for accounts without overrides and
for anonymous browsing.

Fresh installs use `034_v0.6.0.sql`. The original `034_v0.5.5.sql` filename
mistakenly used the development-time application version; tagged v0.5.5 did
not include schema 034. This is a naming correction, not a new schema version:
the SQL is unchanged apart from its release header, and the catalog retains
the old filename and original checksum as a ledger-only compatibility entry.
Existing databases keep their recorded baseline and checksum without rewriting
history or replaying SQL. This explicit replacement path is an exception to
the normal immutable-baseline rule, not a reason to rename snapshots on each
release. The historical `033_v0.5.5.sql` development snapshot remains available
for databases that used it. Databases on schema 032 or 033 continue through
the remaining numbered migrations.

## v0.6.1 Upgrade

v0.6.1 adds no numbered SQL and remains on schema 034. Existing databases start
without applying migrations, and fresh installs continue to use
`034_v0.6.0.sql`.

## v0.7.0 Upgrade

Existing v0.6.1 databases advance from schema 034 through numbered migrations
035–044. The upgrade hook preserves user-authored workflow definitions and
triggers for review before migration 035 removes their active copies. A
database that already passed 035 under an earlier build needs a pre-035 backup
to recover definitions that were deleted before the preservation hook existed.
New installations use `044_v0.7.0.sql`; existing installations never apply a
baseline during upgrade.

The released v0.6.1 baseline remains `034_v0.6.0.sql`. Baselines 035–044 that
were generated during v0.7.0 development with a v0.6.1 suffix were not part of
the v0.6.1 release. Their files were removed, and v0.8.0 also removed their
checksum-only ledger entries; see [v0.8.0 Upgrade](#v080-upgrade).

## v0.7.1 Upgrade

Existing v0.7.0 databases advance from schema 044 through numbered migrations
045–047. Migration 045 adds `work_metadata_link` without changing existing
rows. Migrations 046 and 047 queue works with DLsite variant titles or genres
for the search index, which catches up in the background after startup. New
installations use `047_v0.7.1.sql`; existing installations never apply a
baseline during upgrade.

The released v0.7.0 baseline remains `044_v0.7.0.sql`. Baselines 045 and 047
that were generated during v0.7.1 development with a v0.7.0 suffix were not
part of the v0.7.0 release. Their files were removed, and v0.8.0 also
removed their checksum-only ledger entries; see [v0.8.0 Upgrade](#v080-upgrade).

## v0.8.0 Upgrade

Existing v0.7.1 databases advance from schema 047 through numbered migrations
048–059. The migrations queue existing works for background tag projection,
title builds, remote title projection, and search indexing instead of
rewriting them during startup; migration 048 removes only all-language title
overrides that exactly match a DLsite title from the same work family. New
installations use `059_v0.8.0.sql`; existing installations never apply a
baseline during upgrade.

The released v0.7.1 baseline remains `047_v0.7.1.sql`. Baselines from schema
050 onward that were generated during v0.8.0 development with a v0.7.1 suffix
were not part of the v0.7.1 release, and their files have been removed.

v0.8.0 also stops accepting databases that only unreleased development builds
could create. The catalog no longer carries checksum-only entries for the
development baselines generated between v0.6.1 and v0.8.0 (035–044 with a
v0.6.1 suffix, 045 and 047 with a v0.7.0 suffix, and 050–059 with a v0.7.1
suffix), and the metadata redesign branch's alternative 051–053 history and
its `compat/metadata/` SQL are removed. A database whose ledger references
one of these is refused at startup with a ledger validation error; recreate it
or restore it from a backup of a released version. Databases created by a
released version, including those whose ledger starts at `033_v0.5.5.sql` or
`034_v0.5.5.sql`, and those created from the retained pre-release
`031_current.sql` and `032_current.sql` snapshots, upgrade through the
numbered chain as before.
