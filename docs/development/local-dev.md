# Local Development

## Backend

```sh
cd backend
go run ./cmd/kikoto
```

## Frontend

```sh
cd frontend
npm ci --strict-allow-scripts
npm run dev
```

## Docker

Run from the repository root. `make docker-up` uses the same configuration:

```sh
docker compose --project-directory . -f deploy/compose/dev.yml up -d --build
```

The project directory keeps `.env`, build contexts, and `config/`, `cache/`,
and `data/` mounts at their existing repository-root locations.

## Common Checks

Tests and validation targets are in [Testing](testing.md), database changes in
[Migrations](migrations.md), security-sensitive changes in
[Secure development](security.md), and the commit format in
[Commit and release](commit-and-release.md).

## Useful Paths

- Backend API: `backend/internal/httpapi`
- Frontend source: `frontend/src`
- Migrations: `backend/migrations`
- Public docs: `docs`

## Related Docs

[Backend guidelines](backend-guidelines.md),
[Frontend guidelines](frontend-guidelines.md), and
[Architecture](../architecture/index.md).
