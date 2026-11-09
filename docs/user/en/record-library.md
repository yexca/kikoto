# Home Videos

[English](record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](../ko/record-library.md)

Home videos is an independent library for personal videos and images. It uses
the `/record` mount and never adds files to the audio Library or to a work.

## Set up

Mount a host directory at `/record`, open **Home videos**, and choose
**Initialize root**. Kikoto writes a `.kikoto-record` marker; scanning only
starts after that explicit initialization. The default production mount is:

```yaml
volumes:
  - ./record:/record
```

Organize folders in any depth. The page displays the directory tree directly:

```text
record/
├── artist1/
│   ├── folder-a/
│   └── folder-b/
└── artist2/
    └── folder-c/
```

## Scanning and artwork

Choose **Scan record library** from the page. The scan is queued as a durable
workflow and coalesces with an existing scan. It indexes regular files by
extension, skips links and Kikoto transaction directories, and keeps previous
rows when the root is offline or a scan is partial. Only a complete walk marks
removed folders and files as missing.

Folder artwork uses these image names: `folder`, `poster`, or `cover` for a
poster, and `backdrop`, `fanart`, or `background` for a backdrop. Supported
video extensions include `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, and
`.ts`; supported image extensions include `.jpg`, `.jpeg`, `.png`, `.webp`, and
`.avif`.

Select a video to play it in the page. Playback position is stored per account;
the global audio player remains independent.
