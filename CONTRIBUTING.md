# Contributing

Thanks for helping improve Kikoto. This project is still evolving quickly, so
small, focused changes are easiest to review and keep stable.

## Before Changing Code

Read the public docs that match the area you are changing:

- Architecture changes: `docs/architecture/`
- User-facing behavior: `docs/product/`
- Runtime or deployment behavior: `docs/operations/`
- Development workflow: `docs/development/`
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

## Validation

Backend:

```sh
cd backend
go test ./...
```

Frontend:

```sh
cd frontend
npm install
npm run build
```

Full Docker stack:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

## Documentation Rules

- Put stable public documentation under `docs/`.
- Put product behavior in `docs/product/`.
- Put system boundaries and module design in `docs/architecture/`.
- Put runtime setup, configuration, reliability, and troubleshooting in
  `docs/operations/`.
- Put local development and test instructions in `docs/development/`.
- Capture durable architectural decisions as ADRs in `docs/decisions/`.

## Sensitive Data Check

Before committing, check for:

- Real remote source URLs or credentials.
- Local filesystem paths that reveal private data.
- SQLite databases.
- Cached covers or media files.
- Personal notes, samples, or logs.
