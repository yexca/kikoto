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

</details>
