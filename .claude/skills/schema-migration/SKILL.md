---
name: schema-migration
description: Add or renumber a Kikoto numbered database migration, and regenerate the development baseline, when a change needs a schema change.
---

# Schema Migration

The rules for the numbered chain, baselines, and ledgers are in
[Migrations](../../../docs/development/migrations.md), with the short form in
[Adding A Migration](../../../docs/development/migrations.md#adding-a-migration).
This procedure adds the repository touch points around them.

1. Establish the state. Read `VERSION`, list `backend/migrations/` for the
   highest numbered file (the current schema version), and list
   `backend/migrations/baseline/` and `backend/migrations/compat/`. A released
   numbered file and every file in `baseline/` are immutable; the next number is
   the highest present plus one. Take the number from the files, not from
   memory or another branch.
2. Add `backend/migrations/NNN_<lowercase_words>.sql` and follow the file rules
   in [Adding A Migration](../../../docs/development/migrations.md#adding-a-migration):
   no transaction control, idempotent backfills, and the
   `-- kikoto:foreign_keys=off` first line for a table rebuild.
3. From `backend/`, run `go generate ./migrations`. It writes
   `compat/<NNN>_dev.sql` for the new head. Earlier development baselines stay
   in place until release preparation retires them, and the generator never
   writes a released baseline outside release mode
   ([Baseline Generation](../../../docs/development/migrations.md#baseline-generation)).
4. Update the pins in `backend/internal/storage/migration_manager_test.go`:
   `latestNumberedMigrationVersion`, and the upgraded-history list that
   `wantHistory` extends with the numbered files after the released baseline.
   Update [Data model](../../../docs/architecture/data-model.md) when the
   schema's meaning changes. A change that lands before a release adds its note
   to `docs/history/unreleased.md` under the matching area.
5. Add a storage regression test for the user-visible behavior or recovery
   invariant, using the helpers described in
   [Testing](../../../docs/development/testing.md), and run it with
   `TestMigrateBaselineMatchesCompleteIncrementalChain`:

   ```powershell
   cd backend
   go test ./internal/storage ./cmd/schema-baseline
   ```

   Then run `make backend-test` when the change also touches domain code.
6. When a catch-up merge brings in a migration with the same number, rename
   the branch's unreleased file to the next free number with `git mv`, remove
   the branch's own `compat/` baseline with `git rm`, rerun
   `go generate ./migrations`, and move the pins from step 4 and the number
   references in the docs to the new number. Never edit the file `main` added.
7. Run `make sensitive-check`. Leave the result for the maintainer's review.
