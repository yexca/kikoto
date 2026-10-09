# Data Model

Kikoto uses SQLite and a unified work model.

## Work Metadata

Important tables:

- `work`
- `logical_work`
- `work_edition`
- `work_code_alias`
- `work_external_id`
- `work_metadata_link`
- `work_purchase_bonus`
- `work_manual_override`
- `metadata_provider`
- `metadata_snapshot`
- `metadata_snapshot_card_summary`
- `party_metadata_snapshot`
- `dlsite_metadata_variant`
- `work_title_language`
- `remote_metadata_title_variant`
- `work_metadata_field_source`
- `work_metadata_sync_state`
- `work_metadata_provider_state`
- `metadata_sync_attempt`
- `metadata_sync_attempt_work`
- `metadata_sync_attempt_run`
- `tag`
- `work_tag`
- `metadata_tag`
- `metadata_tag_name`
- `metadata_tag_provider_name`
- `work_tag_override`
- `work_dlsite_genre`
- `dlsite_genre_name`
- `dlsite_genre_name_request`
- `dlsite_genre_name_gap`
- `party`
- `work_party`
- `party_alias`
- `party_merge_review`
- `party_catalog_item`
- `party_catalog_refresh_state`
- `person`
- `person_alias`
- `person_merge_review`
- `work_credit`
- `work_snapshot_projection`

DLsite metadata sync stores raw snapshots and updates normalized fields used by
library and detail views.

`work_party` relates a work to a circle (`role = 'circle'`) and records the
provider that supplied the relation; `work_credit` relates a work to a person
in a role such as `voice_actor`. Voice credits and DLsite circle relations are
projected from each work's latest snapshot. `work_snapshot_projection` records,
per work and projection, the snapshot and a hash of the projection input it
last produced. Startup and each metadata sync project only works whose latest
snapshot changed since that record, in bounded batches; a new snapshot whose
projection input is unchanged, such as a new sales count, writes nothing but
the record. Triggers drop a record when a credit or circle relation is removed
or reassigned, or when the work's imported circle catalog row changes, so the
next pass restores what the snapshot still declares. A projection never removes
a credit its snapshot does not name. `party_metadata_snapshot` keeps the two
latest snapshots per circle and provider, as `metadata_snapshot` does per work.

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

### Metadata Language

For DLsite, `dlsite_metadata_variant` stores the title and tags of each
provider-declared language edition in a logical work family, one row per
edition work. The `origin` display token refers to the canonical edition even
when its source language is not Japanese. A language priority only changes
the normalized title/tag projection; the request locale and the raw snapshot
remain provenance data.

Metadata language has two scopes. Everything stored or shared uses each work's
original language (the `origin` priority): the projected `work.title`,
`tag.display_name`, background syncs, catalog snapshots, remote metadata
fallback and Activity text. There is no instance-wide language setting. A
signed-in user may store an own priority in `user_preference.metadata_languages`
(`NULL`, also stored when the user picks `origin`, means no preference). It
changes only what that user's requests present: selected titles and
introductions, tag names, the default detail edition, title sorting, and live
remote-source requests. Requests without a user use the original language. No
stored provider value depends on a personal priority, and a personal change
rewrites nothing.

The startup metadata tag backfill deletes the unused instance keys
`app_setting.dlsite_metadata_languages` and `app_setting.dlsite_metadata_language`
when present. When either holds a language other than `origin`, the same step
first sets `metadata_projection_pending`, so the backfill projects stored
titles and tag names again in the original language.

`work_title_language` holds each work's title for every language that title
selection can stop at: each supported language with its own edition or
language-specific manual title, and always `origin`. Selection over a priority
therefore equals the first present row in that priority, so a title sort reads
`COALESCE` over the viewer's languages and falls back to `work.title` while a
work is queued. Triggers on editions, variants, title overrides and work titles
queue whole families in `work_title_language_dirty`; the search index worker
rebuilds them in bounded batches.

### DLsite Genres

DLsite genre ids are stable across request locales. `work_dlsite_genre`
records the ids each edition carries, and `dlsite_genre_name` learns one name
per id and request locale from fetched products: a response's `name_base` is
stored as the `ja-jp` name, and its `name` under the locale that was requested.
Names are keyed by request locale rather than edition language because an
edition without its own locale is requested in `ja-jp` and reports Japanese
names. Known ids feed shared metadata tag concepts and their display names;
dictionary learning never creates works.

DLsite reports genre names in the requested locale whether or not a work has a
translated edition, so a Japanese-only work still has preferred-language tag
names once the dictionary knows them. Genre name learning fills missing cells
for each preferred non-Japanese language, the union of every account's
priority; saving a personal priority queues it. It asks for the known,
requestable work whose genres cover the most unnamed genres, so requests grow
with the missing genre sets rather than the number of works. It stores only
the response's genre names for genre ids the library already knows; it writes
no work, edition, relation, snapshot, title or introduction.
`dlsite_genre_name_request` records each answered request (`learned`,
`no_names`, or `not_found`) so a work is never asked again in that language;
failed requests are not recorded and stay retryable. Works DLsite already
reported as not found are not requested. `dlsite_genre_name_gap` counts
answered lookups that did not name a genre; after two such answers, or when no
requestable work carries the genre, the genre and language pair is exhausted
and is not selected again. New names refresh the affected concepts' display
names in the same transaction, and the dictionary triggers invalidate the
related works' search documents.

### Shared Metadata Tags

A shared tag has one `tag` row in namespace `metadata`, with an empty
`language` and a stable `normalized_name`: `dlsite-genre:<id>` for a
known genre, or `custom:<id>` for an authored concept. Imported names without
ids retain a deterministic `dlsite-name:<hash>` concept until a provider id
is available. Tag rows in the `dlsite` namespace remain readable until the
startup backfill replaces them. `metadata_tag` holds the genre id, hidden
flag, merge target, and author. `metadata_tag_name` holds manual names by
locale; an empty locale applies to all languages. Personal `user_tag` records
remain account-owned and separate.

A display name tries each locale of a priority in order: that locale's manual
name, the universal manual name, then its genre dictionary name, then Japanese
manual/dictionary names, then any known name. The edition token `origin` does
not stop this dictionary fallback. The single stored `tag.display_name` always
uses the `origin` priority. Synchronization and manual renaming refresh it.
Dictionary learning and concept creation refresh only the changed concepts in
the writing transaction. A normal sync never recalculates the entire dictionary
and never publishes a generated genre placeholder. A viewer with an own
preferred language gets the same chain over its own priority at
read time; the stored name is used unchanged otherwise. Detail language
variants use that variant's requested locale's manual name, then the universal
manual name, then its dictionary name, then the viewer's priority-selected name.

`work_tag_override` records per-work additions and removals. Projection takes
the original edition's genres for the canonical work, never the edition a
language priority selects (otherwise the first edition with a title in the
fixed supported-language order), and each other edition's own genres, follows
merge mappings, adds manual concepts, and applies removals and hiding. Every
language therefore shows the same tag set; detail language variants rename
those tags but never swap them for another edition's genres. Removal wins when
an addition and a removal resolve to the same concept. Effective `work_tag`
rows drive cards, detail language chips, creator lists, search, workflow
predicates, and recommendation similarity. `tags_json` retains the provider's
original names for provenance.

`work_metadata_tag_base` retains each work's original provider concept ids
before hiding, removals, or merge resolution. Snapshot-only DLsite names and
genres are normalized into this base without
fetching or creating new works. Remote snapshot tags enter shared concepts only
through the opt-in [remote metadata fallback](#remote-metadata-fallback);
otherwise they keep their snapshot presentation. Snapshot
fallback fills only absent dictionary cells; names with no known request locale
are unscoped, while `name_base` is Japanese. Invalid objects, more than 256 tags,
names over 512 bytes, or snapshots over 8 MiB skip the entire snapshot fallback
before any relation changes, with a protected diagnostic. Valid normalized input
and manual additions still project.
`work_metadata_tag_projection` records the work and selected source work whose
base has been projected, including an intentionally empty result. Snapshot
writes retain the marker and committed links until a queued replacement
commits. Reads retain snapshot fallback for unprojected works; a global
backfill completion marker alone never makes an empty work authoritative.

Search expands dictionary, manual, and original display names from the effective
concept and all concepts resolving to it through `metadata_tag_resolution`.
Source-name and merge changes invalidate affected documents even when the
effective display name and links stay unchanged. Undo removes the former
source names from works that resolve only to the target.
Tag merges retain the original concept and override ids; undo clears the
mapping, and cycles are rejected. Only the final merge target's hidden flag
controls visibility. A merged source's hidden flag is dormant until undo;
merging into a hidden target hides the result for every related work.
After each work is projected, hidden final concepts and removed work tags do
not participate in display, search, or recommendation inputs. `work_tag` remains
the committed per-work read boundary while background repair is pending, so
merging does not filter away the source link before its replacement commits.
Relation changes advance the existing recommendation input revision, so the
algorithm version is unchanged and new sessions rebuild their generation.

Custom creation trims the name and reuses an existing concept when any known
locale name matches with Unicode case folding. It resolves a matched merged
source to its final target. A match resolving to a hidden target returns
`409 metadata_tag_hidden`; it is never silently created or attached. Work-editor
custom tags are created and attached in
the work-save transaction, so cancellation and failed saves leave no new orphan.

`work_metadata_tag_dirty` is the durable per-work projection
queue with persistent `retry_count` and Unix-second `retry_after`. Snapshot
insert/update/delete triggers queue only existing works and dependent
projections without invalidating markers; inserts and updates also cover stored
edition siblings. Hide/merge/undo enqueue the connected component before and
after the state change in the same transaction. Processing selects, projects,
and acknowledges at most 64 works in one bounded write transaction. Failure or
cancellation retains the whole batch; repeated processing is idempotent. A
failed work is deferred separately for exponential retries from 30 seconds to
five minutes, so later works proceed. Backoff survives restart and counts as
pending. Both mutation responses and tag lists report the instance-wide
`pendingWorkCount`. Demo reads count only eligible demo works.
Relation changes invalidate search and advance recommendation input revisions.

### Circle and Voice Actor Identity

`party.manual_name` takes precedence over `provider_name`; provider
refreshes preserve authored names. `party_alias` stores confirmed alternate
names, including names retained by a merge. Aliases participate in creator
suggestions, work search, and matching an existing circle from a remote record.

`party_catalog_item` holds a circle's discovered catalog per provider, keyed by
circle, provider and canonical code, with title, release date, catalog status
and the raw entry; a catalog item is not a work. `party_catalog_refresh_state`
records each circle and provider's latest catalog refresh attempt, mode,
status, run and error.

A circle merge transfers work relations, every maker id, catalogs, retained
snapshots, series membership, personal state and tags, and earlier merge
reviews. Duplicate catalogs keep the newest observation; duplicate personal
states preserve target ratings/notes and union favorites and tags. Catalog
refresh state is invalidated. `party_merge_review` retains protected before
and after records. Undo applies only captured differences, keeps unrelated new
rows, and rejects a later change to data it would restore. Nested merges undo
in reverse order. Review responses expose names and status, not raw snapshots.

`person_alias` holds a voice actor's confirmed alternate names; an alias with
source `primary_name` cannot be deleted. `person_merge_review` retains each
voice actor merge's names, a protected snapshot, and its `merged` or `undone`
status. Voice actor merge behavior is described under
[Voice Catalog Discovery](#voice-catalog-discovery).

### Manual Overrides and Titles

`work_manual_override` has primary key `(work_id, field_name, language)`. Only
`title` allows a nonempty language (`ja-jp`, `zh-cn`, `zh-tw`, `en-us`,
`ko-kr`); every other field uses the universal `language = ''`. Search
invalidation triggers on title, circle, series, and voice actor overrides also
fire on a language-only update.

Display title selection picks the first preferred language with its own manual
title or DLsite edition, then shows its language manual title, the universal
manual title, or that edition's title. A universal manual title replaces only
the text: it never selects an edition, so the default edition, description, and
tags match the presentation without it. `origin` matches the canonical
edition's declared language and never infers a language from text or request
locale. Unknown origin languages use the universal manual title or original
title. Manual titles without a corresponding provider edition use the original
description; otherwise the description is read from the selected edition's work
row. Missing translated introductions remain empty rather than silently
borrowing Japanese text.

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
indexed and scoped writes/reset invalidate search. A work without DLsite data
falls back to the title a remote source filled (see
[remote metadata fallback](#remote-metadata-fallback)), then to its own title.
Remote titles may declare a language through `language_editions` and
`other_language_editions_in_db`. Stored titles with declared languages enter
the same priority selection and manual-title precedence; an undeclared title
remains a languageless fallback. Remote titles receive no translation-label
stripping, and their metadata choices never become playable editions or proof
of a successful DLsite synchronization.

`PATCH /api/works/{id}/manual-overrides` updates only supplied fields;
explicit null or empty values reset that field. Omitted relations remain
unchanged. The optional `titles` map updates only supplied language keys;
`null` or empty values remove that language. The compatible `title` field is
the universal value; using both forms in one request is rejected. GET returns
`titles` plus the universal `title`. DELETE
`.../manual-overrides/title?language=zh-cn` resets only that title scope; an
omitted language resets only the universal scope.

### Normalized Fields and Metadata Links

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

`work_metadata_link` records a user-declared DLsite product whose metadata a
work uses, for example when a bonus edition is withdrawn from sale and the
regular edition is sold under another code. Metadata sync for a linked work
requests only the linked code and stores the result on the linked work under
its own code: the snapshot's product codes are rewritten to the work, its
translation and language-edition relationships are removed, and
`_kikoto.metadata_source_code` keeps the source for traceability. The linked
code never becomes a work, edition, or alias, and its family is not walked.
Saving a link rechecks a work recorded as `not_found`; removing it keeps the
stored metadata until the work's own code is synchronized again.

### Purchase Bonuses

`work_purchase_bonus` attaches a purchase bonus
(`購入特典`, `早期購入特典`) to the family of the product it was distributed with.
DLsite declares no relationship between the two: the bonus has no translation,
edition, or bonus field naming its parent, and its public page is unlisted. The
bonus is not an edition. It keeps its own work, singleton edition family,
playback cursor, availability, Library card and deletion, because every family
reader treats a sibling `work_edition` as an interchangeable language edition.
The row stores the parent by code only; the parent never becomes a work, edition
or alias, and the detail resolves it at read time to the work with that code or
the canonical work of the family declaring it as an alias. A parent's detail
lists linked bonuses whose code belongs to its family.

`status` is `linked` (with `parent_code`), `unmatched` (detection found no
single parent) or `dismissed` (a user removed the link); `origin` is `detected`
or `user`. Detection never replaces a user's link or dismissal, and a dismissed
work is not detected again. Metadata sync stores a linked bonus's own product
and fills only its empty genres, credits (`creaters`) and series fields from
the parent product, requested in the bonus's locale. The snapshot keeps the
bonus's code, title, introduction, cover and release date, and records
`_kikoto.purchase_bonus_parent_code` and `_kikoto.purchase_bonus_inherited`, so
the tag, credit, card-summary and search projections need no bonus logic. A
dismissal queues a refresh that stores the bonus's own product again.

### Remote Metadata Fallback

Remote file sources may describe works, but they never create a work or a
second identity. A source declares the ability in `file_source.config_json`
`capabilities`. Only Kikoeru-compatible source types support `metadata`; a
config without the list keeps that type's default, and an explicit list,
including an empty one, is authoritative. Code checks the declared capability
and source type, never a display name. A remote source's provider identity is
`kikoeru_source_<source code>`.

`app_setting.remote_metadata_fallback` is the instance policy
`{"enabled", "sourceIds"}`, default off with no sources. `enabled` gates the
lookup after DLsite reports a work as not found and the folding of remote tags
into shared tags. `sourceIds` lists at most 16 distinct metadata-capable
sources and forms the fallback order. Every remote source is ranked, with the
selected ones first in that order and the others by source priority and id.
The ranking decides every stored remote value, independent of which source
wrote last.

The metadata workflow stores `sourceId`, `workCodes`, `remoteMetadataFallback`
and `purchaseBonusAutoLink` alongside its scope and mode in run, job and trigger
JSON. These are execution options, not instance-setting mutations, and a bulk
run's fallback choice is independent of the instance policy. Retries keep the
saved values. A per-work refresh without a selected source snapshots the
instance policy and the purchase-bonus auto-link setting into its job when it
is queued.

`remotemetadata.ReconcileWorkTx` derives a work's normalized fields from the
latest stored snapshot of each remote provider. Snapshots are untrusted:
non-objects, missing codes, titles over 2048 bytes, circle names over 512 bytes,
more than 256 tags, tag names over 512 bytes, more than 16 localizations per
tag, more than 32 entries in either edition collection, or snapshots over
8 MiB are skipped as a whole with a protected log.
Release dates must start with `YYYY-MM-DD`. For each field the first-ranked
source with a value wins. Without DLsite (or another non-remote provider)
metadata, the winner replaces title, release date, age rating and duration;
with it, remote values only fill an empty field.
`work_metadata_field_source` records the provider of each
remote-filled value (`title`, `release_date`, `age_rating`, `duration`,
`circle`, `tags`, `cover`). It holds rows only while the work has no DLsite
metadata; projection clears them when DLsite data arrives, so DLsite always
takes over.

`remote_metadata_title_variant` holds the first-ranked
provider's title per supported language and original edition for an existing
work. A title's language comes from the provider's edition declarations,
never the request locale or title text. `language_editions` supplies code and
language relationships; `other_language_editions_in_db` supplies the titles
already returned for sibling codes. A source-local numeric id alone is not an
edition code. A relationship without a title creates no language choice and
causes no additional request, work, alias or file availability. Raw snapshots
remain the provenance source; projection reads no remote catalog.

The shared title projection always uses the original edition when it has a
stored title; otherwise it keeps the source's own title as the fallback.
Each viewer selects their own title from the stored variants. The title
editor, detail language menu, title sort and search share these values.
Snapshot refreshes and source-order changes replace the projection through the
bounded queue. Turning the fallback off retains these titles as passive
metadata; DLsite takeover removes the remote projection and never fills a
missing DLsite language from a remote source.

The winning circle name links an existing circle by name or confirmed alias.
Only an active fallback source (switch on, selected, capable, enabled) may
create a new circle without a maker id; such duplicates can be merged in the
circle view. One remote circle relation is kept per work, from the winner, and
a manual or DLsite circle keeps precedence. A fallback cover is cached only when
the work has no cover, so an existing DLsite cover is never replaced.

While the fallback is enabled, the first active source whose snapshot declares
tags supplies a remote-only work's shared-tag base. Each tag reuses the concept
whose display, manual, dictionary or provider name equals its primary or any
localized name, ignoring case, so a remote name matching a DLsite genre joins
that genre. An unmatched tag gets the same deterministic `dlsite-name:<hash>`
concept as an imported name without a genre id. Its localized names go to
`metadata_tag_provider_name`, only for concepts without a genre id and only
into absent cells. They rank after manual and dictionary names in display
precedence, are searchable, and invalidate search when they change. Remote
refreshes reach the durable projection queue through the snapshot triggers, so
tags follow the latest snapshot.

`work_metadata_sync_state` and `work_metadata_provider_state` record remote
providers' outcomes as well as DLsite's. When DLsite reported the work not found
and remote values remain, the detail's `metadataSync.status` is
`remote_fallback`, with the filling source and per-field sources, and the
Metadata issue list names that source on the DLsite row.

Turning the switch off stops new lookups and requeues every work with a remote
snapshot. Remote tags then leave shared tags and their snapshot display
returns. Filled titles, dates, circles and covers, their provenance and the
snapshots stay as passive remote data under the same ordering until DLsite or
manual values replace them. Changing the order, or a source's enabled state or
capability, requeues the affected works the same way, and pending remote issues
of a source the fallback does not use are cleared.

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
- `work_folder_location`
- `media_item`
- `media_file_location`
- `media_lyrics_assignment`

Presence can describe that a source knows about a work. Concrete playback,
download, local, and cache paths belong in media file locations.

`work_folder_location` binds a work to one concrete folder root on a file
source, unique per source and root path, separately from the aggregated
presence row, so cleanup and the directory UI address a stable folder identity.
`role` is `external` for a scanned folder or `managed_fetch` for a folder a
Fetch published; `state` is `active`, `missing`, or a review-driven cleanup
state (`pending_cleanup`, `ignored`). A scan marks only folders it could
observe as missing.

`media_item.file_version` and `media_file_location.file_version` version local
file observations. Local scans observe file size and nanosecond modification
time independently of the stable path fingerprint. Changed observations clear
duration/audio metadata without replacing media ids or personal state. Probes
compare their location id and expected version in the write transaction,
rejecting delayed results after a rescan. An empty version is established on
the next visible scan or probe.

`media_lyrics_assignment` is the library-level lyrics file of an audio media
item. It relates two media items of the same work, so a rescan that keeps media
ids keeps the assignment; deleting either item removes it. The audio item may
belong to any edition of the requested work's family, because a work detail can
show a sibling edition's local media. `origin` records how the row was made:
`manual` from the lyrics manager, or `remote_fetch` when a remote lyrics
download assigned the file it published. Clients rank a user's
`user_media_lyrics_preference` first, then this assignment, then name matching.

## Workflows

Important tables:

- `workflow_definition`
- `workflow_trigger`
- `filesystem_trigger_state`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_event`
- `workflow_notification`
- `workflow_candidate`
- `workflow_run_review`
- `remote_fetch_manifest`
- `remote_fetch_manifest_item`
- `remote_fetch_request`
- `availability_watch`
- `availability_watch_target`

Workflow records make scans, metadata sync, source checks, remote fetches, and
review actions inspectable. `workflow_job.priority` is durable queue-ordering
metadata; higher values claim first, with creation time and id as FIFO
tie-breakers. `workflow_event` is a run's event log (level, type, message and
detail), optionally tied to a node run or job. `workflow_notification` holds at
most one notification per user, run and type, such as ready Availability Watch
works or the first metadata prompt; database cleanup can remove dismissed ones.

`workflow_job.progress_bytes_current`, `progress_bytes_total`, and
`progress_bytes_unknown_items` preserve Fetch transfer progress without
overloading file-count progress. `remote_fetch_manifest` is the plan and state
of one Fetch run: the work, remote and local sources, edition code, and target,
staging and backup roots. `remote_fetch_manifest_item` holds one planned file
per target path with its action, expected size, hash, state and conflict
resolution. `remote_fetch_manifest.staging_cleaned_at` records retention
cleanup while the manifest and its reviewable run history remain available for
retry. `remote_fetch_request` maps a client-supplied request id to its source,
work code, run and result, so a repeated request returns the original result
and reusing the id for another work is rejected.

`availability_watch` holds the single shared
[Availability Watch](workflows.md#availability-watch) configuration (action,
source, excluded extensions and revision). `availability_watch_target` holds
the normalized work codes in its pool with per-target check state, the source
that became available and the family edition it offered (`available_code`),
the last family metadata refresh, and child Track and Fetch run ids. A target
is a code, not a work.

`filesystem_trigger_state` stores the fixed local-scan trigger's watched
directory count and most recent event time. It is compact orchestration state,
not a per-file index or a directory snapshot. A bounded changed-path batch is
stored in the resulting incremental workflow run and job input. A pending batch
before dispatch is process-local; the default full Startup scan repairs changes
that occurred while Kikoto was stopped.

## User State

Important tables:

- `user_account`
- `user_password_credential`
- `user_session`
- `user_preference`
- `user_work_state`
- `user_work_playback_cursor`
- `user_media_lyrics_preference`
- `favorite_list`
- `favorite_list_item`
- `user_tag`
- `user_work_tag`
- `user_listening_session`
- `user_listening_day`
- `user_listening_session_day`
- `user_listening_import`
- `user_listening_generation`
- `audit_log`

`user_password_credential` holds one Argon2id password hash per account.
`user_session.id` is the hex SHA-256 digest of the bearer token issued to the
client, never the token itself, so the database and its backups cannot be
replayed as a sign-in. The account store hashes every token before a lookup or
delete. `audit_log` records administrative actions, such as account, access
policy, backup and database maintenance changes, with the acting user, target
and a JSON detail.

`user_preference` stores optional account overrides for folder routing rules,
recommendation configuration, badge threshold, and the personal metadata
language priority (see [Metadata Language](#metadata-language)). A missing
override uses the `app_setting` default, or the original language for
metadata. New recommendation generations use the effective account
configuration; existing session bindings remain immutable.

Listening history is durable and separate from `recommendation_event`.
Sessions belong to an account and canonical work, accept monotonic cumulative
seconds, and survive recommendation retention cleanup. Imported totals store
positive differences above measured totals without fabricating daily activity.
Clearing history increments an account generation checked on every report,
including an unseen first report, to reject delayed retries; marks, lists and
cursors stay intact. Export/import is a versioned work-code-based personal
document, not a database or media backup.

`user_listening_session.dated_report` marks whether a session reports by
occurrence date; a report in the other form conflicts with the stored session.
Undated reports credit only newly reported seconds to the current UTC day in
`user_listening_day`. Dated reports keep cumulative per-session UTC buckets in
`user_listening_session_day`, with a cascading session foreign key; they credit
only each bucket's increase to `user_listening_day`, count a session once on
its actual start date, and keep occurrence time in the session's history
timestamps.

`favorite_list` distinguishes a system `marked` list from ordinary user lists.
The system list has no stored items: it derives membership from a non-`none`
Quick mark. `favorite_list_item` records only explicit user-list membership.
A user list's `icon` is a short presentation key (lowercase letters, digits,
and hyphens) that clients map to their own icon set; an empty or unknown key
shows the default list icon, and the system list never reports one.

`user_work_playback_cursor` stores at most one Resume position for each user and
canonical logical work family. It references the active edition's logical media
item and records the last file source/location context; location deletion clears
those foreign keys without turning a raw path into the progress owner. The
per-track `user_media_progress` table is retained in the schema, but no runtime
code reads or writes it.

The cursor's `report_order` and `report_id` provide a total checkpoint order
independent of position. A repeated or older checkpoint is acknowledged without
replacing a later cursor, including a later backward seek. An explicit
personal-progress import establishes a new checkpoint order at import time,
advancing beyond an existing order if necessary. A reserved server marker wins
a tied client order. The backup's historical playback date remains presentation
data, so an older offline report cannot undo the import; a strictly later
checkpoint, including a backward seek, still replaces it.

Lyrics preferences relate an audio media item to a lyrics media item; runtime
location selection remains a file-source concern. A personal preference
overrides the shared `media_lyrics_assignment` for that user only.

## Recommendation Catalog And Generations

Important tables:

- `recommendation_catalog_epoch` and `recommendation_catalog_state`
- `recommendation_catalog_dirty` and `recommendation_name_dirty`
- `recommendation_catalog_work`, `recommendation_catalog_entity`,
  `recommendation_catalog_frequency`, and `recommendation_catalog_name`
- `recommendation_user_revision`
- `recommendation_generation`
- `recommendation_generation_state`
- `recommendation_client_session`
- `recommendation_generation_profile`
- `recommendation_query_context`, `recommendation_query_candidate`, and
  `recommendation_query_checkpoint`

In production and development, a shared derived catalog stores effective
metadata tags, voices, circles, entity-to-work membership, entity frequency,
names, aliases, and ambiguous name
resolution. Relation and name mutations enqueue durable work in the same
transaction. A cancellable worker processes bounded batches and atomically
publishes a complete `catalog_epoch`. Version intervals retain only changed
records; publishing an epoch does not copy the library. The first epoch becomes
available only after its backfill completes, and later updates keep the last
published epoch available. An epoch also waits for the upstream metadata-tag
projection queue to drain, so names and effective relationships publish together.
GET requests never rebuild the catalog. Each work
receives an indexed exploration key when it is created, independently of the
worker, so a newly created work remains browsable before projection completes.

A generation freezes the algorithm, effective configuration, user revision,
published catalog epoch, entity preference evidence, and sparse personal states
(non-default listening status or favorite). Profile preparation reads all the
user's feedback works, not every work's relations. Its cost grows with feedback
volume, and scoring does not truncate that evidence. Preparation happens outside
the publication transaction; revision validation and bounded retries prevent a
partially prepared profile from being bound to a session. Matching preparation
tasks share one result. A staged epoch pin protects history before preparation
starts, including while the task waits for a CPU slot without a SQLite connection.
Client sessions reuse a ready immutable generation with
the same inputs; cards still read live favorite and listening state from
`user_work_state`. An algorithm version change renews older generation bindings.
An old generation retains its own catalog features, frequencies, names, and
personal evidence despite later edits. Works absent from its epoch receive
neutral affinity features; deleted works are excluded from browsing.
Catalog records, frozen states, and stored candidate prefixes also retain
`primary_code`; reads verify it against the current work. Reusing a deleted
SQLite row id cannot transfer that work's recommendation inputs to another work.

`heuristic-v6` aggregates supporting works once per entity, excludes the
candidate's own feedback, and scales positive evidence from 1 to 2 over the
first five supporting works. Tag specificity is `1 - 0.5 * frequency / work_count`;
contributions are rounded after summation and retain the configured caps.
Exploration is proportional to the remaining affinity headroom, while jitter
uses a separate seeded hash. Creator diversity subtracts 0–8 ordering points
within the bounded query candidates (two per later work in the same lane and
circle, with voice as the fallback); it does not change affinity.

Each normalized query context includes the generation, filters/search, scope,
seed, direction, and ordering inputs. Page and page size do not change it.
Recall budgets are 1,200 entity matches, 400 personal-state works, 200 recent
works, and 200 exploration works; deduplication limits scoring to 2,000 works.
Entity selection and indexed range probes are bounded even for common tags.
Each context retains at most 500 ranked candidates, and each generation retains
at most eight contexts. Within each listening lane, these candidates precede
the complete remaining matching set in a seeded ring over indexed exploration
keys. Lane counts and slot cycles select page windows without a full personal
`ROW_NUMBER` ranking. Search exact matches remain ahead of partial matches,
and zero-slot states follow scheduled states. Total counts include the complete
matching set. Membership and filter changes can move page boundaries; unchanged
visible data has deterministic, complete pagination without duplicates.

Ordinary sorting completes its page before scoring at most 100 page works and
creates no query context. Detail explanations score any work from the frozen
profile and epoch, including works outside the candidate prefix. A list's opaque
`recommendationContext` binds query-specific diversity and ordering explanations
to its owner and generation; without it, explanations report affinity only.
An evicted context returns HTTP 410 `recommendation_context_expired` only when
its token authenticates the original user and generation. Its original session
can still supply frozen affinity without ordering. Invalid, unverifiable,
cross-user, and cross-generation contexts return HTTP 400 `invalid_request`.
Each frozen profile persists a private signing key that stays outside API
responses. Cached legacy unsigned contexts still validate their owner and
generation; an evicted unsigned context cannot prove that binding.

Demo recommendation scores use `demo-random-v1`, a simulated value derived from
the demo session and unified `primary_code`; a missing session uses a stable
default. Feedback and recommendation features are not score inputs. Demo
recommendation sorting uses seeded random pagination and preserves filters,
exact-search priority, and complete totals. The seed affects ordering without
changing a work's demo score. Demo explanations identify `scoreKind` as
`demo_random`, return an empty component list, and omit preference signals,
listening lanes, and ranking adjustments. Demo starts no real recommendation
catalog worker, and its requests do not prepare profiles, generations, query
contexts, candidate recall, or real recommendation scores.

`recommendation_generation_profile` stores each generation's evidence counts and
name mappings. In production and development, the authenticated remote
recommendations endpoint accepts at most 100 candidates from the displayed
page, validates known work identities,
batch-loads their frozen features, and scores unknown candidates with frozen
name resolution and this profile.
Localized tag names and creator aliases resolve to one entity; repeated names
count once and ambiguous names are ignored. Scoring does not fetch upstream
metadata or create works, tags, creators, or source presence.

Cleanup removes expired sessions, unreferenced generations, contexts, unfinished
preparation records, legacy full-library score caches, and unreferenced shared
history in bounded batches. Referenced epochs remain protected. Personal
feedback, settings, telemetry retention, and durable listening history are
separate from these derived caches.

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
  holds the work's own `dlsite_metadata_variant` title and, for a work without
  non-remote metadata, its `remote_metadata_title_variant` titles, so each
  stored edition title matches independently of the projected `work.title`.
  The tag column also holds every learned `dlsite_genre_name` for the work's
  genre ids, so a tag matches in each language the library has fetched.
  Matching remains a substring test; a Library page orders works whose indexed
  value equals a text, circle, voice, or tag needle exactly ahead of partial
  matches, then applies the selected sort. Folding applies NFKC, Unicode
  lowercase, and katakana-to-hiragana mapping. Triggers queue changed works in
  `work_search_dirty`; a background worker rebuilds queued documents in bounded
  batches. A search rebuilds a queue of at most 64 works itself, so an edit is
  searchable at once; a longer queue leaves the search on the previous index
  state and wakes the worker instead of holding the request. Edition-family
  matching is applied at query time, so the index never duplicates a sibling's
  text or creates another work identity.
- User state should survive metadata refresh and source replacement.
- Playback is a work cursor, not a set of independent per-track bookmarks.

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Workflows](workflows.md)
- [Migrations](../development/migrations.md)
