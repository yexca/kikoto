# Record

[English](record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

Record is an independent library for personal videos and images. It uses
the `/record` mount and never adds files to the audio Library or to a work.

## Set up

Record is off until an administrator turns it on. Mount a host directory at
`/record`, then in **System → Library** turn on **Record library** under
**Record** and choose **Initialize root**. Kikoto writes a `.kikoto-record`
marker; scanning only starts after that explicit initialization. While Record
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
photos. Group headings appear when a folder holds more than one kind of item.
Subfolders appear as square tiles that show their poster, their backdrop when
they have no poster, or a folder icon when they have neither; videos as wide
tiles with a frame from the video, their length, and a bar for how much you
have watched; photos as square thumbnails. Thumbnails are made the first time a
folder shows them, so a large folder can take a moment the first time. Subtitle,
metadata, and other files stay hidden, and so do the folder's artwork images.

From any folder, **Continue watching** opens a list of the videos you stopped
part way through, most recent first, with the folder each one is in. Selecting
one plays it from where you stopped, and closing the player returns to the
folder where you opened it.

## Scanning and artwork

Choose **Scan** at the top right of the path bar; it needs library write access.
Hovering it shows when the root was last scanned, and while a scan runs it
shows whether it is queued, running, or finished. The scan is queued as a durable
workflow and coalesces with an existing scan. It indexes regular files by
extension, skips links and Kikoto transaction directories, and keeps previous
rows when the root is offline or a scan is partial. Only a complete walk marks
removed folders and files as missing. The scan also reads each new or changed
video's length and size and each new or changed photo's size; a file that
cannot be read keeps no length and is read again once it changes.

Folder artwork uses these image names: `folder`, `poster`, or `cover` for a
poster, and `backdrop`, `fanart`, or `background` for a backdrop. Supported
video extensions include `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, and
`.ts`; supported image extensions include `.jpg`, `.jpeg`, `.png`, `.webp`, and
`.avif`.

## Watching videos and photos

Select a video to open it in a full-screen player. When you stopped part way
through, Kikoto asks whether to continue from that time or start over. A
`.vtt` or `.srt` file with the same name as the video shows as its subtitles;
`.srt` files must be UTF-8. The previous and next buttons step through the folder's videos, and Back or Esc
closes the player. The position is saved per account about every ten seconds,
on pause, at the end, and when the player closes; saving it needs library write
access. A video that starts playing pauses the global audio player, which stays
paused after the player closes.

Select a photo to view it full screen. Step through the folder's photos with
the arrow buttons, the arrow keys, or a sideways swipe, and close it with Back
or Esc. A photo opens fitted to the screen; a click shows actual size and a
second click fits again, and the mouse wheel, a trackpad or two-finger pinch,
and the `+`, `-`, and `0` keys zoom to any size up to eight times actual size.
Drag to pan a zoomed photo.
