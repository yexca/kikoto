# Playback

Playback is handled by a global browser audio player.

## Current Behavior

- Local media streams through the backend with range support.
- Local and cached `.wma` locations are converted on first playback into a
  fingerprinted MP3 derivative under the cache root. The derivative keeps range
  support and is reused until the source size or modification time changes.
  Direct remote `.wma` streams must be cached before this compatibility path is
  available.
- Clicking a playable file queues naturally sorted playable files in the same
  folder and starts the selected file at zero.
- Work detail exposes fixed Resume instead of work-level Play. Resume is disabled
  without a positive unfinished cursor.
- Playback continues across navigation.
- Browser queue persistence is isolated by server identity and authenticated
  user (or anonymous principal). Unscoped v1 queue/progress state is discarded
  because it has no reliable owner; Dock mode and Mini position remain shared
  device preferences.
- One durable cursor is saved per user and canonical logical work family. It
  references the current edition/media item, source/location context, position,
  duration, completion state, and timestamp. Rapid updates are coalesced and
  sent serially; a transient database-busy response receives one short jittered
  retry.
- Browser queue persistence does not retain per-track progress. Reloaded queue
  metadata is refreshed from the server, while only explicit Resume applies
  the durable work cursor's saved position.
- The player dock supports collapsed and expanded states, queue view, seeking,
  previous/next, skip controls, volume, and playback mode.
- Compact playback reserves page space on mobile and desktop so final actions
  are not covered. PWA update notices stack above the Compact dock.
- Mobile full playback uses edge-to-edge safe areas on every side. Bottom
  controls retain at least 44px touch height and additional home-indicator
  separation.
- Compact metadata keeps the track title and circle visible, falling back to
  the work title when no circle is available. The two lines scroll as one
  measured group and pause briefly at the origin between loops, with
  reduced-motion support.
- Compact relative drag seeking maps a full-width drag to 20% of the track,
  bounded between 20 seconds and 10 minutes, then clamps the result to the
  playable duration.
- Queue rows place move-up, move-down, and remove inside an Options menu that
  closes after selection, on Escape, or on outside interaction. Overflowing
  queue titles scroll without resizing the player.
- Text lyrics include LRC, SRT, VTT, and plain-text sidecars. A compound
  sidecar such as `track.mp3.vtt` is preferred for `track.mp3`, followed by a
  same-stem file and then normalized-name matches.
- If several lyrics files match, the lyrics panel exposes an explicit choice
  instead of depending on database row order. Clearly generic same-directory
  names such as `lyrics` or `subtitle` may be shared by tracks in that folder.
- Work-detail audio rows expose the same Auto and explicit lyrics choices
  without requiring playback first. Selecting a persisted work updates any
  matching queued track immediately; remote-only preview choices remain
  temporary. Duplicate file names include their relative directory path.
- The expanded-player lyrics control cycles through hidden, timed-line preview,
  and full lyrics modes. Hidden is the default and gives the cover more room.
  Tracks without matched lyrics keep the control disabled and do not render an
  empty lyrics placeholder. The preview derives its visible row count from the
  available height and keeps the active timed line centered when possible.

An authenticated user's explicit lyrics selection is stored per audio media
item. The preference targets the lyrics media item rather than a concrete file
location, so source replacement can choose another available location. `Auto`
clears the override and restores deterministic matching; an unavailable saved
choice falls back without deleting the preference.

## Cursor Boundary

Only explicit Resume applies persisted position. It targets the cursor's edition
and media item, tries the saved location, and then uses current source priority.
Direct track selection starts at zero. Switching or falling back to another
location during active playback preserves the current in-memory time without
rereading the cursor.

Remote preview playback should not persist a cursor until the remote work has
been synced into local media records.

## Preferred Locations

Playback should prefer durable local files, then cache files, then remote stream
locations when available. Source outages should not disrupt already available
local or cached playback.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Reliability](../operations/reliability.md)
