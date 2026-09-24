Changes through v0.6.1 are summarized in [v0.6.1](v0.6.1.md).

> [!IMPORTANT]
> **Upgrade notes.** Migration 038 adds a derived card-summary cache for
> metadata snapshots and queues every existing snapshot. The server fills it in
> small background batches after startup; lists stay correct while it drains.
>
> Migration 039 disables every Follow a circle, Follow a series, and Follow a
> voice actor trigger, because their options changed (Track, Fetch, the new
> works switch, and the metadata refresh choice were removed). Each disabled
> trigger shows that it needs reconfiguring: open it, check its Run options,
> save it, and turn it on again. Manual runs are unaffected.

## Workflows

- Follow a circle, Follow a series, and Follow a voice actor are organized as
  Input, Filter, and Actions. Input is the target and the catalog refresh
  (Incremental or Full). Filter holds a release date range and a work limit,
  both off by default. Actions are Sync metadata for catalog works that lack it,
  the tag, and for circles Check remote sources.
- Without a filter, a follow syncs every catalog work that lacks metadata. The
  trigger popover warns before saving an automated follow without a filter and
  recommends turning one on.
- Track and Fetch are no longer follow actions, and a follow no longer refreshes
  the metadata of works that already have it.
- Metadata sync can refresh all works, one circle's works, or one voice actor's
  works, either only missing or outdated metadata or all of it. Scheduled
  metadata sync triggers keep their previous behavior until edited.
- The release date filter now uses the catalog's release date for works not yet
  in the library, so a release range no longer filters out every new circle or
  series work.
- Circle and voice actor detail refreshes keep their behavior.

## Tags

- Works, circles, and voice actors edit personal tags in a searchable picker
  instead of a comma-separated field: a popover on desktop and a bottom sheet
  on mobile. Type to filter your existing tags for that kind of item, press
  Enter to create one, and check or uncheck a tag to add or remove it. Each
  change saves immediately, and a tag you uncheck stays listed until the picker
  closes so it can be checked again.

## Favorites

- Changing lists for selected works no longer replaces each work's existing
  list membership. The list picker shows whether all, some, or none of the
  selected works are in each list, and saves only the lists you change, in one
  transaction.

## Performance

- Library and voice lists read a compact per-snapshot card summary instead of
  decoding every work's full DLsite snapshot.
- SQLite connections use `synchronous=NORMAL`, a 16 MiB page cache, and a
  256 MiB memory map per connection.
- The bundled frontend's hashed assets are cached as immutable, while the app
  shell, service worker, and manifest are revalidated. JSON and text responses
  are gzip-compressed for clients that accept it; media, Range, event-stream,
  and authentication responses are unchanged. The split-deployment nginx
  configuration gets matching compression and asset caching.
- Concurrent requests for the same work detail share one request.
- The player's playback clock is published separately, so only progress,
  lyrics, and sleep-timer displays re-render during playback.

## Maintenance

- Compact database runs in the background as a workflow shown in Activity.
  Only one can be queued or running at a time, and the result is still recorded
  in the audit log.
- Expired sessions and old workflow runs are cleaned up automatically shortly
  after startup and then daily, with the same retention rules as manual
  cleanup.

## Accessibility And Translation

- Dialogs keep keyboard focus inside the top-most dialog.
- The player seek bar and cache usage meter announce readable values.
- Translate the Workflows page strings that previously fell back to English in
  Japanese, Korean, and both Chinese locales.
