# Player and Video

How the global audio player loads, normalizes, and guards playback and its
resume position, and how the full-screen video player of work detail and
Record plays outside it.

## Global Player

The global player keeps its public track and state types in `playerTypes` so
media-tree and queue models do not depend on the React provider.
`playerPersistence` owns browser preference access and queue parsing; it
discards obsolete stored queue and progress keys and reads the older
sleep-timer shape. The provider uses account-scoped storage keys and remains
mounted across navigation. System media controls (Media Session and the
Android notification) stay registered and read the latest actions through a
ref, so they never act on a stale queue or mode. The dock (`player/dock`) has
Mini, Compact, and full surfaces, while queue reordering math and formatting
stay in pure modules.

A restored queue refreshes once after startup through the server's queue
resolve (`playerQueueRestore`), in one request however long the queue is: a
playable item takes the location, locations, names, lyrics, progress, and work
information the server resolves, and an item that is missing or cannot play
leaves the queue; when the library cannot be reached, the queue stays as
saved. An item the listener has already started keeps its location. A changed
viewer preference, such as the metadata languages, resolves only the queued
tracks' display names again, in one request, and a saved display name does so
for its work (`useQueueDisplayNameRefresh`). The player never ranks locations
itself: a track's locations arrive in the server's playback order (see
[Playback Locations and Queues](../backend/media-playback.md#playback-locations-and-queues)),
which the fallback after a failed location and the source menu follow.

The server picks each track's delivery, and `audioPlaybackSource` asks it: the
player declares the audio formats its element decodes and whether it plays HLS,
and [audio playback info](../backend/media-playback.md#audio-playback-decision)
answers with the original file, an HLS playlist, or a complete MP3 conversion
and the URL to load. Compatibility playback asks for a conversion. The answer
is shared by every caller and kept for a minute, and a track that fails asks
again when it retries. The player holds a track back from its element until
the server has answered, and a loaded track keeps its answer however long it
plays. The player decides the next auto-advance track as soon as the current
one has loaded and keeps that answer until its turn, so its turn finds the
answer made and gapless advance waits for no request. A request that fails leaves the track on the
stream route, which decides between the file and a complete MP3 conversion
from the declared formats. The player decides nothing from a file name. A
remote stream is never converted and has no playback info; its URL is the
remote media route, and a location the server does not read itself plays from
its own stream URL. A Record track asks Record's playback info the same way
and plays its own stream when that is the answer or the browser cannot play
HLS; its progress goes to the Record progress route instead of the playback
report scheduler, when the listener has `library:write`. Source
loading attaches an HLS playlist natively on iOS and iPadOS and through a
lazily loaded hls.js elsewhere; hls.js starts loading at the pending start
position, asks the element to play again once it has attached its source, and
reports fatal errors to playback recovery, which checks the playlist URL
rather than the element's `blob:` source. Source loading also warms the next
auto-advance track: a file or MP3 conversion in one detached audio element, so
the player element can reuse the buffered bytes for the identical URL, and an
HLS playlist by requesting its first segment; the window is wider for an MP3
conversion.

## Volume and Loudness

The element volume is the product of the sleep timer's fade and the loudness
normalization cut. Loudness normalization measures the current track, then
the next one, and moves a level that changes mid-track gradually. In full
normalization it routes a same-origin element through a Web Audio gain node
only while the page is visible and the element's context already runs; user
gestures and play requests start and resume that context, and until it runs
the element keeps its own output and the cut uses element volume. A routed
element cannot leave Web Audio, so while one may exist the provider renders
an empty standby `<audio>` element that each gesture prepares, and the
playback instance moves to it at the same position and play intent. That
happens when a routed element plays for a moment while its context cannot
run, and after leaving full normalization once the routed element pauses or
the next track starts. Element-bound effects depend on `audioElementKey`, and
media event handlers ignore a replaced element.

## Lyrics Timeline

The server reads lyrics files: LRC, WebVTT, SRT, and ASS or SSA text become
timed lines, so the player, the lyrics previews, and the work detail file
viewer show the same lines (see
[Timed Text](../backend/media-playback.md#timed-text)). `lib/timedLyrics` keeps
only the active-line lookup and the listener's offset. The player loads a
track's lyrics as the server's timed lines, moves them by the listener's
lyrics offset, so the active line, line seeking, and screen lyrics share one
timeline, and shows a file with no timed line as its own text. The line the
server marks as naming the models of AI-made lyrics stays among the lines; a
timing check leaves it out.

## Playback Guards

Sleep rewind preferences share the account/server scope of listening time and
update the resume cursor only when the timer stops playback. Android and iOS
output-disconnect events pause the media element and player intent, including
pending play requests. Every start of the media element passes the engine's
start guard; in the native apps, the speaker playback guard holds starts
through the device speaker until the in-app confirmation, so notification,
lock screen, Control Center, and media key controls cannot bypass it.

## Resume Position

- Apply a persisted position only through Resume or the restored current queue
  item. After a reload, that item continues the work cursor when it still points
  at the same media item and is unfinished, unless the listener has already
  played or sought in it. Ordinary track selection starts at zero, while an
  active source fallback (only when the account enabled it) carries the current in-memory time, or a start position
  still waiting for metadata, to the replacement location.
- A playback instance writes the work cursor only after its start position is
  applied and the listener has played or sought in it. Page hide, pause, track
  switches, and the sleep timer must not replace the cursor with the position
  of an idle or still-loading element.

## Video Player

The work detail file viewer shows images and text, and opens a video in the
work video player (`features/work-detail/media`), which steps through the
folder's videos. It and Record's video player play outside the global player
with one layout: the media overlay (`components/media-overlay`), the
full-screen dark modal that Record's photo viewer also uses; a header with
close, the title and the item's place in its list, previous and next, the
caller's own actions (Record's audio only, the work's audio track menu), and
outside the phone layout a shortcuts button that lists the shortcuts; a status
area for the failure with Retry, the preparing spinner, and the question
whether to continue from a saved position; and the video stage
(`player/video`). The overlay passes key presses to the stage, so its
shortcuts work while focus rests on the player. A video starts playing once
its start is chosen, and on the phone layout the stage requests fullscreen
then, within the tap that opened or started it, while a wide video turns to
landscape.

The stage owns the `<video>` element, its controls, shortcuts, subtitle
tracks, playback rate, and fullscreen, and the source that playback info
chose, which it attaches as an HLS playlist natively on iOS and iPadOS and
through a lazily loaded hls.js elsewhere. It starts the first source at the
caller's start position and play state, and a failed, recovered, or changed
source starts the next one where the last stopped, in the same play state. It
reports why a source failed, so the caller can prepare a direct file or a
remux again as a transcode, and reports the positions the viewer reaches, so
each caller keeps its own resume store: the work video player in browser
storage, Record's on the server. The video fits both dimensions of the space
the stage is given, with the caller's overlays over it.

The `<video>` element has no native controls; the stage lays its own over it,
keeping tap zones, double-tap streaks, the hide rule, and seeking in a pure
controls model, and reuses the player's control primitives and seek steps
through `player/mediaControls`. Keyboard shortcuts, buttons, and double taps
all seek through one seek function. The stage element itself goes fullscreen,
so the controls stay, except on iOS and iPadOS, whose fullscreen is the system
player; the stage leaves fullscreen when it unmounts. Its menus pass the stage
to `AnchoredPopover` as `container` while it is fullscreen, because a popover
in `document.body` is not shown over a fullscreen element.

Subtitle menu choices set each `<track>` element's `track.mode`. Same-name
WebVTT, SRT, ASS, and SSA files from the video's lyrics matches load at once
as the WebVTT the server converts them to, and the
embedded streams that playback info lists follow, each fetched only once its
track is selected. Every track loads through the API transport as an object
URL, so native shells need no subtitle asset route. Work video resume
positions live in account-scoped browser storage, keyed by location id and
holding only positions; the stage reports a position only after its start
position applies, so a still-loading element never replaces it.

A fullscreen video wider than it is tall locks the screen to landscape until
fullscreen ends (`player/video/videoFullscreenOrientation`),
however fullscreen was entered. Browsers use the Screen Orientation API, and
a rejected lock leaves the screen as it is. The Android WebView rejects that
API, so the shell shows WebView fullscreen itself, over the content frame and
below the app lock cover with the system bars hidden, and its app-local
`KikotoVideoFullscreen` plugin holds the landscape lock while that view is
shown. iOS plays fullscreen video in the system player.
