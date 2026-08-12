# Agent Guide

Read these first:

- `README.md`
- `docs/overview.md`
- `docs/architecture/core-boundaries.md`
- `docs/architecture/data-model.md`
- `docs/architecture/workflows.md`
- `docs/architecture/backend.md`
- `docs/architecture/frontend.md`
- `DESIGN.md`
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
- During the first stable-version phase, DLsite-style `primary_code` remains the
  main identity key. Do not redesign around source-local ids or a new identity
  system until the current product is stable.

Fetch publication directories such as `.kikoto-staging`, `.kikoto-backup`, and
the reviewable `.kikoto-trash` must remain on the `/data` filesystem so
publication and rollback can use same-filesystem rename semantics. Do not move
durable transaction or review state to disposable `/cache` storage.

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

- Follow `DESIGN.md`. Preserve the global player across navigation and
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

## Release and Handoff

Use the repository's normal signed-commit path. If the 1Password signing agent
requires approval or is unavailable, stop and ask the user. Do not disable
commit signing, pass a no-sign flag, replace the configured signer, or otherwise
bypass the agent.

Current release boundary:

- `001_initial.sql` is the immutable v0.1.0 database.
- `002_v0_1_1.sql` is the consolidated v0.1.1 upgrade.
- Migrations `003` through `027` are the current numbered chain.
- `VERSION` currently reports v0.4.1; add migration `028` for the next schema
  change. Do not edit a released migration.

Before handoff, run validation proportional to the change:

- Backend tests, vet, and race coverage for backend behavior.
- Frontend lint, unit tests, build, and relevant Playwright coverage for UI or
  client behavior.
- Docker validation for image, Compose, mount, or runtime changes.
- `npm run docs:check-links` from `frontend` for public documentation changes.
- A tracked-file privacy scan over the actual diff.

Public tracked code and docs must use generic remote-source examples, reserved
domains, and obviously synthetic identifiers. Never commit real configured
source names, endpoints, credentials, personal paths, logs, databases, or work
records. Ignore rules are not a secrecy boundary; keep deployment details in an
access-controlled system outside the repository workspace whenever possible.
