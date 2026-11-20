# Migrations Agent Guide

Read [Migrations](../../docs/development/migrations.md) for the full model. The
rules below are the ones an edit must not break.

## Before Starting

Inspect the repository state; never assume it:

- `VERSION` for the application release. Do not hard-code it or infer it from
  an old release note.
- The highest numbered `NNN_*.sql` file, which is the schema version.
- The filenames in `baseline/` and `compat/`.

## Rules

- `001_initial.sql` and every numbered migration after it are immutable once
  released. Never edit an applied migration.
- A schema change adds the next contiguous number after the highest existing
  migration; see
  [Adding A Migration](../../docs/development/migrations.md#adding-a-migration).
- An empty database applies the highest baseline its mode reads, then later
  numbered migrations. Existing databases always continue through the numbered
  chain and are never rebuilt from a fresh-install baseline.
- Released baselines live in `baseline/`. Development baselines of the
  unreleased chain live in `compat/`, which only `KIKOTO_MODE=development`
  reads.
- After a numbered migration changes, run `go generate ./migrations` from
  `backend/` to refresh the development baseline.
- A release runs the generator with `-release`: it writes a released baseline
  only when the chain changed and clears `compat/`. Never add a second
  released baseline for an existing schema version; see
  [Baselines](../../docs/development/migrations.md#baselines).

Release order and tagging:
[Release Steps](../../docs/development/commit-and-release.md#release-steps).
