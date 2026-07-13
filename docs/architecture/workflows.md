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
recommendations and may track or fetch those remote works.

DLsite popular voice collection reads the provider ranking for 24 hours, 7
days, 30 days, or a selected year. Non-annual runs may be limited to works
released within 30 days. The recoverable worker synchronizes metadata and
appends a run-specific tag owned by the user who started the run. It does not
create remote file-source presence or fetch media.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out. Batch
startup and source-change checks first probe source health, then check candidate
works only against reachable sources.

## Review Candidates

Workflow candidates capture user-reviewable outcomes such as duplicate local
folders, unavailable DLsite products, and old local locations left after remote
fetches.
