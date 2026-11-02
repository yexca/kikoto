# Unreleased

<details>
<summary><strong>Playback</strong></summary>

- Converted video plays from one continuous encode instead of one FFmpeg
  process per six-second segment, so audio no longer clicks at every segment
  boundary, later segments arrive without per-segment startup, and one video
  holds a single transcode slot. Segments converted before the upgrade are
  not reused.

</details>
