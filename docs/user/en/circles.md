# Circles
[English](../en/circles.md) · [简体中文](../zh-Hans/circles.md) · [繁體中文](../zh-Hant/circles.md) · [日本語](../ja/circles.md) · [한국어](../ko/circles.md)

Circles represent makers, circles, and related party catalog state.

## Current Behavior

- Lists known parties in server-paged results with per-card catalog and
  availability state.
- Provides search, filters, URL-backed pagination, favorite state, and user
  tags.
- Keeps search, one-tap view chips, and the page-size action on one wrapping
  toolbar row. The chips are `All circles`, `Favorite`, `Tagged`,
  `Available`, `Local`, `Remote`, `Missing`, and `Attention`, and the
  pressed chip names the current view. On a phone the search field keeps its
  own row with page size beside it, and the chips scroll sideways below.
- Shows each circle as a cover tile: the circle's cover with a `No cover`
  fallback, the favorite control on the cover, the name, the latest release
  date, and personal tags. Tiles fill the row on wide layouts and form two
  columns on a phone.
- Uses the latest known DLsite work's locally cached cover as the circle's
  cover. **Change cover…** in the detail **More** menu lists the circle's
  works, with a search, and makes the chosen work's cover the circle's cover
  on its tile and detail summary. **Latest work** in the same dialog restores
  the cover that follows each new release. The choice belongs to the account
  that made it, and a chosen work that leaves the circle's catalog gives way
  to the latest work's cover.
- Summarizes each circle tile with its sync state, one canonical
  `Available N/total` count, and an availability bar: a solid segment for
  works with a local copy, a lighter segment for works only a remote source
  holds, and an empty track for the rest.
- Shows circle detail by external id.
- Paginates circle catalog works on the server. Catalog totals remain complete,
  while search, availability, and series filters and the chosen order apply
  before pagination; bulk selection covers the loaded page.
- Orders catalog works by **Release date**, **Code**, **Title**, **Rating**, or
  **Sales**, ascending or descending, newest release first by default. Works
  without a rating or sales count stay last in either direction. The order and
  the page size (24, 48, or 96) are remembered on the device for each account
  and apply to every circle.
- Supports catalog refresh in incremental or full mode.
- Stores catalog rows separately from imported works.
- Shows local/cache/remote source availability tags for catalog works.
- Presents work results with the same responsive grid and work cards as the
  Library. This applies to both circle detail and circle series;
  the separate circle-entity list keeps its own controls. Selecting a DLsite
  tag or personal tag on a work card opens a local Library search for it.
- Shows the circle detail summary on a cover-tinted panel with the circle's
  aliases and personal tags. Its **Available**, **Local**, **Remote**, and
  **Unavailable** counts sit beside an availability bar and describe the whole
  catalog, whatever the works below are filtered to.
  A circle that was never pulled states that only works the library already
  knows are listed; otherwise the summary shows when the catalog was last
  synced. Series cards carry the same availability bar.
- Keeps the common refresh actions in the detail summary: **First pull** for a
  circle that was never pulled, then **Refresh circle**, which also checks the
  remote sources. **Retry metadata** appears only while catalog works still
  lack metadata and fills just those. Each action queues a Sync a circle catalog run
  without a filter or tag and returns at once; the button shows
  **Refreshing** until the run settles, and the run is visible in Activity.
- The bell beside **Favorite** subscribes to the circle's new works, and the
  bell beside a series' DLsite link to that series; see
  [Discover](discover.md#subscribing). A series of a subscribed circle is already
  included.
- The **More** menu holds **Change cover…** and **Sync this circle's catalog…**,
  the Sync a circle catalog preset with this circle filled in, for every other
  combination of catalog refresh, filter, metadata, tag, and source check. To
  refresh metadata the circle's works already have, run Metadata sync with the
  circle scope.
- Shortens the common detail actions on mobile, keeps icon-only Favorite,
  More, and DLsite controls accessible by name, and places DLsite last.
- Uses the Library-style works toolbar on wide layouts: the Works/Series switch
  and a bounded search on the left, then the sort button that names the
  current order, display options, the availability filter, and selection on
  the right. Display options hold the **Cards** choice of **Full**,
  **Compact**, and **Mini** shared with the Library, the columns, and the page
  size; a newly chosen card mode starts from its
  [preset](library.md#current-behavior). The shared collection pagination sits
  above and below the grid.
- Keeps mobile work controls to the Works/Series switch with the sort button
  beside it and one Catalog options action. Search, availability, the card
  mode, mobile columns, page size, and selection mode live in that sheet, and
  the series view keeps its search inline;
  wide layouts retain inline controls. The series overview lists series and
  offers no order.
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
