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
- Text lyrics include LRC, SRT, VTT, and plain-text sidecars. A compound
  sidecar such as `track.mp3.vtt` is preferred for `track.mp3`, followed by a
  same-stem file and then normalized-name matches.
- If several lyrics files match, the lyrics panel exposes an explicit choice
  instead of depending on database row order. Clearly generic same-directory
  names such as `lyrics` or `subtitle` may be shared by tracks in that folder.

Lyrics selection is scoped to the currently queued track. It is not currently
stored as a persistent user preference.

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
