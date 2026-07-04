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
- `party`
- `party_external_id`
- `party_catalog_item`
- `work_party`

DLsite metadata sync stores snapshots for traceability and updates normalized work fields used by the library and detail views.

Circle and maker browsing use the party tables. Catalog rows can exist before a
work has been imported into the unified work table.

## File Sources

Important tables:

- `file_source`
- `file_source_endpoint`
- `media_item`
- `media_file_location`

The current implementation creates a local file source and local file locations during scan. Administrators can configure local and compatible remote file sources from Settings.

## Workflows

Important tables:

- `workflow_definition`
- `workflow_trigger`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_candidate`

Current workflows include:

- Local scan.
- DLsite metadata sync.
- Compatible remote source sync.
- Source availability checks.
- Media cache, remote fetch actions, and parent bulk remote actions.
- Circle metadata and catalog refresh.

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
- `user_party_state`
- `person`
- `person_alias`
- `person_user_state`
- `person_user_tag`
- `work_credit`

Quick listening marks live on `user_work_state`. Playback progress lives on
`user_media_progress` and is attached to logical `media_item` records rather than
raw file locations.

Circle ratings and notes live on `user_party_state`. Voice actor favorite,
rating, note, and tag state lives on person user-state and user-tag tables.

## Planned Tables

Future features are expected to add tables for:

- Queue or listening history.
- Download tasks.
- Cache entries.
- Review or maintenance records for stale, duplicate, or ambiguous scan results.
