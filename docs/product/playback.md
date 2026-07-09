# Playback

Playback is handled by a global browser audio player.

## Current Behavior

- Local media streams through the backend with range support.
- Clicking a playable file queues playable audio files in the same folder.
- Work-level play queues all playable tracks for the work.
- Playback continues across navigation.
- Progress is saved per user and logical media item.
- The player dock supports collapsed and expanded states, queue view, seeking,
  previous/next, skip controls, volume, and playback mode.

## Progress Boundary

Playback progress attaches to media items. Remote preview playback should not
persist progress until the remote work has been synced into local media records.

## Preferred Locations

Playback should prefer durable local files, then cache files, then remote stream
locations when available. Source outages should not disrupt already available
local or cached playback.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Reliability](../operations/reliability.md)
