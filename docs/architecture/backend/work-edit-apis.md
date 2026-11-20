# Work File and Folder Edit APIs

The endpoints that edit the files of a local work: lyrics, duplicate detection, bundle members, folder edits, and the Fetch follow-up.

## Lyrics Edit

`POST /api/works/{id}/lyrics-edit/plan` and `POST /api/works/{id}/lyrics-edit`
preview and apply an edit of the lyrics Kikoto manages in one local work
folder. An addition is a lyrics file of that folder, which is copied, or moved
when the request or the administrator's lyrics folder setting chooses move, a
file of
another local folder of the family, which is copied, or a file a configured
source offers for a family edition, which is downloaded through that source's
download lane; each declares its language and lands in that language's lyrics
folder. The plan items share the Fetch plan item's shape and conflict
decisions. Copies and downloads are staged on the target work's storage pool,
removals run through media cleanup, and the work folder is rescanned; the
lyrics assignments and personal lyrics choices of a moved file follow it to the
media item of its new path.

An edit assigns added files in their language. Each of its explicit
`assignments` names a track and an added file and replaces what the track has
in that language. With `assign`, the server pairs the added files with the
folder's tracks that have no assignment in a file's language: the files of one
place in one language go together, a track takes the file
[name matching](../data-model/custom-works.md#custom-works) picks for it, and
the tracks left are aligned by track number, or by position when the counts
are equal, with the subfolder holding the most of those files. A file the plan
leaves out is not assigned. The plan lists these pairs as `assignments`;
applying pairs the files again against the folder as it is then and stores a
pair only where the track still has nothing in that language. Its permissions
and limits are in
[Lyrics files](../../development/security.md#lyrics-files).

## Duplicate Files

`POST /api/works/{id}/local-files/duplicates` requires `downloads:manage` and
reports the local files of the work's family that hold the same bytes, in any
of its editions and folders. It first indexes family folders that have no
indexed files, then hashes only files that share a size and caches each hash
per file version. One request hashes for at most 20 seconds and always
completes at least one file; a response with `complete: false` reports how
much is pending, and repeating the request continues from the stored hashes. A
link, an unreadable file, and a file that changes while it is read are left
out. The request never changes a library file.

## Bundle Members

`GET /api/works/{id}/bundle-candidates`, `PUT /api/works/{id}/bundle-members/{code}`,
and `DELETE /api/works/{id}/bundle-members/{code}` require `library:write` and
manage the members of the bundle a work is; see
[Bundles](../data-model/overrides-normalized-fields-bundles.md#bundles). A member cannot be a code of the work's own
family, and a bundle holds at most 64 members. Candidates come from the work's
DLsite series: the series' catalog codes in catalog order, then library works
of the work's circles whose stored DLsite metadata names the series, at most
32, leaving out members, removed members, and the family. The response reports
whether the title names a bundle or the bundle has members.

## Folder Edit

`GET /api/works/{id}/folder-edit/sources`,
`POST /api/works/{id}/folder-edit/plan`,
`POST /api/works/{id}/folder-edit/merge-check`, and
`POST /api/works/{id}/folder-edit`
edit one active local folder of a work. Sources lists the family's editions
with their local folders and stored source availability; it requires
`downloads:manage`, or `library:read` in Demo, whose workspace previews an
edit with a sample plan in the browser and sends neither a plan nor an edit.
`POST /api/works/{id}/folder-edit/sources/check` first asks every enabled
remote source that passes its health check about each of the family's
editions, at most 16, one edition at a time, records the answers as their
stored availability, and then returns the same listing. A plan names the
files to add, from another active local folder of the family or from a remote
edition of the family, and the folder's local file locations to remove. An
addition may name a `targetPath` below the folder instead of its own path,
never inside `lyrics_kikoto`; an addition that keeps a path inside another
folder's `lyrics_kikoto` lands in this folder's lyrics folder only while
Kikoto created and marked it, and the run creates and marks an absent one.
Lyrics of a language are added through the lyrics edit. `moves` give
files of the folder another path below it, `folders` are folders to create,
and `mergeFolderIds` are other active local folders of the family to delete
once the folder holds what the edit copies from them. The plan checks that no
two files of the result share a path and that no file sits where a folder of
another path belongs; a path a removed or moved file frees can be taken, and
only that very file frees it: another file whose path differs only in letter
case or Unicode composition stays and is a conflict. It
resolves each addition's target as a Fetch plan does, with the same
decisions, and never changes a file. The merge check takes the same request
and lists the files of the merged folders that the edited folder will not hold
with the same size and SHA-256, hashing within a time budget, caching hashes on
the files' locations, and reporting `complete: false` while files remain to
compare; a remote addition is not compared, and a file an addition replaces
does not stay even when its path differs only as a case-insensitive
filesystem compares it. Metadata a NAS or operating system keeps beside files
(`@eaDir`, `__MACOSX`, `._` files, `.DS_Store`, `Thumbs.db`) is neither
listed nor compared and is deleted with its merged folder. A complete check
returns a `review` that identifies the files it compared, with their sizes
and modification times, and carries the files it reported lost. Apply of an
edit that merges folders requires that `mergeReview` and answers
`409 folder_edit_merge_changed` when the merged folders or the files the
edited folder keeps changed since the check, when comparing again finds a
merged file without a copy that the review did not report lost, such as a
file that can no longer be read, or a Fetch of a merged folder's work is still
running. Apply rejects a plan that has
conflicts or changes nothing, and queues one `work_folder_edit` run; a folder
has one active run, which also covers a folder another run merges, and a
repeated request id returns the run it queued. The run collects additions,
removes each removed file only while it is the version the plan saw on disk,
takes every moved file out of its place before any file takes a path,
publishes without ever replacing a file that appeared after planning, and
replaces an existing file only where a decision chose to and while it has the
size the plan saw, gives each moved file's media item its new path when the item
has no other available file outside the folders the edit merges, so its
references follow it; an item whose file at that path the edit removes gives
the path up and keeps its own references. It then removes the folders
it emptied, creates the requested folders, and indexes the folder. A resumed
or retried run never collects again a file it already published. Before
publication, its checkpoint records each collected file's size, file version,
and SHA-256. If a rename completes before the publication checkpoint, recovery
accepts the target only when it is a plain file below plain directories and
matches that proof; a changed target is kept and stops the edit. A checkpoint
without proof can continue while its collected file exists; a missing copy
without proof requires a new review. It deletes each merged folder last, only
while it holds exactly the files the edit was planned with and each of them
the reviewed merge check did not report lost
still has a file of the same size and SHA-256 in the edited folder; otherwise the run
stops and asks for a new review. It marks the deleted folder's locations
unavailable and its folder ignored; a run that fails or is cancelled returns a
merged folder it had started on to the work, also while the edited folder is
offline. A run that stops before it finishes puts every moved file that left
its place but has not reached its new path back where it was; a file whose old
path another file took since stays in the run's staging folder for a retry.
Cancelling a run that no executor holds, such as one waiting for a retry, for
recovery after a restart, or for another job that is changing library
folders, settles it the same way once no other job is changing library
folders. A cancelled run that a service stop or an offline folder kept from
settling is settled at the next start. Its permissions, destination checks,
and limits are in
[Folder edit](../../development/security.md#folder-edit).

## Fetch Follow-Up

A Fetch plan or Fetch request may carry `followUp`: folder edit additions and
decisions for the folder the Fetch publishes. The plan
response then adds `followUp`, a folder edit plan resolved against that folder
with the Fetch's own targets already taken, so a follow-up file that would
land on a fetched file is a conflict. Once the Fetch completes, it queues one
`work_folder_edit` run on the folder it registered, with request id
`fetch-follow-up:<run id>`, and records `follow_up_run_id` or
`follow_up_error` in its run summary. `follow_up_error` holds only a reason
written for the user, which a `fetch.follow_up_failed` event of the Fetch run
repeats in its run; any other cause stays in the server log. While the
library or a storage pool the follow-up reads or writes is offline, the
summary records `follow_up_waiting` instead, with one `fetch.follow_up_waiting`
event, and the workflow coordinator tries again every minute until the
storage is back. Startup recovery queues the follow-up of every completed
Fetch that records neither `follow_up_run_id` nor `follow_up_error`, so a stop
between the Fetch's completion and its follow-up neither loses the follow-up
nor queues it twice: the request id finds a run queued before the stop. A
failure of this recovery is logged and never keeps the service from starting.
Automatic Fetches never carry a follow-up.
