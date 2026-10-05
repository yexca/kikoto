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
- `metadata_snapshot_card_summary`
- `dlsite_metadata_variant`
- `work_metadata_sync_state`
- `metadata_sync_attempt`
- `metadata_sync_attempt_work`
- `metadata_sync_attempt_run`
- `tag`
- `work_tag`
- `metadata_tag`
- `metadata_tag_name`
- `work_tag_override`
- `party_alias`
- `party_merge_review`
- `work_dlsite_genre`
- `dlsite_genre_name`
- `party`
- `person`
- `work_credit`
- `work_snapshot_projection`

DLsite metadata sync stores raw snapshots and updates normalized fields used by
library and detail views.

Voice credits and DLsite circle relations are projected from each work's
latest snapshot. `work_snapshot_projection` records, per work and projection,
the snapshot and a hash of the projection input it last produced. Startup and
each metadata sync project only works whose latest snapshot changed since that
record, in bounded batches; a new snapshot whose projection input is unchanged,
such as a new sales count, writes nothing but the record. Triggers drop a
record when a credit or circle relation is removed or reassigned, or when the
work's imported circle catalog row changes, so the next pass restores what the
snapshot still declares. A projection never removes a credit its snapshot no
longer names. `party_metadata_snapshot` keeps the two latest snapshots per
circle and provider, as `metadata_snapshot` does per work.

`metadata_snapshot_card_summary` holds one compact, versioned card summary per
snapshot (circle, base and edition codes, release date, rating count, series,
tags, and voice actors) so Library and voice lists do not decode the raw
snapshot for every row. It is a derived cache of `snapshot_json`, not a second
metadata source: triggers drop the summary when the snapshot content changes
and queue the snapshot in `metadata_snapshot_card_summary_dirty`, and the
server rebuilds queued or outdated-version summaries in small background
batches. A row without a current summary is read from the raw snapshot.

`work_metadata_sync_state` records the latest synchronization outcome for each
work, metadata provider, and component (`metadata` or `cover`). Failed and
unavailable components form the metadata reasons in Work maintenance. State
remains per edition/provider/component; the maintenance read combines these
with live missing-source reasons and pages one selectable row per work family.
Repeated failures update the component state; a newer success clears only
that component's pending state. Failed requests retain existing metadata,
and provider updates do not change `work_manual_override`.

Attempts receive a durable increasing id before family requests start. The
latest successful attempt protects stored metadata against stale successful
responses; current state also rejects stale failures. Attempt/work outcomes and
attempt/run associations let Activity link to outstanding problems without
changing run results or another user's reviews. Once an attempt's issue has
been resolved, a later failure does not reopen its old Activity association.
Shared issue responses contain fixed statuses rather than upstream error text.
Failure tracking never creates a work solely from a discovered catalog code.

For DLsite, `dlsite_metadata_variant` stores the title and tags for each
provider-declared language edition in a logical work family. The `origin`
display token refers to the canonical edition even when its source language is
not Japanese. The configured priority only changes the normalized title/tag
projection; the request locale and the raw snapshot remain provenance data.

DLsite genre ids are stable across request locales. `work_dlsite_genre`
(migration `047`) records the ids each edition carries, and
`dlsite_genre_name` learns one name per id and request locale from fetched
products: `name_base` is the Japanese name and `name` is the name for the
locale that was requested. Names are keyed by request locale rather than
edition language because an edition without its own locale is requested in
`ja-jp` and reports Japanese names. Known ids feed shared metadata tag
concepts and their display names; dictionary learning never creates works.

### Shared Metadata Tags

A shared tag has one `tag` row in namespace `metadata`, with an empty
`language` and a stable `normalized_name`: `dlsite-genre:<id>` for a
known genre, or `custom:<id>` for an authored concept. Imported names without
ids retain a deterministic `dlsite-name:<hash>` concept until a provider id
is available. The old `dlsite` rows remain readable during startup backfill.
`metadata_tag` holds the genre id, hidden flag, merge target, and author.
`metadata_tag_name` holds manual names by locale; an empty locale applies to
all languages. Personal `user_tag` records remain account-owned and separate.

The single `tag.display_name` tries each configured preferred locale in order:
that locale's manual name, the universal manual name, then its genre dictionary name,
then Japanese manual/dictionary names, then any known name. The edition token
`origin` does not stop this dictionary fallback. Synchronization, manual
renaming, and language-priority changes refresh the stored display name.
Dictionary learning and concept creation refresh only the changed concepts in
the writing transaction. A normal sync never recalculates the entire dictionary
and never publishes a generated genre placeholder. Detail language variants use
that variant's requested locale's manual name, then the universal manual name,
then its dictionary name, then the stored priority-selected name.

`work_tag_override` records per-work additions and removals. Projection takes
the selected edition's genres for the canonical work and each other edition's
own genres, follows merge mappings, adds manual concepts, and applies removals
and hiding. Removal wins when an addition and a removal resolve to the same
concept. Effective `work_tag` rows drive cards, detail language chips,
creator lists, search, workflow predicates, and recommendation similarity.
`tags_json` retains the provider's original names for provenance.

`work_metadata_tag_base` retains each work's original provider concept ids
before hiding, removals, or merge resolution. Snapshot-only DLsite names and
genres are normalized into this base without
fetching or creating new works. Remote snapshot tags remain in their existing
snapshot presentation and do not enter shared concepts at this stage. Snapshot
fallback fills only absent dictionary cells; names with no known request locale
are unscoped, while `name_base` is Japanese. Invalid objects, more than 256 tags,
names over 512 bytes, or snapshots over 8 MiB skip the entire snapshot fallback
before any relation changes, with a protected diagnostic. Valid normalized input
and manual additions still project.
`work_metadata_tag_projection` records the work and selected source work whose
base has been projected, including an intentionally empty result. Snapshot
writes retain the marker and committed links until a queued replacement commits. Reads
retain snapshot fallback for unprojected works; a global backfill completion
marker alone never makes an empty work authoritative.

Search expands dictionary, manual, and original display names from the effective
concept and all concepts resolving to it through `metadata_tag_resolution`.
Source-name and merge changes invalidate affected documents even when the
effective display name and links stay unchanged. Undo removes the former
source names from works that now resolve only to the target.
Tag merges retain the original concept and override ids; undo clears the
mapping, and cycles are rejected. Only the final merge target's hidden flag
controls visibility. A merged source's hidden flag is dormant until undo;
merging into a hidden target hides the result for every related work.
After each work is projected, hidden final concepts and removed work tags do
not participate in display, search, or recommendation inputs. `work_tag` remains
the committed per-work read boundary while background repair is pending, so
merging does not filter away the old source link before its replacement commits.
Relation
changes advance the existing recommendation input revision, so the algorithm
version is unchanged and new sessions rebuild their generation.

Custom creation trims the name and reuses an existing concept when any known
locale name matches with Unicode case folding. It resolves a matched merged
source to its final target. A match resolving to a hidden target returns
`409 metadata_tag_hidden`; it is never silently created or attached. Work-editor
custom tags are created and attached in
the work-save transaction, so cancellation and failed saves leave no new orphan.

`work_metadata_tag_dirty` (migration 051) is the durable per-work projection
queue with persistent `retry_count` and Unix-second `retry_after`. Snapshot
insert/update/delete triggers queue only existing works and dependent
projections without invalidating markers; inserts and updates also cover stored
edition siblings. Hide/merge/undo enqueue the connected component before and
after the state change in the same transaction. Processing selects, projects,
and acknowledges at most 64 works in one bounded write transaction. Failure or
cancellation retains the whole batch; repeated processing is idempotent. A failed
work is deferred separately for exponential retries from 30 seconds to five
minutes, so later works proceed. Backoff survives restart and counts as pending. Both
mutation responses and tag lists report the instance-wide `pendingWorkCount`.
Demo reads count only eligible demo works.
Relation changes invalidate search and advance recommendation input revisions.

### Circle Identity

`party.manual_name` takes precedence over `provider_name`; provider
refreshes preserve authored names. `party_alias` stores confirmed alternate
names, including names retained by a merge. Aliases participate in creator
suggestions, work search, and matching an existing circle from a remote record.

A circle merge transfers work relations, every maker id, catalogs, retained
snapshots, series membership, personal state and tags, and earlier merge
reviews. Duplicate catalogs keep the newest observation; duplicate personal
states preserve target ratings/notes and union favorites and tags. Catalog
refresh state is invalidated. `party_merge_review` retains protected before
and after records. Undo applies only captured differences, keeps unrelated new
rows, and rejects a later change to data it would restore. Nested merges undo
in reverse order. Review responses expose names and status, not raw snapshots.

Migration 052 rebuilds `work_manual_override` with primary key
`(work_id, field_name, language)`. Existing rows retain `language=''`, timestamps,
authorship and cover assets. Only title allows a nonempty language (`ja-jp`,
`zh-cn`, `zh-tw`, `en-us`, `ko-kr`); other fields remain universal. Field and
foreign-key indexes and all migration-036 search invalidation triggers are
recreated, including language-only updates.

Display title selection tries each configured language: its manual title, the
universal manual title, then that DLsite edition. `origin` matches the canonical
edition's declared language and never infers a language from text or request
locale. Unknown origin languages use the universal manual title or original title. Manual titles
without a corresponding provider edition use the original description; otherwise
the description is read from the selected edition's work row. Missing translated
introductions remain empty rather than silently borrowing Japanese text.

`metadatatitles` holds the shared pure selection/display policy. Every
non-canonical edition is a translation, independent of translator classification.
One leading DLsite language-edition label is recognized by its suffix format,
including unsupported languages such as `【ドイツ語版】`; genre labels remain.
Provider projections and raw snapshots are untouched, and authored titles and
unrelated brackets survive. Batched HTTP presentation applies the policy to
cards, search results, circle and voice actor lists without reading introductions.
Each edition list entry uses its own provider title, never a sibling's title.
Detail variants carry their effective title and
plain-text introduction, including manual-only language choices. Universal manual
titles overlay existing choices without creating a language; only a specific
manual language may add a choice. Unknown original languages stay unknown in
the menu, selection and editor sources. All manual languages are
indexed and scoped writes/reset invalidate search. Remote-title fallback is not
part of this stage.

The optional PATCH `titles` map updates only supplied language keys; `null` or
empty values remove that language. Legacy `title` remains the universal value;
using both forms in one request is rejected. GET returns `titles` plus compatible
universal `title`. DELETE `.../manual-overrides/title?language=zh-cn` resets only
that title scope; an omitted language resets only the universal scope.

`PATCH /api/works/{id}/manual-overrides` updates only supplied fields;
explicit null or empty values reset that field. Omitted relations remain
unchanged. Migration 048 clears only title overrides exactly matching a
trimmed provider title in the work's own edition or logical family.

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

`work_metadata_link` (migration `045`) records a user-declared DLsite product
whose metadata a work uses, for example when a bonus edition is no longer
published and the regular edition is sold under another code. Metadata sync
for a linked work requests only the linked code and stores the result on the
linked work under its own code: the snapshot's product codes are rewritten to
the work, its translation and language-edition relationships are removed, and
`_kikoto.metadata_source_code` keeps the source for traceability. The linked
code never becomes a work, edition, or alias, and its family is not walked.
Saving a link rechecks a work previously recorded as `not_found`; removing it
keeps the stored metadata until the work's own code is synchronized again.

## Voice Catalog Discovery

Important tables:

- `voice_catalog_item`
- `voice_catalog_source`
- `voice_catalog_refresh_state`

`voice_catalog_item` is a person-scoped discovery projection keyed by canonical
`primary_code`. It lets a voice actor page retain remote discoveries before a
corresponding `work` exists. A remote-only catalog item does not create a work,
credit, logical work, or second identity. When the canonical work already
exists, `work_id` links the projection to that same work.

`voice_catalog_source` records the exact remote code and catalog availability
observed through a `metadata_provider`, using the same source-derived provider
identity as the circle catalog. A complete successful source refresh marks
older observations from that provider `not_found`; a failed or cancelled source
refresh leaves its previous observations intact. The configured `file_source`
is mapped separately when Kikoto projects known-work availability into
`work_source_presence`; concrete playable paths still belong in
`media_file_location`.

`voice_catalog_refresh_state` stores the alias query set, generation, per-source
completion, latest durable workflow result, and each compatible source/query's
recent-added frontier for incremental discovery. The frontier contains remote
identities from a source-provided recent-added order; it never derives ordering
from a release date or primary code. Person merge review snapshots include both
sides' voice catalogs. A merge retains their canonical union and invalidates the
target refresh state because the confirmed alias set changed; Undo restores both
captured catalogs and refresh states. A merge also moves the source's provider
voice actor ids to the target. Credit projection resolves a name that is no
person's display name through a confirmed alias held by exactly one person, so
metadata sync keeps a merge instead of recreating the merged-away person. A
merged name never replaces the target's display name.

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
not a per-file index or a directory snapshot. A bounded changed-path batch is
stored in the resulting incremental workflow run and job input. A pending batch
before dispatch is process-local; the default full Startup scan repairs changes
that occurred while Kikoto was stopped.

## User State

Important tables:

- `user_account`
- `user_session`
- `user_preference`
- `user_work_state`
- `user_work_playback_cursor`
- `user_media_progress` (legacy migration source)
- `user_media_lyrics_preference`
- `favorite_list`
- `favorite_list_item`
- `user_tag`
- `user_work_tag`
- `user_listening_session`
- `user_listening_day`
- `user_listening_import`
- `user_listening_generation`

Migration `043` separates durable listening history from recommendation events.
Sessions belong to an account and canonical work, accept monotonic cumulative
seconds, and survive recommendation retention cleanup. UTC daily buckets receive
only newly reported seconds. Imported totals store positive differences above
measured totals without fabricating daily activity. Clearing history increments an account generation checked on every report,
including an unseen first report, to reject delayed retries; marks, lists and cursors stay intact.
Export/import is a versioned work-code-based personal document, not a database
or media backup.

`user_session.id` is the hex SHA-256 digest of the bearer token issued to the
client, never the token itself, so the database and its backups cannot be
replayed as a sign-in. The account store hashes every token before a lookup or
delete.

`favorite_list` distinguishes a system `marked` list from ordinary user lists.
The system list has no stored items: it derives membership from a non-`none`
Quick mark. `favorite_list_item` records only explicit user-list membership.

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
generation only when an input revision changed. The revision triggers fire
only when a value the scorer reads changes (the work, tag, person, circle, or
role of a relation, a tag namespace, or a user's listening status or
favorite), so a metadata refresh that rewrites provenance or timestamps does
not rebuild recommendations. Existing sessions retain their
generation until they expire, so a refresh cannot change another open tab's
ordering. A released recommendation algorithm version invalidates its older
generation binding and rebuilds it before the session is reused.

## Modeling Rules

- Source-level facts go in `work_source_presence`.
- Concrete local, cache, stream, and download paths go in `media_file_location`.
- Provider snapshots stay available for traceability even when normalized work
  fields are updated.
- Catalog discovery may retain a canonical code without materializing a `work`;
  only an existing, tracked, local, cached, or explicitly requested work is a
  metadata root.
- Interactive code and text search reads normalized metadata and aliases rather
  than scanning raw provider snapshot JSON.
- `work_search` is a derived FTS5 trigram index with one row per work
  (`rowid = work.id`) holding folded code/alias, title, circle, voice actor,
  and tag text, including relevant manual overrides. The title column also
  holds the work's own DLsite variant title, so an origin title stays
  searchable after the priority projection rewrites `work.title`. The tag
  column also holds every learned `dlsite_genre_name` for the work's genre
  ids, so a tag matches in each language the library has fetched. Matching
  remains a substring test; a Library page orders works whose indexed value
  equals a text, circle, voice, or tag needle exactly ahead of partial
  matches, then applies the selected sort. Folding applies NFKC,
  Unicode lowercase, and katakana-to-hiragana mapping. Triggers queue changed
  works in `work_search_dirty`; a background worker rebuilds queued documents
  in bounded batches. A search rebuilds a queue of at most 64 works itself, so
  an edit is searchable at once; a longer queue leaves the search on the
  previous index state and wakes the worker instead of holding the request. Edition-family matching is applied at query time, so the
  index never duplicates a sibling's text or creates another work identity.
- User state should survive metadata refresh and source replacement.
- Playback is a work cursor, not a set of independent per-track bookmarks.

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Migrations](../development/migrations.md)

`user_preference` stores optional account overrides for folder routing rules,
recommendation configuration, and badge threshold. Missing overrides use existing
`app_setting` defaults. Migration `034` adds this table without rewriting existing
instance settings or recommendation sessions. New recommendation generations use
the effective account configuration; existing session bindings remain immutable.
