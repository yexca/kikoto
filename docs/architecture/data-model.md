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
- `filesystem_trigger_state`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_candidate`
- `workflow_run_review`

Workflow records make scans, metadata sync, source checks, remote fetches, and
review actions inspectable. `workflow_job.priority` is durable queue-ordering
metadata; higher values claim first, with creation time and id as FIFO
tie-breakers.

`workflow_job.progress_bytes_current`, `progress_bytes_total`, and
`progress_bytes_unknown_items` preserve Fetch transfer progress without
overloading file-count progress. `remote_fetch_manifest.staging_cleaned_at`
records retention cleanup while the manifest and its reviewable run history
remain available for retry.

`filesystem_trigger_state` stores the fixed local-scan trigger's watched
directory count and most recent event time. It is compact orchestration state,
not a per-file index or a directory snapshot.

## User State

Important tables:

- `user_account`
- `user_session`
- `user_work_state`
- `user_work_playback_cursor`
- `user_media_progress` (legacy migration source)
- `user_media_lyrics_preference`
- `favorite_list`
- `favorite_list_item`
- `user_tag`
- `user_work_tag`

`user_work_playback_cursor` stores at most one Resume position for each user and
canonical logical work family. It references the active edition's logical media
item and records the last file source/location context; location deletion clears
those foreign keys without turning a raw path into the progress owner. Migration
`022` seeds each cursor from the newest legacy `user_media_progress` row in that
family.

Lyrics preferences relate an audio media item to a lyrics media item; runtime
location selection remains a file-source concern.

## Recommendation Snapshots

Important tables:

- `recommendation_input_revision`
- `recommendation_user_revision`
- `recommendation_generation`
- `recommendation_snapshot`
- `recommendation_snapshot_state`
- `recommendation_client_session`

A recommendation generation materializes one user's affinity score and
listening lane for every work from a specific algorithm version, configuration,
global input revision, and user-state revision. Client sessions bind to an
immutable generation so ordinary browsing and card mutations do not repeat the
affinity calculation. Current favorite and listening state still comes from
`user_work_state` for card rendering; a later client session builds a new
generation only when an input revision changed. Existing sessions retain their
generation until they expire, so a refresh cannot change another open tab's
ordering.

## Modeling Rules

- Source-level facts go in `work_source_presence`.
- Concrete local, cache, stream, and download paths go in `media_file_location`.
- Provider snapshots stay available for traceability even when normalized work
  fields are updated.
- Interactive code and text search reads normalized metadata and aliases rather
  than scanning raw provider snapshot JSON.
- User state should survive metadata refresh and source replacement.
- Playback is a work cursor, not a set of independent per-track bookmarks.

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Migrations](../development/migrations.md)
