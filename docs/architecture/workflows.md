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
- Availability Watch.
- Media cache.
- Remote work fetch.
- Remote bulk action.
- Remote popular collection.
- DLsite popular voice collection.
- Cache cleanup.
- Local location cleanup.
- Circle metadata refresh.
- Voice catalog refresh.

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
database migration and enabled by default. The API allows pause, resume, and a
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
batch overflow, invalid or unavailable path batch, watch-root invalidation, or
duplicate work root switches that run to full mode. An invalidated root retains
the recovery request across watcher restarts and dispatches it only after the
replacement watcher has settled.

Kikoto's `.kikoto-staging`, `.kikoto-backup`, and `.kikoto-trash` transaction
trees are excluded. Claimed per-source Fetch roots are also excluded because
Fetch registers final publication directly. A markerless root from an older
release receives the same exclusion only after same-source Fetch history
explains its complete visible structure and at least one exact historical target
exists on disk; watcher configuration does not write the missing marker.
Startup, interval, and manual workflows always run the complete local scan. If a
filesystem scan is already queued or running, later changes remain pending and
are coalesced into at most one follow-up run. Events while the trigger is paused
are discarded. Changes made while Kikoto is stopped are covered by the default
Startup scan; they cannot be recovered by the native event stream alone.

For one unambiguous affected work folder, incremental execution upserts current
files and marks previously available paths absent from the folder `missing`. If
the complete external work root disappears, its folder, source presence, and
available locations become `missing`; the `work`, `media_item`, and location
history remain. Application-owned deletion updates its known location state
immediately and may also produce a native event; the later incremental run is an
idempotent reconciliation. Full scans retain the existing folder-presence and
lazy-index repair behavior. Duplicate-code groups skip automatic invalidation,
fall back to full discovery, and remain review candidates. Neither mode rewrites
`managed_fetch` ownership records.

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

## Availability Watch

Availability Watch is one instance-level system workflow with a shared
  monitoring pool, rather than one watch per user. Authorized users can edit the
  pool of normalized work codes, while its configuration selects a compatible
remote source (or any healthy compatible source), an action on availability,
and Fetch extension exclusions. A change to that configuration records the
user whose permissions govern its scheduled execution.

It supports at most one interval schedule trigger and may also be run directly
from its configuration surface. Each execution snapshots the active pool,
records a normal workflow run, node runs, and durable job, then leaves unknown
remote results as availability state instead of materializing new `work` rows.
Newly available works move into the Ready pool; configured Track and Fetch
actions remain child workflows with their own histories. A successful run that
finds new ready works creates a notification for enabled administrators, and
the notification opens the shared Ready pool.

## Voice Catalog Refresh

Opening a voice actor detail reads the persisted local works and voice catalog
only; entering either a voice or circle detail never queues a workflow. Creator
catalogs expose Never, Attention, or Synced from their last successful pull and
the configured freshness window. An authorized user can start an explicit First
pull or manual refresh through the same durable workflow, which requires
metadata-sync permission.

The workflow searches the display name and every confirmed alias against each
enabled compatible source. It follows the source-reported result count through
all pages and applies no product-level page or result maximum. Outbound response
limits, a per-source deadline, cancellation, repeated-page detection, and a
three-source concurrency bound still protect the request boundary. Results are
deduplicated by canonical `primary_code` before each successful source is
persisted atomically.

A failed source keeps its previous catalog observations, while a complete
source marks observations absent from the new generation `not_found`. Remote
discoveries remain catalog rows and never materialize works recursively. Only
catalog items that already resolve to canonical works enter the refresh run's
metadata node; it synchronizes them within the same `voice_catalog_refresh`
run rather than creating one metadata workflow per work. Metadata incremental
refreshes select only those known canonical work families without a DLsite
snapshot; full refreshes retry every known canonical family. Neither mode
materializes a catalog-only row as a work. Metadata failures can make the
workflow partial without making an otherwise complete catalog generation stale.

## Review Candidates

Workflow candidates capture user-reviewable outcomes such as duplicate local
folders, unavailable DLsite products, and old local locations left after remote
fetches. A Fetch from a source with restricted outbound hosts also creates a
`remote_origin_blocked` candidate when a media origin is outside that source's
boundary. The run and active node become partial, the recoverable job is not
automatically retried, and Activity records only the normalized origin rather
than the media path or query. After an administrator changes the source policy,
a manual Retry resolves the old candidate and resumes the same run.
