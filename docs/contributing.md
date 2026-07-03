# Contributing

## Development Principles

- Keep metadata sources and file sources separate.
- Do not commit runtime data, local media, cached covers, databases, or secrets.
- Prefer small, focused changes.
- Keep Docker-based validation working.
- Update public documentation when behavior changes.

## Commit Messages

Use:

```text
<type>(scope): <description>
```

Examples:

```text
feat(player): add queue controls
fix(scan): skip unavailable folders
docs(api): describe media streaming
```

## Validation

Backend:

```sh
docker run --rm -v "${PWD}/backend:/src" -w /src golang:1.22 go test ./...
```

Frontend:

```sh
docker run --rm -v "${PWD}/frontend:/src" -w /src node:22 sh -c "npm install && npm run build"
```

Full stack:

```sh
docker compose up -d --build
```

## Sensitive Data

Before committing, check for:

- Local filesystem paths.
- Real library data.
- Databases.
- Cached covers.
- Credentials.
- Personal notes or samples.
