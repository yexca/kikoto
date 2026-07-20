# Data Model

Kikoto uses SQLite and a unified work model.

## Work Metadata

Important tables:

- `work`
- `logical_work`
- `work_edition`
- `work_code_alias`
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

`work.rating_average`, `work.sales_count`, and the current commercial fields are
normalized projections maintained by metadata sync. Interactive rating/sales
filtering and sorting read these columns rather than extracting snapshot JSON.
`regular_price` and `current_price` are integer JPY amounts. A work is marked
`is_permanently_free` only when both prices are zero and the provider does not
report a discount; temporary free campaigns therefore remain ineligible for
Demo mode.

`work_code_alias` maps provider-declared edition codes to a logical work. An
alias may reference a persisted edition work, but metadata-only aliases do not
create works and do not imply local or remote file availability.

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
- `user_media_lyrics_preference`
- `favorite_list`
- `favorite_list_item`
- `user_tag`
- `user_work_tag`

Playback progress and lyrics choices are attached to logical media items, not
raw file paths. Lyrics preferences relate an audio media item to a lyrics media
item; runtime location selection remains a file-source concern.

## Modeling Rules

- Source-level facts go in `work_source_presence`.
- Concrete local, cache, stream, and download paths go in `media_file_location`.
- Provider snapshots stay available for traceability even when normalized work
  fields are updated.
- Interactive code and text search reads normalized metadata and aliases rather
  than scanning raw provider snapshot JSON.
- User state should survive metadata refresh and source replacement.

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Migrations](../development/migrations.md)
