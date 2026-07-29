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

- Local library scan and missing metadata sync.
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
fetches.
