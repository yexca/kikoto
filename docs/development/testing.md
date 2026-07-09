# Testing

## Backend

```sh
cd backend
go test ./...
```

## Frontend

```sh
cd frontend
npm install
npm run build
```

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
2. Run `cd frontend && npm install && npm run build`
3. Check the affected product docs and README links.

## Related Docs

- [Local development](local-dev.md)
- [Commit and release](commit-and-release.md)
