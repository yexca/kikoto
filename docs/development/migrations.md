# Migrations

Database migrations live in `backend/migrations/`.

## Current Practice

Kikoto is still early in product shaping. The current first-version schema may
be represented as one initial migration rather than a long chain of compatibility
migrations.

## Guidelines

- Keep schema changes aligned with the unified work model.
- Preserve source and metadata boundaries.
- Avoid adding legacy compatibility paths that are unnecessary for a fresh
  first-version database.
- Update [Data model](../architecture/data-model.md) when schema meaning
  changes.
