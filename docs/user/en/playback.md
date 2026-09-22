# Playback
[English](../en/playback.md) · [简体中文](../zh-Hans/playback.md) · [繁體中文](../zh-Hant/playback.md) · [日本語](../ja/playback.md) · [한국어](../ko/playback.md)

Playback is handled by a global browser audio player.

## Current Behavior

- Local and cached audio with a browser-oriented extension is served directly
  with HTTP range support. This keeps startup and duration discovery on the
  browser's native media path without waiting for FFprobe.
- When direct audio decoding fails and the file still exists, the player offers
  compatibility playback for only the current track, the current queue, or all
  future local and cached playback. Compatibility playback and audio with an
  unsupported extension are converted by FFmpeg to a complete MP3 cache file
  with duration and seeking information. First playback waits for preparation;
  later requests reuse the result and support HTTP Range, seeking, Resume, and
  normal end-of-track queue advancement. A confirmed missing file continues
  through the normal source fallback order instead of offering conversion.
- Local and cached video is inspected before playback. Incompatible video first
  returns its probed total duration and a complete HLS VOD playlist. Six-second
  H.264/AAC segments are generated independently on
  demand, so the player can request a later segment without transcoding every
  preceding segment. Hls.js supplies MSE playback where needed; clients with
  native HLS support use the same playlist directly.
- Temporary video preparation failures receive bounded retries. A remaining
  failure keeps an inline Retry action; direct-to-HLS recovery and explicit
  retries retain the playback position and whether the video was paused.
- Generated video segments are rebuildable cache data under
  `/cache/transcodes/hls`. The shared audio/video transcode LRU quota defaults to
  5 GiB. Segments are invalidated by the source path, size, modification time, or
  transcode profile changing. A segment is capped at 16 MiB and a generation attempt at
  two minutes. Stale partial files left by an interrupted process are reclaimed.
- Prepared audio is rebuildable data under `/cache/transcodes/audio` and shares
  the transcode cache quota with video. Preparation is limited to four minutes
  and 512 MiB per file; incomplete or failed output is never published. Source
  changes invalidate the cached result. Originals remain unchanged.
- Tracked remote and remote-preview media is fetched through the configured
  source policy and proxied unchanged through the backend by default. The
  proxy keeps the browser-facing response same-origin and forwards range and
  conditional request headers, while never exposing the configured source URL.
  Remote responses are not sent through FFmpeg, including when a client sends
  `forceTranscode`; unsupported remote media must be fetched into a local or
  cache location before realtime conversion is available. Remote playback is
  streamed and is not written to `/cache`; the separate remote-source cache
  workflow remains independent.
- Prepared audio responses support random byte ranges and include their complete
  length. HLS video segments are immutable for their source revision and are
  seekable through the complete VOD timeline. Video output is bounded to 720p,
  padded to even dimensions before `yuv420p` encoding, and produced with a
  conservative two-thread profile. FFmpeg and FFprobe each have a small fixed
  concurrency limit and a short, bounded wait queue; requests that cannot
  acquire a slot promptly are rejected so a process cannot remain occupied for
  an unbounded period.
- The Docker image includes both `ffmpeg` and `ffprobe`. Other deployments must
  make both binaries available on the backend process `PATH`.
- Clicking a playable file queues naturally sorted playable files in the same
  folder and starts the selected file at zero.
- Work detail exposes fixed Resume instead of work-level Play. Resume is disabled
  without a positive unfinished cursor.
- Playback continues across navigation.
- Entering Work detail while a matching work is actively playing selects the
  current playback source and opens that track's folder. A paused queue, an
  unrelated playing work, and later playback started after the page opens keep
  the normal recommended directory. Manual source or edition changes also
  return directory navigation to the user's control.
- Desktop keeps the four primary browse workspaces mounted after first use.
  Mobile keeps only the two most recent workspaces mounted, preserving quick
  return while bounding hidden DOM and request work on older devices.
- Browser queue persistence is isolated by server identity and authenticated
  user (or the anonymous principal when instance access is enabled). Unscoped
  v1 queue/progress state is discarded because it has no reliable owner; Dock
  mode and Mini position remain shared device preferences.
- One durable cursor is saved per user and canonical logical work family. It
  references the current edition/media item, source/location context, position,
  duration, completion state, and timestamp. Rapid updates are coalesced and
  sent serially; a transient database-busy response receives one short jittered
  retry.
- Browser queue persistence does not retain per-track progress. Reloaded queue
  metadata is refreshed from the server, while only explicit Resume applies
  the durable work cursor's saved position.
- The player dock supports Mini, Compact, and full Now Playing states, queue
  view, seeking, previous/next, skip controls, and playback mode. The full view
  uses borderless transport glyphs, a thin scrubber with elapsed and remaining
  time, and the playback source between them. Its secondary row holds lyrics,
  screen lyrics, playback mode, sleep timer, and queue; playback speed and
  compatibility scope share the More menu beside the title. The Compact bar
  adds a Next control.
- While a track plays, the next track that end-of-track advancement would
  select is preloaded once the current track is within 45 seconds of its end
  or already fully buffered. Only that one track is warmed, through the same
  playback URL the player will request, so a prepared compatibility conversion
  is also ready. Preloading is skipped for repeat-one, the end of an ordered
  queue, a finishing sleep timer, and when the browser requests reduced data
  usage.
- Backward and forward seeking default to 10 and 30 seconds. Settings accepts
  whole-second values from 1 through 300 and stores them per server and user in
  the browser. The same values drive player buttons, keyboard shortcuts,
  browser Media Session actions, and Android media controls.
- Compact playback reserves page space on mobile and desktop so final actions
  are not covered. PWA update notices stack above the Compact dock.
- Mobile full playback uses edge-to-edge safe areas on every side. Bottom
  controls retain at least 44px touch height and additional home-indicator
  separation.
- Player time rendering is bounded to about two updates per second. The Android
  bridge coalesces pending state and normally calibrates native position every
  five seconds, while pause, seek, track, and speed changes remain immediate.
  Native builds use the Android media session only and disable backdrop blur;
  browser builds retain the browser Media Session integration.
- Compact metadata keeps the track title and circle visible, falling back to
  the work title when no circle is available. The two lines scroll as one
  measured group and pause briefly at the origin between loops, with
  reduced-motion support.
- Compact relative drag seeking maps a full-width drag to 20% of the track,
  bounded between 20 seconds and 10 minutes, then clamps the result to the
  playable duration.
- Queue rows can be reordered by dragging their handle; the list scrolls near
  its edges and Escape cancels the drag. A focused handle also moves its row
  with the Up and Down arrow keys. Move-up, move-down, and remove remain in an
  Options menu that closes after selection, on Escape, or on outside
  interaction. Overflowing queue titles scroll without resizing the player.
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
- The expanded player sizes its artwork against both the available width and
  height, so portrait phones, short landscape phones, and small desktop windows
  keep the cover, title, and transport controls fully visible. Short landscape
  phones place the transport controls beside the artwork.
- When the current track has timed lyrics, the active line appears under the
  title; selecting it opens the lyrics view. The lyrics control opens the same
  view: it replaces the artwork on phones and opens a side column next to the
  now-playing column on desktop, where it shares tabs with the queue. The active
  line stays centered, manual scrolling pauses following for a few seconds, and
  selecting a line seeks to it. Tracks without matched lyrics keep the control
  disabled.
- Screen lyrics keep the current and next line visible outside the page.
  Browsers with Document Picture-in-Picture open a small always-on-top window
  that stays visible while the browser is minimized; other browsers with video
  Picture-in-Picture show a rendered lyrics video instead. The Android app shows
  a draggable floating overlay above other apps while Kikoto is in the
  background. It requires the "Display over other apps" permission and advances
  lines from the playback clock even when the WebView is throttled.
- Every player mode reserves the same bottom page space, so switching between
  mini, compact, and full modes does not change the page height.

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
- [Reliability](../../operations/reliability.md)
