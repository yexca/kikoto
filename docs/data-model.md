# Data Model

Kikoto uses a unified work model.

## Core Principle

A work should exist once. File sources add playable locations; they do not own separate work identities.

```text
work
  -> media_item
  -> media_file_location
  -> file_source
```

## Work Metadata

Important tables:

- `work`
- `work_external_id`
- `metadata_provider`
- `metadata_snapshot`

DLsite metadata sync stores snapshots for traceability and updates normalized work fields used by the library and detail views.

## File Sources

Important tables:

- `file_source`
- `file_source_endpoint`
- `media_item`
- `media_file_location`

The current implementation creates a local file source and local file locations during scan. Administrators can configure local and Kikoeru-compatible file sources from Settings.

## Workflows

Important tables:

- `workflow_definition`
- `workflow_trigger`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_candidate`

Current workflows:

- Local scan.
- DLsite metadata sync.
- Built-in remote sync, media cache, and media save definitions as scaffolding.

Workflow definitions are either `system` or `user` scoped. System definitions are
read-only. User definitions can be created and edited from the Workflows page.
Activity uses `workflow_node_run` records to show node-level status.

## User State

Important tables:

- `user_account`
- `user_session`
- `user_work_state`
- `user_media_progress`
- `favorite_list`
- `favorite_list_item`
- `user_tag`
- `user_work_tag`

Quick listening marks live on `user_work_state`. Playback progress lives on
`user_media_progress` and is attached to logical `media_item` records rather than
raw file locations.

## Planned Tables

Future features are expected to add tables for:

- Queue or listening history.
- Download tasks.
- Cache entries.
