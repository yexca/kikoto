# Migrations

Database migrations live in `backend/migrations/`.

## Current Practice

`001_initial.sql` is the immutable v0.1.0 schema. Changes released in v0.1.1
are consolidated in `002_v0_1_1.sql`; a v0.1.0 database must upgrade by running
that migration without rebuilding or replacing user data.

`003_user_media_lyrics_preference.sql` is the next additive migration and
stores per-user audio-to-lyrics media preferences. Released migrations remain
immutable; subsequent schema changes must use the next numbered file.

The current sequence continues through `008_work_code_alias.sql`, which adds
metadata-only logical-work code aliases and backfills existing edition metadata.

## Guidelines

- Keep schema changes aligned with the unified work model.
- Preserve source and metadata boundaries.
- Avoid adding legacy compatibility paths that are unnecessary for a fresh
  first-version database.
- Update [Data model](../architecture/data-model.md) when schema meaning
  changes.
