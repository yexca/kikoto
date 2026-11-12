# Unreleased

> [!NOTE]
> Record reads its library from a separate `/record` mount. The bundled Compose
> files mount `./record`; add the same mount to a custom Compose file to use
> Record.

<details>
<summary><strong>Record</strong></summary>

- Record is a separate library for personal videos and photos in the
  sidebar. It reads its own `/record` mount, starts after an administrator
  initializes the root, and never adds files to the audio Library or to a
  work.
- Record browses one folder at a time under a path that leads back to every
  parent, and the address keeps the open folder for Back, Forward, and reload.
  Folders with artwork open with a poster and backdrop banner and **Play** or
  **Continue from**; videos, photos, and subfolders can be filtered and
  sorted.
- Videos play in a full-screen player that steps through the folder, offers to
  continue where you stopped, saves the position per account, and pauses the
  global audio player. Photos open full screen with arrow keys and swipes.
- A scan reads each video's length and size. Video tiles show a frame from the
  video and photos show small thumbnails, both made the first time a folder
  shows them; folder artwork images stay out of the photos.
- **Continue watching** at the top of Record lists the videos you stopped part
  way through and resumes them. A `.vtt` or UTF-8 `.srt` file named like a
  video plays as its subtitles.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Go toolchain is updated to 1.26.11, which fixes an HTTP/1 server crash
  caused by a race on request headers when a request body is size-limited
  (GO-2026-6859).

</details>
