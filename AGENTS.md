# Agent Guide

Kikoto is a local-first, self-hosted library and player for purchased audio
works: a Go backend, a React frontend, and Android and iOS shells.

## Where To Read Next

Before changing files under a path, read its guide, then open only the doc
pages it names.

| Path | Guide |
| --- | --- |
| `frontend/` | [`frontend/AGENTS.md`](frontend/AGENTS.md) |
| `backend/` | [`backend/AGENTS.md`](backend/AGENTS.md) |
| `backend/migrations/`, release or schema work | [`backend/migrations/AGENTS.md`](backend/migrations/AGENTS.md) |
| `docs/`, `README*`, any public Markdown | [`docs/AGENTS.md`](docs/AGENTS.md) |
| A recurring procedure | [`.claude/skills/`](.claude/skills/README.md); follow a `SKILL.md` whose description matches |

## Product Invariants

- `work` is the unified `primary_code` entity. Folders, cache entries, remote
  sources, and catalogs only describe its presence, locations, or metadata
  snapshots; never create a second work identity for any of them.
- Metadata sources (what a work is) and file sources (where it plays) are
  separate. Source names and icons are data: branch on declared capabilities
  and source type, never on a display name or service brand.
- Catalog discovery is not permission to materialize every code as a `work`;
  local, tracked, cached, or requested works are the automatic metadata roots.
  Stop and discuss before broadening a provider crawl or redesigning identity
  away from DLsite-style `primary_code`.
- Fetch publication directories (`.kikoto-staging`, `.kikoto-backup`,
  `.kikoto-trash`) stay on the target pool's filesystem (data root, or
  `/data/<pool>`) so publication and rollback are same-filesystem renames.
  Durable transaction or review state never moves to `/cache`, and pools
  never share a transaction directory.
- A scan never marks works missing where it cannot see: an unmounted root, an
  offline pool without `.kikoto-pool`, or folders below the scan depth. New
  scan, watcher, and cleanup paths keep that pool scope.
- Every new or changed outbound HTTP path follows the [Outbound HTTP checklist](backend/AGENTS.md#outbound-http).

## Validation

The `Makefile` is canonical; use a direct command only when it has no target.
Run the smallest sufficient target, not an aggregate, for a narrow change.

| Change | Target |
| --- | --- |
| Public docs | `make frontend-docs` |
| Frontend style / frontend / backend behavior | `make ci-style` / `ci-frontend` / `ci-backend` |
| Browser workflow / Docker runtime | `make frontend-e2e` / `make smoke` |
| Android / iOS (macOS) | `make android-test android-build` / `make ios-build` |
| Production image | `make DOCKER_IMAGE=kikoto:ci docker-build` |
| Everything portable / plus Android | `make ci-local` / `make ci` |

- Redirect slow targets (`make ci-*`, `frontend-e2e`, `smoke`) to a log file
  outside tracked paths and read it; do not re-run to see another part. Known
  traps: [Local Pitfalls](docs/development/testing.md#local-pitfalls).
- Tests protect a user-visible behavior, contract, state transition, or
  regression at the lowest sufficient layer, once
  ([Value Gate](docs/development/testing.md#value-gate)); fixtures follow
  [Synthetic Fixture Data](docs/development/testing.md#synthetic-fixture-data).
- Before every commit and handoff, run `make sensitive-check` and review it;
  Actions does not run it. Never bypass it with comments: an approved public
  endpoint goes in `scripts/privacy-allowlist.json` per
  [Before Committing](docs/development/testing.md#before-committing).

## Release and Handoff

- Commit through the normal signed path. If the 1Password agent needs approval
  or is unavailable, stop and ask; never disable or replace signing. Merge per
  [Merging Into main](docs/development/commit-and-release.md#merging-into-main).
- Do not push, open or update a PR, or post on issues, discussions, or reviews
  without the user's explicit approval; draft the text first.
- Never invent identifiers. Versions come from `VERSION`; migration numbers,
  issue and PR numbers, tags, and catalog codes come from the repository, the
  user, or the issue; ask when none applies. Commit, issue, and PR text name
  functions, files, settings, and targets, never line numbers.
- Tracked files use generic source examples, reserved domains, and synthetic
  identifiers. Never commit real source names, endpoints, credentials,
  personal paths, logs, databases, or work records; ignore rules are not a
  secrecy boundary.

## Documentation

Docs describe the current system in present tense; history lives only in
`docs/history/` and ADRs. The full writing rules are in
[`docs/AGENTS.md`](docs/AGENTS.md).
