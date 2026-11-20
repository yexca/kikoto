# HLS Encoding

How remux keyframe indexes, HLS encodes, their per-kind limits, and Intel GPU encoding work.

## Keyframe Index

Copied video can be cut only at its keyframes, so a remux playlist follows a
keyframe index instead of the six-second grid. FFprobe reads the timestamps
and flags of the video packets, one scan at a time per server, for at most a
minute and 64 MiB of output. Each segment starts at the keyframe nearest six
seconds after the previous start, at least three seconds later; a segment
longer than 15 seconds, including one before the first keyframe, makes the
index unusable. Playback info waits five seconds for the index and otherwise
offers a transcode while the scan continues. Results are kept in memory per
source revision for the 64 most recent files, and a failed scan is retried
after ten minutes. A usable index is also stored in the transcode cache, at
`transcodes/hls-keyframes/<location>/<revision>.json` with the name of the
segment rules it was cut with, so a restarted server reads it instead of
scanning again; reading it counts as a use for the cache limit, and a stored
index that is malformed or was cut by other rules is scanned again.

`GET /api/works/{id}` with media and `GET /api/works/{id}/media` queue the
work's available local and cached videos, and `GET /api/records/tree` the
listed folder's available record videos, for a keyframe scan after writing
their response. A queue of at most 32 videos runs one video at a time
behind the response, skips a video whose probe shows no stream a remux copies
or whose average bitrate exceeds the remux limit, skips a video that every
current browser plays directly with its default audio track (H.264 up to High
4.2 in MP4 with AAC, MP3, or no audio, its first audio stream the default), and
reads a stored index without scanning. Whether the client decodes the stream
is decided only at playback. Demo queues nothing, so it scans only for a
playback. A scan that a playback starts cancels a queued scan holding or
waiting for the scan slot, and that scan's result is not remembered, so the
next request for the file scans it again; a playback that asks for the index
being prefetched waits for that scan instead.

## Encode Timeline

An HLS encode runs from the requested segment and writes the timestamps of one
shared timeline for its source revision, so segments from different encodes
fit together. Video timestamps start 10 seconds in, which keeps B-frame decode
timestamps positive from the first segment, so FFmpeg never shifts one
encode's timeline against another's.

- Audio and transcoded video use FFmpeg's HLS muxer, with the segment's start
  as both input seek and output timestamp offset. A video transcode places
  keyframes only on the six-second grid, without scene-cut keyframes, converts
  to a constant frame rate of at most 60 fps, and clones the last frame of a
  video stream that ends early up to the published duration; the muxer cuts
  segments at those keyframes, so every encode cuts them at the playlist's
  boundaries, within one frame. An encode of the audio of a video pads it with
  silence to the published duration, so audio that ends before the video
  still produces every listed segment. Each segment is written beside its
  final name and renamed when complete.
- A remux seeks to the source timestamp just before the segment's keyframe,
  keeps source timestamps, and discards packets before that time, so the
  keyframe is the first packet. FFmpeg's segment muxer cuts at the indexed
  keyframes by counting video packets from that first packet. It writes each
  segment under a temporary name, and the session renames a segment once the
  next one starts or the encode reaches the end of the input. H.264 is copied
  into MPEG-TS segments. HEVC is copied into fMP4 segments under the `hvc1`
  sample entry, the only HEVC form Apple's HLS players accept: each segment is
  one fragment whose decode time continues the shared timeline, and the
  playlist declares version 7 and names one initialization section,
  `init.m4s`, in `EXT-X-MAP`. The section and segments are served as
  `video/iso.segment`, never under an `.mp4` name or as `video/mp4`, which
  browser download managers capture as files. Every encode of a revision writes the same
  section, so encodes discard theirs and the server produces it once per
  revision with a run of the remux encode that copies no media. That run
  takes a transcode slot for at most 30 seconds, one run per section at a
  time, and writes its empty segment and list into a temporary directory
  outside the cache. It reads the section into memory, limited to 1 MiB, and
  holds no transcode cache lock until it stores the section beside the
  segments under the shared quota, so clearing the cache never waits for it.
  Its failure is remembered as a failed remux, so playback info then offers a
  transcode.

Strict interleaving keeps each audio packet in the segment of its timestamp. A
segment file that exists under its final name is complete.

## Encode Lifetime and Limits

A missing segment close to the running encode's output waits up to 45 seconds
for it; any other missing segment stops that encode and starts one there. For
transcoded video, starting at a later segment produces it sooner than encoding
the ones before it. An encode stops when it is far enough ahead of the
furthest segment requested, after its segment budget, when it reaches a
segment an earlier encode already produced, after 20 minutes, and, for video,
when no request has asked or waited for a segment for a minute. Serving a
segment while no encode runs starts the next one in the background when a
segment within the refill lead is missing. An encode takes a transcode slot
and a quota reservation for its segment budget, and fails when
a segment exceeds the segment size limit.

| Limit | Audio | Transcoded video | Remuxed H.264 or HEVC video |
| --- | --- | --- | --- |
| Wait instead of restarting | within 20 segments | within 2 segments | within 10 segments |
| Stop ahead of the furthest request | 300 segments | 60 segments | 20 segments |
| Refill lead | 100 segments | 20 segments | 10 segments |
| Segment budget | 400 segments | 80 segments | 30 segments |
| Quota reservation | 256 KiB per segment | 3 MiB per segment | 1.25 times the source bytes of the budget, plus 192 kbit/s audio |
| Segment size limit | 16 MiB | 16 MiB | 64 MiB |
| Stop without requests | none | 1 minute | 1 minute |

Encodes join where playback seeks or a refill starts, and audio there can
overlap or miss a few tens of milliseconds. A video stream with no frame after
the requested position, such as a single still picture, produces no segment
boundaries when transcoded, so seeking into it fails; a remux of it has no
usable keyframe index and is not offered.

## Hardware Encoding

Transcoded video can be encoded by an Intel GPU, chosen by the administrator
settings `video_hardware_acceleration` (`none`, `qsv`, or `vaapi`) and
`video_hardware_device`, a `/dev/dri/renderD*` render node. The GPU receives
the frames the CPU decoded, scaled, and padded for the software encode, so
both share the 720p bound, forced keyframes on the six-second grid, timeline,
and audio; VA-API encodes in variable bitrate and QSV turns forced keyframes
into IDR frames, both at 2000 kbit/s under the software 2800 kbit/s cap. At
startup and after the settings change, a check encodes a 42-second 29.97 fps
clip, in the encoder's normal mode and then in low-power mode, and accepts the
encoder only when every segment starts with a keyframe within one frame of its
playlist position; the settings response reports the outcome. Playback info
then names a hardware revision, derived from the source revision and the mode,
whose segments live under `hls-hw`. Its playlist has the software grid, so the
software encode serves its segments whenever the encoder is off, changed, or
failed for that file: a failed hardware session, at any segment, is remembered
for an hour per file revision, and the request that met the failure is
answered by the software encode.
