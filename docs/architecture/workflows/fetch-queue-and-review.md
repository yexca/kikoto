# Queue, Restart, and Fetch Review

How workflow jobs are ordered and recovered across a restart, how Fetch publishes files, and how Fetch review candidates are decided.

## Queue Ordering

`workflow_job.priority` is persisted with each job. One embedded executor claims
the highest-priority queued job, preserving FIFO order by creation time and id
within a priority, and runs only one workflow job at a time. A submission is
persisted as `queued` before it is claimed as `running`; later submissions wait
in the same durable queue, including jobs from different workflow definitions
and resource keys. Playback-triggered cache fills use the highest tier, direct
user work such as manual workflows and cleanup uses the middle tier, and
scheduled/background work uses the default tier. Priority does not preempt a
job that is already running.

Each executor records its own result, but the runner settles the job when the
executor returns. A transient source failure within the retry budget is
requeued with a delay. A job still running under the executor's lease after
any other exit, including an error or panic that recorded nothing, is marked
failed and its run records a `job.result_missing` event, so one faulty exit
path cannot hold the single-executor queue.

A short operation an API request queues, such as a local file deletion or a
cache-limit cleanup, runs within the request only while its job is at the head
of the queue, and otherwise waits for the executor. When the request ends
before the operation records a result, as when its client disconnects, the job
returns to the queue without spending a resume and its run records a
`job.requeued_after_disconnect` event; the executor then runs it.

The coordinator dispatches the earliest due interval trigger and moves its
next run one interval ahead as it queues the run. An occurrence whose run
cannot be queued is retried five minutes later, and one whose run a service
stop prevented stays due for the next start. A trigger whose dispatch fails
before its next run moves waits five minutes and records the failure as its
last error, so it never holds back the other due triggers. Saving an enabled
interval trigger with the same interval, as saving the options it runs with
does, keeps its next run; a new interval, or switching it on, plans the next
run one interval from then.

The executor is single-instance, so the process records every job lease it
holds and that record decides whether a running job still has an executor.
Heartbeats show recent activity but never expire a lease: a busy database or a
long `VACUUM` can delay them while the job is still working. A lease is
recorded before the claim that writes it and released only after its job is
settled. The coordinator settles any running job whose lease is not held,
such as a job whose own settlement write failed: a recoverable job with resume
budget returns to the queue from its checkpoint and spends one resume
(`job.orphan_requeued`), and any other job fails (`job.orphan_failed`).

The manual **Recover stale workflow runs** command applies the same rule to the
runs the user can see. It never touches a job whose executor is still running
or a queued job. It also returns a run left running beside a queued job to the
queue (`run.requeued_stranded`), and fails a run with no queued or running job
(`run.recovered_stale`). A run is repaired this way only when its jobs have not
changed for a minute.

## Service Stop and Restart

On `SIGTERM` or `SIGINT` the service stops claiming jobs, refuses new
connections, and lets in-flight requests finish within
`KIKOTO_SHUTDOWN_TIMEOUT_SECONDS`. Playback, live transcoding, HLS, remote
playback, and workflow event streams only read and last as long as their
client keeps them open, so they end as soon as the stop begins, including a
response blocked on a paused player that stopped reading; a stream requested
during the stop is refused as retryable `service_stopping`. Other requests,
including every request that changes state, keep running; those still running
after half of the timeout are cancelled. The database closes only after the
job executor and other background work have returned.

A running job interrupted by the stop is settled before exit. A recoverable job
returns to the queue with its checkpoint and does not spend its resume budget,
because a requested stop is not a failure; a job that cannot resume from a
checkpoint fails with the stop reason. Its run records a
`job.interrupted_by_stop` event in both cases. A job waiting for the
`media:cleanup` resource while another job, scan, or Fetch publication changes
library folders stops waiting when the service stops or its run is cancelled.
Fetch publication does not start once a stop has begun, and a publication that
already started places its files and records it before the job stops.

Startup recovery is the path for crashes, forced kills, and a stop that
exceeds its deadline. No lease from an earlier process is live, so every
running job is settled by the orphan rule under
[Queue Ordering](#queue-ordering): it is requeued from its checkpoint and
spends one resume, or it fails. Queued jobs keep waiting, runs are repaired as
the manual command repairs them but without its one-minute wait, and
interrupted Fetch publications finish placing their files, as described under
[Fetch Publication](#fetch-publication). While the target's pool is offline, recovery leaves the publication as
it is, and a retry of the run finishes it once the pool is back.

Fetch retries and startup recovery share the same publication reconciliation
and local registration steps. A published or registered target is completed
from its persisted plan and files, without re-downloading cache inputs or
refreshing the remote source. Registration and cleanup remain resumable; an
archive moved before its review candidate was saved is recovered on retry.
The completed manifest, retired remote-stream identities, node results, job
lease release, and run result commit together. Rollback backups are removed
only after that commit. Startup also repairs a completed manifest whose job or
run result was left unfinished. Simple workflow result writes likewise commit
their node, job, and run states in one transaction, so an interrupted write
keeps the lease for the runner's settlement path. A run cancelled before its
job records a result keeps its cancellation, as do its job and nodes. A Fetch
is cancelled only until its publication starts placing files; a cancellation
that arrives later leaves it to publish, register its files, succeed, and
queue its follow-up.

### Fetch Publication

Fetch publishes file by file. Staging holds only the files the Fetch writes:
each new or replacing file is copied into `.kikoto-staging/<run>/work` on the
target's pool and verified there. Publication then renames each staged file
into the target folder. A file it replaces first moves to the same relative
path under `.kikoto-backup/<run>/work`, so the replaced file stays
recoverable until the Fetch completes. Files the Fetch does not write are
never copied, moved, or rewritten: they keep their content, modification
times, and hard links, a change made to them while the Fetch runs is kept,
and a linked subfolder the Fetch does not write into does not stop it. New
files appear one at a time rather than all at once.

Each planned file's staged, target, and backup entries decide how its
placement finishes, not what else the folder holds, so an interrupted
publication finishes by placing the remaining files again: a file already
placed has left staging and is skipped, and a replaced file whose staged copy
is still there is placed. A replaced file whose staged copy is gone returns
from the backup to its place, and the Fetch stages again. A target that already
has a backup from an earlier attempt counts as placed when it holds the staged
content, and is otherwise never replaced again until that backup is settled.
A placement that fails for any other reason puts back what that attempt
placed: each placed file returns to staging and the file it replaced returns
from the backup, and the Fetch returns to verified, so it never stays half
published and a retry places the same staged files again.

## Review Candidates

Fetch honors an explicit Replace decision even when the target has the same
size or the source does not declare a size. When the source declares no size,
an existing target or cache file counts as present only when it has the size
Kikoto recorded for that location, as indexing records a local file and a
completed download records a cache file. Any other existing cache file is
downloaded again. Any other existing target is a target conflict, since
nothing confirms it is the remote file, so the user keeps or replaces it as
with a target of another size. A file that is already in the target is not
evidence that the selected replacement was staged.
After an interruption, only a staged file matching a previously verified
manifest hash may be reused; other selected files are copied from their chosen
local or cache source again before verification and publication.

Fetch planning identifies a target path without regard to letter case or
Unicode composition, because a library can sit on a filesystem that stores such
names as one file. Two selected files whose targets differ only that way are a
target conflict for the user to resolve. Verification requires every planned
file to be its own file in staging and refuses to publish otherwise.

A remote track title is untrusted and is normalized once into the name the file
is listed, planned, cached, and stored under: path separators and `.` or `..`
components are dropped, and a title with nothing left is named after its
position in its folder.

Once a Fetch is published, it archives for review only the folders of the work
its `copy_local` items came from, the files the user consolidated in the Fetch
dialog, into the `.kikoto-trash` of that folder's pool, and records a
`local_fetch_merge_cleanup` candidate for them. The plan lists those folders as
`archiveRoots`, and the dialog's After Fetch pane shows them. A Fetch without
`copy_local` items, such as a remote-only selection, a bulk or Availability
Watch Fetch, or the Fetch composed by folder management, archives and
removes nothing: it registers its folder and leaves every other folder of the
work, including the ones a composed Fetch's follow-up folder edit adds files
from, in place. The Fetch removes the cache and retires the remote streams of
the files it promoted; files it left unselected keep both. Untracking a source
while a queued or running Fetch still needs one of its cache files keeps that
file, as cache trimming does.

Workflow candidates capture user-reviewable outcomes such as unavailable
DLsite products and the folders a Fetch consolidated. A Fetch from a source with restricted outbound hosts also creates a
`remote_origin_blocked` candidate when a media origin is outside that source's
boundary. The run and active node become partial, the recoverable job is not
automatically retried, and its run records only the normalized origin rather
than the media path or query. After an administrator changes the source policy,
a manual Retry resolves that candidate and resumes the same run.

The **All** filter of Metadata's DLsite works sends `reason=catalog` to the bounded maintenance read.
It lists already persisted work families, including those without pending issues,
using the same search, pagination, permission, and demo eligibility boundaries.
It does not discover providers or materialize catalog results. `reason=all`
selects the attention union, and a run filter always narrows the read to that
run's unresolved metadata issues.

The canonical management URL is `/metadata`. `/work-management` URLs and
`/maintenance` work, unlinked, and metadata links redirect there while
preserving their category, settings, and run context. Failed first-sync
notifications and pending metadata results open recovery here; operators
without workflow access use the unscoped issue list, since reading a
run-scoped list requires workflow permission. Runs without recorded pending
issues keep their run diagnostics.
