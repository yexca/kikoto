# Runtime Responsibilities

What the backend process does at runtime, its background workers, and the limits of its embedded job runner.

- Authenticate users and enforce permissions.
- Enforce the production instance access policy before API handlers, with
  sign-in required by default and optional anonymous `GET`/`HEAD` access.
- Scan local libraries.
- Scan the independent record library and serve its authenticated video,
  audio, and image routes without coupling it to audio work identity; record
  videos and audio files use the [playback pipeline](media-playback.md) under their own
  routes and cache keys.
- Sync metadata snapshots.
- Serve library and detail APIs.
- Browse and sync remote sources.
- Stream local media with range support.
- Publish complete-duration HLS VOD manifests for incompatible local or cached
  audio and video under one route, `GET /api/media/{id}/hls/{file}`, which
  branches on the media kind. The audio player adds `profile=audio` to play
  only the first audio stream of a video; that profile has its own revisions
  and audio encode, so it never shares segments with the video playlist of
  the same file, and a video without audio fails as unsupported like an audio
  file without one. Segments of all of them come from one continuous encode
  per source revision, so segment boundaries stay seamless; H.264 and HEVC
  video the client decodes is copied rather than transcoded. All are quota-bounded and
  live under the disposable cache root.
- Prepare incompatible local or cached audio as complete, quota-bounded MP3
  cache files with duration and HTTP Range support for clients without HLS
  playback, preserving original media.
- Record workflow runs and activity state.
- Claim durable workflow jobs by priority through one global executor, so only
  one workflow job runs at a time.
- Coalesce concurrent local-media indexing for the same work, keep duration
  probes serialized per server, and expose slow index phase timings in logs.

## Local Duration Probing

Local duration probing runs in one service-scoped worker. Indexing coalesces
wakeups instead of retaining file lists in waiting goroutines. The worker reads
at most 64 pending local locations at a time, skips complete duration metadata,
and resumes missing or unversioned metadata on startup. Local file observations
include size and nanosecond modification time; scans clear derived duration and
audio metadata after a change, and probes commit only against their observed
location id and file version. Probe reads use the same online-pool and work-root
depth scope as scans. Identical size and preserved modification time cannot be
distinguished without content hashing. A pass has a fixed location-id frontier;
indexing during a pass requests one follow-up. Duration probes share the
bounded FFprobe runner with playback probes: at most two concurrent processes,
two waiters that give up after one second, a five-second limit per probe
including that wait, and 128 KiB of output. Shutdown cancels active probing.
A probe that FFprobe completes but cannot use, by exiting with an error,
printing invalid output, or exceeding the output limit, records the observed
version in `probe_failed_version`, and the worker skips that location until a
scan records another version. A timeout, a busy runner, cancellation, or a
missing FFprobe records nothing.

## Query Planner Statistics

Query planner statistics are refreshed by one bounded background worker after
committed bulk changes; GET requests never run analysis. Its triggers and
bounds are in [Database maintenance](../../operations/database.md#maintenance).

## Current Limits

- Fetch, cache, cleanup, scan, metadata, and preset workflow paths run as
  persisted jobs; other operations run synchronously in their request.
- The embedded job runner is single-instance and SQLite-backed; it is not a
  distributed worker system.
- Retry, cancellation, and restart recovery are defined per job family rather
  than by one universal guarantee.
