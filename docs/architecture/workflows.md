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
- Cache cleanup.
- Local location cleanup.
- Circle metadata refresh.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out. Batch
startup and source-change checks first probe source health, then check candidate
works only against reachable sources.

## Review Candidates

Workflow candidates capture user-reviewable outcomes such as duplicate local
folders, unavailable DLsite products, and old local locations left after remote
fetches.
