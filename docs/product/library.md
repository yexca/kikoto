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
- Shows compact DL sales and a five-segment non-numeric rating comparison in one
  metrics row. A playback-history icon appears when a persisted cursor exists.
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
- Uses the same responsive grid for work collections across the Library,
  Favorites, circle detail, and voice detail surfaces. Column choices are
  shared instead of being reimplemented per page.
- Persists the selected work-collection column settings locally and applies
  them across Library, Favorites, circle work collections, and voice work
  collections.
- Supports stable seeded random ordering. A seed keeps pagination consistent;
  reshuffling creates a new seed rather than reversing an order.
- Defaults new Library views to personalized recommendation ordering while
  preserving history/session-restored browse choices. Canonical URLs retain
  only the query and non-default listening status; legacy explicit browse
  parameters remain readable. Recommendation placement separates listening
  intent from affinity: Listening and Want receive leading slots, Unmarked
  remains the primary discovery pool, Relisten and Finished receive bounded
  insertions, and Shelved waits until scheduled states are exhausted. Explicit
  status filters still return every matching work. Within each state, a bounded
  affinity score uses favorite, tag, voice, and circle signals without treating
  the candidate itself as taste history. A seeded discovery boost and result
  variation adjust that affinity only for the current within-state ordering;
  badges and telemetry retain the bounded affinity score. Relisten and favorite history are
  positive evidence; Finished alone is neutral. Each browser tab or native-app
  launch binds to an immutable recommendation generation, so navigation,
  pagination, filters, card mutations, and toolbar reshuffles do not recompute
  affinity. Favorite and listening changes remain visible on cards immediately
  but affect placement in the next client session. A new session rebuilds the
  generation only when recommendation inputs changed; otherwise it reuses the
  current generation with a new stable seed. The seed keeps both state mixing
  and within-state variety pagination-safe, and the toolbar refresh action
  changes only that seed within the current generation.
- Shows a compact, horizontally scrollable recently-played strip above the
  Library controls. It is ordered per user from the one cursor owned by each
  logical work family and includes the latest track position without replacing
  the full work-card grid. The
  strip can be collapsed, and that preference is kept in the browser.
- Uses one shared query across Local, Tracked, and configured remote sources.
  Each source retains its own pagination, sort, and scroll state, while grid
  column settings remain shared. A source cannot restore stale query text after
  the user clears it elsewhere.
- Keeps the active Local, Tracked, or remote-source page size in the first-row
  action toolbar and leaves the compact top pagination focused on result context
  and page navigation.
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
list, favorite filters, ordering, seed, pagination, selection, and work anchor are
restored from the current history entry with user-scoped session fallback.
`All Favorites` aggregates works with a Quick mark and works in any user list.
`Marked` is the fixed system list containing only works whose Quick mark is not
Unmarked; its membership is derived and cannot be edited as a list. Other
lists are user-created and keep explicit membership. Switching lists keeps the
full favorite-list row stable while results load, and Shelved is the final
listening-state option. Playback cursors alone never add a work to Favorites.
The source picker can refine favorite works to any of several selected
configured file sources without creating per-source work copies or requesting
a live remote refresh. List creation and contextual list management share the
fixed overflow menu beside the horizontally scrollable list row.

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
