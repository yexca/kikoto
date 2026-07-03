# Frontend

Kikoto's frontend is a compact personal library and player interface.

## Implemented Surfaces

- Library grid.
- Work detail routes by product code.
- Local directory tree.
- Sources page.
- Workflows page.
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

## Work Detail

Work detail shows:

- Cover.
- Product code and title.
- Circle, rating, tags, and voice metadata.
- Local file tree.
- DLsite link.
- Play action.

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

The expanded player keeps a stable outer size. Queue and lyrics panels replace the main artwork area instead of resizing the dock.

## Future Frontend Work

- Real search and filtering.
- Persisted playback progress.
- Now Playing page.
- Favorites and custom tags.
- Source editing.
- Workflow detail and retry actions.
- Mobile gesture support for the player dock.
