# Custom Works

Local folders held as works without a catalog code.

A custom work is a local folder the library holds as a work without a catalog
code ([ADR-0005](../../decisions/ADR-0005-custom-work-codes.md)). Its code is `KT`
followed by eight digits, a work code like the catalog prefixes, and its
folder's name carries the code in brackets, such as
`Example Work [KT00000001]`, so scans find it like any other work folder.
Scans recognize a custom code only in that bracketed form, and remote-source
codes are catalog codes only, so no remote entry resolves to a custom work.
`custom_work_code_counter` holds the highest number assigned; a number is
assigned once, even when the creation that reserved it fails, and a number a
work or a folder name within the scan depth already uses is skipped.

A folder can become a custom work when it lies in an online storage pool
within the scan depth, is not hidden or one of Kikoto's own directories, and
neither it nor any folder above or below it within the depth carries a work
code or cannot be read, since an unreadable folder may hold a work folder.
Creating the work checks the folder again, then commits the code to the
counter in a short transaction, renames the folder inside its parent, and
inserts the work with its title, so no database write waits on the rename. A
failed rename inserts no work, and a failed insert renames the folder back. An
incremental scan of the renamed folder then records its location and files; if
the server stops between the rename and the insert, the next scan records the
work from the renamed folder. The `custom_work_rename_notice` setting
records the accepted version of the notice that creating a custom work renames
its folder, the administrator who accepted it and when; creation is refused
until the current version is accepted. A custom work has no DLsite page,
provider metadata, or remote source, and its metadata comes from manual
overrides. Work detail marks it `customWork`. Metadata sync, metadata previews,
metadata links, purchase bonus and bundle member changes, and source checks
refuse it with `409 custom_work_unsupported`; per-source metadata runs and
source presence checks leave it out.

`media_item.file_version` and `media_file_location.file_version` version local
file observations. Local scans observe file size and nanosecond modification
time independently of the stable path fingerprint. Changed observations clear
duration/audio metadata without replacing media ids or personal state. Probes
compare their location id and expected version in the write transaction,
rejecting delayed results after a rescan. An empty version is established on
the next visible scan or probe. `probe_failed_version` marks the version
FFprobe could not read; a scan that records another version clears it.
`loudness_version` is the version that `loudness_integrated_lufs`,
`loudness_peak_dbfs`, and `loudness_peak_kind` (`true` or `sample`) describe,
as read from disk by the measurement, so it can be ahead of `file_version`
until the next scan or probe. A scan that records a version other than
`loudness_version` clears the loudness, playback uses it only for the version
on disk, and listings only while it matches `file_version`.

`media_file_location.content_hash` caches the SHA-256 of a local file for
identical-file detection, and `content_hash_version` holds the size and
modification time it was computed for. A file observed with another version has
no usable hash until it is hashed again. Only files that share a size with
another local file of the same work family are ever hashed, and a file on
disk is one candidate however many locations name it.

`media_item_display_name` and `work_folder_display_name` hold the names the
work detail directory shows for local files and folders, one row per
[metadata language](work-metadata.md#metadata-language) other than `origin`, shared by every
viewer like manual metadata. A file's name belongs to its media item, so it
follows the item through rescans and folder edits, and has no extension: the
file keeps its own. A folder's name belongs to its path below the work folder,
so copies of a work in several folders share it as their files share media
items. A media read gives each local location whose file or folders have a
name in the viewer's languages before `origin` a `displayPath`: its path with
those names in place of the real segments. The real path still decides order,
track numbers, folder recommendation and lyrics matching. A folder edit moves a
folder's names with it when every file it moved out of the folder keeps its
path below the folder, lands below one other folder, and leaves no available
local file of the work behind; a folder that already has a name in a language
keeps it. A file or folder renamed outside Kikoto loses its names, as a file
loses its media item. A folder's names stay stored while a local media item of
the work has a fingerprint path below the folder, so a folder on an unmounted
pool or one that is only recorded missing keeps them. They are removed when a
folder edit leaves no such item, and by the empty track entry cleanup once the
disk-verified missing-file cleanup has removed the last file below the folder.
A name records its `origin`: `manual` from the display name editor, which
also resets an LLM name it changes, or `llm` with the `model` and the real
name it translated (`source_text`) when accepted from
[Translate with AI](translate-with-ai.md#translate-with-ai). A folder edit moves the origin with
the name.

`media_lyrics_assignment` holds the library-level lyrics files of an audio
media item, one per `language`: `ja-jp`, `zh-cn`, `zh-tw`, `en-us`, `ko-kr`,
or the empty language, which applies to every language. The language is
declared by whoever assigns the file and is never inferred from a file name or
its text. A row relates two media items of the same work, so a rescan that
keeps media ids keeps the assignment; deleting either item removes it. The
audio item may belong to any edition of the requested work's family, because a
work detail can show a sibling edition's local media. `origin` records how the
row was made: `manual` from the lyrics manager or for a lyrics file moved within
the work folder, `remote_fetch` for a file a lyrics edit downloaded,
`library_import` for a file it copied from another local folder of the family,
`transcription` when an accepted [speech transcription](speech-transcription.md#speech-transcription)
published it, or `translation` when an accepted
[lyrics translation](llm-translation.md#llm-translation) published it. `media_lyrics_ai_source`
names, per lyrics media item Kikoto published from speech recognition or
translation, the speech model and the translation model that wrote it; media
reads give the item `aiLyrics`, which the player shows as an AI mark.

The lyrics Kikoto manages are the lyrics files inside a language's folder of
the `lyrics_kikoto` folder at the top of a work folder: `ja`, `en`,
`zh-hans`, `zh-hant`, `ko`, or `fallback` for every language. Kikoto owns a
`lyrics_kikoto` folder only when it holds the `.kikoto-lyrics` marker Kikoto
writes when it creates the folder, a small JSON file with `version`,
`managedBy` and `purpose`; no table records ownership. The scan never indexes
the marker. Kikoto adds lyrics to, deletes from and reorganizes only an owned
folder; an unmarked `lyrics_kikoto` folder, a name that differs only in case,
or a file in its place blocks lyrics publication, and lyrics folders a work
ships under other names are ordinary work files. A lyrics edit that leaves the
folder holding only its marker removes both, and deleting the whole work folder
takes the marker with it. A lyrics file
a lyrics edit moves into such a folder takes a new media item, because a local
item is identified by its path. The move points the `media_lyrics_assignment` and
`user_media_lyrics_preference` rows of the old item at the new one, unless the
old item still has an available file, and moves the assignments that use the
file to the declared language. A track that already has another file in that
language keeps it, and its assignment of the moved file in another language is
removed. The assignments a lyrics edit is asked to add take the language of
their file.

A media read lists an audio item's assignments in the order that viewer's
playback tries them: the viewer's metadata languages in priority order, where
`origin` stands for the declared language of the family's original edition,
then the every-language assignment, then the remaining languages in the fixed
supported order. Clients rank a user's `user_media_lyrics_preference` first,
then these assignments in that order, then name matching.
`user_media_lyrics_offset` holds a user's lyrics timing offset for one audio
item, a nonzero number of milliseconds within 30 seconds either way. It is
independent of the lyrics choice and is read into that viewer's media item as
`lyricsOffsetMs`; lyrics files are never rewritten for it.

The lyrics indicator of a work card is the same resolution run on the server
for every track of the work. The personal preference takes no part, because it
only picks among lyrics a track already has. A work has lyrics when a track has
an assignment whose lyrics file is available in the library, or a lyrics file
matched by name among the work's local files or among the files of the track's
remote source. A work without tracks of its own takes the status of the other
editions of its family. The server's name matching in
`httpapi/lyrics_match.go` and the player's in `player/lyricsMatching.ts` accept
the same track and lyrics pairs.
