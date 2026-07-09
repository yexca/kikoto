# Circles

Circles represent makers, circles, and related party catalog state.

## Current Behavior

- Lists known parties with catalog and availability counts.
- Provides search, filters, pagination, favorite state, user tags, rating, and
  notes.
- Shows circle detail by external id.
- Supports catalog refresh in incremental or full mode.
- Stores catalog rows separately from imported works.
- Shows local/cache/remote source availability tags for catalog works.
- Allows stale catalog rows to be removed after confirmation.

## Boundary

Circle catalogs explain what a party has published. They do not create concrete
playback locations until a source sync or fetch creates media locations.

## Refresh Behavior

Incremental refresh should prefer newest catalog rows and stop when known rows
are reached. Full refresh can walk more provider pages but should not delete old
catalog rows automatically.

## Related Docs

- [Library](library.md)
- [Sources](sources.md)
- [Workflows](workflows.md)
