# Library

The Library is the main browsing surface for works.

## Current Behavior

- Shows local, tracked, and configured remote source tabs.
- Uses server-side pagination for large result sets.
- Searches normalized titles, codes, language-edition aliases, circles, tags,
  and voice credits before hydrating the current page. Provider-declared edition
  codes remain searchable without creating extra works or scanning raw metadata
  snapshots during a Library request.
- Shows cover, title, code, Circle / Series on one ellipsized line, voice
  metadata, local availability, source tags, and quick listening marks when
  available.
- Measures provider tags into at most two card rows. A `+N` badge opens hidden
  tags in a popover; personal tags remain a separate user-owned row.
- Replaces card date and playback-history rows with compact DL sales and a
  five-segment non-numeric rating comparison.
- Shows a language icon only when the database knows an available non-Origin
  edition through an enabled source. Unknown or metadata-only language relations
  do not imply availability.
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
  preserving history/session-restored browse choices. Canonical URLs retain
  only the query and non-default listening status; legacy explicit browse
  parameters remain readable. Recommendation
  scores use bounded personal listening, favorite, tag, voice, and circle
  signals without treating the candidate itself as taste history. Equal-score
  works use the same stable browse seed for pagination-safe variety, and the
  toolbar refresh action creates a new recommendation seed.
- Shows a compact, horizontally scrollable recently-played strip above the
  Library controls. It is ordered per user from the one cursor owned by each
  logical work family and includes the latest track position without replacing
  the full work-card grid. The
  strip can be collapsed, and that preference is kept in the browser.
- Uses one shared query across Local, Tracked, and configured remote sources.
  Each source retains its own pagination, sort, layout, and scroll state, but
  cannot restore stale query text after the user clears it elsewhere.
- Keeps database cleanup out of Library. Maintenance -> Unlinked works provides
  paged search, source checks, and confirmed local-information deletion for
  logical families with no available source or media location.
- Legacy No source Library links redirect to the Unlinked works maintenance tab;
  legacy aggregate Library links return to the normal Library.
- When `KIKOTO_MODE=demo`, backend list, detail, and media responses admit
  only all-ages, permanently free works. Local works use normalized commercial
  metadata, where unknown metadata and temporary free promotions are excluded;
  Remote Sources use their filtered search contract. Demo sessions can play
  admitted full media but cannot mutate library, settings, or workflow state.

Work cards use the same summary model on every collection surface, including
voice credits when they are known. Compact cards show at most two voice names
and summarize additional credits without allowing metadata to grow the card
unboundedly.

Favorites keeps only entity/search intent in the canonical URL. Its selected
list, shelf filters, ordering, seed, pagination, selection, and work anchor are
restored from the current history entry with user-scoped session fallback.
Switching lists keeps the full favorite-list row stable while results load, and
Shelved is the final listening-state option.

## Identity

Library cards represent unified works, not per-source copies. Remote cards can
track or sync a work before it has local files, but the resulting state attaches
to the same unified work identity. Track also persists the selected source tree
and opens that source in Tracked, so a second Fork is not required.

## Source Tabs

Source tabs should help users answer where a work can be played or fetched from.
They are not separate libraries with separate metadata ownership. Local,
tracked, cache, and remote facts all point back to the same work model.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Core boundaries](../architecture/core-boundaries.md)
