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
>
> By default `KIKOTO_ROOT_PASSWORD` no longer sets the administrator password on
> every start. Existing accounts keep their current passwords, so the root
> account still signs in with the last applied value and can now change it in
> Settings. Remove `KIKOTO_ROOT_PASSWORD` from `.env`; Kikoto logs a warning
> while it is set. To keep the previous behavior, set
> `KIKOTO_ROOT_ACCOUNT_MODE=environment` instead. Update `docker-compose.yml`
> either way, because the previous file neither passes the new variables nor
> starts without `KIKOTO_ROOT_PASSWORD`.

## Accounts

- A new production instance no longer needs a password in `.env`. The web app
  shows **Set up Kikoto**, and the first administrator is created with a
  one-time setup token from the service log or `config/setup-token`, so a
  client that can only reach the port cannot claim the instance.
- `docker compose exec kikoto /app/kikoto admin reset-password` resets a
  forgotten administrator password from the host while Kikoto runs. It prints
  a new password, restores the account as an enabled super administrator, and
  signs it out everywhere.
- A reset targets the initial administrator by default. When it no longer
  exists, the account must be named with `--username` or
  `KIKOTO_ROOT_USERNAME`; the error lists the super administrators. A named
  account must exist, except `root`, which is created so an instance with no
  usable administrator can still be recovered.
- Without shell access, `KIKOTO_ROOT_PASSWORD_RESET=true` applies
  `KIKOTO_ROOT_PASSWORD` once at startup. Restarting with the same values does
  not undo a password changed later in Settings.
- `KIKOTO_ROOT_ACCOUNT_MODE=environment` keeps the root account defined by
  `KIKOTO_ROOT_USERNAME` and `KIKOTO_ROOT_PASSWORD` on every start, as before,
  and locks its password, role, enabled state, and deletion in the app. The
  password reset switch and the reset command do not apply to that account.
- In the default `setup` mode the initial administrator is managed like any
  other super administrator: it can change its own password, and another super
  administrator can change its role or delete it.
- New passwords must have at least 8 characters and must not be a value that
  appeared in the documentation.

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
- A trigger popover that stays open while you select another workflow tab now
  saves to the workflow it was opened for. Before, a new trigger could be
  created on the other workflow, or an edited one moved there with options in
  the wrong shape.

## Tags

- Works, circles, and voice actors edit personal tags in a searchable picker
  instead of a comma-separated field: a popover on desktop and a bottom sheet
  on mobile. Type to filter your existing tags for that kind of item, press
  Enter to create one, and check or uncheck a tag to add or remove it. Each
  change saves immediately, and a tag you uncheck stays listed until the picker
  closes so it can be checked again.

## Circles And Voice Actors

- Opening a circle that is not in the database no longer adds it.
  Administrators are offered Follow a circle with the circle ID filled in;
  other users are asked to contact an administrator. When a first fetch fails,
  the circle it started is removed, so a mistyped circle ID no longer stays in
  the circle list.
- A Follow run form opened from a circle or voice actor page notes which
  target it filled in.
- A voice actor page that does not exist explains that syncing the metadata of
  any of their works creates it, or asks you to contact an administrator.
- Opening a work's circle, series, or voice actor link fetches missing
  metadata from DLsite only for users who can sync metadata. Other users open
  links the site already stores and are otherwise asked to contact an
  administrator.
- The circle and voice actor lists no longer fail in a library with more than
  about 32,000 circles or voice actors.

## Playback

- Reloading or restarting the app no longer resets Resume progress to 0:00. A
  restored track saves progress only after it starts playing or you seek in it,
  so hiding the page, locking the device, or switching tracks before that no
  longer overwrites the saved cursor.
- A reloaded queue continues its current track from the saved cursor when that
  cursor points at the same track and is unfinished.
- A Resume or reload start position that is still loading carries over when
  playback falls back to another source, instead of restarting at 0:00.

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
- Stopping or upgrading the container now shuts down gracefully: in-flight
  requests finish, and a running workflow job returns to the queue without
  spending a retry, instead of being recovered as if the service had crashed.
  The drain is bounded by the new `KIKOTO_SHUTDOWN_TIMEOUT_SECONDS` (default
  20). The bundled Compose files set `stop_grace_period: 30s`; add the same to
  a custom Compose file, because Docker's default 10 seconds can kill the drain.
- The update check now reports only published GitHub Releases, so a version
  is no longer announced while its image and APK are still being published.
- A release pushes the Docker image, including `latest`, only after the
  Android APK has also built, and publishes the GitHub Release last.

## Accessibility And Translation

- Dialogs keep keyboard focus inside the top-most dialog.
- The player seek bar and cache usage meter announce readable values.
- Translate the Workflows page strings that previously fell back to English in
  Japanese, Korean, and both Chinese locales.
