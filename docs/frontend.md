# Frontend

Kikoto's frontend is a compact personal library and player interface.

## Implemented Surfaces

- Library grid.
- Library pagination with 24/48 works per page.
- Work detail routes by product code.
- Work detail language edition selector for translated product-code families.
- Work detail favorite-list selector for existing lists.
- Circle list and circle detail routes.
- Voice actor list and detail routes.
- Local directory tree.
- Settings page with source, local scan, and cache configuration.
- Workflows page for definitions, scheduled triggers, and system definitions.
- Activity page for workflow run history and node-level status.
- Users page for administrators.
- Quick listening mark controls.
- Global player dock.
- Favorites surface for quick marks and work-detail list membership.

## Library

Work cards show:

- Cover image when cached.
- Product code.
- Work title.
- Circle.
- DLsite rating.
- Tags.
- Voice actor metadata.
- Local availability.
- Quick listening mark.
- Source tags separated from metadata tags.

Large local result sets are paginated. Page controls are only shown when the
current result set spans more than one page.

## Work Detail

Work detail shows:

- Cover.
- Product code and title.
- Circle, rating, tags, and voice metadata.
- Known translated editions for the same logical work.
- Local file tree.
- DLsite link.
- Play action.
- Quick listening mark.
- Favorite-list membership.
- Per-track progress for resume.
- Source availability tabs for local, cached, remote, and configured compatible
  sources.

When a work belongs to a translated product-code family, the detail page keeps
the base metadata page while showing every known edition. Editions with local
media are selectable for playback and directory-tree browsing. Editions without
local media remain visible but unavailable, so users can see that the
translation exists without implying that it can be played locally.

If the base edition has no local files, the page defaults the file tree to the
first playable local edition.

The favorite control opens a selector for existing favorite lists. Adding a work
to any list also keeps the legacy favorite state enabled for compatibility.
Full favorite-list creation and management is a separate workflow.

Clicking a playable file queues the playable audio files in that same folder. The work-level Play action queues all playable tracks in the work.

Remote work actions use consistent naming:

- Sync updates remote metadata and file locations.
- Fetch materializes remote files under the configured local save path.
- Mark stores the current user's listening state, syncing a remote-only work
  first when needed.

Single-work Fetch opens a directory tree selector for remote files. Bulk remote
actions run through parent workflow runs.

## Circles

The Circles page lists known circles or makers from the local database. It
supports search, availability/status filters, paging, and selectable list
density.

Circle detail pages use `/circles/{externalId}` routes and show:

- User rating and note.
- Catalog, imported, playable, and unavailable counts.
- Refresh controls for incremental or full catalog refresh.
- Product JSON mode for available-only or all catalog works.
- Source match tags.
- Catalog work cards with quick listening marks when the work is available.
- Bulk sync + fetch and fetch actions for selected compatible remote works.
- Single-work remote Fetch with directory tree selection.
- Manual deletion for catalog rows that are no longer present in the external
  catalog.

## Voices

Voice actor pages use `/voices/{personId}` routes and show:

- Favorite, rating, note, and user tags.
- Local, cached, remote, playable, and known work counts.
- Alias review, duplicate merge, and merge undo controls.
- Known and compatible remote-source works in the shared work-card layout.
- Bulk sync + fetch and fetch actions for selected compatible remote works.
- Single-work remote Fetch with directory tree selection.

## Player Dock

The player is global, so playback continues when navigating between pages.

Implemented controls:

- Collapsed and expanded states.
- Previous and next track.
- Back 5 seconds and forward 10 seconds.
- Play and pause.
- Progress seek.
- Queue panel.
- Lyrics placeholder.
- Playback mode toggle.
- Vertical volume popover.
- Persisted progress restore.

The expanded player keeps a stable outer size. Queue and lyrics panels replace the main artwork area instead of resizing the dock.

## Future Frontend Work

- Real search and filtering.
- Favorite-list creation, rename, sort, and deletion UI.
- Custom user tag UI.
- Persisted queue restore.
- Source connection tests and priority controls.
- Workflow retry actions.
- Review/maintenance triage for stale or ambiguous scan results.
- Mobile gesture support for the player dock.
