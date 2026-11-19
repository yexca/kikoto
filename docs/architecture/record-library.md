# Record Library

The record library is an independent local media subsystem for home videos,
audio files, and images. Its root is configured separately from the audio data root, with
`KIKOTO_RECORD_ROOT` defaulting to `/record` in the container. It is not a
storage pool and it is never included in the audio local-work scan.

Record is off until an administrator turns it on in **System → Library**,
which saves the `record_library_enabled` app setting. While it is off, every
`/api/records` route answers `404` with `record_library_disabled`, the
navigation leaves Record out, and `/records` is not found; `GET
/api/runtime-settings` reports the setting to signed-in readers as
`recordLibraryEnabled`. Turning it off deletes nothing: record rows, progress,
and thumbnails stay for when it is turned on again.

The root carries a `.kikoto-record` marker: `kikoto-record-v1` followed by a
random identity that the database keeps in `record_root.marker_id`. An
administrator initializes the root explicitly in the same settings section
before the first scan; initializing writes a new identity, adopts the one a
marker already carries, and gives one to a marker that has none. Adopting an
identity other than the one the database keeps, such as initializing another
disk mounted at the path, forgets the folders, files, progress, and states
recorded for the earlier identity in the same transaction, so the new disk's
files never take over earlier assets by path. The root is
online only while its marker carries the identity the database keeps. A
missing marker, a marker without an identity, or a database that never
initialized the root leaves it unconfigured; a marker of another identity,
such as another initialized disk mounted at the same path, and a marker that
is a link, oversized, or unreadable leave it offline. An unavailable root
leaves existing record rows unchanged; it never marks the whole library
missing, and deletions are refused.

Record folders and assets have their own identities. A record asset does not
become a `work`, does not receive a `primary_code`, and is not stored in
`media_item`. Playback and file-serving primitives may be shared with work
media, while record metadata, progress, and state stay in record tables.

The schema keeps one row per folder and one row per regular file. Paths are
relative to the record root and normalized for lookup. The scanner walks the
whole configured record root and classifies video, audio, image, subtitle,
metadata, and other files by a bounded extension allowlist. It does not follow links or
junctions and skips Kikoto transaction directories and operating-system
metadata directories.

Record scans run as the durable `record_library_scan` workflow. Only a complete
root walk reconciles missing folders and assets. An unreadable directory or a
cancelled scan leaves rows it could not observe in their previous state.
Discovery records file size and modification time. A file whose size,
modification time, or kind changed returns to the pending probe state and loses
its earlier duration and dimensions.

After the walk, the same scan probes pending videos, audio files, and images
with `ffprobe`:
at most 2,000 per scan, two at a time, each with a 20-second timeout, one
thread, the file protocol only, and a bounded output. A video records its
duration, dimensions, codecs, and whether it has audio; an audio file records
its duration, its audio codec, and whether it embeds cover art (a video stream
marked as an attached picture), which does not make it a video; an image
records its dimensions. A file the probe cannot read is marked failed without failing the
scan, and it is probed again only after it changes. Files past the per-scan
bound, and every pending file when `ffprobe` is missing, stay pending for the
next scan. Cancelling the scan stops the probe and leaves the rest pending. The
scan records its last-scanned time only after the probe, so a client waiting
for that time sees the new durations. The run summary reports how many files
were probed, failed, and remain.

Thumbnails are made on first request rather than during the scan: a scan stays
a walk and a probe, and only folders someone opens pay for `ffmpeg`. A video's
thumbnail is the frame a tenth of the way in (one second in when the duration
is unknown, and the first frame when that seek finds nothing); an image's is
the image itself; an audio file's is its embedded cover art, and an audio file
without cover art has no thumbnail. Each fits a 640-pixel box as JPEG. At most two `ffmpeg`
processes run, concurrent requests for one revision share one run, and at most
64 requests wait before the server answers busy. `ffmpeg` writes into the
[temporary directory](../operations/configuration.md#temporary-files); each
result must carry a JPEG signature and stay within 2 MiB before it is cached
or served.

Thumbnails are part of the transcode cache, under
`transcodes/record-thumbs/` in the cache root. They share its quota and
eviction, its usage in **Cleanup → Cache**, and its clear action: storing a
thumbnail reserves its size under the transcode cache limit, evicting the
least recently used cache files first, and serving a thumbnail counts as a
use. A thumbnail is named by asset, file size, and modification time, so a
changed file gets a new thumbnail and the asset's earlier one is removed when
it is written. A file `ffmpeg` cannot read leaves an empty failure marker for
that revision, so it is not tried again until it changes or the cache is
cleared. After a complete scan, the thumbnails and failure markers of assets
that are no longer available videos, images, or audio files with cover art are
removed, and the run summary
counts them; a partial scan leaves them in place. An evicted or cleared
thumbnail is made again on its next request.

Record videos and audio files play through the library media playback
pipeline described in [Backend](backend.md): playback info chooses direct
playback, a remux, or a transcode from the client's capabilities; HLS segments,
embedded text subtitles, keyframe indexes, transcode slots, failure memory, and
the transcode cache quota follow the same rules. A record asset's playlists and
cache directories are keyed `record-<asset id>` beside the numeric keys of
library locations, and its revision covers the asset id, relative path, size,
and modification time, so it never shares segments with a library file.

Deleting a record file or folder moves it into `.kikoto-trash/records` in
the record root, which the scanner skips, under a folder named for the UTC
time and `file-<asset id>` or `folder-<folder id>` that keeps the item's
relative path. It is a rename on the root's own filesystem; Kikoto never
copies the item elsewhere and never empties the trash. A folder moves with
everything in it, listed or not, and nothing inside it is followed. The
request names the relative path the viewer confirmed, and the deletion is
refused when the id now names another path: SQLite gives the id of a removed
row to the next one, so a page left open could otherwise reach a file indexed
since. The deletion is also refused while the root is not online, for an asset that is not
available, for the root folder and a missing folder, and when any component
of the item's path, or of the trash folders, is a link or anything other than
a plain directory or, for a file, a regular file; the path is checked again
right before the rename. The running HLS encodes of every file removed stop
before the move and again after it; the asset rows, and a folder's subfolder
rows, go with every viewer's progress and state; and the playback cache
directories under each file's `record-<asset id>` key and its thumbnails are
removed. When the rows cannot be removed, the item moves back.

Folder artwork follows explicit sidecar names. `folder`, `poster`, and `cover`
are poster candidates; `backdrop`, `fanart`, and `background` are backdrop
candidates. The server checks image signatures before serving record artwork or
image previews and never exposes an absolute filesystem path.

The HTTP surface is under `/api/records`:

- `GET /api/records` reports root state; `POST /api/records/root/initialize`
  creates the marker for an administrator with `sources:write`.
- `GET /api/records/tree?folderId=<id>&offset=<n>` returns one page of up to
  200 children of a folder, subfolders first and then available files, each
  by name, with their artwork, stream, thumbnail, subtitle, and download URLs
  and the viewer's saved progress on each video and audio file. `total`
  counts every child, and `nextOffset`, absent on the last page, is where the
  next page starts. The browser reads a folder to its last page.
- `GET /api/records/assets/{id}` returns asset metadata; `GET
  /api/records/assets/{id}/stream` serves an authenticated Range-capable video,
  audio file, or image.
- `GET /api/records/assets/{id}/playback` answers how a video or audio file
  plays, in the shape of library playback info, for the `capabilities`,
  `forceTranscode`, and `audioStream` queries. `profile=audio` asks for the
  sound of a video, which always plays as an audio encode; an audio file plays
  directly when the client decodes it and as an audio encode otherwise.
- `GET /api/records/assets/{id}/hls/{file}` serves the playlists and segments
  playback info names, and `GET /api/records/assets/{id}/subtitles/{stream}.vtt`
  an embedded text subtitle stream as WebVTT.
- `GET /api/records/assets/{id}/download` sends any available record file as
  an attachment with the untrusted-file headers.
- `GET /api/records/assets/{id}/thumbnail?v=<revision>` serves a video,
  image, or audio cover-art thumbnail. The tree names the file revision in `v`; a matching
  revision is cached by the browser as immutable, any other is revalidated.
- `GET /api/records/assets/{id}/subtitle` serves a WebVTT or SubRip sidecar
  as WebVTT. SubRip cues gain the WebVTT header and dotted milliseconds. A
  file over 2 MiB, text that is not UTF-8, WebVTT without its header, and
  other subtitle formats are not served.
- `GET /api/records/continue?limit=<1-50>` lists the viewer's most recently
  played available videos and audio files that stopped past their first five
  seconds and before their last five, 12 by default.
- `GET /api/records/folders/{id}/artwork/{poster|backdrop}` serves recognized
  sidecar artwork after signature validation.
- `POST /api/records/scans` queues the coalesced durable scan for
  `library:write` users after the root is online.
- `GET` and `PUT /api/records/assets/{id}/progress` read and write per-user
  video and audio progress; writing it needs `playback:use`.
- `DELETE /api/records/assets/{id}` moves an available record file to the
  trash for `downloads:manage` users and answers its `trashPath` relative to
  the record root; `DELETE /api/records/folders/{id}` moves a folder with
  everything in it and also answers `assetIds`, the files it held. Both take
  a JSON body with the confirmed `expectedPath` and answer `409` with
  `record_item_changed` when the id now names another path.

The **Record** navigation entry opens a folder browser over this tree with a
full-screen video player and photo viewer, described in
[Frontend](frontend.md). Record audio, and the sound of a video on request,
plays in the global audio player; starting a record video pauses it.
