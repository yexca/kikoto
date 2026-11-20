# Media Playback

How the backend measures loudness, shares conversion capacity, answers playback info, chooses audio tracks, and extracts subtitles for local and cached media.

## Loudness

`GET /api/media/{id}/loudness` returns a local audio or video location's EBU
R 128 integrated loudness and peak. It is readable wherever the location's
stream is. When the file version on disk has none, the request measures it with
FFmpeg's `ebur128` filter on the first audio stream, asking for the true peak
and retrying with the sample peak, under the four-minute audio preparation
limit. Measurements run one at a time in their own slot, never in a transcode
slot, so playback conversion does not wait for them; a request waits at most
one second for that slot. FFmpeg's stderr is kept only as a 16 KiB tail for
the summary. Concurrent requests for one file share a measurement, a
measurement of a file that changed meanwhile is discarded, and the stored
result is keyed by the version the measurement read, even before a scan or
probe records that version for the location. Remote and cache locations answer
`404`, a busy slot `503 media_loudness_busy`, and a failed or timed-out
measurement `503 media_loudness_unavailable`; Demo measures nothing.

## Failure Memory and Transcode Slots

Audio preparation, subtitle extraction, realtime video conversion that ends
before any output, and an HLS encode that fails before its first segment
remember a failure for 30
seconds (a hardware video encode for an hour, after any failure), and loudness measurement remembers a failure
or timeout for an hour, keyed by purpose, path, size, and modification time,
holding at most 256 entries. A request in that time fails at once instead of
running FFmpeg again.

Playback conversion, which is HLS encodes, audio preparation, realtime
conversion, and the HEVC initialization run, shares one server-wide pool of
transcode slots. The administrator setting `realtime_transcode_slots`
(`transcodeSlots` in the settings API, 1 to 5, default 2) sizes it; a lower
count applies as running conversions release their slots. A request that finds
every slot taken waits at most one second in a queue of two places and is then
answered as busy.

## Compatibility Preparation

Compatibility preparation starts only from a playback request for that file,
including the player's single next-track preload, which requests the same
playback URL or the first segment of the same playlist. The backend never
prepares an unplayed queue, work, or library in the background, because
speculative preparation would spend the transcode slots and the shared
cache quota without a demonstrated benefit. The one exception is the keyframe
index of a remux, described in [HLS Encoding](hls-encoding.md#keyframe-index), which uses neither the transcode slots nor
a quota reservation.

## Playback Decision

`GET /api/media/{id}/playback` chooses how a local or cached video plays and
says so in `conversion`, which clients may ignore: `none` serves the file
directly, `remux` copies its video into HLS and encodes only the audio, and
`transcode` converts both. A video is remuxed when it does not play directly,
its stream is 8-bit 4:2:0 H.264 in Baseline, Main, or High profile at a
profile and level the client reports decoding, or 8- or 10-bit 4:2:0 HEVC in
Main or Main 10 profile at a profile, level, and bit depth the client reports
decoding in HLS, its average bitrate is at most 20 Mbit/s, its keyframes fit
the [segment limits](hls-encoding.md#keyframe-index), and a remux of the revision has not failed recently.
A `forceTranscode` request, which the player sends after direct playback
fails, skips the remux, because a remux would hand the same video stream to
the same decoder. A remux playlist is named by its own revision, derived from
the source revision and the copied codec, so the HLS route serves all of them
from one path and H.264 and HEVC remuxes never share segments.

HEVC in HLS plays through Media Source Extensions in hls.js, which a browser
can support without playing the file directly, or the reverse. The HLS HEVC
decoder keys `video-hls-hevc-main`, `video-hls-hevc-main-l51`,
`video-hls-hevc-main10`, and `video-hls-hevc-main10-l51` therefore mirror the
tiers of the direct HEVC decoder keys and are probed against Media Source: the
player sends one only when Media Source accepts the codec and AAC and, where
the browser offers MediaCapabilities, reports `media-source` decoding of it as
supported and power efficient.

## Audio Tracks

Playback info lists the audio streams of a video in `audioTracks`, with each
stream's index in the file, codec, channels, language, title, and default
flag, and names the one that plays in `audioStream`. Without a choice a video
plays its default track: the first audio stream flagged default, or the first
audio stream. A request names another track with the `audioStream` query, the
stream index of an audio stream of the file; any other value answers
`400 invalid_audio_stream`. Only the first audio stream plays directly, since
a browser chooses the audio of a file it plays itself, so another track is
remuxed or transcoded under the usual rules with FFmpeg mapping `0:a:N`. Each
track but the first has its own source revision, derived from the file
revision and the track number, so its playlists, cache directories, and
derived remux and hardware revisions are its own; the HLS URL carries
`audioStream` for a track other than the default, and its playlist repeats it
on every segment. A keyframe index, which depends only on the video stream,
is shared by every track. Transcode slots, sessions, quota, and failure memory
keyed by the file apply to every track alike. The audio of a video in the
audio player, realtime conversion, and loudness measurement use the first
audio stream and accept no `audioStream`.

## Subtitles

Playback info also lists a video's embedded text subtitle streams (SubRip,
ASS, SSA, WebVTT, and MP4 timed text) in `subtitles`: each stream's container
index, codec, language and title tags, default and forced flags, and its
`GET /api/media/{id}/subtitles/{stream}.vtt` URL. Picture subtitles are not
listed. The list comes from the playback probe that already decides direct
playback, which also reads the forced flag. The subtitle route converts one
stream to WebVTT with FFmpeg for at most two minutes and 4 MiB of output held
in memory. Extractions run one at a time in a slot of their own, never in a
transcode slot, so they run while every transcode slot is taken and never hold
one up; up to four requests wait for that slot, each for at most two minutes,
and a request that finds the queue full is answered as busy at once.
Concurrent requests for one stream share its extraction. Extraction holds no
transcode cache lock; only storing the result does, under a quota reservation
of its size. The file is kept under the transcode cache quota, named by a revision of the
source path, size, modification time, and stream, so a changed source is
extracted again and the old file is evicted like any other cache file.
Responses carry the untrusted-file headers, and a URL naming the current
revision is cached as immutable.
