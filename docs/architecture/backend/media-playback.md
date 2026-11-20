# Media Playback

How the backend measures loudness, shares conversion capacity, answers playback info for video and audio, chooses audio tracks, extracts subtitles for local and cached media, and reads lyrics and subtitle text.

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

## Audio Playback Decision

`GET /api/media/{id}/playback?profile=audio` chooses how the audio player plays
a local or cached audio file, or the audio of a video, and answers
`delivery`, `conversion`, `url`, and `durationSeconds`:

- `direct` (`conversion` `none`) names the stream route with the declared
  `capabilities`, which serves the file itself with range support. The probed
  first audio stream and its container decide, never the extension: FLAC named
  `.mp3` plays directly for a client that declares `audio-flac` and is
  converted for one that does not, and MP3 named `.wma` plays directly.
- `hls` names the audio HLS playlist of the file's revision. A client declares
  `audio-hls` when it plays one; the playlist is a conversion, so the transcode
  slots, failure memory, and cache quota apply as they do to video.
- `prepared` names the stream route with `forceTranscode`, which serves one
  complete MP3 conversion. A client without `audio-hls` gets it for any
  converted file, and so does a file that HLS cannot segment.

`forceTranscode`, the player's compatibility playback, skips `direct`. The
extension decides only when the probe cannot run or rejects the file: a known
audio extension then plays directly through the stream route's `forceDirect`,
which serves the file without probing, and any other file is converted. A
playback info request converts nothing, since the conversion starts with the
request for the URL it names, so the player may ask for the next track ahead
of its turn. The probe result is cached for two minutes, so the stream
request that follows does not probe again. The `audio-hls` capability names
no format, and the stream route ignores it.

A Record audio file, or the audio of a Record video, is answered by
`GET /api/records/assets/{id}/playback?profile=audio` with the same decision
between `direct` and `hls`; Record has no `prepared` delivery.

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

## Timed Text

`backend/internal/timedtext` is the one reader of lyrics and subtitle text, so
no client parses LRC, WebVTT, SubRip, or ASS and SSA. It reads the format from
the content, never the file name: a `WEBVTT` header, or complete cue timing
lines at least as many as lines that start with LRC timestamps, make a cue
file; otherwise LRC timestamps make it LRC, then ASS dialogue. A WebVTT file
may therefore be named `.txt`. The reader keeps LRC `[offset:]` tags, hour
fields, and minutes past 99, and drops markup, cue identifiers, settings, and
word timestamps from line text.

The two text routes, `GET /api/media/{id}/text` and
`GET /api/remote-sources/{id}/works/{code}/text`, answer in one of two shapes
when asked with `format`; a file is read, bounded, and decoded as in
[Remote text preview](../../development/security.md#remote-text-preview) first.

- `format=lyrics` returns JSON: `timed`, `lines` (`time` in seconds, `text`,
  and `attribution` for the line naming the models of AI-made lyrics, decided
  by the translation package's attribution templates), the song `tags` of an
  LRC header, `sparse` for a file where only a few lines carry LRC timestamps,
  and `text`, the file itself, when it holds no timed line. Timed lines are
  JSON rather than WebVTT because lyrics are shown and sought by line start;
  LRC lines have no end, and WebVTT would make every client parse cues again.
- `format=webvtt` returns `text/vtt` for a `<track>` element. A WebVTT file
  passes through as written; SubRip cues are rewritten, keeping `<i>`, `<b>`,
  and `<u>` and escaping the rest; ASS and SSA dialogue keeps only timing and
  text. A cue without a usable end lasts until the next cue, or five seconds.
  A file with no cue answers `422 subtitle_has_no_cues`.

Any other `format` is `400 invalid_text_format`. A Record subtitle URL always
answers WebVTT and ignores `format`.

`POST /api/lyrics/parse` reads text a client already holds, such as a
translation result or a transcription, as the `format=lyrics` shape without
`text`. It reads no file, stores nothing, accepts at most 512 KiB, needs a
signed-in viewer only, and stays available in Demo.

The same package renders WebVTT for speech recognition output and converts
SubRip sidecars for Record.
