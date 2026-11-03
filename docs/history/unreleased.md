# Unreleased

<details>
<summary><strong>Playback</strong></summary>

- The work detail video viewer reopens a local or cached video where it
  stopped, with a Start over button, loads same-name WebVTT and SRT files as
  subtitles, and adds keyboard shortcuts for play, seeking, fullscreen, mute,
  and speed.
- iOS and iPadOS play converted video through their native HLS player, which
  keeps native fullscreen and AirPlay.
- Local and cached video plays directly instead of through the 720p
  transcode when the browser decodes it as stored: H.264 Main and High up to
  level 5.2, HEVC Main and Main 10 in MP4, AV1 in MP4 and WebM, 10-bit VP9,
  and H.264 or VP9 in Matroska where the browser reports Matroska support.
  HEVC and AV1 play directly only where the browser reports their decoding as
  power efficient. The server matches each file's profile, level, bit depth,
  and pixel format, and 4:2:2, 4:4:4, and 10-bit H.264 video is still
  transcoded.
- Converted video plays from one continuous encode instead of one FFmpeg
  process per six-second segment, so audio no longer clicks at every segment
  boundary, later segments arrive without per-segment startup, and one video
  holds a single transcode slot. Segments converted before the upgrade are
  not reused.
- A video file played through the audio player streams its audio as the
  six-second AAC playlist that converted audio uses, so it starts within
  about a second instead of waiting for a complete MP3 conversion, and a long
  video no longer fails to convert. Only the first audio stream is encoded;
  the picture is never decoded. The MP3 conversion remains for browsers
  without HLS playback.
- H.264 video the browser decodes but cannot play in its container or with
  its audio, such as H.264 in Matroska, AVI, MPEG-TS, or FLV, or in MP4 with
  AC-3, DTS, FLAC, or PCM audio, keeps its source picture: its video is copied
  into HLS segments cut at its own keyframes and only the audio is converted.
  Video with keyframes more than 15 seconds apart or above 20 Mbit/s is still
  transcoded to 720p, and a copied video the browser fails to decode is
  prepared again as a transcode.
- HEVC Main and Main 10 video that the browser decodes in streamed playback
  but cannot play directly, such as HEVC in Matroska in a browser without
  Matroska support, keeps its source picture the same way, copied into fMP4
  HLS segments instead of transcoded to 720p H.264.
- Converted video can be encoded by an Intel GPU through VA-API or Quick Sync
  Video, chosen under Settings → Cache & Fetch and off by default. A test
  encode at startup and on save decides whether the GPU is used, and a file
  whose GPU encode fails is encoded by the CPU. The amd64 image includes the
  Intel VA-API driver; pass `/dev/dri` to the container to use it.

</details>
