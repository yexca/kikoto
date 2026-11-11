# Record

[English](record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

Record is an independent library for personal videos and images. It uses
the `/record` mount and never adds files to the audio Library or to a work.

## Set up

Mount a host directory at `/record`, open **Record**, and choose
**Initialize root**. Kikoto writes a `.kikoto-record` marker; scanning only
starts after that explicit initialization. The default production mount is:

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

Record shows one folder at a time. The path above it names the folder and
leads back to any folder that contains it. The address keeps the open folder,
so browser Back, Forward, and reload return to the same place.

A folder with backdrop artwork opens with a banner that shows its poster, name,
and numbers of videos and photos, with **Play** for the first video or
**Continue from** the time where you left the video you watched last. Other
folders show the same facts as a plain heading.

The toolbar shows **All**, **Videos**, or **Photos** and sorts by name in either
direction. Subfolders appear as posters, or as a folder when they have none;
videos as wide tiles with their length when it is known and a bar for how much
you have watched; photos as square thumbnails. Subtitle, metadata, and other
files stay hidden. **Refresh** reads the folder again.

## Scanning and artwork

Choose **Scan** in the toolbar; it needs library write access. Beside it the
page shows when the root was last scanned and, after you start a scan, whether
it is queued, running, or finished. The scan is queued as a durable
workflow and coalesces with an existing scan. It indexes regular files by
extension, skips links and Kikoto transaction directories, and keeps previous
rows when the root is offline or a scan is partial. Only a complete walk marks
removed folders and files as missing.

Folder artwork uses these image names: `folder`, `poster`, or `cover` for a
poster, and `backdrop`, `fanart`, or `background` for a backdrop. Supported
video extensions include `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, and
`.ts`; supported image extensions include `.jpg`, `.jpeg`, `.png`, `.webp`, and
`.avif`.

## Watching videos and photos

Select a video to open it in a full-screen player. When you stopped part way
through, Kikoto asks whether to continue from that time or start over. The
previous and next buttons step through the folder's videos, and Back or Esc
closes the player. The position is saved per account about every ten seconds,
on pause, at the end, and when the player closes; saving it needs library write
access. A video that starts playing pauses the global audio player, which stays
paused after the player closes.

Select a photo to view it full screen. Step through the folder's photos with
the arrow buttons, the arrow keys, or a sideways swipe, and close it with Back
or Esc.
