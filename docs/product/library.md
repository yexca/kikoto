# Library

The Library is the main browsing surface for works.

## Current Behavior

- Shows local, tracked, and configured remote source tabs.
- Uses server-side pagination for large result sets.
- Searches normalized titles, codes, language-edition aliases, circles, tags,
  and voice credits before hydrating the current page. Provider-declared edition
  codes remain searchable without creating extra works or scanning raw metadata
  snapshots during a Library request.
- Shows cover, title, code, circle, rating, tags, voice metadata, local
  availability, source tags, and quick listening marks when available.
- Shows the current price when normalized commercial metadata is available and
  labels zero-price works as Free.
- Shows the signed-in user's work tags separately from metadata tags on unified
  work cards and detail. `mytag:` filters personal tags without changing the
  provider `tag:` search meaning.
- Keeps source availability visually separate from metadata tags.
- Shows known age ratings beside the circle name on work cards while retaining
  the complete age metadata in work detail.
- Offers the same grid or masonry presentation for work collections across the
  Library, Favorites, circle detail, and voice detail surfaces. Responsive
  column choices are shared instead of being reimplemented per page.
- Persists the selected work-collection layout locally and applies it across
  Library, Favorites, circle work collections, and voice work collections.
- Supports stable seeded random ordering. A seed keeps pagination consistent;
  reshuffling creates a new seed rather than reversing an order.
- Defaults new Library views to personalized recommendation ordering while
  preserving explicit URL and session-restored browse choices.
- Shows a compact, horizontally scrollable recently-played strip above the
  Library controls. It is ordered per user, deduplicated by work, and includes
  the latest track position without replacing the full work-card grid. The
  strip can be collapsed, and that preference is kept in the browser.
- Provides database-oriented diagnostic scopes for works that do not currently
  appear in everyday source tabs.
- When `KIKOTO_MODE=demo`, backend list, detail, and media responses admit
  only all-ages, permanently free works. Local works use normalized commercial
  metadata, where unknown metadata and temporary free promotions are excluded;
  Remote Sources use their filtered search contract. Demo sessions can play
  admitted full media but cannot mutate library, settings, or workflow state.

Work cards use the same summary model on every collection surface, including
voice credits when they are known. Compact cards show at most two voice names
and summarize additional credits without allowing metadata to grow the card
unboundedly.

Favorites keeps its shelf filters and pagination in the URL. Returning from a
work detail restores the current-page selection and the originating work
anchor after that shelf page has rendered.

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
