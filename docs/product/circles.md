# Circles

Circles represent makers, circles, and related party catalog state.

## Current Behavior

- Lists known parties in server-paged results with per-card catalog and
  availability state.
- Provides search, filters, URL-backed pagination, favorite state, user tags,
  rating, and notes.
- Uses a Library-style first-row toolbar: search stays on the left and the
  page-size and circle-filter actions (defaulting to `All circles`) stay on the
  right; narrow layouts collapse search into the toolbar actions.
- Shows the latest known DLsite work code and locally cached cover in compact
  responsive creator cards, with a `No cover` fallback.
- Summarizes each circle card with its sync state and one canonical
  `Available N/total` badge instead of separate local and remote counts.
- Shows circle detail by external id.
- Supports catalog refresh in incremental or full mode.
- Stores catalog rows separately from imported works.
- Shows local/cache/remote source availability tags for catalog works.
- Presents work results with the same responsive grid and work cards as the
  Library. This applies to both circle detail and circle series;
  the separate circle-entity list keeps its own controls.
- Shows one `Available N` badge beside user-defined tags on circle detail. The
  duplicated statistic tiles and circle aliases are omitted from circle UI.
- Keeps the two common refresh actions in the detail summary and moves targeted
  catalog, metadata, and source refresh modes into an anchored Advanced
  popover.
- Shortens the common detail actions on mobile, keeps icon-only Favorite,
  Advanced, and DLsite controls accessible by name, and places DLsite last.
- Keeps mobile work controls to the Works/Series switch, search, and one Catalog
  options action. Availability, mobile columns, and selection mode live in that
  sheet; wide layouts retain inline controls.
- Treats the mobile detail back control as Up to the last server-and-user-scoped
  Circles list location, including when the detail was opened from Library.
  Wide layouts keep the source-aware history return label and destination.
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
