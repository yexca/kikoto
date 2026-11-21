# File Availability

File sources, locations and availability tables, plus the independent record library.

Important tables:

- `file_source`
- `file_source_endpoint`
- `work_source_presence`
- `work_folder_location`
- `media_item`
- `media_file_location`
- `media_lyrics_assignment`
- `media_item_display_name`
- `work_folder_display_name`
- `media_lyrics_ai_source`

Presence can describe that a source knows about a work. Concrete playback,
download, local, and cache paths belong in media file locations.

`work_folder_location` binds a work to one concrete folder root on a file
source, unique per source and root path, separately from the aggregated
presence row, so cleanup and the directory UI address a stable folder identity.
`role` is `external` for a scanned folder or `managed_fetch` for a folder a
Fetch published; `state` is `active`, `missing`, or a review-driven cleanup
state (`pending_cleanup`, `ignored`). A scan marks only folders it could
observe as missing, together with the available file locations below such a
folder that lie in no folder it found.

A work may have several active folders: a scan that finds one work code in
several folders records each of them for that work. The local presence names
one of them, the folder flagged `is_primary`, and keeps naming it while that
folder exists, so repeated scans do not move the work between its folders.
Every active folder's files are indexed as media of the work, and each file
belongs to the folder its path lies in. Several folders are a state the work
detail offers to tidy up, not an error.

A media read (the work detail with media and `GET /api/works/{id}/media`)
gives each local location the `folderId` of the work folder that holds it and
its `relativePath` below that folder's root. The folder is the deepest of the
media work's recorded folders, in any state, on the location's file source
whose root contains the path, compared after the same normalization and with
the same case sensitivity as scans and cleanup, so a folder need not be named
after the work code and two roots that differ only in case are two folders. A
location no recorded folder holds carries neither field. The work detail
groups, lists, and names folder files by these fields; every folder edit,
deletion, and cleanup still checks its paths on the server.

A local path of a work has one location, on one media item. A scanned file's
item is the one its path is already recorded on, such as the remote item a
Fetch published the file under; that item leaves any remote folder and takes
the file's `local:<code>:<work-relative path>` fingerprint unless another item
holds it. Only a path with no record goes to the item with that fingerprint,
which the file's copies in the work's other folders share, or to a new one. A
Fetch registers a target path on the item that holds it in the same way. A
remote sync likewise refreshes a source path's remote location on the item
that holds it, and leaves an item a scan has made local as the scan recorded
it; only a path no item holds goes to the item with the
`remote:<source>:<code>:<path>` fingerprint.

A work folder is the outermost folder within the scan depth whose name carries
a work code. A folder inside it whose name carries a code, such as a bonus or
disc folder named after its own product, is part of that work folder, and its
files are files of the outer work. A code in a folder name is a word of its
own: a letter or digit right before it, or a digit right after it, makes it
part of a longer word or number, so `XRJ00000001` carries no code. A folder named `Lyrics - <language> - <code> - <date>-<time>`, the
name a remote lyrics download gives a folder after the edition it read, names
no work: it stays part of the work folder that holds it.

## Independent Record Library

The record library is a separate local-file model for home videos, audio files,
and images.
`record_root` stores the configured root and, in `marker_id`, the identity its
`.kikoto-record` marker carries;
`record_folder` stores the normalized directory tree with each folder's chosen
poster and backdrop; `record_asset` stores one row per regular file and its
discovery/probe state; both keep the natural-order `sort_key` of the name,
computed for the collation `record_root.derived_version` names; `record_asset_progress`
stores per-user playback position; and `record_asset_state` stores per-user
favorite, watched, and note state. These tables do not reference `work`,
`media_item`, or `primary_code`. See [Record library](../record-library.md) for
scan and serving rules.
