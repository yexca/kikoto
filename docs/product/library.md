# Library

The Library is the main browsing surface for works.

## Current Behavior

- Shows local, tracked, and configured remote source tabs.
- Uses server-side pagination for large result sets.
- Shows cover, title, code, circle, rating, tags, voice metadata, local
  availability, source tags, and quick listening marks when available.
- Keeps source availability visually separate from metadata tags.
- Provides database-oriented diagnostic scopes for works that do not currently
  appear in everyday source tabs.

## Identity

Library cards represent unified works, not per-source copies. Remote cards can
track or sync a work before it has local files, but the resulting state attaches
to the same unified work identity.

## Source Tabs

Source tabs should help users answer where a work can be played or fetched from.
They are not separate libraries with separate metadata ownership. Local,
tracked, cache, and remote facts all point back to the same work model.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Core boundaries](../architecture/core-boundaries.md)
