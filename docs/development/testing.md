# Testing

## Backend

```sh
cd backend
go test ./...
```

Backend tests are organized by boundary:

- Package unit tests stay beside the production files as `*_test.go`. They may
  use the production package name when they need to verify unexported logic.
- Public API and cross-package database tests live under
  `backend/tests/integration` and use an external `integration_test` package.
- Process, container, and restart-interruption tests should live in a dedicated
  suite under `backend/tests` instead of importing handler internals.

Do not export production identifiers only to move a white-box test into the
integration suite. Extract a domain service first, then test its public
contract.

## Frontend

```sh
cd frontend
npm install
npm run lint
npm run test:unit
npm run build
```

Vitest unit and component tests stay beside their source under `frontend/src`.
Playwright browser tests live under `frontend/tests/e2e`; Android JVM and device
tests use the standard Gradle `src/test` and `src/androidTest` source sets.

## Smoke Test

```sh
make smoke
```

## Before Committing

- Run relevant tests.
- Check `git status`.
- Check for secrets or runtime data.
- Update public docs for behavior changes.

## Suggested Routine

For a backend-only change:

1. Run `cd backend && go test ./...`
2. Review affected public docs.
3. Check git-tracked changes for sensitive paths or data.

For a frontend-facing change:

1. Run backend tests if API behavior changed.
2. Run frontend lint, unit tests, and the production build.
3. Run the relevant Playwright project for interaction changes.
4. Check the affected product docs and README links.

## Related Docs

- [Local development](local-dev.md)
- [Commit and release](commit-and-release.md)
