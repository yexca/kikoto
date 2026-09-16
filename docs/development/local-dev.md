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

- Backend tests: [Testing](testing.md)
- Frontend build: [Testing](testing.md)
- Database changes: [Migrations](migrations.md)
- Security-sensitive changes: [Secure development](security.md)
- Commit format: [Commit and release](commit-and-release.md)

## Useful Paths

- Backend API: `backend/internal/httpapi`
- Frontend source: `frontend/src`
- Migrations: `backend/migrations`
- Public docs: `docs`

## Related Docs

- [Backend guidelines](backend-guidelines.md)
- [Frontend guidelines](frontend-guidelines.md)
- [Architecture](../architecture/index.md)
