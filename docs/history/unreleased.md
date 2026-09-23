Changes through v0.6.1 are summarized in [v0.6.1](v0.6.1.md).

> [!IMPORTANT]
> **Upgrade notes.** Migration 038 adds a derived card-summary cache for
> metadata snapshots and queues every existing snapshot. The server fills it in
> small background batches after startup; lists stay correct while it drains.

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
