# Voices
[English](../en/voices.md) · [简体中文](../zh-Hans/voices.md) · [繁體中文](../zh-Hant/voices.md) · [日本語](../ja/voices.md) · [한국어](../ko/voices.md)

Voice pages present persisted person and credit data.

## Current Behavior

- Lists voice actors from local provider credits and user-maintained person
  data as cover tiles with Local and Remote counts and an availability bar: a
  solid segment for works with a local copy, a lighter segment for works only
  a remote source holds, and an empty track for the rest.
- Uses server-paged, URL-backed list search and filters. Each tile shows the
  voice actor's cover with the favorite control on it, the name, aliases, the
  latest release date, and a dynamic user-tag row, with Library-style
  pagination. Tiles fill the row on wide layouts and form two columns on a
  phone.
- Uses the latest known credited-work cover as the voice actor's cover.
  **Change cover…** in the detail **More** menu lists the voice actor's works,
  with a search, and makes the chosen work's cover the voice actor's cover on
  the tile and detail summary. **Latest work** in the same dialog restores the
  cover that follows each new release. The choice belongs to the account that
  made it, and a chosen work that leaves the voice actor's works gives way to
  the latest work's cover.
- Keeps search, one-tap view chips, and the page-size action on one wrapping
  toolbar row. The chips are `All voices`, `Favorite`, `Tagged`,
  `Available`, `Local`, `Remote`, and `Missing`, and the pressed chip names
  the current view. On a phone the search field keeps its own row with page
  size beside it, and the chips scroll sideways below. User tags remain
  visible and searchable, but the list does not expose a tag filter.
- Shows favorite, rating, note, and user tag state.
- Shows confirmed aliases under the detail title. Alias review, duplicate
  merge, and merge undo live in the Metadata page's **Voice actors** view;
  the detail **More** menu links there for users with `metadata:sync`.
- Names each voice actor as the DLsite metadata of the original edition does.
  A translated edition's spelling is kept as an alias and names the voice actor
  only when no original edition in the library credits them. When DLsite
  renames a voice actor, the person follows the new name and keeps the former
  one as an alias; a name kept in a manual merge stays. Voice actors that DLsite
  metadata shows to be one creator are merged into one person, credited once
  per work, and the merge can be undone from **Merge history** like a manual
  one.
- Groups works with no provider voice credits under an `unknown` bucket.
- Shows Local and Remote availability badges followed by user tags on the
  cover-tinted voice detail summary. Cache remains available to playback and filtering data, but is not
  presented as Local.
- Presents known and remote works with the same responsive grid and shared work
  cards as the Library. Selecting a DLsite tag or personal tag on a work card
  opens a local Library search for it.
- Orders the works by **Release date**, **Code**, **Title**, **Rating**, or
  **Sales**, ascending or descending, newest release first by default. Works
  without the chosen fact stay last in either direction. The order and the
  page size (24, 48, or 96) are remembered on the device for each account and
  apply to every voice actor.
- Paginates a voice actor's works on the server. Known works and the remote
  catalog merge into one list, and the search, the availability filter, and
  the chosen order apply before pagination; bulk selection covers the loaded
  page. The search matches a work the way a plain Library search does, by
  code, title, circle, voice actor, tag, or personal tag, and a work only the
  remote catalog holds by its code, title, circle, or tag. Every edition of a
  work counts as one work, available when any edition is. Person detail and
  the remote sources' catalog state load separately.
  Remote source searches use bounded concurrency, while voice counts and user
  tags are aggregated in batches.
- Keeps Favorite, the common refresh actions, and a **More** menu in the
  detail summary. **First pull** or **Refresh** queues a Sync a voice actor catalog
  run with only known works' metadata across every compatible remote source, and
  **Retry metadata** appears only while known works still lack metadata. The
  button shows **Refreshing** until the run settles. A warning beside the sync
  state counts remote sources that failed their last pass and opens that run
  in Activity. The bell beside **Favorite** subscribes to the voice actor's
  new works; see [Subscriptions](subscriptions.md). **More** holds **Change
  cover…**, **Sync this voice actor's catalog…**,
  which opens the preset with this voice actor selected for source, filter,
  metadata, and tag choices, and **Manage aliases**. The works toolbar mirrors the Library: a bounded search on the
  left, then the sort button that names the current order, display options,
  the availability filter, and selection on the right, with the shared
  collection pagination above and below the grid. Display options hold the
  **Cards** choice of **Full**, **Compact**, and **Mini** shared with the
  Library, the columns, and the page size; a newly chosen card mode starts from
  its [preset](library.md#current-behavior). A phone keeps the sort button
  above the works and opens search, the filter, the card mode, columns, page
  size, and
  selection from a separate options sheet.
- Treats the mobile detail back control as Up to the last
  server-and-user-scoped Voice Actors list location, including when the detail
  was opened from Library or Favorites. Wide layouts keep the source-aware
  history return.

## Boundary

DLsite remains a metadata provider for known works. Kikoto does not treat DLsite
keyword crawling as a reliable voice actor catalog.

## Review Behavior

Alias and merge tools should preserve user state and keep merge undo visible
when duplicate person records are consolidated.

## Related Docs

- [Library](library.md)
- [Work detail](work-detail.md)
- [Data model](../../architecture/data-model.md)
