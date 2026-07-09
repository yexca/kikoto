# Backend Guidelines

## Principles

- Keep metadata sources and file sources separate.
- Do not create separate work identities per source.
- Prefer idempotent workflow steps.
- Preserve local and cached state when remote sources fail.
- Sanitize user-facing source errors.

## Validation

```sh
cd backend
go test ./...
```

## Documentation

Update architecture docs for boundary or persistence changes. Update product
docs for user-visible behavior changes.
