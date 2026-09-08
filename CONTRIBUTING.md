# Contributing

Thanks for helping improve Kikoto. This project is still evolving quickly, so
small, focused changes are easiest to review and keep stable.

## Before Changing Code

Read the public docs that match the area you are changing:

- Architecture changes: `docs/architecture/`
- User-facing behavior: `docs/user/` and `docs/product/`
- Runtime or deployment behavior: `docs/operations/`
- Development workflow: `docs/development/`
- Security-sensitive implementation: `docs/security/` and
  `docs/development/security.md`
- Major design decisions: `docs/decisions/`

## Core Rules

- Keep metadata sources and file sources separate.
- Do not split one work into separate identities per source.
- Do not commit runtime data, local media, cached covers, SQLite databases,
  secrets, or personal source details.
- Update public documentation when behavior changes.
- Keep changes scoped to the feature or fix being implemented.

## Commit Messages

Use:

```text
<type>(scope): <description>
```

Examples:

```text
feat(player): add queue controls
fix(scan): skip unavailable folders
docs(sources): describe health checks
```

## Security Reports

Do not disclose suspected vulnerabilities in public issues, discussions, or
pull requests. Follow the private reporting process in the
[Security Policy](SECURITY.md).

## Validation

The Makefile is the canonical validation entry point. Use the smallest target
that covers the files you changed:

```sh
make frontend-docs       # public documentation and link checks
make ci-style            # frontend format/lint/docs and privacy-test checks
make ci-backend          # backend format/lint/tests/vet/race/vulnerability checks
make ci-frontend         # frontend audits, unit coverage, and build
make smoke               # Docker/runtime changes
make frontend-e2e        # browser workflow changes
```

For a complete locally portable check, run `make ci-local`; `make ci` also
builds Android when its toolchain is available. Before every commit, run the
privacy scan against the actual working tree diff:

```sh
make sensitive-check
```

Direct commands can be useful for focused iteration, but they do not replace
the corresponding Makefile target. For example:

```sh
cd backend
go test ./...
```

Frontend:

```sh
cd frontend
npm ci --strict-allow-scripts
npm run docs:check-links
npm run build
```

Full Docker stack:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

## Documentation Rules

- Put stable public documentation under `docs/`.
- Put user entry points under `docs/user/`.
- Put product behavior in `docs/product/`.
- Put system boundaries and module design in `docs/architecture/`.
- Put runtime setup, configuration, reliability, and troubleshooting in
  `docs/operations/`.
- Put local development and test instructions in `docs/development/`.
- Use `docs/security/` to map reporting, deployment, development, and privacy
  security guidance.
- Capture durable architectural decisions as ADRs in `docs/decisions/`.

## Sensitive Data Check

Before committing, check for:

- Real remote source URLs or credentials.
- Local filesystem paths that reveal private data.
- SQLite databases.
- Cached covers or media files.
- Personal notes, samples, or logs.

Use reserved domains and the repository-reserved identifiers in
[Synthetic Fixture Data](docs/development/testing.md#synthetic-fixture-data) for
public fixtures. Review the actual staged diff, not only the files you intended
to change. See [Secure Development](docs/development/security.md) for outbound
request, error, filesystem, and privacy-review requirements.
