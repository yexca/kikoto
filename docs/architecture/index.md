# Architecture

Kikoto is organized around a single rule:

```text
Metadata sources and file sources are separate.
```

Metadata sources answer what a work is. File sources answer where playable or
downloadable files are.

## Architecture Topics

- [Core boundaries](core-boundaries.md)
- [Backend](backend.md)
- [Frontend](frontend.md)
- [Data model](data-model.md)
- [Workflows](workflows.md)
- [Source presence](source-presence.md)

## When To Read What

- Read [Core boundaries](core-boundaries.md) before changing identity,
  metadata, source, or user-state behavior.
- Read [Source presence](source-presence.md) before changing source
  availability, tracking, cache, or fetch flows.
- Read [Data model](data-model.md) before editing migrations.
- Read [Workflows](workflows.md) before adding background or reviewable work.
- Read [Backend](backend.md) and [Frontend](frontend.md) before changing module
  layout or API/UI responsibilities.

## Runtime Topology

```text
Browser
  -> React frontend
  -> Go HTTP API
  -> SQLite
  -> local filesystem, cache, metadata providers, and file source adapters
```

The current implementation is synchronous-first but records workflow state so
later async workers can attach to the same model.

## Related Docs

- [Product specs](../product/index.md)
- [Backend guidelines](../development/backend-guidelines.md)
- [Migrations](../development/migrations.md)
- [ADR index](../decisions/index.md)
