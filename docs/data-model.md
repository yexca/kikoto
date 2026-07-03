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
- `media_item`
- `media_file_location`

The current implementation creates a local file source and local file locations during scan.

## Workflows

Important tables:

- `workflow_template`
- `workflow_node`
- `workflow_run`
- `workflow_job`

Current workflows:

- Local scan.
- DLsite metadata sync.

## Planned Tables

Future features are expected to add tables for:

- Playback progress.
- Queue or listening history.
- User tags and favorites.
- Download tasks.
- Cache entries.
