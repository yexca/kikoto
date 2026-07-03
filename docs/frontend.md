# Frontend

Kikoto's frontend is a compact personal library and player interface.

## Implemented Surfaces

- Library grid.
- Work detail routes by product code.
- Local directory tree.
- Settings page with source, local scan, and cache configuration.
- Workflows page for definitions, scheduled triggers, and system definitions.
- Activity page for workflow run history and node-level status.
- Users page for administrators.
- Quick listening mark controls.
- Global player dock.

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

## Work Detail

Work detail shows:

- Cover.
- Product code and title.
- Circle, rating, tags, and voice metadata.
- Local file tree.
- DLsite link.
- Play action.
- Quick listening mark.
- Per-track progress for resume.

Clicking a playable file queues the playable audio files in that same folder. The work-level Play action queues all playable tracks in the work.

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
- Now Playing page.
- Favorites and custom tags.
- Persisted queue restore.
- Source connection tests and priority controls.
- Workflow retry actions.
- Mobile gesture support for the player dock.
