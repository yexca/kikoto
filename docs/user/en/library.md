# Library
[English](../en/library.md) · [简体中文](../zh-Hans/library.md) · [繁體中文](../zh-Hant/library.md) · [日本語](../ja/library.md) · [한국어](../ko/library.md)

The Library is the main browsing surface for works.

## Current Behavior

- Shows local, tracked, and configured remote source tabs.
- Uses server-side pagination for large result sets.
- Searches normalized titles, codes, language-edition aliases, circles, tags,
  and voice credits before hydrating the current page. Provider-declared edition
  codes remain searchable without creating extra works or scanning raw metadata
  snapshots during a Library request.
- Matches search text literally and ignores width, letter case, and kana
  script: `100%` and `a_b` are not wildcards, full-width `ＡＢＣ` finds `abc`, and
  katakana finds the same word written in hiragana. Prefix a term with a
  clause such as `tag: 癒し`, `circle:`, `va:`, or `mytag:` to search one field.
- A DLsite tag also matches its name in every language Kikoto has fetched for
  that tag: when an edition requested in English reports `Healing` for the tag
  shown as `癒し`, `tag: healing` finds both. Results whose tag, title, circle,
  or voice credit equals the search term exactly appear before partial matches,
  and the selected sort orders each group.
- The `+` button in the search field opens a floating editor for a
  structured search condition. Selecting a condition badge edits it in the same
  popover without moving the results.
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
  only the query and non-default listening status; explicit browse parameters
  in a link are still read. Recommendation placement separates listening
  intent from affinity: Listening and Want receive leading slots, Unmarked
  remains the primary discovery pool, Relisten and Finished receive bounded
  insertions, and Shelved waits until scheduled states are exhausted. Explicit
  status filters still return every matching work. Within each state, a bounded
  affinity score uses favorite, tag, voice, and circle signals without treating
  the candidate itself as taste history. Repeated positive feedback strengthens
  each matched signal up to five supporting works, and common tags carry less
  weight. A seeded discovery boost favors weaker evidence; independent result
  variation adjusts that affinity only for the current within-state ordering;
  a small creator diversity adjustment also affects ordering. Badges and
  telemetry retain the bounded affinity score. Relisten and favorite history are
  positive evidence; Finished alone is neutral. Each browser tab or native-app
  launch binds to an immutable recommendation generation, so navigation,
  pagination, filters, card mutations, and toolbar reshuffles do not recompute
  affinity. Favorite and listening changes remain visible on cards immediately
  but affect placement in the next client session. A new session rebuilds the
  generation only when recommendation inputs changed; otherwise it reuses the
  current generation with a new stable seed. The seed keeps both state mixing
  and within-state variety pagination-safe, and the toolbar refresh action
  changes only that seed within the current generation.
- Remote recommendation badges also score works that have not been imported,
  using known localized tags and creator aliases. Turning badges on scores the
  current page in one batch without reloading the remote source, then reveals
  badges progressively (with reduced motion respected). Only scores meeting
  your badge threshold are shown. A score failure leaves the works available
  and offers Retry. Remote scores use the same frozen session preference profile
  and do not import any works.
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
- Keeps database cleanup out of Library. Metadata -> No available source
  provides paged search, source checks, and confirmed local-information
  deletion for logical families with no available source or media location.
- `/no-source` and `/library/no-source` links open Metadata -> No available
  source; `/library/all` and `/library/remote` links open the Library.
- When `KIKOTO_MODE=demo`, backend list, detail, and media responses admit
  only all-ages, permanently free works. Local works use normalized commercial
  metadata, where unknown metadata and temporary free promotions are excluded.
  The simulated Remote Kikoeru source only republishes admitted local works.
  Demo sessions can play admitted full media but cannot mutate library,
  settings, or workflow state.

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
a live remote refresh.

On wide screens a shelf rail beside the results lists All Favorites, Marked,
your lists, and followed circles and voice actors with their counts. Like the
Workflows and Settings rails, it can hide its names and keep only icons, and the
choice is remembered on that device. Each user list can show an icon chosen in
Edit lists, which is what tells the lists apart in the icon rail; the list icon
also appears in the add-to-list menus. Phones show the same shelves as one
scrollable row. The open shelf has a header with a cover mosaic, its count, how
many works are finished, and the works you are listening to. Works can be shown
as cards or as a denser list with each work's resume point.

## Identity

Library cards represent unified works, not per-source copies. Remote cards can
track or sync a work before it has local files, but the resulting state attaches
to the same unified work identity. Track also persists the selected source tree
and opens that source in Tracked.

## Source Tabs

Source tabs should help users answer where a work can be played or fetched from.
They are not separate libraries with separate metadata ownership. Local,
tracked, cache, and remote facts all point back to the same work model.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Core boundaries](../../architecture/core-boundaries.md)
