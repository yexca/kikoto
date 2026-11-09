# Record Library

The record library is an independent local media subsystem for home videos and
images. Its root is configured separately from the audio data root, with
`KIKOTO_RECORD_ROOT` defaulting to `/record` in the container. It is not a
storage pool and it is never included in the audio local-work scan.

The root carries a `.kikoto-record` marker. An administrator initializes the
root explicitly before the first scan. A missing, unmounted, foreign, or
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
Discovery records file size and modification time; this workflow leaves media
probe fields in their pending state.

Folder artwork follows explicit sidecar names. `folder`, `poster`, and `cover`
are poster candidates; `backdrop`, `fanart`, and `background` are backdrop
candidates. The server checks image signatures before serving record artwork or
image previews and never exposes an absolute filesystem path.

The HTTP surface is under `/api/records`:

- `GET /api/records` reports root state; `POST /api/records/root/initialize`
  creates the marker for an administrator with `sources:write`.
- `GET /api/records/tree?folderId=<id>` returns up to 200 children for one
  folder and available video/image stream and artwork URLs.
- `GET /api/records/assets/{id}` returns asset metadata; `GET
  /api/records/assets/{id}/stream` serves an authenticated Range-capable video
  or image.
- `GET /api/records/folders/{id}/artwork/{poster|backdrop}` serves recognized
  sidecar artwork after signature validation.
- `POST /api/records/scans` queues the coalesced durable scan for
  `library:write` users after the root is online.
- `GET` and `PUT /api/records/assets/{id}/progress` read and write per-user
  video progress.

The desktop application adds a **Home videos** navigation entry and loads the
directory tree lazily in the records feature. The existing global audio player
remains independent of record video playback.
