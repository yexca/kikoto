# Record Library

The record library is an independent local media subsystem for home videos and
images. Its root is configured separately from the audio data root, with
`KIKOTO_RECORD_ROOT` defaulting to `/record` in the container. It is not a
storage pool and it is never included in the audio local-work scan.

Record is off until an administrator turns it on in **System → Library**,
which saves the `record_library_enabled` app setting. While it is off, every
`/api/records` route answers `404` with `record_library_disabled`, the
navigation leaves Record out, and `/records` is not found; `GET
/api/runtime-settings` reports the setting to signed-in readers as
`recordLibraryEnabled`. Turning it off deletes nothing: record rows, progress,
and thumbnails stay for when it is turned on again.

The root carries a `.kikoto-record` marker. An administrator initializes the
root explicitly in the same settings section before the first scan. A missing, unmounted, foreign, or
unreadable root is reported as unavailable and leaves existing record rows
unchanged; it never marks the whole library missing.

Record folders and assets have their own identities. A record asset does not
become a `work`, does not receive a `primary_code`, and is not stored in
`media_item`. Playback and file-serving primitives may be shared with work
media, while record metadata, progress, and state stay in record tables.

The schema keeps one row per folder and one row per regular file. Paths are
relative to the record root and normalized for lookup. The scanner walks the
whole configured record root and classifies video, image, subtitle, metadata,
and other files by a bounded extension allowlist. It does not follow links or
junctions and skips Kikoto transaction directories and operating-system
metadata directories.

Record scans run as the durable `record_library_scan` workflow. Only a complete
root walk reconciles missing folders and assets. An unreadable directory or a
cancelled scan leaves rows it could not observe in their previous state.
Discovery records file size and modification time. A file whose size,
modification time, or kind changed returns to the pending probe state and loses
its earlier duration and dimensions.

After the walk, the same scan probes pending videos and images with `ffprobe`:
at most 2,000 per scan, two at a time, each with a 20-second timeout, one
thread, the file protocol only, and a bounded output. A video records its
duration, dimensions, codecs, and whether it has audio; an image records its
dimensions. A file the probe cannot read is marked failed without failing the
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
the image itself. Both fit a 640-pixel box as JPEG. At most two `ffmpeg`
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
that are no longer available videos or images are removed, and the run summary
counts them; a partial scan leaves them in place. An evicted or cleared
thumbnail is made again on its next request.

Folder artwork follows explicit sidecar names. `folder`, `poster`, and `cover`
are poster candidates; `backdrop`, `fanart`, and `background` are backdrop
candidates. The server checks image signatures before serving record artwork or
image previews and never exposes an absolute filesystem path.

The HTTP surface is under `/api/records`:

- `GET /api/records` reports root state; `POST /api/records/root/initialize`
  creates the marker for an administrator with `sources:write`.
- `GET /api/records/tree?folderId=<id>` returns up to 200 children for one
  folder with their artwork, stream, thumbnail, and subtitle URLs and the
  viewer's saved progress on each video.
- `GET /api/records/assets/{id}` returns asset metadata; `GET
  /api/records/assets/{id}/stream` serves an authenticated Range-capable video
  or image.
- `GET /api/records/assets/{id}/thumbnail?v=<revision>` serves a video or
  image thumbnail. The tree names the file revision in `v`; a matching
  revision is cached by the browser as immutable, any other is revalidated.
- `GET /api/records/assets/{id}/subtitle` serves a WebVTT or SubRip sidecar
  as WebVTT. SubRip cues gain the WebVTT header and dotted milliseconds. A
  file over 2 MiB, text that is not UTF-8, WebVTT without its header, and
  other subtitle formats are not served.
- `GET /api/records/continue?limit=<1-50>` lists the viewer's most recently
  played available videos that stopped past their first five seconds and
  before their last five, 12 by default.
- `GET /api/records/folders/{id}/artwork/{poster|backdrop}` serves recognized
  sidecar artwork after signature validation.
- `POST /api/records/scans` queues the coalesced durable scan for
  `library:write` users after the root is online.
- `GET` and `PUT /api/records/assets/{id}/progress` read and write per-user
  video progress.

The **Record** navigation entry opens a folder browser over this tree with a
full-screen video player and photo viewer, described in
[Frontend](frontend.md). Record video playback does not go through the global
audio player; starting a record video pauses it.
