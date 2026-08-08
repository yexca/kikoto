# Workflows

Kikoto treats long-running and reviewable operations as workflows.

## Model

```text
workflow_definition
  -> workflow_trigger
  -> workflow_run
      -> workflow_node_run
      -> workflow_job
      -> workflow_candidate
      -> workflow_run_review
```

## Current Built-In Workflows

- Local library scan.
- Metadata sync.
- Remote source sync.
- Source availability check.
- Media cache.
- Remote work fetch.
- Remote bulk action.
- Remote popular collection.
- DLsite popular voice collection.
- Cache cleanup.
- Local location cleanup.
- Circle metadata refresh.

## Popular Collections

Remote popular collection reads the configured compatible file source's own
recommendations and may track or fetch those remote works when run manually.
Startup and interval triggers retain a bounded Track configuration and expand
their tag template when each run is dispatched. Automatic Fetch remains in the
typed custom-workflow path where file, byte, known-size, and disk-reserve bounds
are explicit.

DLsite popular voice collection reads the provider ranking for 24 hours, 7
days, 30 days, or a selected year. Non-annual runs may be limited to works
released within 30 days. The recoverable worker synchronizes metadata and
appends a run-specific tag owned by the user who started the run. It does not
create remote file-source presence or fetch media.

Configurable built-in triggers retain the configuring user for user-owned tag
effects and revalidate that user's permissions when dispatching. Triggered runs
store both their trigger reference and the final resolved input.

## Local Folder Trigger

`local_library_scan` owns one fixed `filesystem_event` trigger created by the
database migration and enabled by default. The API allows only pause and resume;
it rejects manual creation, identity changes, conversion, duplication, and
deletion.

The coordinator performs one bounded walk at watcher startup to register
visible directories through the configured scan depth. It then consumes native
filesystem events and dynamically registers newly created or atomically moved
directory trees; there is no recurring directory traversal. Events are
debounced for five seconds before the existing full local-scan graph is queued.
Kikoto's `.kikoto-staging`, `.kikoto-backup`, and `.kikoto-trash` transaction
trees are excluded. Claimed per-source Fetch roots are also excluded from the
native event watcher because Fetch registers final publication directly. The
Startup and manual workflows continue to run the complete local scan. If a
scan is already queued or running, later changes remain pending and are
coalesced into at most one follow-up run. Events while the trigger is paused
are discarded. Changes made while Kikoto is stopped are covered by the default
Startup scan; they cannot be recovered by the native event stream alone.

Local scan and metadata sync have separate definitions, jobs, resource lanes,
statuses, failures, review candidates, and retry histories. A local scan never
calls a metadata provider as part of its own run. Manual, Startup, and interval
scan configuration exposes `Follow-up run`; it defaults off and, when enabled,
queues a separate `metadata_sync` run only after the scan reaches a terminal
state. The fixed filesystem trigger keeps this option off. Queued automatic
metadata follow-ups are coalesced so a burst of scans does not create redundant
provider work.

## Queue Ordering

`workflow_job.priority` is persisted with each job. The single worker claims
higher priorities first, then preserves FIFO order by creation time and id.
Playback-triggered cache fills use the highest tier, direct user work such as
manual workflows and cleanup uses the middle tier, and scheduled/background
work uses the default tier. Priority does not preempt a job that is already
running.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out.
Source-change checks first probe source health, then check candidate works only
against reachable sources. The local library scan does not check remote source
availability.

## Review Candidates

Workflow candidates capture user-reviewable outcomes such as duplicate local
folders, unavailable DLsite products, and old local locations left after remote
fetches. A Fetch from a source with restricted outbound hosts also creates a
`remote_origin_blocked` candidate when a media origin is outside that source's
boundary. The run and active node become partial, the recoverable job is not
automatically retried, and Activity records only the normalized origin rather
than the media path or query. After an administrator changes the source policy,
a manual Retry resolves the old candidate and resumes the same run.
