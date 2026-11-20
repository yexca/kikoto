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
  pressed chip names the current view. On a phone the chips scroll sideways
  with **Search** and page size at the row's end; **Search** opens the search
  field above the row, and closing it clears the search.
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
- Shows the circle detail summary on the cover's tint without a frame: the
  portrait; one line with the circle code linking to DLsite followed by the
  catalog's **Local**, **Remote**, and **Unavailable** counts; the name and
  aliases; and the personal tags with the button that edits them. A count of
  zero is left out, the **Works** tab below states the catalog's size, and
  the counts describe the whole catalog, whatever the works below are
  filtered to. Series cards carry an availability bar.
- Keeps the summary's actions quiet: **Favorite**, the subscribe bell, the
  catalog refresh, and **More**. The page has no primary button. On a phone
  the actions show as icons named for assistive technology.
- The bell subscribes to the circle's new works, and the bell beside a series'
  DLsite link to that series; see [Discover](discover.md#subscribing). A
  series of a subscribed circle is already included.
- For users who may refresh catalogs, the button before **More** reads
  **First pull** for a circle that was never pulled, which reads the whole
  catalog, and **Refresh** after that, which also checks the remote sources;
  its tooltip names when the catalog was last synced. Either queues a Sync a
  circle catalog run without a filter or tag and returns at once. Until the
  run settles the button reads **Refreshing** and opens the run in Workflows.
- The **More** menu holds **Change cover…** and, for users who may refresh
  catalogs, **Retry metadata** only while catalog works still lack metadata,
  which fills just those, and **Sync catalog…**, which opens the Sync a
  circle catalog preset in a dialog with this circle filled in, for every
  other combination of catalog refresh, filter, metadata, tag, and source
  check. While one of the circle's series is shown, **Sync series catalog…**
  opens the Sync a series catalog preset for that series the same way. To
  refresh metadata the circle's works already have, run Metadata sync with
  the circle scope. A user without these permissions sees none of them. Demo
  offers **Change cover…**, which saves no cover, and the preset, which opens
  read-only.
- Keeps the works toolbar to the Works/Series switch, a search field, the sort
  button that names the current order, the availability filter, and **View**.
  **View** holds the **Cards** choice of **Full**, **Simple**, **Compact**,
  and **Mini** shared with the Library, the columns, the page size, and
  **Select works**; a newly chosen card mode starts from its
  [preset](library.md#current-behavior). A caption before the sort button
  states how many works match and, from tablet width, the page; more pages add
  the shared pagination below the grid. The series overview lists series and
  offers no order.
- On a phone the Works/Series switch takes its own row, followed by the work
  count with **Search**, the sort button, the filter, and **View**, which
  opens as a sheet. **Search** opens the search field above that row.
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
