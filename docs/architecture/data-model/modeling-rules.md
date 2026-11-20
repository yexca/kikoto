# Modeling Rules

Cross-table rules for where a fact belongs and how derived search state behaves; read before adding or changing a table.

- Source-level facts go in `work_source_presence`.
- Concrete local, cache, stream, and download paths go in `media_file_location`.
- Provider snapshots stay available for traceability even when normalized work
  fields are updated.
- Catalog discovery may retain a canonical code without materializing a `work`;
  only an existing, tracked, local, cached, or explicitly requested work is a
  metadata root.
- Interactive code and text search reads normalized metadata and aliases rather
  than scanning raw provider snapshot JSON.
- `work_search` is a derived FTS5 trigram index with one row per work
  (`rowid = work.id`) holding folded code/alias, title, circle, voice actor,
  and tag text, including relevant manual overrides, plus one column per staff
  role (`staff_author`, `staff_scenario`, `staff_illustration`, `staff_music`,
  `staff_other`). A role clause reads its column, `staff:` reads every staff
  column, and plain text reads every column. The title column also
  holds the work's own `dlsite_metadata_variant` title and, for a work without
  non-remote metadata, its `remote_metadata_title_variant` titles, so each
  stored edition title matches independently of the projected `work.title`.
  A bundle's code and title columns also hold its members' codes and library
  titles; see [Bundles](overrides-normalized-fields-bundles.md#bundles).
  The tag column also holds every learned `dlsite_genre_name` for the work's
  genre ids, so a tag matches in each language the library has fetched.
  Matching remains a substring test; a Library page orders works whose indexed
  value equals a text, circle, voice, staff, or tag needle exactly ahead of
  partial matches, then applies the selected sort. Folding applies NFKC, Unicode
  lowercase, and katakana-to-hiragana mapping. Triggers queue changed works in
  `work_search_dirty`; a background worker rebuilds queued documents in bounded
  batches. A search rebuilds a queue of at most 64 works itself, so an edit is
  searchable at once; a longer queue leaves the search on the previous index
  state and wakes the worker instead of holding the request. A migration that
  recreates the index carries every existing document into it before queueing
  every work, so a search during the full rebuild reads the previous documents
  and a negated clause never matches a work only because its document is
  missing. Edition-family
  matching is applied at query time, so the index never duplicates a sibling's
  text or creates another work identity.
- User state should survive metadata refresh and source replacement.
- Playback is a work cursor, not a set of independent per-track bookmarks.
