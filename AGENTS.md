# Agent Guide

Read these first:

- `README.md`
- `docs/overview.md`
- `docs/architecture/core-boundaries.md`
- `docs/architecture/data-model.md`
- `docs/architecture/workflows.md`
- `docs/architecture/backend.md`
- `docs/architecture/frontend.md`
- `docs/development/design.md`
- `SECURITY.md`
- `docs/development/security.md`

## Product Boundaries

Critical rule:

```text
Metadata sources and file sources are separate.
```

Core boundary:

```text
work is the unified primary_code entity. Local folders, cache entries, remote
sources, and source catalogs only describe presence, locations, or metadata
snapshots for that work.
```

- Do not create a second work identity for a source-local id, translation,
  folder, cache entry, or remote result.
- Source names and icons are data. Branch on declared source capabilities and
  source type, never on a configured display name or a private service brand.
- Catalog discovery is not permission to recursively materialize every
  discovered code as a `work`. Local, tracked, cached, or explicitly requested
  works are the automatic metadata roots. Stop and discuss before broadening a
  provider crawl.
- DLsite-style `primary_code` is the identity key. Do not redesign around
  source-local ids or a new identity system; stop and discuss before proposing
  one.

Fetch publication directories such as `.kikoto-staging`, `.kikoto-backup`, and
the reviewable `.kikoto-trash` must remain on the filesystem of the storage
pool that holds the target, so publication and rollback can use
same-filesystem rename semantics: the data root in standard mode,
`/data/<pool>` in storage pool mode. Do not move durable transaction or review
state to disposable `/cache` storage, and do not share one transaction
directory across pools.

A scan must never mark works missing where it cannot see: an unmounted data
root or offline pool (no `.kikoto-pool` marker), or folders deeper than the
scan depth. Keep new scan, watcher, and disk-verified cleanup paths behind the
same pool scope.

## Remote Request Boundary

An endpoint explicitly configured by an administrator is trusted configuration
and may intentionally be a private LAN address. URLs, redirects, headers, and
metadata returned by that source are still untrusted input.

For every new or materially changed outbound HTTP path:

- Accept only HTTP(S) URLs and reject embedded credentials.
- State whether the destination must remain on the configured origin or may use
  an explicit allowlist. Do not follow arbitrary redirects; validate every hop
  and remove credentials when an allowed redirect changes origin.
- When untrusted input can influence the hostname, prevent DNS rebinding by
  validating the addresses and connecting to the same validated address.
- Bound timeouts, buffered metadata responses, streamed bytes, concurrency, and
  retry behavior. Large media must stream to a bounded destination rather than
  be buffered in memory.
- Keep detailed upstream errors in protected logs or Activity. Public API and UI
  errors must not reveal credentials, private endpoints, or local paths.
- Add tests for private/reserved addresses, redirects, response limits,
  cancellation, and the explicitly configured private-origin exception.

The shared server-side outbound transport establishes this URL, origin,
redirect, address, and DNS-pinning boundary for built-in metadata clients and
configured remote-source requests. A new path is not covered merely because the
transport exists: route it through the shared policy, define its destinations,
and add the relevant regression tests before documenting the stronger contract.

## Code Organization

New and extracted code should follow a downward dependency direction:

```text
app composition -> domain feature -> shared application code -> primitives
```

- App and route layers compose domains. Shared code must not import a domain
  feature, and sibling domain features should communicate through composition or
  an extracted shared contract rather than importing each other's internals.
- Promote a domain only after it owns a real page or workflow plus several
  cohesive files. Prefer incremental extraction over a repository-wide move.
- Keep UI, state models, transport, and persistence separate when that makes the
  behavior independently testable. Do not add more unrelated orchestration to
  already large page or HTTP-handler files.
- A feature with multiple outside consumers should expose a small explicit
  public entry rather than requiring deep imports.

## UI and Test Contracts

- Follow `docs/development/design.md`. Preserve the global player across navigation and
  contain page failures so one remote or media error does not discard known
  local state.
- Use semantic design tokens. Status color communicates availability or intent,
  never source identity.
- Tests should protect a concrete user-visible behavior, public contract, state
  transition, or prior regression. Choose the lowest sufficient layer and do
  not repeat the same assertion at every layer.
- Before adding or changing test fixtures, follow
  [Synthetic Fixture Data](docs/development/testing.md#synthetic-fixture-data).
  Use the deterministic test fixture constructors and repository-reserved
  `RJ00000000` through `RJ00000099` sequence when work identity is incidental;
  use the bounded high-cardinality constructor only when more than 100 distinct
  works are required. Do not randomize or improvise a plausible catalog number.
- Prefer accessible roles, names, and labels in browser tests. Add an authored
  stable semantic marker only when a complex app-owned surface has no useful
  accessible boundary. Do not make utility classes or incidental DOM ancestry a
  public test contract.
- Pure visual assertions are appropriate only for a documented layout,
  accessibility, or responsive contract.

## Documentation

Docs describe the current system and its current decisions, not how it got
there. Where each topic belongs is in
[Documentation Rules](docs/README.md#documentation-rules).

- Write in present tense. Do not narrate change: no "previously", "no longer",
  "now", "as before", "was removed", "migration NNN adds", version-dated
  asides, PR/issue/commit references, or before/after comparisons.
- When behavior changes, rewrite the affected section as if it had always been
  this way instead of appending a paragraph. Search for and remove every
  statement the change contradicts, including user pages, operations pages,
  and translations.
- Compatibility that still runs is current behavior. State it as a rule
  ("`/maintenance` redirects to Settings"), not as a story.
- History belongs only in `docs/history/` (release notes, with pending changes
  and per-release upgrade steps in `unreleased.md`) and in the context of ADRs
  in `docs/decisions/`.
- Reference docs contain no TODOs, plans, roadmaps, or dated measurement logs.
- State each rule or fact in one place and link to it instead of restating it.
- When an English user page changes, update the matching locale pages in the
  same change. If a translation cannot be updated, remove the stale passage
  rather than leave it contradicting the English page.

## Validation Commands

The `Makefile` is the canonical entry point for repository validation. Prefer
its targets over reconstructing CI commands by hand, so local checks and GitHub
Actions continue to exercise the same commands. Use a direct command only when
the Makefile has no target for the required check.

- Use the smallest sufficient target for the change: `make frontend-docs` for
  public documentation, `make ci-style` for frontend style checks,
  `make ci-backend` for backend behavior, and `make ci-frontend` for frontend
  behavior.
- Use `make smoke` for Docker/runtime changes, `make frontend-e2e` for browser
  workflow changes, `make android-test android-build` for Android changes,
  `make ios-build`
  for iOS shell changes on macOS with Xcode, and
  `make DOCKER_IMAGE=kikoto:ci docker-build` for production image changes.
- `make ci-local` runs the complete locally portable Actions sequence, including
  Docker validation but excluding the Android SDK build. `make ci` adds the
  Android build and is the full local equivalent when its toolchain is
  available.
- Keep validation proportional: do not run the full aggregate target for a
  narrow change when its affected target is sufficient.
- Before every commit, run `make sensitive-check` and review any findings. It
  scans tracked changes against `HEAD` plus untracked files, so run it before
  committing rather than after. This privacy check is intentionally
  separate from the GitHub Actions validation sequence.
- Do not bypass the privacy scan with source comments. An approved built-in
  public endpoint belongs in `scripts/privacy-allowlist.json` with its
  repository-relative owner files and a reason. Prefer an exact URL; use a
  path-only `*`/`**` wildcard only for a stable public namespace, as described
  in
  [Before Committing](docs/development/testing.md#before-committing). Review
  every change to that list before committing.

## Release and Handoff

Use the repository's normal signed-commit path. If the 1Password signing agent
requires approval or is unavailable, stop and ask the user. Do not disable
commit signing, pass a no-sign flag, replace the configured signer, or otherwise
bypass the agent.

Release and migration boundaries are derived from repository state:

- Read `VERSION` for the application version; do not hard-code the current
  release in agent instructions or infer it from an old release note.
- `001_initial.sql` and every numbered migration after it are immutable once
  released. Add the next contiguous number after the highest existing
  migration for a schema change; never edit an applied migration.
- An empty database applies the highest baseline the mode reads, then any
  later numbered migrations. Released baselines live in `baseline/`;
  development baselines of the unreleased chain live in `compat/`, which only
  `KIKOTO_MODE=development` reads. After a numbered migration changes, run
  `go generate ./migrations` to refresh the development baseline. A release
  runs the generator with `-release`, which writes a released baseline only
  when the chain changed and clears `compat/`. Never add a second released
  baseline for an existing schema version.
- Existing databases must continue through the numbered migration chain and
  must never be reconstructed from a fresh-install baseline.
- Before release or migration work, inspect `VERSION`, the highest numbered
  migration, and the baseline filenames in `baseline/` and `compat/`. Details
  are in [Migrations](docs/development/migrations.md); release steps are in
  [Commit And Release](docs/development/commit-and-release.md#release-steps).

Before handoff, run the smallest sufficient targets from
[Validation Commands](#validation-commands), then `make sensitive-check`.

Public tracked code and docs must use generic remote-source examples, reserved
domains, and obviously synthetic identifiers. Never commit real configured
source names, endpoints, credentials, personal paths, logs, databases, or work
records. Ignore rules are not a secrecy boundary; keep deployment details in an
access-controlled system outside the repository workspace whenever possible.
