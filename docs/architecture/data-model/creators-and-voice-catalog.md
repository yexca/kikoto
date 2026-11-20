# Creators and Voice Catalog

Circles and voice actors as `party` and `person` rows with aliases and merges, and the voice catalog discovered from DLsite.

## Circle and Voice Actor Identity

`party.manual_name` takes precedence over `provider_name`; provider
refreshes preserve authored names. `party_alias` stores confirmed alternate
names, including names retained by a merge. Aliases participate in creator
suggestions, work search, and matching an existing circle from a remote record.

`party_catalog_item` holds a circle's discovered catalog per provider, keyed by
circle, provider and canonical code, with title, release date, catalog status
and the raw entry; a catalog item is not a work. `party_catalog_refresh_state`
records each circle and provider's latest catalog refresh attempt, mode,
status, run and error.

A work's primary circle is its own manual override, then from its family's
canonical work a manual override, the circle whose maker id matches the
canonical edition, and DLsite relations, then its own relations; ties go to the
lowest party id. A catalog item belongs to the canonical work's manual
override, then the circle of the family's origin edition maker id, then the
canonical work's primary circle, then the circle that lists it, so a
translation's listing counts for the original circle and an unknown code stays
with the circle that lists it. The `work_primary_circle_ranking` and
`party_catalog_owner_resolution` views define these rules. Triggers on
`work_party`, `work_edition`, `logical_work`, `party_external_id`, `work`, and
`party_catalog_item` persist the results in `work_primary_circle_projection`
and `party_catalog_item.owner_party_id`, so reading one circle costs in
proportion to that circle's catalog. `work_primary_circle` is the reader-facing
view with the party's current name and preferred external id. A migration that
rebuilds one of those tables recreates its triggers.

`user_party_state` and `user_person_state` hold one account's rating, note,
favorite, and cover choice for a circle or voice actor.
`cover_primary_code` names the work whose cover represents the creator for
that account; an empty value shows the latest work's cover. A summary applies
the choice only while that code is one of the creator's works and has a cover
to show, and a write rejects any other code. A merge keeps the surviving
creator's choice and otherwise adopts the merged one's; Undo does not restore
cover choices.

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
name an administrator merged never replaces the target's display name. A merge
that credit projection makes gives the merged names `identity_merged_*` alias
sources instead of `merged_*`, so they carry no such priority; Undo treats both
alike. A merge points every manual voice actor list (`work_manual_override`
field `voice_actors`) that named the merged-away person at the target, keeping
one entry where a list named both; Undo restores a list the merge rewrote unless
it was edited since.
