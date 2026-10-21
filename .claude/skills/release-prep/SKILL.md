---
name: release-prep
description: Prepare a Kikoto release when the maintainer asks to get a named version ready, covering the release-facing pages and test literals that the documented release steps leave out.
---

# Release Prep

The release steps themselves are in
[Release Steps](../../../docs/development/commit-and-release.md#release-steps).
This procedure adds the preparation around them.

1. Take the release tag from the maintainer. Read `VERSION`, the highest
   numbered migration, and the files in `backend/migrations/baseline/` and
   `backend/migrations/compat/`.
2. Reconcile the pending notes with history. Compare
   `git log --no-merges <previous tag>..HEAD` with
   `docs/history/unreleased.md` and add each missing user-facing change to its
   area block. Then write `docs/history/<tag>.md` in the shape described in
   [Release Notes](../../../docs/development/commit-and-release.md#release-notes),
   with upgrade notes for the schema range, a new released baseline, and any
   operator action.
3. Follow release steps 1 to 3: `VERSION`, the baseline generator in release
   mode, the notes move, and the history index.
4. Update the release-pinned values: `latestReleasedBaselineVersion`,
   `latestReleasedBaselineFilename`, and the version passed to `MigrateFS` in
   `backend/internal/storage/migration_manager_test.go`, plus the
   [Release To Schema Map](../../../docs/development/migrations.md#release-to-schema-map)
   and the accepted-ledger table in
   [Accepted And Refused Ledgers](../../../docs/development/migrations.md#accepted-and-refused-ledgers).
5. Refresh the release-facing pages. Check `technologyGroups` in
   `frontend/src/pages/AboutPage.tsx` against `frontend/package.json`,
   `backend/go.mod`, the Dockerfiles, and the mobile shells. Review
   `README.md` for stale claims and update its translations with the
   `doc-locale-sync` skill.
6. Run the validation targets for the touched areas and `make sensitive-check`.
   Leave the result for the maintainer's review. Committing, pushing, and
   tagging (release steps 4 and 5) wait for the maintainer's approval.
