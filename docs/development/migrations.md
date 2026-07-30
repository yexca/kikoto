# Migrations

Database migrations live in `backend/migrations/`.

## Current Practice

`001_initial.sql` is the immutable v0.1.0 schema. Changes released in v0.1.1
are consolidated in `002_v0_1_1.sql`; a v0.1.0 database must upgrade by running
that migration without rebuilding or replacing user data.

`003_user_media_lyrics_preference.sql` is the next additive migration and
stores per-user audio-to-lyrics media preferences. Released migrations remain
immutable; subsequent schema changes must use the next numbered file.

The current sequence continues through `020_filesystem_event_watcher.sql`.
Migrations `008` through `013` add normalized work aliases and commercial
metadata, terminal provider state, recommendation telemetry, and explicit video
audio-presence data with a legacy backfill. Migration `014` adds durable
workflow-job priority and its claim-order index. Migrations `015` through `017`
add workflow notifications, resource lanes, and Availability Watch state;
`018` merges Startup library refresh into local scan; `019` adds the fixed
local-scan filesystem trigger; and `020` replaces directory-snapshot polling
state with native filesystem-event watcher state.

## Guidelines

- Keep schema changes aligned with the unified work model.
- Preserve source and metadata boundaries.
- Avoid adding legacy compatibility paths that are unnecessary for a fresh
  first-version database.
- Update [Data model](../architecture/data-model.md) when schema meaning
  changes.
