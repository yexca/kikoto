# Record

[English](record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

Record is an independent library for personal videos, images, and audio files.
It uses the `/record` mount and never adds files to the audio Library or to a
work.

## Set up

Record is off until an administrator turns it on. Mount a host directory at
`/record`, then in **System → Library** turn on **Record library** under
**Record** and choose **Initialize root**. Kikoto writes a `.kikoto-record`
marker that names this root; scanning only starts after that explicit
initialization. Another disk mounted at `/record`, even one initialized for
Record elsewhere, shows Record as offline and leaves this library as it was.
Choosing **Start a new catalog** for that disk, after a confirmation, makes it
the Record root and starts the library afresh: the earlier disk's folders and
watched positions are forgotten.
When the directory is there but its `.kikoto-record` marker is gone, Record keeps its
library: everyone can still browse and play it, a scan adds new files without
marking any missing, and files cannot be deleted. Under **Record** in
**System → Library**, **Restore marker** writes the marker again and keeps the
library, once the disk that holds the library's folders is mounted; **Start a new catalog**, after a confirmation, forgets the library
and indexes the directory afresh on the next scan. An empty directory, as an
unmounted disk leaves behind, cannot start a new catalog: mount the disk, or
add files to the directory first.
While Record
is off, the sidebar leaves it out for every account; turning it off keeps its
folders, watched positions, and thumbnails for when it is turned on again.
The default production mount is:

```yaml
volumes:
  - ./record:/record
```

Organize folders in any depth. The page browses the same tree:

```text
record/
├── artist1/
│   ├── folder-a/
│   └── folder-b/
└── artist2/
    └── folder-c/
```

## Browsing

Record shows one folder at a time. The path bar at the top names the folder and
leads back to any folder that contains it, with **Continue watching** and
**Scan** (or **Refresh** when your account cannot scan) at the right end. The
address keeps the open folder, so browser Back, Forward, and reload return to
the same place; Backspace also steps up one folder.

Items are ordered naturally by name: subfolders first, then videos, then
photos, then the folder's other files. Group headings appear when a folder
holds more than one kind of item.
Subfolders appear as square tiles that show their poster, their backdrop when
they have no poster, or a folder icon when they have neither; videos as wide
tiles with a frame from the video, their length, and a bar for how much you
have watched; photos as square thumbnails. Beside a video's name, **Play as
audio** plays its sound in the global audio player from where you stopped, with
the folder's other videos queued after it as sound. Thumbnails are made the first time a
folder shows them, so a large folder can take a moment the first time. The
folder's artwork images stay hidden.

**Files** lists everything else in the folder, one row each with its type and
size: audio files with their length and a bar for how much you have heard,
subtitles, metadata, and any other file. An audio file that carries cover art
shows it in its row. Selecting an audio file plays it, as described in
[Listening to audio](#listening-to-audio).

From any folder, **Continue watching** opens a list of the videos and audio files
you stopped part way through, most recent first, with the folder each one is in. Selecting
one plays it from where you stopped. A video opens over its folder, and closing
the player returns to the folder where you opened it; an audio file opens its
folder and plays in the global audio player.

## Scanning and artwork

Choose **Scan** at the top right of the path bar; it needs library write access.
Hovering it shows when the root was last scanned, and while a scan runs it
shows whether it is queued, running, or finished. The scan is queued as a durable
workflow and coalesces with an existing scan. It indexes regular files by
extension, skips links and Kikoto transaction directories, and keeps previous
rows when the root is offline or a scan is partial. Only a complete walk marks
removed folders and files as missing. The scan also reads each new or changed
video's length and size, each new or changed audio file's length and whether
it carries cover art, and each new or changed photo's size; a file that
cannot be read keeps no length and is read again once it changes.

Folder artwork uses these image names: `folder`, `poster`, or `cover` for a
poster, and `backdrop`, `fanart`, or `background` for a backdrop. Supported
video extensions include `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, and
`.ts`; supported audio extensions include `.mp3`, `.m4a`, `.aac`, `.flac`,
`.wav`, `.ogg`, `.opus`, `.wma`, `.aiff`, and `.mka`; supported image
extensions include `.jpg`, `.jpeg`, `.png`, `.webp`, and `.avif`.

## Watching videos and photos

Select a video to open it in a full-screen player that fits the picture and
its controls to the screen. It has the on-screen controls, touch gestures,
Subtitles menu, and keyboard shortcuts of
[a work's video player](work-detail.md#current-behavior); on a
computer, the keyboard button at the top lists the shortcuts. On a phone,
the video switches to fullscreen when it starts, and a video wider than it is
tall turns the screen to landscape until fullscreen ends; on iPhone and iPad,
**Full screen** opens the system player. When you stopped part way through, Kikoto asks
whether to continue from that time or start over. A video your browser cannot
play as it is, such as an MPEG-TS (`.ts`) recording or HEVC on a browser
without it, plays the way the Library's videos do: the server repackages it
without re-encoding when the browser decodes its picture, and converts it
otherwise. A `.vtt` or `.srt` file with the same name as the video shows as
its subtitles; `.srt` files must be UTF-8. Text subtitles inside the video
are offered too. The previous and next buttons step through the folder's
videos, and Back or Esc closes the player.

At the top right of the video player, **Play as audio** closes the player and
continues the video's sound in the global audio player from the same moment,
with the folder's other videos queued after it as sound. **More actions** beside it
holds **Delete**.

The position is saved per account about every ten seconds, on pause, at the
end, and when the player closes. A video
that starts playing pauses the global audio player, which stays paused after
the video player closes, and the video pauses when the global audio player
starts again.

Select a photo to view it full screen. Step through the folder's photos with
the arrow buttons, the arrow keys, or a sideways swipe, and close it with Back
or Esc. A photo opens fitted to the screen; a click shows actual size and a
second click fits again, and the mouse wheel, a trackpad or two-finger pinch,
and the `+`, `-`, and `0` keys zoom to any size up to eight times actual size.
Drag to pan a zoomed photo.

## Listening to audio

Selecting an audio file plays it in the global audio player from where you
stopped, with the folder's other audio files queued in order. The player shows
the file's own cover art, or no picture when the file has none, and names the
folder under the title; double-clicking the cover, or double-tapping it on a
phone, opens that folder. A file your browser cannot play as it is, such as
`.wma`, is converted, and [compatibility playback](playback.md#current-behavior)
works as it does for Library audio. The position is saved as it is for videos.
Record audio has no lyrics, does not count toward listening history, and stays
out of the queue the player restores after a reload.

## Deleting files and folders

An account with file management access (`downloads:manage`) can delete Record
files and folders. **Delete** is in a **More actions** menu: at the top right
of the video player, at the top of the photo viewer, at the end of each row under
**Files**, and beside the name of each video and folder tile. A review names the file or
folder by its path inside the record root and lists what goes and what stays;
**Continue**, then **Move to trash**, deletes it. After a file is deleted, the
viewer moves on to the next video or photo, or closes when there is none.

Deleting moves the file or folder into `.kikoto-trash/records` in the record
root, under a folder named for the time and the item, with its folders inside
the root kept. A folder goes with everything in it, including files Record
does not list. The progress of every account, the thumbnails, and the playback
cache of the files removed go too, and those files leave the global audio
player's queue. Files beside a deleted file, such as its subtitles, stay.
Kikoto never empties the trash: to restore a file or folder, move it back and
scan, or delete it from disk to free the space. Nothing is deleted while the
record root is offline, the root folder itself cannot be deleted, and an item
reached through a link is refused. An item that changed since the page showed
it, such as one deleted from another tab, is refused too; refresh and review
it again.
