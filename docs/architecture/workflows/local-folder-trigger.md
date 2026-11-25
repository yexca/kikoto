# Local Folder Trigger and File Refresh

The local library scan trigger and the media index refresh of local work folders.

## Local Folder Trigger

`local_library_scan` owns one fixed `filesystem_event` trigger created by the
database migration and enabled by default. A fresh install turns it and the
Startup scan off until [library onboarding](library-layout-and-onboarding.md#library-layout-and-onboarding)
chooses. The API allows pause, resume, and a
choice between `incremental` and `full` scan mode. Incremental is the default.
It rejects manual creation, identity or name changes, conversion, duplication,
and deletion.

At watcher startup, the coordinator registers visible directories through the
configured discovery depth and every descendant directory below a recognized
work root. It then consumes native filesystem events and dynamically registers
newly created or atomically moved directory trees; there is no recurring full
registration walk. The number of native watches therefore scales with the
directory count inside local works and remains subject to the host's `inotify`
watch limit.

Each visible Create, Write, Remove, or Rename resets a trailing five-second
timer. Dispatch occurs only after five seconds without another observed event.
This is an event-settling guarantee, not proof that an open writer has closed:
a writer can pause longer than five seconds without emitting an event. Imports
that require strict publication must write into an excluded staging tree,
verify the result, and use a same-filesystem rename into the final work root.

The coordinator deduplicates at most 1,024 changed paths into the durable run
and job input. Incremental execution resolves those paths to affected known or
new work roots, walks each affected work's complete media tree, and reconciles
its locations. It does not walk unaffected media trees. A watcher error, path
batch overflow, invalid or unavailable path batch, watch-root invalidation, a
work whose code lies in several folders, or an affected work folder whose
files cannot be read switches that run to full mode. A watch-root invalidation,
or a watch configuration change that replaces the watcher while changes wait
to be dispatched, keeps a full-scan recovery request across watcher restarts
and dispatches it only after the replacement watcher has settled.

Kikoto's `.kikoto-staging`, `.kikoto-backup`, and `.kikoto-trash` transaction
trees are excluded. Claimed per-source Fetch roots are also excluded because
Fetch registers final publication directly. A Fetch root without its
`.kikoto-fetch-root` marker receives the same exclusion only after same-source
Fetch history explains its complete visible structure and at least one exact
historical target exists on disk; watcher configuration does not write the
missing marker.
Startup, interval, and manual workflows always run the complete local scan. A
request for a complete scan, from Run, Startup, an interval, a retry, a library
layout change, or the folder watcher, while a complete scan is queued and not
yet running returns that run, and its result is recorded on the request's
trigger too. While
a complete scan runs, a request queues its own, because the running scan may
already have passed the folders that changed. Folder changes and a new custom
work queue their own incremental scan. If a filesystem
scan is already queued or running, later changes remain pending and
are coalesced into at most one follow-up run. Events while the trigger is paused
are discarded. Changes made while Kikoto is stopped are covered by the default
Startup scan; they cannot be recovered by the native event stream alone.

For one unambiguous affected work folder, incremental execution upserts current
files and marks previously available paths absent from the folder `missing`. If
the complete external work root disappears, its folder, source presence, and
available locations become `missing`; the `work`, `media_item`, and location
history remain. Application-owned deletion updates its known location state
immediately and may also produce a native event; the later incremental run is an
idempotent reconciliation. A full scan records presence for every discovered
folder. For a folder with a completed media index or indexed files, it compares
the current paths, sizes, and file versions outside write transactions. An
unchanged tree keeps its media rows and index metadata; a changed tree is
reconciled through the shared per-folder indexer, including files added,
removed, or replaced while the server was stopped. An indexed tree that
intersects a directory discovery could not read keeps its stored files
unchanged while the scan continues with other folders. Discovery reads folders
only down to the scan depth, while this comparison reads the whole tree, so a
tree it cannot read completely, such as one holding an unreadable folder below
the scan depth or a file removed while it is read, likewise keeps its stored
files, and its work folder is recorded in `unreadable_folders`. New and moved folders
without an index are indexed lazily. A full scan commits discovered folders in
batches of 250, so progress saves and other writers are not locked out for the
whole library, and marks unseen work roots missing only in its final
transaction. An interrupted scan records completed folders and leaves unseen
roots unchanged; its retry repeats the idempotent folder writes. A folder
whose work, presence, and folder location already match is not rewritten, so
its timestamps record its last change. A work whose code is found in several
folders keeps every one of them as an active folder (see
[File Availability](../data-model/file-availability.md#file-availability)): none of their locations
is invalidated in favour of another, and the scan raises nothing for review.
A recorded folder of such a work that the scan observes but does not find
becomes `missing` with the file locations below it.
Neither mode rewrites `managed_fetch` ownership records.

Local scan and metadata sync have separate definitions, jobs, resource labels,
statuses, failures, review candidates, and retry histories. A local scan never
calls a metadata provider as part of its own run, and a scan takes no options.
A metadata sync follows a scan only through its own After trigger, which a scan
that added works dispatches once it has finished (see
[Automatic Triggers](built-in-workflows.md#automatic-triggers)). A repeated
dispatch joins the metadata sync already queued or running with the same
options, so a burst of scans does not create redundant provider work.

## Local Work File Refresh

`local_media_index` indexes the media tree of local work folders that a local
scan has already discovered, the same per-work indexing that otherwise runs
lazily the first time a work's media is requested. A lazy request indexes every
active folder of the work that has no indexed files yet, and skips a folder
that cannot be read, such as one in an offline pool. It never discovers new work
roots; that is the local scan's job, and the Workflows page lists it second,
after the scan.

| Mode | Selected folders |
| --- | --- |
| `incremental` (default) | Available `local_folder` presences whose `raw_json.file_tree_scanned` is not set |
| `full` | Every available `local_folder` presence |

The job reads the complete target list before indexing, so no cursor holds a
pooled connection while folders are walked and written. It then indexes each
folder through the shared per-work indexer, which coalesces with a concurrent
lazy request for the same folder, and checkpoints progress at most once a
second. A folder that fails is recorded (the first 50 failures are kept) and the
run continues; the run is `partial` when some folders fail and `failed` when
none succeed. Cancellation stops before the next folder.

One run is queued or running at a time: a manual start, retry, or trigger
dispatch while one is active returns that run. Manual runs and interval triggers
store `{"mode": ...}`; the After trigger, which follows a complete scan that
leaves folders unindexed, stores `incremental`; retry repeats the failed run's
mode. Starting a run requires `workflows:run` and `metadata:sync`, like the
local scan. No trigger is seeded.

A single work's refresh, `POST /api/works/{id}/local-files/refresh`, runs the
same per-work indexer directly instead of queuing a run and requires
`downloads:manage`. Without a folder it indexes the folder the work's local
presence names, then every other active folder of the work that the scan
reaches. With `folderId`, which **Manage files** sends for the folder it edits,
it indexes only that active folder of the work and leaves the others as
indexed. A folder on an offline pool, or outside the scan scope
(`folder_outside_scan_scope`), is refused rather than recorded as missing.
