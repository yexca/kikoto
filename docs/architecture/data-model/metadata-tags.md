# Metadata Tags and Genres

DLsite genre ids and names, and the shared tag model that projects them with provider and manual names.

## DLsite Genres

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

## Shared Metadata Tags

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
name, the universal manual name, then its genre dictionary name, its provider name, and its accepted LLM name;
Japanese names and any known name follow the same precedence. The edition token `origin` does
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
through the opt-in [remote metadata fallback](remote-metadata-fallback.md#remote-metadata-fallback);
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
