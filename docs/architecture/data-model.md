# Data Model

Kikoto uses SQLite and a unified work model.

## Work Metadata

Important tables:

- `work`
- `logical_work`
- `work_edition`
- `work_external_id`
- `metadata_provider`
- `metadata_snapshot`
- `tag`
- `work_tag`
- `party`
- `person`
- `work_credit`

DLsite metadata sync stores raw snapshots and updates normalized fields used by
library and detail views.

## File Availability

Important tables:

- `file_source`
- `file_source_endpoint`
- `work_source_presence`
- `media_item`
- `media_file_location`

Presence can describe that a source knows about a work. Concrete playback,
download, local, and cache paths belong in media file locations.

## Workflows

Important tables:

- `workflow_definition`
- `workflow_trigger`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_candidate`
- `workflow_run_review`

Workflow records make scans, metadata sync, source checks, remote fetches, and
review actions inspectable.

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

Playback progress is attached to logical media items, not raw file paths.

## Modeling Rules

- Source-level facts go in `work_source_presence`.
- Concrete local, cache, stream, and download paths go in `media_file_location`.
- Provider snapshots stay available for traceability even when normalized work
  fields are updated.
- User state should survive metadata refresh and source replacement.

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Migrations](../development/migrations.md)
