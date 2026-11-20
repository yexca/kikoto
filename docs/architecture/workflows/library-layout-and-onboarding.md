# Library Layout and Onboarding

How the library is laid out across storage pools and how onboarding configures it.

## Library Layout and Onboarding

The library is either one standard pool (the data root) or registered storage
pools (first-level folders of the data root). `app_setting` holds
`library_mode`, `storage_pools` (path and marker ID), `fetch_pool`, and the
standard pool's marker ID; paths in the database stay relative to the data
root, so a pool is the first path segment in pool mode and no schema changes.
A work folder, one whose name carries a work code or that the library records
as a work's folder, is never offered as a pool, and registering or migrating
to one is refused with `storage_pool_is_work_folder`.
`GET/PUT /api/library/layout`, `POST /api/library/pools/reconnect`, and
`POST /api/library/onboarding/complete` require `sources:write`.

At startup, before this start is recorded, an instance whose previous start
(`schema_state.last_successful_app_version`) was a release before v0.7.0, or
that has no recorded start but already holds local works, has upgrade
onboarding pending; if unconfigured it becomes `standard`, and it keeps its
triggers. An instance whose previous start was v0.7.0 or later (or a
development build) has already been offered onboarding, so a configured layout
is marked onboarded without changing triggers. The administrator may keep
standard mode or confirm a move into storage pools, then review the local scan
and the saved user definitions described under
[Preset Workflows](shown-works-and-presets.md#preset-workflows).
The layout step uses one primary action: Next for an unchanged configuration,
or Save and continue for changes. After a confirmed migration finishes, Next
continues with the saved layout and its migration scan.
The standard-to-pools confirmation explains that works already inside selected
pools stay in place, while works outside them move into the chosen Fetch pool
with their data-root-relative paths preserved. Unrelated files remain in place;
the switch does not empty every unselected folder. The summary counts moved
directories and the total size of their files. Copy and verification complete
before library records are updated and original files are removed.
A fresh install stays unconfigured and turns the local scan's Startup trigger
and folder watcher off once; onboarding chooses the layout, runs a scan and
optional metadata sync, and sets both triggers. Its onboarding stays pending
across restarts until finished. A configured mode switch or
Fetch pool switch requires a preview and confirmation. Kikoto blocks ordinary
requests during the durable copy, checksum verification, database path update,
source cleanup, and local scan. Administrators see progress and can retry a
failed move; other users see maintenance. A pool that still holds unrelated
works cannot be removed.
The plan includes indexed local roots and unindexed work folders visible at
the current scan depth. A folder below that depth remains outside the scan's
scope until the administrator increases the depth and scans it.

Each scan computes its scope from the online pools and the effective depth.
The data root may be reached through a symbolic link: discovery, the custom
work picker, and the folder watcher walk its target and report paths under the
configured root, and deletion and cleanup work below it. Below the data root,
every destructive path still refuses a link. A registered pool is a real directory: a pool folder that is a link is
offline, and a discovery walk does not follow one.
Depth counts inside a pool and is at least the deepest Fetch save template or
active `managed_fetch` root. Discovery walks only online pools; missing-marking
of folders and presences applies only to recorded roots inside that scope.
Offline pools make a full or incremental scan `partial` with an
`offline_pools` summary; no online pool fails the scan. A pool that goes
offline during a full scan is reported the same way: its works keep their
state and the rest of the scan completes.
A folder below a walk's start that the walk cannot read, for lack of
permission or because it disappeared during the walk, is skipped and recorded
in an `unreadable_folders` summary that makes the scan `partial`; recorded
roots at or below it leave the scope, so they keep their state. Any other walk
error still fails the scan. Every walk, the folder watcher, and file indexing
skip the directories and files `localfs.IsIgnoredDirectoryName` and
`IsIgnoredFileName` name: Kikoto's own transaction directories and the NAS and
operating system additions such as `@eaDir`, `#recycle`, `__MACOSX`, `._*`,
and `.DS_Store`. Of these directories, `localfs.IsMetadataDirectoryName`
names the ones that only hold metadata and never the user's files: `@eaDir`
and `__MACOSX`. A recorded root in any other ignored directory, such as a
recycle bin or snapshot, is outside the scope, and its locations are never
marked missing. A recorded root in a metadata directory
(`localfs.IsMetadataPath`) is never a work folder: it is never indexed or
made primary, and a scan whose online-pool, depth, and unreadable-folder
limits reach it marks it and its locations missing as not found. Inside a
root a scan finds or an
index reads, such an entry is not a file of the work: the scan marks a
location recorded there missing, while the rest of a completed index stays
valid. Fetch planning resolves
new works into the Fetch pool and existing folders in their own pool, rejects
`library_not_configured`, `fetch_pool_required`, `fetch_pool_offline`, and
`library_offline` with `409`, records the pool as `transactionPool` in the
plan, and creates staging, backup, and quarantine entries under that pool.

Pool availability outside scans is computed per request and never stored. A
local file location, work folder, or local presence on an offline pool keeps
its indexed state, and responses report its availability as `offline`, without
a stream URL; it reads as available again once the pool is back, without a
scan. Library filters and counts still treat such a work as local. Every read,
write, or deletion of library files checks the pool of the path it touches
first: streaming, download, text preview, HLS playback, ASR, local file
refresh, folder edits and their copy and merge folders, lyrics edits and their copy
folders, generated-lyrics publication, file and folder deletion, workflow
review cleanup, Fetch trash deletion, a starting or resuming Fetch run, and
startup Fetch recovery. A
refused request answers `409` with `storage_pool_offline` in pool mode or
`library_offline` in standard mode and changes nothing. Fetch quarantine leaves
a root on an offline pool in place, opening a work does not index a folder on
one, cover candidates omit its images, and the duplicate-file check leaves its
files out.

`remote_work_fetch` runs are named `Fetch <code>` and record the queuing
workflow as their trigger reason. A work's detail page, including a remote-only
work opened by its code, and the bulk actions open the shared Fetch workspace
to review files, destination, and conflicts before publication. Submission uses the source Fetch endpoints, permission checks, and
idempotent request scope; Fetch has no automation triggers.
