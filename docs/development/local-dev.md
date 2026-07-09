# Local Development

## Backend

```sh
cd backend
go run ./cmd/kikoto
```

## Frontend

```sh
cd frontend
npm install
npm run dev
```

## Docker

```sh
docker compose up -d --build
```

## Common Checks

- Backend tests: [Testing](testing.md)
- Frontend build: [Testing](testing.md)
- Database changes: [Migrations](migrations.md)
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
